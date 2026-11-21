//! 本机 IPC：按行分隔的 JSON 协议，Unix 走 socket、Windows 走具名管道，见 `onex_core::transport`
//! 和 `onex_core::ipc`。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use onex_core::ipc::{ArtifactProgress, ErrorBody, ManagedAgent, Request, Status};
use onex_core::transport::{self, Connection, Listener};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::credentials::{CredentialStore, DeviceCredentials};
use crate::outbox::Outbox;
use crate::pricing::format_ms;
use crate::router::AgentProtocol;
use crate::state::State;

/// 一行请求的长度上限，防止本机其他进程塞大包。
const MAX_LINE: u64 = 64 * 1024;

/// `crate::launch::prepare` 已经实现准备逻辑的 agent。和 `managed_runtime::SUPPORTED_AGENTS`
/// 不是同一个名单：后者是「Server 下发的发行记录认哪些 agent 名字」，这里是「onexd 本机真的会
/// 准备启动」，两者独立演进（例如先接入制品下发，后接入启动准备）。S1 只有 Claude Code；
/// S2 接入 Codex、Kimi Code 时在这里加名字，并给 `launch.rs` 加对应的 `prepare_<agent>`。
const LAUNCHABLE_AGENTS: &[&str] =
    &["claude-code", "codex", "kimi-code", "deepseek-desktop", "workbuddy", "claude-desktop", "codex-desktop"];

pub struct Ipc {
    pub state: Arc<State>,
    pub outbox: Arc<Outbox>,
    pub router_addr: Option<String>,
    /// Server 的 HTTP 根地址，从 WS 地址推出
    pub server_url: Option<String>,
    /// 受管启动需要的 daemon 数据目录和本机令牌；None 时不支持 launch
    pub launch: Option<LaunchCtx>,
    /// 设备身份持久化；None 时（非 macOS 或测试未配置）Login 只存内存，和此前行为一致
    pub credentials: Option<Arc<dyn CredentialStore>>,
    pub identity_transition: tokio::sync::Mutex<()>,
    pub shutdown: CancellationToken,
}

pub struct LaunchCtx {
    pub home: PathBuf,
    /// 下载受管制品用；和上游 router 的客户端分开，走正常代理设置（CDN 在公网）
    pub http: reqwest::Client,
    /// launch_id → 进行中的启动
    running: Arc<std::sync::Mutex<std::collections::HashMap<String, Running>>>,
    preparing: std::sync::Mutex<Option<Preparation>>,
    download_failed: std::sync::Mutex<HashMap<String, String>>,
}

struct Running {
    agent: String,
    stop: CancellationToken,
    code: Arc<std::sync::Mutex<Option<i32>>>,
    session_id: String,
    token: String,
}

#[derive(Clone)]
struct Preparation {
    agent: String,
    release_id: Option<String>,
    progress: Option<ArtifactProgress>,
}

struct Preparing<'a>(&'a std::sync::Mutex<Option<Preparation>>);

impl Drop for Preparing<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().take();
    }
}

impl LaunchCtx {
    pub fn new(home: PathBuf, http: reqwest::Client) -> Self {
        Self {
            home,
            http,
            running: Default::default(),
            preparing: Default::default(),
            download_failed: Default::default(),
        }
    }

    fn reserve_preparation(&self, agent: &str) -> bool {
        let mut preparing = self.preparing.lock().unwrap();
        if preparing.is_some() {
            return false;
        }
        *preparing = Some(Preparation { agent: agent.to_owned(), release_id: None, progress: None });
        true
    }

    fn try_prepare(&self, agent: &str) -> Option<Preparing<'_>> {
        self.reserve_preparation(agent).then(|| Preparing(&self.preparing))
    }

    fn progress(&self, update: ArtifactProgress) {
        if let Some(preparation) = self.preparing.lock().unwrap().as_mut() {
            preparation.progress = Some(update);
        }
    }

    fn bind_preparation(&self, release: &str) {
        if let Some(preparation) = self.preparing.lock().unwrap().as_mut() {
            preparation.release_id = Some(release.to_owned());
        }
    }
}

/// 绑定本机 IPC 入口（Unix socket 或 Windows 具名管道，权限收紧到当前用户，拒绝远程）。
/// 已有入口能连上说明另一个 onexd 在跑，报错退出；Unix 下连不上是残留文件，删掉重建。
pub async fn bind(path: &std::path::Path) -> Result<Listener> {
    transport::bind(path).await
}

pub async fn serve(listener: Listener, path: PathBuf, ipc: Arc<Ipc>) {
    loop {
        tokio::select! {
            _ = ipc.shutdown.cancelled() => break,
            r = listener.accept() => match r {
                Ok(conn) => {
                    let ipc = ipc.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle(conn, &ipc).await {
                            warn!(error = %format!("{e:#}"), "ipc connection");
                        }
                    });
                }
                Err(e) => warn!(error = %e, "ipc accept"),
            }
        }
    }
    transport::cleanup(&path);
}

async fn handle(stream: Connection, ipc: &Arc<Ipc>) -> Result<()> {
    let (r, mut w) = stream.into_split();
    let mut r = BufReader::new(r);
    let mut line = String::new();
    loop {
        line.clear();
        let n = (&mut r).take(MAX_LINE).read_line(&mut line).await?;
        if n == 0 {
            return Ok(());
        }
        if !line.ends_with('\n') && n as u64 == MAX_LINE {
            write_line(&mut w, &err("invalid", "请求超过 64 KB")).await?;
            return Ok(());
        }
        let request = serde_json::from_str::<Request>(line.trim());
        let _identity = if matches!(request, Ok(Request::Login { .. } | Request::Logout | Request::Shutdown)) {
            Some(ipc.identity_transition.lock().await)
        } else {
            None
        };
        if ipc.shutdown.is_cancelled() {
            return Ok(());
        }
        let (reply, stop) = match request {
            Ok(req) => dispatch(req, ipc).await,
            Err(e) => (err("invalid", &format!("无法解析请求：{e}")), false),
        };
        // 先决定好的关停不能因为回复写失败（调用方已经断开）就不生效。
        let written = write_line(&mut w, &reply).await;
        if stop {
            ipc.shutdown.cancel();
            return written;
        }
        written?;
    }
}

async fn dispatch(req: Request, ipc: &Arc<Ipc>) -> (Value, bool) {
    match req {
        Request::Status => (ok(status(ipc)), false),
        Request::Login { token, server, device_id } => (login(ipc, token, server, device_id), false),
        Request::Logout => logout(ipc),
        // 只给公钥，私钥不出 daemon
        Request::DeviceInfo => {
            (json!({"ok": true, "public_key": ipc.state.device_key.public_b64(), "server_url": ipc.server_url}), false)
        }
        Request::Launch { agent, program, cwd, env, model, agent_version } => (
            launch(ipc, &agent, program.as_deref(), &cwd, &env, model.as_deref(), agent_version.as_deref()).await,
            false,
        ),
        Request::Download { agent } => (start_download(ipc, &agent), false),
        Request::LaunchDone { launch_id, exit_code } => {
            let Some(ctx) = &ipc.launch else { return (err("invalid", "这个 onexd 不支持启动 Agent"), false) };
            let Some(launch) = ctx.running.lock().unwrap().remove(&launch_id) else {
                return (json!({"ok": true}), false);
            };
            info!(%launch_id, ?exit_code, "agent exited");
            ipc.state.launch_tokens.write().unwrap().remove(&launch.token);
            ipc.state.desktop_sessions.stop(&launch.token);
            ipc.state.workbuddy_turns.stop(&launch.token);
            *launch.code.lock().unwrap() = exit_code;
            launch.stop.cancel();
            ipc.state.active_session.write().unwrap().take_if(|s| *s == launch.session_id);
            match crate::launch::finish(&ctx.home, &launch_id) {
                Ok(()) => (json!({"ok": true}), false),
                Err(e) => (err("invalid", &format!("{e:#}")), false),
            }
        }
        Request::Shutdown => {
            info!("shutdown requested via ipc");
            (json!({"ok": true}), true)
        }
    }
}

/// `device_id` 缺省时是旧用法／调试（只认 token，不落 Keychain）。带 `device_id` 时这是一次正常注册登录：
/// 和当前已生效的设备身份冲突就拒绝，否则先把这把内存里的私钥和新身份一起写 Keychain，再切换 token。
/// Keychain 写入失败整体失败，不让调用方以为已经能在重启后恢复身份。
fn login(ipc: &Ipc, token: String, server: Option<String>, device_id: Option<String>) -> Value {
    let token = token.trim().to_string();
    if token.is_empty() {
        return err("invalid", "token 不能为空");
    }
    if let Some(current) = ipc.state.token.borrow().as_ref() {
        if current == &token && ipc.state.expected_device_id.read().unwrap().as_ref() == device_id.as_ref() {
            return json!({"ok": true});
        }
        return err("conflict", "设备已登录，请先退出当前账号");
    }
    let Some(device_id) = device_id else {
        info!("device token updated via ipc (legacy, memory-only)");
        ipc.state.token.send_replace(Some(token));
        return json!({"ok": true});
    };
    let configured = ipc.server_url.as_deref().and_then(normalize_origin);
    let supplied = server.as_deref().and_then(normalize_origin);
    let Some(origin) = configured.filter(|origin| supplied.as_ref() == Some(origin)) else {
        return err("invalid", "登录地址与本机服务配置不一致");
    };
    if !device_id.starts_with("dev_")
        || device_id.len() > 64
        || !device_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return err("invalid", "设备标识无效");
    }
    if let Some(store) = &ipc.credentials {
        let creds = DeviceCredentials {
            server: origin,
            device_id: device_id.clone(),
            device_token: token.clone(),
            device_key: ipc.state.device_key.bytes_for_keychain(),
        };
        if store.save(&creds).is_err() {
            return err("internal", "无法把设备身份写入系统钥匙串");
        }
        info!(%device_id, "device credentials persisted to keychain");
    }
    *ipc.state.expected_device_id.write().unwrap() = Some(device_id.clone());
    ipc.state.token.send_replace(Some(token));
    json!({"ok": true})
}

pub fn normalize_origin(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// 注销：Keychain 条目删不掉就整体失败，不报告"已注销"；成功后清断流所需的内存状态，
/// 和 shutdown 一样让调用方知道要重新拉起 onexd（打包环境由 LaunchAgent 负责，手工调试自己重新执行）。
fn logout(ipc: &Ipc) -> (Value, bool) {
    if let Some(store) = &ipc.credentials
        && store.clear().is_err()
    {
        return (err("internal", "无法清除系统钥匙串里的设备身份"), false);
    }
    info!("device logged out via ipc; shutting down for a clean restart");
    if let Err(e) = ipc.state.lease.cutoff("logout", None) {
        warn!(error = %format!("{e:#}"), "could not persist logout cutoff");
    }
    *ipc.state.config.write().unwrap() = Default::default();
    ipc.state.secrets.write().unwrap().clear();
    if let Some(ctx) = &ipc.launch {
        for (_, launch) in ctx.running.lock().unwrap().drain() {
            launch.stop.cancel();
        }
    }
    ipc.state.launch_tokens.write().unwrap().clear();
    ipc.state.desktop_sessions.clear();
    ipc.state.workbuddy_turns.clear();
    ipc.state.active_session.write().unwrap().take();
    ipc.state.token.send_replace(None);
    (json!({"ok": true}), true)
}

fn start_download(ipc: &Arc<Ipc>, agent: &str) -> Value {
    let Some(ctx) = ipc.launch.as_ref() else {
        return err("invalid", "这个 onexd 不支持下载 Agent");
    };
    let Some(token) = ipc.state.token.borrow().clone() else {
        return err("unauthenticated", "还没有登录，请先登录 OneX");
    };
    if !LAUNCHABLE_AGENTS.contains(&agent) {
        return err("agent_not_allowed", "没有可用的受管发行版本");
    }
    let (os, arch) = (onex_core::ipc::os_name(), onex_core::ipc::arch_name());
    let release = {
        let cfg = ipc.state.config.read().unwrap();
        if cfg.policy_blocked {
            return err("agent_not_allowed", "设备策略尚未成功同步");
        }
        let Ok(release) = crate::managed_runtime::select(&cfg.agents, agent, os, arch) else {
            return err("agent_not_allowed", "没有可用的受管发行版本");
        };
        if cfg.agent_cache && !crate::managed_runtime::is_server_artifact(release) {
            return err("agent_not_allowed", "当前发行没有可用的 Server 缓存地址");
        }
        release.clone()
    };
    if !ctx.reserve_preparation(agent) {
        return err("conflict", "已有制品正在处理");
    }
    ctx.bind_preparation(&release.id);
    ctx.download_failed.lock().unwrap().remove(agent);
    let ipc = ipc.clone();
    tokio::spawn(async move {
        let Some(ctx) = ipc.launch.as_ref() else { return };
        let _preparation = Preparing(&ctx.preparing);
        let access = ipc
            .server_url
            .as_deref()
            .map(|origin| crate::managed_runtime::ArtifactAccess { origin, device_token: &token });
        let result = tokio::select! {
            _ = ipc.shutdown.cancelled() => return,
            result = crate::managed_runtime::resolve_with_progress(
                &ctx.home, &ctx.http, std::slice::from_ref(&release), &release.agent, os, arch, access,
                |progress| ctx.progress(progress),
            ) => result,
        };
        if result.is_err() {
            ctx.download_failed.lock().unwrap().insert(release.agent, release.id);
        }
    });
    json!({"ok": true})
}

async fn launch(
    ipc: &Ipc,
    agent: &str,
    program: Option<&str>,
    cwd: &str,
    env: &std::collections::BTreeMap<String, String>,
    model: Option<&str>,
    agent_version: Option<&str>,
) -> Value {
    let (Some(ctx), Some(router_addr)) = (&ipc.launch, &ipc.router_addr) else {
        return err("invalid", "这个 onexd 不支持启动 Agent");
    };
    let desktop = crate::desktop_bundle::Bundle::manages(agent);
    let Some(protocol) = AgentProtocol::for_agent(agent).filter(|_| {
        LAUNCHABLE_AGENTS.contains(&agent) && (!desktop || cfg!(all(target_os = "macos", target_arch = "aarch64")))
    }) else {
        return err("agent_not_allowed", &format!("OneX 暂不支持启动 {agent}"));
    };
    {
        let config = ipc.state.config.read().unwrap();
        if config.policy_blocked {
            return err("agent_not_allowed", "设备策略尚未成功同步");
        }
        if program.is_some() && (agent != "claude-code" || config.requires_managed_launch()) {
            return err("agent_not_allowed", "该 Agent 需要使用已批准的受管发行版本");
        }
    }
    if ipc.state.token.borrow().is_none() {
        return err("unauthenticated", "还没有登录，请先登录 OneX");
    }
    // 处于 cutoff 且没有租约时，启动 Agent 立即申请一次租约，不等下一个 60 秒窗口（v0.13）。
    ipc.state.lease.request_lease_now();
    let Some(_prepare) = ctx.try_prepare(agent) else {
        return err("conflict", "已有 Agent 正在启动");
    };
    if desktop && ctx.running.lock().unwrap().values().any(|launch| launch.agent == agent) {
        return err("conflict", "该桌面 Agent 已在运行");
    }
    let (os, arch) = (onex_core::ipc::os_name(), onex_core::ipc::arch_name());
    let (approved, tool_releases) = {
        let cfg = ipc.state.config.read().unwrap();
        if cfg.policy_blocked {
            return err("agent_not_allowed", "设备策略尚未成功同步");
        }
        if cfg.balance_stopped() {
            return err("balance_exhausted", "OneX 橡皮余额已用完，请联系管理员充值。");
        }
        let approved = if program.is_none() {
            let Ok(release) = crate::managed_runtime::select(&cfg.agents, agent, os, arch) else {
                return err("agent_not_allowed", "没有可用的受管发行版本");
            };
            if cfg.agent_cache && !crate::managed_runtime::is_server_artifact(release) {
                return err("agent_not_allowed", "当前发行没有可用的 Server 缓存地址");
            }
            Some(release.clone())
        } else {
            None
        };
        let tools: Vec<_> = crate::tools::select(&cfg.tools, agent, os, arch).into_iter().cloned().collect();
        (approved, tools)
    };
    // program 不填：按 Server 下发的发行目录自己选型、下载、校验并原子缓存；program 填了就是旧 PATH 用法。
    let device_token = ipc.state.token.borrow().clone();
    let access = ipc
        .server_url
        .as_deref()
        .zip(device_token.as_deref())
        .map(|(origin, device_token)| crate::managed_runtime::ArtifactAccess { origin, device_token });
    let (resolved_program, claude_engine) = if let Some(release) = &approved {
        ctx.bind_preparation(&release.id);
        let acquire = async {
            let program = crate::managed_runtime::resolve_with_progress(
                &ctx.home,
                &ctx.http,
                std::slice::from_ref(release),
                agent,
                os,
                arch,
                access,
                |progress| ctx.progress(progress),
            )
            .await?;
            let engine = if agent == "claude-desktop" {
                Some(crate::managed_runtime::resolve_claude_engine(&ctx.home, release, access).await?)
            } else {
                None
            };
            Ok::<_, anyhow::Error>((program, engine))
        };
        match tokio::select! {
            _ = ipc.shutdown.cancelled() => return err("unauthenticated", "请重新登录 OneX"),
            result = acquire => result,
        } {
            Ok(path) => path,
            Err(error) => {
                warn!(agent, version = %release.version, error = %error, "managed agent artifact resolution failed");
                return err("upstream_error", "无法下载或校验受管 Agent 制品");
            }
        }
    } else {
        (PathBuf::from(program.expect("legacy launch provides a program")), None)
    };
    let installed_tools = if tool_releases.is_empty() {
        Vec::new()
    } else {
        let Some(access) = ipc.server_url.as_deref().zip(device_token.as_deref()) else {
            return err("unauthenticated", "没有可用于取得受管工具的设备身份");
        };
        match tokio::select! {
            _ = ipc.shutdown.cancelled() => return err("unauthenticated", "请重新登录 OneX"),
            result = crate::tools::download(access.0, access.1, &tool_releases) => result,
        } {
            Ok(tools) => tools,
            Err(error) => {
                warn!(agent, %error, "managed tool bundle resolution failed");
                return err("upstream_error", "无法下载或校验受管 Skill 或 MCP 制品");
            }
        }
    };
    let resolved_program = if let Some(release) = approved.as_ref().filter(|_| desktop) {
        match crate::desktop_bundle::executable(release, resolved_program).await {
            Ok(entry) => entry,
            Err(error) => {
                warn!(agent, %error, "desktop bundle rejected");
                return err("upstream_error", "无法校验或安装原厂桌面应用");
            }
        }
    } else {
        resolved_program
    };
    let _identity = ipc.identity_transition.lock().await;
    if ipc.shutdown.is_cancelled()
        || device_token.is_none()
        || ipc.state.token.borrow().as_deref() != device_token.as_deref()
        || ipc.state.phase() == crate::state::Phase::Unauthenticated
    {
        return err("unauthenticated", "请重新登录 OneX");
    }
    let program = resolved_program.to_string_lossy().into_owned();
    let program = program.as_str();
    let tools_current = |cfg: &crate::state::ConfigSnapshot| {
        crate::tools::select(&cfg.tools, agent, os, arch).into_iter().eq(tool_releases.iter())
    };
    // 别名候选：精确名字的路由；通配路由用它固定的上游模型名（server 的 MVP seed 是 `*` → Qwen3.8-27B）
    let (models, routable) = {
        let cfg = ipc.state.config.read().unwrap();
        if cfg.policy_blocked {
            return err("agent_not_allowed", "设备策略尚未成功同步");
        }
        if !tools_current(&cfg) {
            return err("agent_not_allowed", "受管工具授权已变化，请重试");
        }
        if approved.is_none() && cfg.requires_managed_launch() {
            return err("agent_not_allowed", "该能力合约要求使用已批准的受管发行版本");
        }
        if let Some(release) = &approved
            && crate::managed_runtime::select(&cfg.agents, agent, os, arch).ok() != Some(release)
        {
            return err("agent_not_allowed", "受管发行已变化，请重试");
        }
        let compatible = || cfg.routes.iter().filter(|route| protocol.accepts_upstream(&route.protocol));
        let exact = compatible().filter(|route| !route.model.ends_with('*')).map(|route| route.model.as_str());
        let wildcard = compatible().filter_map(|route| {
            let prefix = route.model.strip_suffix('*')?;
            route.upstream_model.as_deref().filter(|model| model.starts_with(prefix))
        });
        let mut seen = HashSet::new();
        let models: Vec<_> = exact
            .chain(wildcard)
            .filter(|name| !desktop || protocol.select_agent_route(&cfg, name, Some(agent)).is_some())
            .filter(|name| seen.insert(*name))
            .map(str::to_owned)
            .collect();
        let routable = model.is_some_and(|name| protocol.select_agent_route(&cfg, name, Some(agent)).is_some());
        (models, routable)
    };
    let model = match model {
        Some(m) if routable => m.to_string(),
        Some(m) => {
            return err("model_not_allowed", &format!("模型 {m} 对此 Agent 不可用，可用的有：{}", models.join("、")));
        }
        None => match models.first() {
            Some(m) => m.clone(),
            None => {
                return err(
                    "model_not_allowed",
                    "此 Agent 没有可用的默认模型。请显式指定合约允许的模型，或联系管理员检查路由。",
                );
            }
        },
    };
    let agent_version = approved.as_ref().map(|release| release.version.as_str()).or(agent_version);
    let local_token = crate::id::token();
    if desktop {
        let owner = ipc
            .state
            .conn
            .lock()
            .unwrap()
            .device_id
            .clone()
            .or_else(|| ipc.state.expected_device_id.read().unwrap().clone());
        let Some(owner) = owner else { return err("unauthenticated", "请先连接 OneX Server") };
        let model_bearer = (agent == "workbuddy").then(crate::id::token);
        return start_desktop(
            ipc,
            ctx,
            crate::desktop_launch::Request {
                owner: &owner,
                home: &ctx.home,
                agent,
                entry: &resolved_program,
                cwd: Path::new(cwd),
                token: &local_token,
                model_bearer: model_bearer.as_deref(),
                router: router_addr,
                model: &model,
            },
            approved.as_ref().expect("desktop launch always has an approved release"),
            claude_engine.as_ref().map(|(path, engine)| (path.as_path(), *engine)),
        )
        .await;
    }
    let r = crate::launch::Request {
        agent,
        home: &ctx.home,
        router_addr,
        local_token: &local_token,
        model: &model,
        program: Path::new(program),
        cwd: Path::new(cwd),
        client_env: env,
    };
    match crate::launch::prepare(&r) {
        Ok(mut l) => {
            if let Err(error) = crate::tools::apply(agent, &mut l, &installed_tools) {
                let _ = crate::launch::finish(&ctx.home, &l.launch_id);
                warn!(agent, %error, "could not prepare managed tools");
                return err("invalid", "无法加载受管 Skill 或 MCP");
            }
            let cfg = ipc.state.config.read().unwrap();
            let release_unchanged = if let Some(release) = &approved {
                crate::managed_runtime::select(&cfg.agents, agent, os, arch).ok() == Some(release)
            } else {
                !cfg.requires_managed_launch()
            };
            if cfg.policy_blocked
                || !release_unchanged
                || !tools_current(&cfg)
                || protocol.select_config_route(&cfg, &model).is_none()
            {
                let _ = crate::launch::finish(&ctx.home, &l.launch_id);
                return err("agent_not_allowed", "启动策略已变化，请重试");
            }
            info!(launch_id = %l.launch_id, session_id = %l.session_id, program, agent_version, model = %model, cwd, "agent launch prepared");
            let s = crate::capture::Session {
                session_id: l.session_id.clone(),
                config_dir: l.config_dir.clone(),
                agent_version: agent_version.map(str::to_owned),
                model: model.clone(),
                cwd: l.cwd.clone(),
            };
            let stop = CancellationToken::new();
            let code = Arc::new(std::sync::Mutex::new(None));
            let native = match agent {
                "codex" => Some(crate::native_capture::Agent::Codex),
                "kimi-code" => Some(crate::native_capture::Agent::Kimi),
                _ => None,
            };
            let (native, first_native_session) = native
                .map(|agent| {
                    let (sender, receiver) = tokio::sync::watch::channel(None);
                    ((agent, sender), receiver)
                })
                .unzip();
            ipc.state.launch_tokens.write().unwrap().insert(
                local_token.clone(),
                crate::state::LaunchBinding {
                    approved_model: None,
                    session_id: l.session_id.clone(),
                    agent: agent.into(),
                    release_id: approved.as_ref().map(|release| release.id.clone()),
                    first_native_session,
                },
            );
            ctx.running.lock().unwrap().insert(
                l.launch_id.clone(),
                Running {
                    agent: agent.to_owned(),
                    stop: stop.clone(),
                    code: code.clone(),
                    session_id: l.session_id.clone(),
                    token: local_token.clone(),
                },
            );
            *ipc.state.active_session.write().unwrap() = Some(l.session_id.clone());
            if let Some((native, first_session)) = native {
                let capture = crate::native_capture::LaunchCapture::new(
                    s,
                    ipc.state.clone(),
                    ipc.outbox.clone(),
                    local_token,
                    first_session,
                );
                tokio::spawn(capture.run(native, stop, code));
            } else {
                tokio::spawn(crate::capture::Capture::new(s, ipc.outbox.clone()).run(stop, code));
            }
            json!({"ok": true, "launch_id": l.launch_id, "session_id": l.session_id, "program": l.program,
                "args": l.args, "env": l.env, "cwd": l.cwd, "model": model})
        }
        Err(e) => err("invalid", &format!("无法准备启动：{e:#}")),
    }
}

async fn start_desktop(
    ipc: &Ipc,
    ctx: &LaunchCtx,
    request: crate::desktop_launch::Request<'_>,
    release: &onex_core::ws::AgentRelease,
    engine_archive: Option<(&Path, crate::desktop_bundle::RuntimeBundle)>,
) -> Value {
    use std::process::Stdio;

    let crate::desktop_launch::Prepared { launch, workspace, runtime, claude_profile } =
        match crate::desktop_launch::prepare(&request, engine_archive) {
            Ok(ready) => ready,
            Err(error) => {
                warn!(agent = request.agent, %error, "desktop profile rejected");
                return err("invalid", "无法准备私有桌面应用配置");
            }
        };
    let workbuddy_capture = if request.agent == "workbuddy" {
        match crate::workbuddy_capture::Capture::new(
            &launch.config_dir,
            &launch.cwd,
            request.owner,
            &release.version,
            request.model,
            ipc.outbox.clone(),
        ) {
            Ok(capture) => Some(Arc::new(capture)),
            Err(error) => {
                let _ = crate::launch::finish(&ctx.home, &launch.launch_id);
                warn!(%error,"private native transcript index unavailable");
                return err("invalid", "无法打开受管会话记录");
            }
        }
    } else {
        None
    };
    if let Some(bearer) = request.model_bearer
        && !ipc.state.workbuddy_turns.start(request.token, bearer, request.owner, &release.id, request.model)
    {
        let _ = crate::launch::finish(&ctx.home, &launch.launch_id);
        return err("conflict", "桌面会话凭据已被占用，请重试");
    }
    ipc.state.desktop_sessions.start(
        request.token.to_owned(),
        request.owner.to_owned(),
        request.agent.to_owned(),
        release.version.clone(),
        release.id.clone(),
        request.model.to_owned(),
        workspace,
        ipc.outbox.clone(),
    );
    let claude = claude_profile.is_some();
    if let Some(capture) = &workbuddy_capture {
        ipc.state.desktop_sessions.attach_workbuddy_capture(request.token, capture.clone());
    }
    if let Some(profile) = claude_profile {
        ipc.state.desktop_sessions.register_claude_window(request.token, profile);
    }
    let mut command = tokio::process::Command::new(&launch.program);
    command
        .args(&launch.args)
        .current_dir(&launch.cwd)
        .env_clear()
        .envs(&launch.env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            ipc.state.desktop_sessions.stop(request.token);
            ipc.state.workbuddy_turns.stop(request.token);
            let _ = crate::launch::finish(&ctx.home, &launch.launch_id);
            warn!(agent = request.agent, %error, "desktop process did not start");
            return err("invalid", "原厂桌面应用启动失败");
        }
    };
    let stop = ipc.shutdown.child_token();
    let token = request.token.to_owned();
    let id = launch.launch_id.clone();
    let running = ctx.running.clone();
    running.lock().unwrap().insert(
        id.clone(),
        Running {
            agent: request.agent.to_owned(),
            stop: stop.clone(),
            code: Default::default(),
            session_id: launch.session_id,
            token: token.clone(),
        },
    );
    let state = ipc.state.clone();
    let home = ctx.home.clone();
    let launch_id = id.clone();
    let capture = (claude || request.agent == "codex-desktop").then(|| crate::capture::Session {
        session_id: String::new(),
        config_dir: launch.config_dir,
        agent_version: Some(release.version.clone()),
        model: request.model.to_owned(),
        cwd: launch.cwd,
    });
    let outbox = ipc.outbox.clone();
    let device = request.owner.to_owned();
    tokio::spawn(async move {
        let capture_stop = CancellationToken::new();
        let capture = if let Some(workbuddy) = workbuddy_capture {
            Some(tokio::spawn(workbuddy.run(capture_stop.clone())))
        } else {
            capture.map(|session| {
                if claude {
                    tokio::spawn(crate::native_capture::capture_claude_desktop(
                        session,
                        token.clone(),
                        state.clone(),
                        outbox,
                        capture_stop.clone(),
                    ))
                } else {
                    tokio::spawn(crate::native_capture::capture_codex_desktop(
                        session,
                        device,
                        outbox,
                        capture_stop.clone(),
                    ))
                }
            })
        };
        tokio::select! {
            _ = child.wait() => {}
            _ = stop.cancelled() => { let _ = child.kill().await; }
        }
        capture_stop.cancel();
        if let Some(capture) = capture {
            let _ = capture.await;
        }
        state.desktop_sessions.stop(&token);
        state.workbuddy_turns.stop(&token);
        drop(runtime);
        let _ = crate::launch::finish(&home, &id);
        running.lock().unwrap().remove(&id);
        info!(launch_id = %id, "desktop process exited");
    });
    json!({"ok":true, "launch_id":launch_id, "desktop":true})
}

fn status(ipc: &Ipc) -> Status {
    let conn = ipc.state.conn.lock().unwrap().clone();
    let up = ipc.state.upstream.lock().unwrap().clone();
    let entry = |e: Option<(String, String, i64)>| {
        e.map(|(outcome, request_id, at)| json!({"outcome": outcome, "request_id": request_id, "at": format_ms(at)}))
    };
    let (agent_cache, config_revision, capability_contract, releases, policy, notices, policy_blocked) = {
        let config = ipc.state.config.read().unwrap();
        (
            config.agent_cache,
            config.revision,
            config.capability_contract,
            config.agents.clone(),
            config.policy.as_ref().map(|policy| policy.summary.clone()),
            config.policy.as_ref().map(|policy| policy.notices.clone()).unwrap_or_default(),
            config.policy_blocked,
        )
    };
    let managed_agents = ipc
        .launch
        .as_ref()
        .map(|ctx| {
            let (os, arch) = (onex_core::ipc::os_name(), onex_core::ipc::arch_name());
            let preparing = ctx.preparing.lock().unwrap().clone();
            let running = ctx.running.lock().unwrap();
            let download_failed = ctx.download_failed.lock().unwrap();
            LAUNCHABLE_AGENTS
                .iter()
                .filter_map(|&agent| {
                    let release = crate::managed_runtime::select(&releases, agent, os, arch).ok()?;
                    let is_cached = crate::managed_runtime::cache_ready(&ctx.home, release);
                    let preparation = preparing.as_ref().filter(|state| {
                        state.agent == agent && state.release_id.as_deref().is_none_or(|id| id == release.id)
                    });
                    let progress = preparation.and_then(|state| state.progress);
                    let instance_count = running.values().filter(|launch| launch.agent == agent).count();
                    let stage = if policy_blocked {
                        "policy_pending"
                    } else if let Some(progress) = progress {
                        if progress.verifying { "verifying" } else { "downloading" }
                    } else if preparation.is_some() {
                        "preparing"
                    } else if running.values().any(|l| {
                        l.agent == agent
                            && crate::desktop_bundle::Bundle::manages(agent)
                            && !ipc.state.desktop_sessions.is_ready(&l.token)
                    }) {
                        "starting"
                    } else if instance_count > 0 {
                        "running"
                    } else if download_failed.get(agent) == Some(&release.id) && !is_cached {
                        "download_failed"
                    } else if is_cached {
                        "cached"
                    } else {
                        "available"
                    };
                    Some(ManagedAgent {
                        id: agent.into(),
                        version: release.version.clone(),
                        status: stage.into(),
                        instance_count,
                        progress,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Status {
        agent_cache,
        ws_last_error: conn.last_error.as_ref().map(|(r, _)| r.clone()),
        ws_last_error_at: conn.last_error.as_ref().map(|(_, at)| format_ms(*at)),
        lease: ipc.state.lease.status(),
        upstream: json!({
            "inflight": up.inflight,
            "completed": up.completed,
            "last": entry(up.last),
            "last_error": entry(up.last_error),
        }),
        version: env!("CARGO_PKG_VERSION").into(),
        logged_in: ipc.state.token.borrow().is_some(),
        ws: conn.phase.as_str().into(),
        device_id: conn.device_id.or_else(|| ipc.state.expected_device_id.read().unwrap().clone()),
        config_revision,
        capability_contract,
        policy,
        policy_blocked,
        notices,
        local_usage: up.local_usage,
        outbox_last_seq: ipc.outbox.last_seq(),
        outbox_ack_seq: ipc.outbox.ack_seq().unwrap_or(0),
        router_addr: ipc.router_addr.clone(),
        managed_agents,
    }
}

fn ok(s: Status) -> Value {
    let mut v = serde_json::to_value(s).unwrap();
    v.as_object_mut().unwrap().insert("ok".into(), true.into());
    v
}

fn err(code: &str, message: &str) -> Value {
    json!({"ok": false, "error": ErrorBody { code: code.into(), message: message.into(), detail: None }})
}

async fn write_line(w: &mut (impl AsyncWriteExt + Unpin), v: &Value) -> Result<()> {
    let mut s = v.to_string();
    s.push('\n');
    w.write_all(s.as_bytes()).await?;
    Ok(())
}
