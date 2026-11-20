//! 本机 IPC：按行分隔的 JSON 协议，Unix 走 socket、Windows 走具名管道，见 `onex_core::transport`
//! 和 `onex_core::ipc`。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use onex_core::ipc::{ErrorBody, ManagedAgent, Request, Status};
use onex_core::transport::{self, Connection, Listener};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::credentials::{CredentialStore, DeviceCredentials};
use crate::outbox::Outbox;
use crate::pricing::format_ms;
use crate::state::State;

/// 一行请求的长度上限，防止本机其他进程塞大包。
const MAX_LINE: u64 = 64 * 1024;

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
    running: std::sync::Mutex<std::collections::HashMap<String, Running>>,
    preparing: tokio::sync::Mutex<()>,
}

struct Running {
    stop: CancellationToken,
    code: Arc<std::sync::Mutex<Option<i32>>>,
    session_id: String,
    token: String,
}

impl LaunchCtx {
    pub fn new(home: PathBuf, http: reqwest::Client) -> Self {
        Self { home, http, running: Default::default(), preparing: Default::default() }
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

async fn handle(stream: Connection, ipc: &Ipc) -> Result<()> {
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

async fn dispatch(req: Request, ipc: &Ipc) -> (Value, bool) {
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
        Request::LaunchDone { launch_id, exit_code } => {
            let Some(ctx) = &ipc.launch else { return (err("invalid", "这个 onexd 不支持启动 Agent"), false) };
            let Some(launch) = ctx.running.lock().unwrap().remove(&launch_id) else {
                return (json!({"ok": true}), false);
            };
            info!(%launch_id, ?exit_code, "agent exited");
            ipc.state.launch_tokens.write().unwrap().remove(&launch.token);
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
    if let Err(e) = ipc.state.lease.cutoff("logout") {
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
    ipc.state.active_session.write().unwrap().take();
    ipc.state.token.send_replace(None);
    (json!({"ok": true}), true)
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
    if agent != "claude-code" {
        return err("agent_not_allowed", &format!("OneX 暂不支持启动 {agent}"));
    }
    if ipc.state.token.borrow().is_none() {
        return err("unauthenticated", "还没有登录，请先登录 OneX");
    }
    let Ok(_prepare) = ctx.preparing.try_lock() else {
        return err("conflict", "已有 Agent 正在启动");
    };
    let (os, arch) = (onex_core::ipc::os_name(), onex_core::ipc::arch_name());
    let approved = if program.is_none() {
        let cfg = ipc.state.config.read().unwrap();
        let Ok(release) = crate::managed_runtime::select(&cfg.agents, agent, os, arch) else {
            return err("agent_not_allowed", "没有可用的受管发行版本");
        };
        Some(release.clone())
    } else {
        None
    };
    // program 不填：按 Server 下发的发行目录自己选型、下载、校验并原子缓存；program 填了就是旧 PATH 用法。
    let resolved_program = if let Some(release) = &approved {
        match tokio::select! {
            _ = ipc.shutdown.cancelled() => return err("unauthenticated", "请重新登录 OneX"),
            result = crate::managed_runtime::resolve(&ctx.home, &ctx.http, std::slice::from_ref(release), agent, os, arch) => result,
        } {
            Ok(path) => path,
            Err(_) => return err("upstream_error", "无法下载或校验受管 Agent 制品"),
        }
    } else {
        PathBuf::from(program.expect("legacy launch provides a program"))
    };
    let _identity = ipc.identity_transition.lock().await;
    if ipc.shutdown.is_cancelled()
        || ipc.state.token.borrow().is_none()
        || ipc.state.phase() == crate::state::Phase::Unauthenticated
    {
        return err("unauthenticated", "请重新登录 OneX");
    }
    let program = resolved_program.to_string_lossy().into_owned();
    let program = program.as_str();
    // 别名候选：精确名字的路由；通配路由用它固定的上游模型名（server 的 MVP seed 是 `*` → Qwen3.8-27B）
    let (models, routable) = {
        let cfg = ipc.state.config.read().unwrap();
        if let Some(release) = &approved
            && crate::managed_runtime::select(&cfg.agents, agent, os, arch).ok() != Some(release)
        {
            return err("agent_not_allowed", "受管发行已变化，请重试");
        }
        let mut exact: Vec<String> =
            cfg.routes.iter().filter(|r| !r.model.contains('*')).map(|r| r.model.clone()).collect();
        exact.extend(cfg.routes.iter().filter(|r| r.model.contains('*')).filter_map(|r| r.upstream_model.clone()));
        exact.dedup();
        let routable = model.is_some_and(|m| crate::router::select_route(&cfg.routes, m).is_some());
        (exact, routable)
    };
    let model = match model {
        Some(m) if routable => m.to_string(),
        Some(m) => return err("model_not_allowed", &format!("模型 {m} 没有开通，可用的有：{}", models.join("、"))),
        None => match models.first() {
            Some(m) => m.clone(),
            None => {
                return err(
                    "model_not_allowed",
                    "还没有收到可用的模型。请用 onex status 确认已连上 Server，或联系管理员开通模型。",
                );
            }
        },
    };
    let local_token = crate::id::token();
    let r = crate::launch::Request {
        home: &ctx.home,
        router_addr,
        local_token: &local_token,
        model: &model,
        program: Path::new(program),
        cwd: Path::new(cwd),
        client_env: env,
    };
    match crate::launch::prepare(&r) {
        Ok(l) => {
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
            ipc.state.launch_tokens.write().unwrap().insert(local_token.clone(), l.session_id.clone());
            ctx.running.lock().unwrap().insert(
                l.launch_id.clone(),
                Running {
                    stop: stop.clone(),
                    code: code.clone(),
                    session_id: l.session_id.clone(),
                    token: local_token,
                },
            );
            *ipc.state.active_session.write().unwrap() = Some(l.session_id.clone());
            tokio::spawn(crate::capture::Capture::new(s, ipc.outbox.clone()).run(stop, code));
            json!({"ok": true, "launch_id": l.launch_id, "session_id": l.session_id, "program": l.program,
                "args": l.args, "env": l.env, "cwd": l.cwd, "model": model})
        }
        Err(e) => err("invalid", &format!("无法准备启动：{e:#}")),
    }
}

fn status(ipc: &Ipc) -> Status {
    let conn = ipc.state.conn.lock().unwrap().clone();
    let up = ipc.state.upstream.lock().unwrap().clone();
    let entry = |e: Option<(String, String, i64)>| {
        e.map(|(outcome, request_id, at)| json!({"outcome": outcome, "request_id": request_id, "at": format_ms(at)}))
    };
    let managed_agents = ipc
        .launch
        .as_ref()
        .and_then(|ctx| {
            let releases = ipc.state.config.read().unwrap().agents.clone();
            let (os, arch) = (onex_core::ipc::os_name(), onex_core::ipc::arch_name());
            crate::managed_runtime::cached(&ctx.home, &releases, "claude-code", os, arch)
        })
        .map(|(version, is_cached)| {
            let ctx = ipc.launch.as_ref().expect("catalogue requires launch context");
            let stage = if !ctx.running.lock().unwrap().is_empty() {
                "running"
            } else if ctx.preparing.try_lock().is_err() {
                "downloading"
            } else if is_cached {
                "cached"
            } else {
                "available"
            };
            vec![ManagedAgent { id: "claude-code".into(), version, status: stage.into() }]
        })
        .unwrap_or_default();
    Status {
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
        config_revision: ipc.state.config_revision(),
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
