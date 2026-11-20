//! `desktop_call` 的业务实现。
//!
//! 职责边界按 [desktop-ui/IPC.md](../../../desktop-ui/IPC.md)：这里持有登录 HTTP、设备注册、
//! 偏好、daemon IPC 客户端，只向 WebView 返回裁剪后的安全快照。UI 本身没有任何网络或文件权限。
//!
//! **启动走系统终端，不是本进程 fork**：Claude Code 是 TUI，需要真实 PTY/控制台，Tauri 的 WebView
//! 进程没有终端可接管。两个平台分开实现（见 `spawn_managed_cli`）：macOS 按与 Codex 的裁决打开
//! 系统 Terminal.app 运行一个固定、随包分发、不接受外部参数的 `.command`；Windows 不经中间脚本，
//! 直接用 `CREATE_NEW_CONSOLE` 起装在 Desktop 同目录的 `onex.exe` sidecar。两条路径都复用现有 CLI
//! 的 `Launch`/`LaunchDone` 流程；这里不经 IPC 传 program、路径或环境，也不自己管子进程生命周期。
//!
//! onexd 持久化设备令牌和私钥。桌面只保存显示所需的账号和租户信息，并与 daemon 的设备身份核对。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use onex_core::ipc::{Request, Status};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::profile;

/// 对应 IPC.md 的错误码表；未知码折叠为 `internal`，由 UI 按固定文案显示。
const KNOWN_CODES: &[&str] = &[
    "unauthenticated",
    "forbidden",
    "not_found",
    "conflict",
    "invalid",
    "seat_limit",
    "balance_exhausted",
    "lease_expired",
    "agent_not_allowed",
    "model_not_allowed",
    "rate_limited",
    "upstream_error",
    "internal",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Op {
    State,
    SendCode {
        target: String,
    },
    Login {
        target: String,
        code: String,
        #[serde(default)]
        invite_code: Option<String>,
    },
    SelectTenant {
        tenant_id: String,
    },
    Launch {
        agent_id: String,
    },
    Settings {
        hide_on_close: bool,
    },
    Logout,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

pub type Reply = Result<Snapshot, ErrorBody>;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Snapshot {
    pub version: String,
    pub phase: String,
    pub user: Option<User>,
    pub tenant: Option<Tenant>,
    pub tenants: Vec<Tenant>,
    pub connection: String,
    pub agents: Vec<Agent>,
    pub settings: Settings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tenant {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub status: String,
    pub actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub server_origin: String,
    pub hide_on_close: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { server_origin: String::new(), hide_on_close: true }
    }
}

/// 登录过程中间态，不出现在快照里：全局令牌、候选租户、设备公钥。
struct PendingLogin {
    global_token: String,
    tenants: Vec<(String, String)>,
}

/// 原生桥持有的全部可变状态；一个进程一份，构造时固定 daemon socket 路径。
pub struct Bridge {
    socket_path: PathBuf,
    http: reqwest::Client,
    inner: Mutex<Inner>,
    mutation: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct Inner {
    phase: Phase,
    user_name: Option<String>,
    tenant: Option<Tenant>,
    device_id: Option<String>,
    pending: Option<PendingLogin>,
    hide_on_close: bool,
    send_code_target: Option<String>,
    launching: Option<Instant>,
}

#[derive(Default, Clone, PartialEq, Eq)]
enum Phase {
    #[default]
    SignedOut,
    ChooseTenant,
    Ready,
}

impl Bridge {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            http: reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("build http client"),
            inner: Mutex::new(Inner { hide_on_close: true, ..Default::default() }),
            mutation: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn call(&self, op: Op) -> Reply {
        if matches!(op, Op::State) {
            return self.state().await;
        }
        let _change = self
            .mutation
            .try_lock()
            .map_err(|_| ErrorBody { code: "conflict".into(), message: "已有操作正在进行".into() })?;
        match op {
            Op::State => self.state().await,
            Op::SendCode { target } => self.send_code(target).await,
            Op::Login { target, code, invite_code } => self.login(target, code, invite_code).await,
            Op::SelectTenant { tenant_id } => self.select_tenant(tenant_id).await,
            Op::Launch { agent_id } => self.launch(agent_id).await,
            Op::Settings { hide_on_close } => self.settings(hide_on_close).await,
            Op::Logout => self.logout().await,
        }
    }

    async fn state(&self) -> Reply {
        let status = self.ipc_call(&Request::Status).await.ok();
        self.snapshot(status.as_ref()).await
    }

    async fn send_code(&self, target: String) -> Reply {
        let target = target.trim().to_string();
        if target.is_empty() {
            return Err(invalid("请输入邮箱或手机号"));
        }
        let server = self.server_origin().await?;
        let resp = self
            .http
            .post(format!("{server}/v1/auth/code"))
            .json(&json!({"target": target}))
            .send()
            .await
            .map_err(|_| unavailable())?;
        map_http_error(resp).await?;
        self.inner.lock().unwrap().send_code_target = Some(target);
        self.state().await
    }

    async fn login(&self, target: String, code: String, invite_code: Option<String>) -> Reply {
        let target = target.trim().to_string();
        let code = code.trim().to_string();
        if target.is_empty() || code.is_empty() {
            return Err(invalid("请输入邮箱或手机号和验证码"));
        }
        {
            let sent = self.inner.lock().unwrap().send_code_target.clone();
            if sent.as_deref() != Some(target.as_str()) {
                return Err(ErrorBody { code: "invalid".into(), message: "请先发送验证码".into() });
            }
        }
        let server = self.server_origin().await?;
        let mut body = json!({"target": target, "code": code, "kind": "desktop"});
        if let Some(i) = &invite_code {
            body["invite_code"] = i.as_str().into();
        }
        let resp =
            self.http.post(format!("{server}/v1/auth/login")).json(&body).send().await.map_err(|_| unavailable())?;
        let v = map_http_error(resp).await?;
        let global_token = str_field(&v, "token")?;
        let user_name = v.pointer("/user/name").and_then(Value::as_str).unwrap_or(&target).to_string();
        let tenants: Vec<(String, String)> = v["tenants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| Some((t.get("id")?.as_str()?.to_string(), t.get("name")?.as_str()?.to_string())))
            .collect();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.user_name = Some(user_name);
            inner.pending = Some(PendingLogin { global_token, tenants });
            inner.phase = Phase::ChooseTenant;
            inner.send_code_target = None;
        }
        self.state().await
    }

    async fn select_tenant(&self, tenant_id: String) -> Reply {
        let (global_token, tenant_name) = {
            let inner = self.inner.lock().unwrap();
            if inner.phase != Phase::ChooseTenant {
                return Err(forbidden());
            }
            let Some(pending) = &inner.pending else { return Err(forbidden()) };
            let Some((_, name)) = pending.tenants.iter().find(|(id, _)| id == &tenant_id) else {
                return Err(forbidden());
            };
            (pending.global_token.clone(), name.clone())
        };
        let server = self.server_origin().await?;
        let resp = self
            .http
            .post(format!("{server}/v1/auth/select-tenant"))
            .bearer_auth(&global_token)
            .json(&json!({"tenant_id": tenant_id, "kind": "desktop"}))
            .send()
            .await
            .map_err(|_| unavailable())?;
        let v = map_http_error(resp).await?;
        let scoped_token = str_field(&v, "token")?;

        let info = self.ipc_call(&Request::DeviceInfo).await.map_err(|_| unavailable())?;
        let public_key = str_field(&info, "public_key")?;
        if public_key.len() != 44 {
            return Err(unavailable());
        }

        let resp = self
            .http
            .post(format!("{server}/v1/devices"))
            .bearer_auth(&scoped_token)
            .json(&json!({"name": device_name(), "os": onex_core::ipc::os_name(),
                "arch": onex_core::ipc::arch_name(), "public_key": public_key}))
            .send()
            .await
            .map_err(|_| unavailable())?;
        let dev = map_http_error(resp).await?;
        let device_token = str_field(&dev, "device_token")?;
        let device_id = str_field(&dev, "device_id")?;
        let accepted = self
            .ipc_call(&Request::Login {
                token: device_token,
                server: Some(server.clone()),
                device_id: Some(device_id.clone()),
            })
            .await;
        let _ = self.http.post(format!("{server}/v1/auth/logout")).bearer_auth(&scoped_token).send().await;
        accepted.map_err(|_| unavailable())?;
        // device_token 不落盘；只存核对用的非敏感字段，供窗口重开时识别“同一台已登录设备”。
        let user_name = self.inner.lock().unwrap().user_name.clone().unwrap_or_default();
        let stored = profile::StoredProfile {
            device_id: device_id.clone(),
            tenant_id: tenant_id.clone(),
            tenant_name: tenant_name.clone(),
            user_name,
        };
        if profile::store(&self.socket_path, &stored).is_err() {
            let _ = self.ipc_call(&Request::Logout).await;
            return Err(unavailable());
        }
        let _ = self.http.post(format!("{server}/v1/auth/logout")).bearer_auth(&global_token).send().await;

        {
            let mut inner = self.inner.lock().unwrap();
            inner.tenant = Some(Tenant { id: tenant_id, name: tenant_name });
            inner.device_id = Some(device_id);
            inner.pending = None;
            inner.phase = Phase::Ready;
        }
        self.state().await
    }

    /// Restore display data only for the identity confirmed by the daemon.
    pub async fn restore_session(&self) {
        let Some(stored) = profile::load(&self.socket_path) else { return };
        for _ in 0..12 {
            if let Ok(status) = self.ipc_status().await {
                if !status.logged_in || status.device_id.as_ref().is_some_and(|id| id != &stored.device_id) {
                    return;
                }
                if status.device_id.as_ref() == Some(&stored.device_id) && status.ws != "unauthenticated" {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let Ok(_change) = self.mutation.try_lock() else { return };
        let Ok(status) = self.ipc_status().await else { return };
        if !status.logged_in || status.ws == "unauthenticated" || status.device_id.as_ref() != Some(&stored.device_id) {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.phase != Phase::SignedOut {
            return;
        }
        inner.phase = Phase::Ready;
        inner.user_name = Some(stored.user_name);
        inner.tenant = Some(Tenant { id: stored.tenant_id, name: stored.tenant_name });
        inner.device_id = Some(stored.device_id);
    }

    async fn launch(&self, agent_id: String) -> Reply {
        let status = self.ipc_call(&Request::Status).await.map_err(|_| unavailable())?;
        let already_launching = {
            let mut inner = self.inner.lock().unwrap();
            if inner.phase != Phase::Ready || !same_device(&status, &inner) {
                return Err(forbidden());
            }
            let already = inner.launching.is_some_and(|until| until > Instant::now());
            if !already
                && !self
                    .ready_agents(Some(&status), &inner)
                    .iter()
                    .any(|a| a.id == agent_id && a.actions.iter().any(|action| action == "launch"))
            {
                return Err(ErrorBody {
                    code: "agent_not_allowed".into(),
                    message: "OneX 暂不支持启动该 Agent".into(),
                });
            }
            if !already {
                inner.launching = Some(Instant::now() + Duration::from_secs(5));
            }
            already
        };
        // 重复点击不另启进程：直接返回当前快照
        if already_launching {
            return self.state().await;
        }
        let result = self.launch_claude_code().await;
        if result.is_err() {
            self.inner.lock().unwrap().launching = None;
        }
        result?;
        self.state().await
    }

    /// 受管 CLI 需要真实 PTY（Claude Code 是 TUI），Tauri 的 WebView 进程没有终端可接管。两个平台
    /// 分开实现，不共用一套"随包脚本"：macOS 按裁决打开系统 Terminal.app 运行一个固定、随包分发、
    /// 不接受外部参数的 `.command`，脚本内部写死调用可信路径下的 `onex run claude-code`；Windows
    /// 不经中间脚本，直接起装在 Desktop 同目录的 `onex.exe`（Tauri externalBin sidecar），同样固定
    /// `run claude-code --managed` 两个参数，`CREATE_NEW_CONSOLE` 开一个新控制台窗口给它。两条路径
    /// 都复用现有 CLI 的 `Launch`/`LaunchDone` 流程，这里不再重复实现一遍启动和回收子进程的逻辑，
    /// 也不把 program/路径/环境经 IPC 从 WebView 传过来。
    async fn launch_claude_code(&self) -> Result<(), ErrorBody> {
        spawn_managed_cli().await.map_err(|_| unavailable())
    }

    async fn settings(&self, hide_on_close: bool) -> Reply {
        self.inner.lock().unwrap().hide_on_close = hide_on_close;
        self.state().await
    }

    pub(crate) fn hide_on_close(&self) -> bool {
        self.inner.lock().unwrap().hide_on_close
    }

    async fn logout(&self) -> Reply {
        let was_logged_in = self.inner.lock().unwrap().phase == Phase::Ready;
        #[cfg(windows)]
        let retired_key = if was_logged_in {
            let info = self.ipc_call(&Request::DeviceInfo).await.map_err(|_| unavailable())?;
            Some(str_field(&info, "public_key")?)
        } else {
            None
        };
        if was_logged_in {
            self.ipc_call(&Request::Logout).await.map_err(|_| unavailable())?;
        }
        let _ = profile::clear(&self.socket_path);
        {
            let mut inner = self.inner.lock().unwrap();
            inner.phase = Phase::SignedOut;
            inner.user_name = None;
            inner.tenant = None;
            inner.device_id = None;
            inner.pending = None;
            inner.send_code_target = None;
            inner.launching = None;
        }
        // Windows：`Logout` 让 onexd 把自己整个关掉（和 macOS 一致，见 onexd/src/ipc.rs::logout），
        // macOS 靠 LaunchAgent 的 KeepAlive 自动重启；Windows 没有等价机制，Desktop 必须在这里自己
        // 把它重新拉起，否则这同一个窗口里马上再 SendCode/Login 就会因为连不上 daemon 直接失败，
        // 用户只能靠重启整个 Desktop 应用才能恢复，这不是"注销后能再登录"该有的体验。
        #[cfg(windows)]
        if let Some(retired_key) = retired_key.as_deref() {
            crate::ensure_onexd_running(&self.socket_path, Some(retired_key)).await;
        }
        self.state().await
    }

    /// Server 地址只有一个来源：onexd 自己连的那个（`DeviceInfo.server_url`，从 daemon 的
    /// `ONEX_SERVER` 推出）。Desktop 不维护自己的一份地址，测试用临时 onexd 实例时这里天然就会
    /// 读到测试地址，不需要额外的环境变量旁路。
    async fn server_origin(&self) -> Result<String, ErrorBody> {
        let info = self.ipc_call(&Request::DeviceInfo).await.map_err(|_| unavailable())?;
        info["server_url"].as_str().and_then(normalize_origin).ok_or_else(unavailable)
    }

    async fn ipc_status(&self) -> anyhow::Result<Status> {
        let v = self.ipc_call(&Request::Status).await?;
        Ok(serde_json::from_value(v)?)
    }

    fn ready_agents(&self, status: Option<&Value>, inner: &Inner) -> Vec<Agent> {
        let starting = inner.launching.is_some_and(|until| until > Instant::now());
        status
            .filter(|s| same_device(s, inner))
            .and_then(|s| s["managed_agents"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|a| {
                let id = a["id"].as_str()?;
                if id != "claude-code" {
                    return None;
                }
                let version = a["version"].as_str()?.to_owned();
                let status = match a["status"].as_str()? {
                    "available" | "cached" if starting => "starting",
                    "available" | "cached" => "available",
                    "downloading" => "downloading",
                    "running" => "running",
                    _ => return None,
                };
                let actions =
                    if matches!(status, "available" | "running") && !starting { vec!["launch".into()] } else { vec![] };
                Some(Agent {
                    id: id.into(),
                    name: "Claude Code".into(),
                    version,
                    status: status.into(),
                    actions,
                    message: None,
                })
            })
            .collect()
    }

    async fn ipc_call(&self, req: &Request) -> anyhow::Result<Value> {
        let reply = tokio::time::timeout(Duration::from_secs(3), ipc_call_with(&self.socket_path, req)).await??;
        anyhow::ensure!(reply["ok"] == true, "daemon declined request");
        Ok(reply)
    }

    /// 把内部状态和 daemon 状态裁剪成对外安全快照：只给白名单字段，不转发 daemon 原始对象。
    async fn snapshot(&self, status: Option<&Value>) -> Reply {
        let server_origin = self.server_origin().await.unwrap_or_default();
        let inner = self.inner.lock().unwrap();
        let connection = status.and_then(|s| s["ws"].as_str()).unwrap_or("idle");
        let connection = match connection {
            "connected" => "connected",
            "connecting" => "connecting",
            "backoff" => "backoff",
            _ => "idle",
        }
        .to_string();
        let phase = match inner.phase {
            Phase::SignedOut => "signed_out",
            Phase::ChooseTenant => "choose_tenant",
            Phase::Ready => "ready",
        }
        .to_string();
        let tenants = inner
            .pending
            .as_ref()
            .map(|p| p.tenants.iter().map(|(id, name)| Tenant { id: id.clone(), name: name.clone() }).collect())
            .unwrap_or_default();
        let agents = if inner.phase == Phase::Ready { self.ready_agents(status, &inner) } else { vec![] };
        Ok(Snapshot {
            version: env!("CARGO_PKG_VERSION").into(),
            phase,
            user: inner.user_name.clone().map(|name| User { name }),
            tenant: inner.tenant.clone(),
            tenants,
            connection,
            agents,
            settings: Settings { server_origin, hide_on_close: inner.hide_on_close },
        })
    }
}

fn same_device(status: &Value, inner: &Inner) -> bool {
    status["logged_in"] == true
        && status["ws"] != "unauthenticated"
        && inner.device_id.as_deref().is_some_and(|id| status["device_id"].as_str() == Some(id))
}

pub(crate) async fn ipc_call_with(socket_path: &std::path::Path, req: &Request) -> anyhow::Result<Value> {
    let stream = onex_core::transport::connect(socket_path).await?;
    let (r, mut w) = stream.into_split();
    let mut line = serde_json::to_string(req)?;
    line.push('\n');
    w.write_all(line.as_bytes()).await?;
    let mut reply = String::new();
    BufReader::new(r).read_line(&mut reply).await?;
    Ok(serde_json::from_str(&reply)?)
}

/// The installer places the terminal entry point in the application resources. macOS bundles
/// resources at `<App>.app/Contents/Resources/`, one level up from the executable's own
/// `Contents/MacOS/`.
#[cfg(target_os = "macos")]
fn launch_script_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let bundled = executable.parent()?.join("../Resources/onex-run-claude.command");
    bundled.is_file().then_some(bundled)
}

/// macOS：打开一个新的 Terminal.app 窗口运行随包脚本，固定两个参数（目标 app 和脚本自身路径），
/// 均来自本进程资源目录，不接受调用方输入。
#[cfg(target_os = "macos")]
async fn spawn_managed_cli() -> std::io::Result<()> {
    let script = launch_script_path()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "onex-run-claude.command not found"))?;
    let status = tokio::process::Command::new("/usr/bin/open")
        .args(["-a", "/System/Applications/Utilities/Terminal.app", "--"])
        .arg(&script)
        .status()
        .await?;
    if !status.success() {
        return Err(std::io::Error::other(format!("Terminal.app launch failed: {status}")));
    }
    Ok(())
}

/// Windows：不经中间脚本，直接起装在 Desktop 同目录的 `onex.exe`（Tauri externalBin sidecar，
/// 和 `ensure_onexd_running` 解析 `onexd.exe` 用同一种"同目录"约定，见 `lib.rs`）。固定两个参数
/// `run claude-code --managed`，不接受调用方输入。`CREATE_NEW_CONSOLE` 让它在一个新控制台窗口里
/// 运行——Claude Code 是 TUI，需要自己的控制台，不能继承 Desktop（没有控制台的 GUI 子系统进程）
/// 不存在的控制台。
#[cfg(windows)]
async fn spawn_managed_cli() -> std::io::Result<()> {
    const CREATE_NEW_CONSOLE: u32 = 0x00000010;
    let executable = std::env::current_exe()?;
    let onex = executable
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no parent directory for current_exe"))?
        .join("onex.exe");
    if !onex.is_file() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "onex.exe sidecar not found"));
    }
    let mut child = tokio::process::Command::new(&onex)
        .args(["run", "claude-code", "--managed"])
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()?;
    tokio::spawn(async move {
        if let Err(error) = child.wait().await {
            tracing::warn!(%error, "failed to wait for the OneX terminal process");
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn device_name() -> String {
    std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "OneX Desktop".into())
}

#[cfg(windows)]
fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "OneX Desktop".into())
}

/// 规范化为无路径、无身份、无 query/fragment 的 origin；空输入给空字符串。
fn normalize_origin(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
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

fn str_field(v: &Value, k: &str) -> Result<String, ErrorBody> {
    v.get(k).and_then(Value::as_str).map(str::to_owned).ok_or_else(unavailable)
}

async fn map_http_error(resp: reqwest::Response) -> Result<Value, ErrorBody> {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(v);
    }
    let code = v.pointer("/error/code").and_then(Value::as_str).unwrap_or("internal");
    let code = if KNOWN_CODES.contains(&code) { code } else { "internal" };
    Err(ErrorBody { code: code.into(), message: "请求失败".into() })
}

fn invalid(message: &str) -> ErrorBody {
    ErrorBody { code: "invalid".into(), message: message.into() }
}

fn forbidden() -> ErrorBody {
    ErrorBody { code: "forbidden".into(), message: "没有权限执行此操作".into() }
}

fn unavailable() -> ErrorBody {
    ErrorBody { code: "internal".into(), message: "本机服务暂不可用，请稍后重试".into() }
}
