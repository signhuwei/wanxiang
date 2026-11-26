//! 本机 IPC：按行分隔的 JSON 协议，Unix 走 socket、Windows 走具名管道，见 `onex_core::transport`
//! 和 `onex_core::ipc`。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use onex_core::ipc::{ArtifactProgress, ErrorBody, ManagedAgent, Request, Status};
use onex_core::transport::{self, Connection, Listener};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::credentials::{CredentialStore, DeviceCredentials, HistoryIdentity, HistoryScope};
use crate::desktop_launch::DeepSeekModel;
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
    preparing: std::sync::Mutex<PreparationSlot>,
    download_failed: std::sync::Mutex<HashMap<String, String>>,
    desktop_tasks: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

struct Running {
    agent: String,
    stop: CancellationToken,
    code: Arc<std::sync::Mutex<Option<i32>>>,
    capture: Option<tokio::task::JoinHandle<()>>,
    session_id: String,
    token: String,
    search: Option<SearchAccess>,
}

struct SearchAccess {
    capability: String,
    releases: Vec<String>,
    sessions: HashMap<String, String>,
}

#[derive(Clone)]
struct Preparation {
    agent: String,
    release_id: Option<String>,
    progress: Option<ArtifactProgress>,
}

#[derive(Default)]
struct PreparationSlot {
    current: Option<Preparation>,
    stopping: bool,
}

struct Preparing<'a>(&'a std::sync::Mutex<PreparationSlot>);

impl Drop for Preparing<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().current = None;
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
            desktop_tasks: Default::default(),
        }
    }

    fn reserve_preparation(&self, agent: &str) -> bool {
        let mut preparing = self.preparing.lock().unwrap();
        if preparing.stopping || preparing.current.is_some() {
            return false;
        }
        preparing.current = Some(Preparation { agent: agent.to_owned(), release_id: None, progress: None });
        true
    }

    fn try_prepare(&self, agent: &str) -> Option<Preparing<'_>> {
        self.reserve_preparation(agent).then(|| Preparing(&self.preparing))
    }

    fn progress(&self, update: ArtifactProgress) {
        if let Some(preparation) = self.preparing.lock().unwrap().current.as_mut() {
            preparation.progress = Some(update);
        }
    }

    fn bind_preparation(&self, release: &str) {
        if let Some(preparation) = self.preparing.lock().unwrap().current.as_mut() {
            preparation.release_id = Some(release.to_owned());
        }
    }

    fn has_previous_cli(&self) -> bool {
        let Ok(entries) = std::fs::read_dir(self.home.join("run")) else { return false };
        let current = self.running.lock().unwrap();
        entries.flatten().any(|entry| {
            entry.file_name().to_str().is_some_and(|id| {
                crate::launch::is_generated_launch_id(id)
                    && !current.contains_key(id)
                    && onex_core::run_lock::is_active(&entry.path())
            })
        })
    }

    fn has_open_agents(&self) -> bool {
        if !self.running.lock().unwrap().is_empty() {
            return true;
        }
        self.has_previous_cli()
    }

    fn stop_preparations_when_idle(&self) -> bool {
        let mut preparing = self.preparing.lock().unwrap();
        if preparing.current.is_some()
            || self.has_open_agents()
            || self.desktop_tasks.lock().unwrap().iter().any(|task| !task.is_finished())
        {
            return false;
        }
        #[cfg(target_os = "macos")]
        if let Some(devices) = self.home.parent().filter(|path| path.ends_with("devices")) {
            match onex_core::daemon::macos_managed_processes_alive(devices) {
                Ok(false) => {}
                Ok(true) => return false,
                Err(error) => {
                    warn!(%error, "cannot verify that macOS managed agents have exited");
                    return false;
                }
            }
        }
        preparing.stopping = true;
        true
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
                    let socket = path.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle(conn, &ipc, &socket).await {
                            warn!(error = %format!("{e:#}"), "ipc connection");
                        }
                    });
                }
                Err(e) => warn!(error = %e, "ipc accept"),
            }
        }
    }
    if let Some(ctx) = &ipc.launch {
        let mut tasks = std::mem::take(&mut *ctx.desktop_tasks.lock().unwrap());
        for launch in ctx.running.lock().unwrap().values_mut() {
            if let Some(capture) = launch.capture.take() {
                launch.stop.cancel();
                tasks.push(capture);
            }
        }
        let joining = async {
            for task in tasks {
                let _ = task.await;
            }
        };
        if tokio::time::timeout(std::time::Duration::from_secs(5), joining).await.is_err() {
            warn!("agent shutdown did not finish; outstanding sessions will recover after restart");
        }
    }
    transport::cleanup(&path);
}

async fn handle(stream: Connection, ipc: &Arc<Ipc>, socket: &Path) -> Result<()> {
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
        let _identity = if matches!(
            request,
            Ok(Request::Login { .. }
                | Request::ResumeDevice { .. }
                | Request::Logout
                | Request::LogoutDevice { .. }
                | Request::ShutdownWhenIdle { .. }
                | Request::Shutdown)
        ) {
            Some(ipc.identity_transition.lock().await)
        } else {
            None
        };
        if ipc.shutdown.is_cancelled() {
            return Ok(());
        }
        let (reply, stop) = match request {
            Ok(req) => dispatch(req, ipc, socket).await,
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

async fn dispatch(req: Request, ipc: &Arc<Ipc>, socket: &Path) -> (Value, bool) {
    match req {
        Request::Status => (ok(status(ipc)), false),
        Request::Login { token, server, device_id } => (login(ipc, token, server, device_id), false),
        Request::ResumeDevice { server, session_token } => resume_device(ipc, &server, &session_token).await,
        Request::Logout => logout(ipc),
        Request::LogoutDevice { device_id } => {
            if ipc.state.expected_device_id.read().unwrap().as_ref() != Some(&device_id) {
                (err("conflict", "本机当前登录设备已变化"), false)
            } else {
                logout(ipc)
            }
        }
        // 只给公钥，私钥不出 daemon
        Request::DeviceInfo => {
            (json!({"ok": true, "public_key": ipc.state.device_key.public_b64(), "server_url": ipc.server_url}), false)
        }
        Request::Launch { agent, program, cwd, env, model, agent_version } => (
            launch(ipc, socket, &agent, program.as_deref(), &cwd, &env, model.as_deref(), agent_version.as_deref())
                .await,
            false,
        ),
        Request::Download { agent } => (start_download(ipc, &agent), false),
        Request::HostedSearch { launch_id, capability, release_id, query, limit, call_key } => {
            (hosted_search(ipc, &launch_id, &capability, &release_id, &query, limit, &call_key).await, false)
        }
        Request::LaunchDone { launch_id, exit_code } => {
            let _identity = ipc.identity_transition.lock().await;
            let Some(ctx) = &ipc.launch else { return (err("invalid", "这个 onexd 不支持启动 Agent"), false) };
            let launch = {
                let mut running = ctx.running.lock().unwrap();
                let Some(launch) = running.get(&launch_id) else {
                    // A terminal from before a daemon restart can still close normally.
                    if crate::launch::is_generated_launch_id(&launch_id)
                        && !onex_core::run_lock::is_active(&ctx.home.join("run").join(&launch_id))
                    {
                        let _ = crate::launch::finish(&ctx.home, &launch_id);
                    }
                    return (json!({"ok": true}), false);
                };
                if crate::state::is_desktop_agent(&launch.agent) {
                    // The desktop supervisor drains the original journal before closing.
                    launch.stop.cancel();
                    return (json!({"ok": true}), false);
                }
                running.remove(&launch_id).unwrap()
            };
            info!(%launch_id, ?exit_code, "agent exited");
            ipc.state.launch_tokens.write().unwrap().remove(&launch.token);
            ipc.state.claude_history.write().unwrap().remove(&launch.token);
            ipc.state.codex_history.write().unwrap().remove(&launch.token);
            ipc.state.kimi_history.write().unwrap().remove(&launch.token);
            ipc.state.desktop_sessions.stop(&launch.token);
            ipc.state.workbuddy_turns.stop(&launch.token);
            *launch.code.lock().unwrap() = exit_code;
            launch.stop.cancel();
            if let Some(capture) = launch.capture
                && let Err(error) = capture.await
            {
                warn!(%launch_id, %error, "final native transcript capture stopped");
            }
            ipc.state.active_session.write().unwrap().take_if(|s| *s == launch.session_id);
            match crate::launch::finish(&ctx.home, &launch_id) {
                Ok(()) => (json!({"ok": true}), false),
                Err(e) => (err("invalid", &format!("{e:#}")), false),
            }
        }
        Request::ShutdownWhenIdle { expected_pid } => {
            if expected_pid.is_some_and(|pid| pid != std::process::id()) {
                return (err("conflict", "后台进程已改变"), false);
            }
            if ipc.state.upstream.lock().unwrap().inflight != 0
                || ipc.state.lease.has_active_requests()
                || !ipc.launch.as_ref().is_none_or(LaunchCtx::stop_preparations_when_idle)
            {
                return (err("agents_running", "等待受管 Agent、下载及请求结束后再更新后台服务"), false);
            }
            info!("idle upgrade shutdown requested via ipc");
            (json!({"ok": true}), true)
        }
        Request::Shutdown => {
            info!("shutdown requested via ipc");
            (json!({"ok": true}), true)
        }
    }
}

async fn resume_device(ipc: &Ipc, origin: &str, session: &str) -> (Value, bool) {
    if ipc.state.token.borrow().is_some() && ipc.state.phase() != crate::state::Phase::Unauthenticated {
        return (err("conflict", "请先退出当前 OneX 账号"), false);
    }
    if ipc.launch.as_ref().is_some_and(LaunchCtx::has_open_agents) {
        return (err("agents_running", "请关闭当前账号的受管 Agent 后重新登录"), false);
    }
    let Some(store) = &ipc.credentials else { return (json!({"ok":true,"resumed":false}), false) };
    let Some(server) = ipc.server_url.as_deref().and_then(normalize_origin) else {
        return (err("invalid", "缺少 OneX Server 地址"), false);
    };
    if normalize_origin(origin).as_deref() != Some(&server) {
        return (err("invalid", "登录地址与本机服务配置不一致"), false);
    }
    let current = if ipc.state.token.borrow().is_some() {
        let Some(device_id) = ipc.state.expected_device_id.read().unwrap().clone() else {
            return (err("conflict", "请先退出当前 OneX 账号"), false);
        };
        Some(HistoryIdentity { device_id, device_key: ipc.state.device_key.bytes_for_keychain() })
    } else {
        None
    };
    match crate::device_history::resume(store.as_ref(), &server, session, current).await {
        Ok(None) => {
            if ipc.state.token.borrow().is_some() {
                return (err("conflict", "请先退出当前 OneX 账号"), false);
            }
            (json!({"ok":true,"resumed":false}), false)
        }
        Ok(Some(credentials)) => {
            if let Err(error) = store.save(&credentials) {
                warn!(%error, "could not save the recovered device");
                return (err("history_unavailable", "无法保存会话恢复所需的设备身份"), false);
            }
            (json!({"ok":true,"resumed":true,"device_id":credentials.device_id}), true)
        }
        Err(error) => {
            if error.downcast_ref::<reqwest::Error>().and_then(reqwest::Error::status)
                == Some(reqwest::StatusCode::NOT_FOUND)
                && ipc.state.token.borrow().is_some()
            {
                return (err("conflict", "本机设备无法与当前登录账号匹配"), false);
            }
            warn!(%error, "could not authenticate the retained history identity");
            (err("history_unavailable", "暂时无法恢复当前账号的本机会话"), false)
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
        ipc.state.replace_token(Some(token));
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
    ipc.state.replace_token(Some(token));
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
    if ipc.launch.as_ref().is_some_and(LaunchCtx::has_open_agents) {
        return (err("agents_running", "请关闭当前账号的受管 Agent 后退出"), false);
    }
    if let Some(store) = &ipc.credentials {
        if let Err(error) = preserve_logout_history(ipc, store.as_ref()) {
            warn!(%error, "could not retain history before logging out");
            return (err("history_unavailable", "无法保存会话恢复所需的设备身份"), false);
        }
        if store.clear().is_err() {
            return (err("internal", "无法清除系统钥匙串里的设备身份"), false);
        }
    }
    info!("device logged out via ipc; shutting down for a clean restart");
    if let Err(e) = ipc.state.lease.cutoff("logout", None) {
        warn!(error = %format!("{e:#}"), "could not persist logout cutoff");
    }
    *ipc.state.config.write().unwrap() = Default::default();
    ipc.state.secrets.write().unwrap().clear();
    ipc.state.launch_tokens.write().unwrap().clear();
    ipc.state.claude_history.write().unwrap().clear();
    ipc.state.codex_history.write().unwrap().clear();
    ipc.state.kimi_history.write().unwrap().clear();
    ipc.state.desktop_sessions.clear();
    ipc.state.workbuddy_turns.clear();
    ipc.state.active_session.write().unwrap().take();
    ipc.state.replace_token(None);
    (json!({"ok": true}), true)
}

fn preserve_logout_history(ipc: &Ipc, store: &dyn CredentialStore) -> Result<()> {
    let Some(device_id) = ipc.state.expected_device_id.read().unwrap().clone() else { return Ok(()) };
    let Some(server) = ipc.server_url.as_deref().and_then(normalize_origin) else { return Ok(()) };
    let identity = HistoryIdentity { device_id, device_key: ipc.state.device_key.bytes_for_keychain() };
    let conn = ipc.state.conn.lock().unwrap();
    if let (Some(device), Some(tenant_id), Some(user_id)) = (&conn.device_id, &conn.tenant_id, &conn.user_id)
        && device == &identity.device_id
    {
        return store.save_history(&HistoryScope { server: &server, tenant_id, user_id }, &identity);
    }
    drop(conn);
    let mut pending = store.load_unscoped_history(&server)?;
    if !pending.iter().any(|known| known.device_id == identity.device_id) {
        // Leave headroom under the Windows credential record size limit.
        anyhow::ensure!(pending.len() < 8, "too many device keys awaiting account verification");
        pending.push(identity);
        store.save_unscoped_history(&server, &pending)?;
    }
    Ok(())
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

async fn hosted_search(
    ipc: &Ipc,
    launch_id: &str,
    capability: &str,
    release: &str,
    query: &str,
    limit: u8,
    key: &str,
) -> Value {
    use reqwest::StatusCode;
    use std::time::Duration;
    use subtle::ConstantTimeEq;

    if !crate::hosted_search::input_valid(query, limit)
        || key.len() != 64
        || !key.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return err("invalid", "查询词或结果数量无效");
    }
    let (Some(ctx), Some(origin)) = (&ipc.launch, &ipc.server_url) else {
        return err("unauthenticated", "没有可用的 OneX 服务");
    };
    let Some(device_token) = ipc.state.token.borrow().clone() else {
        return err("unauthenticated", "请重新登录 OneX");
    };
    let (agent, model_capability, stop) = {
        let running = ctx.running.lock().unwrap();
        let Some(launch) = running.get(launch_id).filter(|launch| {
            launch.search.as_ref().is_some_and(|search| {
                bool::from(search.capability.as_bytes().ct_eq(capability.as_bytes()))
                    && search.releases.iter().any(|id| id == release)
            })
        }) else {
            return err("forbidden", "当前受管启动没有该搜索工具权限");
        };
        (launch.agent.clone(), launch.token.clone(), launch.stop.clone())
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        {
            let cfg = ipc.state.config.read().unwrap();
            if cfg.policy_blocked
                || cfg.balance_stopped()
                || !crate::hosted_search::select(&cfg, &agent).any(|r| r.id == release)
            {
                return err("forbidden", "当前能力合约已停止搜索授权");
            }
        }
        if stop.is_cancelled() || ipc.shutdown.is_cancelled() {
            return err("forbidden", "受管启动已结束");
        }
        let session = {
            let launches = ipc.state.launch_tokens.read().unwrap();
            let Some(binding) = launches.get(&model_capability) else {
                return err("forbidden", "受管启动已结束");
            };
            match &binding.first_native_session {
                Some(pending) => pending.borrow().clone(),
                None => Some(binding.session_id.clone()),
            }
        };
        if let Some(session) = session {
            let session = {
                let mut running = ctx.running.lock().unwrap();
                let Some(search) = running.get_mut(launch_id).and_then(|launch| launch.search.as_mut()) else {
                    return err("forbidden", "受管启动已结束");
                };
                if search.sessions.len() >= 65536 && !search.sessions.contains_key(key) {
                    return err("conflict", "受管启动的搜索调用已达上限");
                }
                search.sessions.entry(key.to_owned()).or_insert(session).clone()
            };
            let result = tokio::select! {
                _ = stop.cancelled() => return err("forbidden", "受管启动已结束"),
                _ = ipc.shutdown.cancelled() => return err("forbidden", "受管启动已结束"),
                result = crate::hosted_search::forward(&ctx.http, origin, &device_token, release, key, &session, query, limit) => result,
            };
            match result {
                Ok((StatusCode::OK, value)) if value["results"].is_array() => {
                    return json!({"ok":true,"results":value["results"]});
                }
                Ok((StatusCode::NOT_FOUND, value))
                    if value["error"]["detail"]["reason"] == "session_not_registered" => {}
                Ok((StatusCode::OK, value)) if value["receipt"].is_object() => {
                    return json!({"ok":true,"receipt":value["receipt"]});
                }
                Ok((StatusCode::ACCEPTED, _)) => return err("conflict", "搜索仍在结算，请勿新建调用"),
                Ok((StatusCode::FORBIDDEN, value)) => {
                    let message = match value["error"]["detail"]["reason"].as_str() {
                        Some("balance") => "橡皮余额不足，未执行搜索",
                        Some("quota") => "可用配额不足，未执行搜索",
                        _ => "当前能力合约不允许搜索",
                    };
                    return err("forbidden", message);
                }
                Ok((StatusCode::CONFLICT, value)) if value["error"]["detail"]["reason"] == "search_lease_required" => {
                    return err("conflict", "还没有可用于搜索的商业租约");
                }
                Ok((StatusCode::BAD_GATEWAY, _)) => return err("upstream_error", "搜索未完成"),
                _ => return err("upstream_error", "未能确认搜索结果，请勿自动重试这笔调用"),
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return err("conflict", "原生会话尚未登记，暂不能使用搜索");
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

async fn launch(
    ipc: &Ipc,
    socket: &Path,
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
        let desktop_supported = cfg!(all(target_os = "macos", target_arch = "aarch64"))
            || (agent == "deepseek-desktop"
                && ipc.server_url.as_deref().is_some_and(crate::desktop_bundle::windows_deepseek_available));
        LAUNCHABLE_AGENTS.contains(&agent) && (!desktop || desktop_supported)
    }) else {
        return err("agent_not_allowed", &format!("OneX 暂不支持启动 {agent}"));
    };
    {
        let pool = ipc.state.pool_launch_config();
        let config = ipc.state.config.read().unwrap();
        let config = pool.as_ref().unwrap_or(&config);
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
    // CLI agents (non-desktop) must have a valid working directory before launch.
    // Desktop agents have an in-app directory picker; CLI agents do not.
    if !desktop {
        let cwd_path = std::path::Path::new(cwd);
        if cwd.is_empty() || !cwd_path.is_absolute() || !cwd_path.is_dir() {
            return err("cwd_required", "请先选择工作目录再启动 Agent");
        }
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
    let (approved, tool_releases, search_releases) = {
        let pool = ipc.state.pool_launch_config();
        let cfg = ipc.state.config.read().unwrap();
        let cfg = pool.as_ref().unwrap_or(&cfg);
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
        let searches = crate::hosted_search::select(&cfg, agent).cloned().collect::<Vec<_>>();
        (approved, tools, searches)
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
                let stage = error.stage();
                let reason_code = error.reason_code();
                let http_status = error.http_status();
                warn!(agent, stage, reason_code, http_status = http_status.unwrap_or(0), "managed tool bundle resolution failed");
                return json!({ "ok": false, "error": {
                    "code": "upstream_error", "message": "无法下载或校验受管工具制品",
                    "detail": { "stage": stage, "reason_code": reason_code, "http_status": http_status }
                }});
            }
        }
    };
    let resolved_program = if let Some(release) = approved.as_ref().filter(|_| desktop) {
        match crate::desktop_bundle::executable(release, resolved_program, ipc.server_url.as_deref()).await {
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
    if ctx.has_previous_cli() {
        return err("agents_running", "请先关闭 Edge 重启前仍在运行的受管 Agent");
    }
    let program = resolved_program.to_string_lossy().into_owned();
    let program = program.as_str();
    let tools_current = |cfg: &crate::state::ConfigSnapshot| {
        crate::tools::select(&cfg.tools, agent, os, arch).into_iter().eq(tool_releases.iter())
            && crate::hosted_search::select(cfg, agent).eq(search_releases.iter())
    };
    // 别名候选：精确名字的路由；通配路由用它固定的上游模型名（server 的 MVP seed 是 `*` → Qwen3.8-27B）
    let (models, routable, deepseek_models, model_limits, model_pinned) = {
        let pool = ipc.state.pool_launch_config();
        let cfg = ipc.state.config.read().unwrap();
        let cfg = pool.as_ref().unwrap_or(&cfg);
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
        let deepseek_models = if agent == "deepseek-desktop" { deepseek_model_choices(&cfg) } else { Vec::new() };
        let compatible = || cfg.routes.iter().filter(|route| protocol.accepts_upstream(&route.protocol));
        let exact = compatible().filter(|route| !route.model.ends_with('*')).map(|route| route.model.as_str());
        let wildcard = compatible().filter_map(|route| {
            let prefix = route.model.strip_suffix('*')?;
            route.upstream_model.as_deref().filter(|model| model.starts_with(prefix))
        });
        let mut seen = HashSet::new();
        let (models, routable) = if agent == "deepseek-desktop" {
            (
                deepseek_models.iter().map(|item| item.name.clone()).collect::<Vec<_>>(),
                model.is_some_and(|name| deepseek_models.iter().any(|item| item.name == name)),
            )
        } else {
            (
                exact
                    .chain(wildcard)
                    .filter(|name| protocol.select_agent_route(cfg, name, Some(agent)).is_some())
                    .filter(|name| seen.insert(*name))
                    .map(str::to_owned)
                    .collect(),
                model.is_some_and(|name| protocol.select_agent_route(cfg, name, Some(agent)).is_some()),
            )
        };
        let model_limits = if pool.is_none() && matches!(agent, "codex" | "kimi-code") {
            models
                .iter()
                .map(String::as_str)
                .chain(model)
                .filter_map(|name| {
                    let route = protocol.select_agent_route(cfg, name, Some(agent))?;
                    cfg.model_limits.get(&route.model_id).copied().map(|limits| (name.to_owned(), limits))
                })
                .collect()
        } else {
            BTreeMap::new()
        };
        (models, routable, deepseek_models, model_limits, pool.is_some())
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
                deepseek_models: &deepseek_models,
                tools: &installed_tools,
            },
            approved.as_ref().expect("desktop launch always has an approved release"),
            claude_engine.as_ref().map(|(path, engine)| (path.as_path(), *engine)),
            &tool_releases,
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
    let prepared = if agent == "kimi-code" {
        let include_history = !ctx.running.lock().unwrap().values().any(|launch| launch.agent == agent);
        if model_pinned {
            crate::kimi_launch::prepare_kimi_code_with_history(&r, include_history)
        } else {
            crate::kimi_launch::prepare_kimi_code_with_model_choices(&r, include_history, &models, &model_limits)
        }
    } else if agent == "codex" && !model_pinned {
        crate::codex_launch::prepare_with_models(&r, &models, &model_limits)
    } else if agent == "claude-code" && !model_pinned {
        crate::launch::prepare_with_model_choices(&r, &models)
    } else {
        crate::launch::prepare(&r)
    };
    match prepared {
        Ok(mut l) => {
            let search = (!search_releases.is_empty()).then(|| SearchAccess {
                capability: crate::id::token(),
                releases: search_releases.iter().map(|r| r.id.clone()).collect(),
                sessions: HashMap::new(),
            });
            let search_config = search.as_ref().map(|access| crate::tools::SearchLaunch {
                socket,
                capability: &access.capability,
                releases: &search_releases,
            });
            if let Err(error) = crate::tools::apply(agent, &mut l, &installed_tools, search_config) {
                let _ = crate::launch::finish(&ctx.home, &l.launch_id);
                warn!(agent, %error, "could not prepare managed tools");
                return err("invalid", "无法加载受管工具");
            }
            let history_lease = if agent == "codex" {
                match crate::codex_launch::restore_history(&l, &ctx.home) {
                    Ok(lease) => Some(lease),
                    Err(error) => {
                        let _ = crate::launch::finish(&ctx.home, &l.launch_id);
                        warn!(agent, %error, "could not restore the native conversation directory");
                        return err("history_unavailable", "无法读取受管 Agent 的本机会话");
                    }
                }
            } else {
                None
            };
            let pool = ipc.state.pool_launch_config();
            let cfg = ipc.state.config.read().unwrap();
            let cfg = pool.as_ref().unwrap_or(&cfg);
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
                    approved_model: pool.is_some().then(|| model.clone()),
                    session_id: l.session_id.clone(),
                    agent: agent.into(),
                    release_id: approved.as_ref().map(|release| release.id.clone()),
                    first_native_session,
                },
            );
            let capture = if let Some((native, first_session)) = native {
                let capture = crate::native_capture::LaunchCapture::new(
                    s,
                    ipc.state.clone(),
                    ipc.outbox.clone(),
                    local_token.clone(),
                    first_session,
                );
                if matches!(native, crate::native_capture::Agent::Kimi) {
                    ipc.state
                        .kimi_history
                        .write()
                        .unwrap()
                        .insert(local_token.clone(), Arc::new(capture.kimi_history(&ctx.home)));
                } else {
                    ipc.state
                        .codex_history
                        .write()
                        .unwrap()
                        .insert(local_token.clone(), Arc::new(capture.codex_history()));
                }
                tokio::spawn(capture.run(native, stop.clone(), code.clone(), history_lease))
            } else {
                let history = Arc::new(crate::capture::ClaudeHistory::new(s.clone(), ipc.outbox.clone()));
                ipc.state.claude_history.write().unwrap().insert(local_token.clone(), history.clone());
                tokio::spawn(crate::capture::Capture::new(s, ipc.outbox.clone()).run(
                    stop.clone(),
                    code.clone(),
                    history,
                ))
            };
            ctx.running.lock().unwrap().insert(
                l.launch_id.clone(),
                Running {
                    agent: agent.to_owned(),
                    stop,
                    code,
                    capture: Some(capture),
                    session_id: l.session_id.clone(),
                    token: local_token,
                    search,
                },
            );
            *ipc.state.active_session.write().unwrap() = Some(l.session_id.clone());
            json!({"ok": true, "launch_id": l.launch_id, "session_id": l.session_id, "program": l.program,
                "args": l.args, "env": l.env, "cwd": l.cwd, "model": model, "run_dir": l.run_dir})
        }
        Err(e) => err("invalid", &format!("无法准备启动：{e:#}")),
    }
}

pub(crate) fn deepseek_model_choices(config: &crate::state::ConfigSnapshot) -> Vec<DeepSeekModel> {
    let mut names = HashSet::new();
    let now = crate::outbox::now_ms();
    let policy_max_output = config.policy.as_ref().and_then(|policy| policy.runtime.max_output);
    config
        .routes
        .iter()
        .filter_map(|route| {
            if !matches!(route.protocol.as_str(), "openai_chat" | "anthropic") {
                return None;
            }
            let name = match route.model.strip_suffix('*') {
                Some(prefix) => route.upstream_model.as_deref().filter(|name| name.starts_with(prefix))?,
                None => &route.model,
            };
            if !names.insert(name) {
                return None;
            }
            [AgentProtocol::Chat, AgentProtocol::Messages].into_iter().find_map(|api| {
                let route = api.select_agent_route(config, name, Some("deepseek-desktop"))?;
                crate::pricing::pick_rate(&config.rates, &route.model_id, now)?;
                Some(DeepSeekModel::new(
                    name.to_owned(),
                    api,
                    crate::desktop_sessions::accepts_images(route),
                    config.model_limits.get(&route.model_id),
                    policy_max_output,
                ))
            })
        })
        .collect()
}

async fn start_desktop(
    ipc: &Ipc,
    ctx: &LaunchCtx,
    request: crate::desktop_launch::Request<'_>,
    release: &onex_core::ws::AgentRelease,
    engine_archive: Option<(&Path, crate::desktop_bundle::RuntimeBundle)>,
    tool_releases: &[onex_core::ws::ToolRelease],
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
    {
        let pool = ipc.state.pool_launch_config();
        let config = ipc.state.config.read().unwrap();
        let config = pool.as_ref().unwrap_or(&config);
        let (os, arch) = (onex_core::ipc::os_name(), onex_core::ipc::arch_name());
        if config.policy_blocked
            || config.balance_stopped()
            || crate::managed_runtime::select(&config.agents, request.agent, os, arch).ok() != Some(release)
            || !crate::tools::select(&config.tools, request.agent, os, arch).into_iter().eq(tool_releases.iter())
        {
            let _ = crate::launch::finish(&ctx.home, &launch.launch_id);
            return err("agent_not_allowed", "桌面 Agent 或受管工具授权已变化，请重试");
        }
    }
    #[cfg(windows)]
    let (job, mut protocol) = if request.agent == "deepseek-desktop" {
        use crate::{windows_desktop_job::DesktopJob, windows_dsh_protocol::DshProtocolGuard};

        match DesktopJob::new()
            .map_err(anyhow::Error::from)
            .and_then(|job| DshProtocolGuard::acquire(&launch.program).map(|protocol| (job, protocol)))
        {
            Ok((job, protocol)) => (Some(job), Some(protocol)),
            Err(error) => {
                let _ = crate::launch::finish(&ctx.home, &launch.launch_id);
                warn!(%error, "could not prepare Windows desktop launch isolation");
                return err("conflict", "无法准备 DeepSeek 窗口及协议关联保护");
            }
        }
    } else {
        (None, None)
    };
    let workbuddy_capture = if request.agent == "workbuddy" {
        match crate::workbuddy_capture::Capture::new(
            &launch.config_dir,
            &launch.cwd,
            request.owner,
            &release.version,
            request.model,
            request.token,
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
    if request.agent == "deepseek-desktop" {
        ipc.state.desktop_sessions.set_deepseek_models(request.token, request.deepseek_models);
    }
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
    #[cfg(target_os = "macos")]
    let manage_process_group = request.agent == "deepseek-desktop";
    #[cfg(target_os = "macos")]
    if manage_process_group {
        command.process_group(0);
    }
    let spawned: std::io::Result<_> = async {
        let child = command.spawn()?;
        #[cfg(windows)]
        if let Some(job) = &job
            && let Err(error) = job.attach(&child)
        {
            let mut child = child;
            let _ = child.kill().await;
            return Err(error);
        }
        Ok(child)
    }
    .await;
    let mut child = match spawned {
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
            capture: None,
            session_id: launch.session_id,
            token: token.clone(),
            search: None,
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
    let supervisor = tokio::spawn(async move {
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
                        outbox.clone(),
                        capture_stop.clone(),
                    ))
                } else {
                    tokio::spawn(crate::native_capture::capture_codex_desktop(
                        session,
                        device,
                        outbox.clone(),
                        capture_stop.clone(),
                    ))
                }
            })
        };
        #[cfg(not(target_os = "macos"))]
        let manage_process_group = false;
        if manage_process_group {
            #[cfg(target_os = "macos")]
            if let Err(error) = crate::macos_desktop_job::wait(&mut child, &stop).await {
                warn!(%error, "macOS DeepSeek process group cleanup did not finish");
                let _ = child.kill().await;
            }
        } else {
            tokio::select! {
                _ = child.wait() => {}
                _ = stop.cancelled() => { let _ = child.kill().await; }
            }
        }
        #[cfg(windows)]
        {
            if let Some(job) = job
                && let Err(error) = job.stop().await
            {
                warn!(%error, "Windows desktop child process cleanup did not finish");
            }
            if let Some(protocol) = protocol.as_mut()
                && let Err(error) = protocol.restore()
            {
                warn!(%error, "could not restore the original DeepSeek protocol association");
            }
        }
        let exited_at = crate::outbox::now_ms();
        capture_stop.cancel();
        if let Some(capture) = capture {
            let _ = capture.await;
        }
        state.desktop_sessions.stop(&token);
        state.workbuddy_turns.stop(&token);
        let owner = crate::outbox::desktop_launch_key(&token);
        if let Err(error) = outbox.close_desktop_sessions(Some(&owner), Some(exited_at)) {
            warn!(%error, "could not persist desktop session endings");
        }
        drop(runtime);
        let _ = crate::launch::finish(&home, &id);
        running.lock().unwrap().remove(&id);
        info!(launch_id = %id, "desktop process exited");
    });
    let mut tasks = ctx.desktop_tasks.lock().unwrap();
    tasks.retain(|task| !task.is_finished());
    tasks.push(supervisor);
    json!({"ok":true, "launch_id":launch_id, "desktop":true})
}

fn status(ipc: &Ipc) -> Status {
    let conn = ipc.state.conn.lock().unwrap().clone();
    let up = ipc.state.upstream.lock().unwrap().clone();
    let entry = |e: Option<(String, String, i64)>| {
        e.map(|(outcome, request_id, at)| json!({"outcome": outcome, "request_id": request_id, "at": format_ms(at)}))
    };
    let (agent_cache, config_revision, capability_contract, releases, policy, notices, policy_blocked) = {
        let pool = ipc.state.pool_launch_config();
        let config = ipc.state.config.read().unwrap();
        let config = pool.as_ref().unwrap_or(&config);
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
            let preparing = ctx.preparing.lock().unwrap().current.clone();
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
        version: crate::BUILD_VERSION.into(),
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

#[cfg(test)]
mod upgrade_tests {
    use super::*;

    #[tokio::test]
    async fn upgrade_shutdown_keeps_live_agents_and_waits_for_idle() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("onexd.sock");
        let shutdown = CancellationToken::new();
        let home = dir.path().join("devices").join("a".repeat(32));
        std::fs::create_dir_all(&home).unwrap();
        let launch = LaunchCtx::new(home.clone(), reqwest::Client::new());
        let service = Arc::new(Ipc {
            state: Arc::new(State::default()),
            outbox: Arc::new(Outbox::open(&dir.path().join("outbox.sqlite")).unwrap()),
            router_addr: None,
            server_url: None,
            launch: Some(launch),
            credentials: None,
            identity_transition: Default::default(),
            shutdown: shutdown.clone(),
        });
        let ctx = service.launch.as_ref().unwrap();
        let listener = bind(&socket).await.unwrap();
        let daemon = tokio::spawn(serve(listener, socket.clone(), service.clone()));
        let request = || onex_core::daemon::exchange(&socket, &Request::ShutdownWhenIdle { expected_pid: None });
        let wrong_pid = Request::ShutdownWhenIdle { expected_pid: Some(0) };
        assert_eq!(onex_core::daemon::exchange(&socket, &wrong_pid).await.unwrap()["error"]["code"], "conflict");
        #[cfg(target_os = "macos")]
        assert_eq!(
            onex_core::daemon::macos_shutdown_when_idle(&socket, 0).await.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            onex_core::daemon::macos_shutdown(&socket, 0).await.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert!(!shutdown.is_cancelled());

        for agent in ["claude-code", "deepseek-desktop"] {
            let stop = shutdown.child_token();
            ctx.running.lock().unwrap().insert(
                agent.into(),
                Running {
                    agent: agent.into(),
                    stop: stop.clone(),
                    code: Default::default(),
                    capture: None,
                    session_id: format!("session-{agent}"),
                    token: format!("token-{agent}"),
                    search: None,
                },
            );
            assert_eq!(request().await.unwrap()["error"]["code"], "agents_running");
            assert!(!stop.is_cancelled());
            assert!(ctx.running.lock().unwrap().remove(agent).is_some());
        }

        let run = home.join("run").join(crate::id::new("lch"));
        std::fs::create_dir_all(&run).unwrap();
        let previous_cli = onex_core::run_lock::claim(&run).unwrap();
        assert_eq!(request().await.unwrap()["error"]["code"], "agents_running");
        drop(previous_cli);

        {
            let _download = ctx.try_prepare("codex").unwrap();
            assert_eq!(request().await.unwrap()["error"]["code"], "agents_running");
        }
        let finishing = CancellationToken::new();
        ctx.desktop_tasks.lock().unwrap().push(tokio::spawn(finishing.clone().cancelled_owned()));
        assert_eq!(request().await.unwrap()["error"]["code"], "agents_running");
        finishing.cancel();
        let capture = ctx.desktop_tasks.lock().unwrap().pop().unwrap();
        capture.await.unwrap();

        service
            .state
            .lease
            .grant(&onex_core::ws::Lease {
                id: "lease-message".into(),
                re: None,
                lease_id: "lease-in-flight".into(),
                expires_at: format_ms(crate::outbox::now_ms() + 180_000),
                budget_milli: 100,
                model_budgets: Default::default(),
                commerce_plan_id: None,
                seq: 1,
            })
            .unwrap();
        let ticket = service.state.lease.admit(0).unwrap();
        assert_eq!(request().await.unwrap()["error"]["code"], "agents_running");
        drop(ticket);

        service.state.upstream.lock().unwrap().inflight = 1;
        assert_eq!(request().await.unwrap()["error"]["code"], "agents_running");
        service.state.upstream.lock().unwrap().inflight = 0;

        #[cfg(target_os = "macos")]
        {
            let bundle = home.join("agents/deepseek-desktop/releases/test/DeepSeek Harness.app/Contents/MacOS");
            std::fs::create_dir_all(&bundle).unwrap();
            let executable = bundle.join("DeepSeek Harness");
            std::fs::copy("/bin/sleep", &executable).unwrap();
            let mut backend = tokio::process::Command::new(&executable).arg("60").kill_on_drop(true).spawn().unwrap();
            assert_eq!(request().await.unwrap()["error"]["code"], "agents_running");
            assert!(!shutdown.is_cancelled());
            assert!(backend.try_wait().unwrap().is_none());
            backend.kill().await.unwrap();
        }

        #[cfg(target_os = "macos")]
        let acknowledgement = onex_core::daemon::macos_shutdown_when_idle(&socket, std::process::id()).await.unwrap();
        #[cfg(not(target_os = "macos"))]
        let acknowledgement = request().await.unwrap();
        assert_eq!(acknowledgement["ok"], true);
        assert!(ctx.try_prepare("codex").is_none());
        daemon.await.unwrap();
        assert!(shutdown.is_cancelled());
    }
}

#[cfg(test)]
mod hosted_search_tests {
    use super::*;
    use axum::{
        Json,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
    };
    use onex_core::ws::SearchTool;

    #[tokio::test]
    async fn stdio_search_uses_the_bound_session_and_replays_a_receipt() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let calls = seen.clone();
        let http = axum::Router::new().route("/v1/edge/tool-search/tool_01M7YV31G92NTSZM04NQKFV5Z7",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let calls = calls.clone();
                async move {
                    assert_eq!(headers["authorization"], "Bearer device-only");
                    let key = headers["idempotency-key"].to_str().unwrap().to_owned();
                    let mut calls = calls.lock().unwrap();
                    calls.push((key, body));
                    let receipt = json!({"call_id":calls[0].0,"status":"charged","ledger_id":"ledger-search"});
                    match calls.len() {
                        1 => (StatusCode::NOT_FOUND, Json(json!({"error":{"detail":{"reason":"session_not_registered"}}}))).into_response(),
                        2 => Json(json!({"receipt":receipt,"results":[{"url":"https://example.test","title":"Sample","snippet":"OK"}]})).into_response(),
                        _ => Json(json!({"receipt":receipt})).into_response(),
                    }
                }
            }));
        let server = tokio::spawn(async move {
            axum::serve(listener, http).await.unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("onexd.sock");
        let state = Arc::new(State::default());
        state.token.send_replace(Some("device-only".into()));
        let release = "tool_01M7YV31G92NTSZM04NQKFV5Z7";
        state.config.write().unwrap().policy = Some(crate::state::AppliedPolicy {
            summary: serde_json::from_value(
                json!({"abi":2,"tenant_id":"ten_test","user_id":"usr_test","device_id":"dev_test",
                "platform_revision":1,"policy_revision":1,"groups":[],"display":[]}),
            )
            .unwrap(),
            notices: vec![],
            balance: None,
            runtime: Default::default(),
            commerce_plan_id: Some("plan".into()),
            search_tools: vec![SearchTool {
                id: release.into(),
                name: "search".into(),
                agents: vec!["claude-code".into()],
            }],
            keys: HashMap::new(),
        });
        state.launch_tokens.write().unwrap().insert(
            "model-only".into(),
            crate::state::LaunchBinding {
                session_id: "native-one".into(),
                agent: "claude-code".into(),
                release_id: None,
                approved_model: None,
                first_native_session: None,
            },
        );
        let ctx = LaunchCtx::new(
            dir.path().into(),
            reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap(),
        );
        ctx.running.lock().unwrap().insert(
            "test-launch".into(),
            Running {
                agent: "claude-code".into(),
                stop: CancellationToken::new(),
                code: Default::default(),
                capture: None,
                session_id: "native-one".into(),
                token: "model-only".into(),
                search: Some(SearchAccess {
                    capability: "search-only".into(),
                    releases: vec![release.into()],
                    sessions: HashMap::new(),
                }),
            },
        );
        let shutdown = CancellationToken::new();
        let service = Arc::new(Ipc {
            state: state.clone(),
            outbox: Arc::new(Outbox::open(&dir.path().join("outbox.sqlite")).unwrap()),
            router_addr: None,
            server_url: Some(origin),
            launch: Some(ctx),
            credentials: None,
            identity_transition: Default::default(),
            shutdown: shutdown.clone(),
        });
        let wrong = hosted_search(&service, "test-launch", "model-only", release, "public", 3, &"0".repeat(64)).await;
        assert_eq!(wrong["error"]["code"], "forbidden");
        let ipc_listener = bind(&socket).await.unwrap();
        let daemon = tokio::spawn(serve(ipc_listener, socket.clone(), service));
        let (agent, stdio) = tokio::io::duplex(4096);
        let child = tokio::spawn(async move {
            let (reader, writer) = tokio::io::split(stdio);
            let config = crate::hosted_search::McpConfig {
                socket,
                launch_id: "test-launch".into(),
                capability: "search-only".into(),
                release_id: release.into(),
                name: "approved".into(),
            };
            crate::hosted_search::serve_stdio(&config, BufReader::new(reader), writer).await.unwrap();
        });
        let (reader, mut writer) = tokio::io::split(agent);
        let mut reader = BufReader::new(reader);
        async fn rpc(
            reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
            writer: &mut (impl tokio::io::AsyncWrite + Unpin),
            id: usize,
            method: &str,
            params: Value,
        ) -> Value {
            let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
            writer.write_all(format!("{request}\n").as_bytes()).await.unwrap();
            let mut line = String::new();
            tokio::time::timeout(std::time::Duration::from_secs(5), reader.read_line(&mut line))
                .await
                .unwrap()
                .unwrap();
            serde_json::from_str(&line).unwrap()
        }
        assert_eq!(
            rpc(&mut reader, &mut writer, 0, "initialize", json!({"protocolVersion":"2024-11-05"})).await["result"]["protocolVersion"],
            "2024-11-05"
        );
        assert_eq!(
            rpc(&mut reader, &mut writer, 1, "tools/list", json!({})).await["result"]["tools"][0]["name"],
            "search"
        );
        let params = json!({"name":"search","arguments":{"query":"public","limit":3}});
        let result = rpc(&mut reader, &mut writer, 2, "tools/call", params.clone()).await;
        assert!(result["result"]["content"][0]["text"].as_str().unwrap().contains("https://example.test"));

        // A replay keeps its original identity even after the native session binding advances.
        state.launch_tokens.write().unwrap().get_mut("model-only").unwrap().session_id = "native-two".into();
        let replay = rpc(&mut reader, &mut writer, 2, "tools/call", params.clone()).await;
        let receipt: Value = serde_json::from_str(replay["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(receipt["receipt"]["ledger_id"], "ledger-search");
        assert!(receipt.get("results").is_none());
        state.config.write().unwrap().policy.as_mut().unwrap().search_tools.clear();
        let revoked = rpc(&mut reader, &mut writer, 3, "tools/call", params).await;
        assert_eq!(revoked["result"]["isError"], true);
        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert!(calls.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(calls[0].1, json!({"session_id":"native-one","query":"public","limit":3}));
        server.abort();
        shutdown.cancel();
        child.abort();
        daemon.await.unwrap();
    }
}
