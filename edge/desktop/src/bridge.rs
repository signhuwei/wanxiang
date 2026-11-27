//! `desktop_call` 的业务实现。
//!
//! 职责边界按 [desktop-ui/IPC.md](../../../desktop-ui/IPC.md)：这里持有登录 HTTP、设备注册、
//! 偏好、daemon IPC 客户端，只向 WebView 返回裁剪后的安全快照。UI 本身没有任何网络或文件权限。
//!
//! **启动走系统终端，不是本进程 fork**：受管 Agent 需要真实 PTY/控制台，Tauri 的 WebView
//! 进程没有终端可接管。macOS 使用 Terminal.app 运行随包脚本，Windows 通过
//! `CREATE_NEW_CONSOLE` 运行随包 CLI。工作目录由原生选择器提供。两平台共用 CLI 的
//! `Launch`/`LaunchDone` 流程，应用内的 WebView 只提供已知的 Agent ID。
//!
//! onexd 持久化设备令牌和私钥。桌面只保存显示所需的账号和租户信息，并与 daemon 的设备身份核对。

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use onex_core::ipc::{ArtifactProgress, LocalUsage, Request, Status};
use onex_core::ws::{PolicyDisplayItem, PolicyNotice, PolicySummary};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::{diagnostics, profile};

/// 对应 IPC.md 的错误码表；未知码折叠为 `internal`，由 UI 按固定文案显示。
const KNOWN_CODES: &[&str] = &[
    "unauthenticated",
    "forbidden",
    "not_found",
    "conflict",
    "invalid",
    "history_unavailable",
    "agents_running",
    "seat_limit",
    "balance_exhausted",
    "lease_expired",
    "agent_not_allowed",
    "model_not_allowed",
    "rate_limited",
    "upstream_error",
    "internal",
];

#[derive(Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Op {
    State,
    Diagnostics,
    IssueList {
        cursor: Option<String>,
    },
    IssueDetail {
        id: String,
        before_revision: Option<u64>,
    },
    IssueComment {
        id: String,
        revision: u64,
        text: String,
        request_id: String,
    },
    IssueSubmit {
        text: String,
        images: Vec<onex_core::ipc::IssueImage>,
        include_logs: bool,
    },
    SendCode {
        target: String,
    },
    Login {
        target: String,
        code: String,
        #[serde(default)]
        invite_code: Option<String>,
    },
    PasswordLogin {
        tenant: String,
        username: String,
        password: String,
    },
    SelectTenant {
        tenant_id: String,
    },
    Launch {
        agent_id: String,
    },
    Download {
        agent_id: String,
    },
    Settings {
        hide_on_close: bool,
    },
    Reconnect {
        #[serde(default)]
        force: bool,
    },
    InstallUpdate {
        version: String,
    },
    Logout,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

struct IssueFailure {
    error: ErrorBody,
    details: diagnostics::Details,
}

impl IssueFailure {
    fn local(error: ErrorBody, reason: &'static str, stage: &'static str) -> Self {
        Self { error, details: diagnostics::Details { code: Some(reason), stage: Some(stage), http_status: None } }
    }
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
    pub policy: Option<PolicyView>,
    pub policy_pending: bool,
    pub notices: Vec<PolicyNotice>,
    pub local_usage: Option<LocalUsage>,
    pub settings: Settings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyView {
    pub config_revision: i64,
    pub policy_revision: u64,
    pub platform_revision: u64,
    pub tenant_revision: Option<u64>,
    pub display: Vec<PolicyDisplayItem>,
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
    pub vendor: String,
    pub runtime_kind: String,
    pub instance_count: u64,
    pub progress: Option<ArtifactProgress>,
    pub status: String,
    pub actions: Vec<String>,
    #[serde(default)]
    pub workspace_pending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_blocked: Option<LaunchBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchBlock {
    DaemonUpdatePending,
    LaunchInProgress,
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

/// 登录过程中间态，不出现在快照里：全局令牌、账号 ID 和候选租户。
struct PendingLogin {
    global_token: String,
    user_id: Option<String>,
    tenants: Vec<(String, String)>,
}

/// 原生桥持有的全部可变状态；一个进程一份，构造时固定 daemon socket 路径。
pub struct Bridge {
    socket_path: PathBuf,
    version: String,
    require_daemon_version: bool,
    http: reqwest::Client,
    inner: Mutex<Inner>,
    mutation: tokio::sync::Mutex<()>,
    #[cfg(target_os = "macos")]
    pub(crate) daemon_transition: tokio::sync::Mutex<()>,
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
    launching: Option<(&'static str, Instant)>,
    selecting_workspace: Option<&'static str>,
    diagnostics: diagnostics::Session,
}

struct WorkspaceSelection<'a>(&'a Mutex<Inner>);

impl Drop for WorkspaceSelection<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().selecting_workspace = None;
    }
}

struct AgentLauncher {
    gui: bool,
    id: &'static str,
    name: &'static str,
    vendor: &'static str,
    #[cfg(target_os = "macos")]
    script: &'static str,
}

const AGENT_LAUNCHERS: &[AgentLauncher] = &[
    AgentLauncher {
        gui: false,
        id: "claude-code",
        name: "Claude Code",
        vendor: "Anthropic",
        #[cfg(target_os = "macos")]
        script: "onex-run-claude.command",
    },
    AgentLauncher {
        gui: false,
        id: "codex",
        name: "Codex",
        vendor: "OpenAI",
        #[cfg(target_os = "macos")]
        script: "onex-run-codex.command",
    },
    AgentLauncher {
        gui: false,
        id: "kimi-code",
        name: "Kimi Code",
        vendor: "月之暗面",
        #[cfg(target_os = "macos")]
        script: "onex-run-kimi.command",
    },
    #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64")))]
    AgentLauncher {
        gui: true,
        id: "deepseek-desktop",
        name: "DeepSeek Harness Desktop",
        vendor: "DeepSeek",
        #[cfg(target_os = "macos")]
        script: "",
    },
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    AgentLauncher { gui: true, id: "workbuddy", name: "WorkBuddy", vendor: "腾讯", script: "" },
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    AgentLauncher { gui: true, id: "codex-desktop", name: "Codex Desktop", vendor: "OpenAI", script: "" },
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    AgentLauncher { gui: true, id: "claude-desktop", name: "Claude Desktop", vendor: "Anthropic", script: "" },
];

fn agent_launcher(id: &str) -> Option<&'static AgentLauncher> {
    AGENT_LAUNCHERS.iter().find(|agent| agent.id == id)
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
        Self::with_version(socket_path, env!("CARGO_PKG_VERSION").into())
    }

    pub(crate) fn with_version(socket_path: PathBuf, version: String) -> Self {
        #[cfg(target_os = "macos")]
        let require_daemon_version = crate::macos_daemon_update::installed_target(&version).is_some();
        #[cfg(not(target_os = "macos"))]
        let require_daemon_version = false;
        Self {
            socket_path,
            version,
            require_daemon_version,
            http: reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("build http client"),
            inner: Mutex::new(Inner { hide_on_close: true, ..Default::default() }),
            mutation: tokio::sync::Mutex::new(()),
            #[cfg(target_os = "macos")]
            daemon_transition: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn call(&self, op: Op) -> Reply {
        self.call_with_workspace(op, || std::future::ready(None)).await
    }

    pub(crate) async fn call_with_workspace<F, P>(&self, op: Op, pick_workspace: F) -> Reply
    where
        F: FnOnce() -> P,
        P: Future<Output = Option<PathBuf>>,
    {
        if matches!(op, Op::State) {
            return self.state().await;
        }
        let _change = self
            .mutation
            .try_lock()
            .map_err(|_| ErrorBody { code: "conflict".into(), message: "已有操作正在进行".into() })?;
        match op {
            Op::State => self.state().await,
            Op::Diagnostics | Op::IssueList { .. } | Op::IssueSubmit { .. } | Op::IssueDetail { .. } |
            Op::IssueComment { .. } => Err(invalid("请使用诊断和反馈入口")),
            Op::SendCode { target } => self.send_code(target).await,
            Op::Login { target, code, invite_code } => self.login(target, code, invite_code).await,
            Op::PasswordLogin { tenant, username, password } => self.password_login(tenant, username, password).await,
            Op::SelectTenant { tenant_id } => self.select_tenant(tenant_id).await,
            Op::Launch { agent_id } => self.launch(agent_id, pick_workspace).await,
            Op::Download { agent_id } => self.download(agent_id).await,
            Op::Settings { hide_on_close } => self.settings(hide_on_close).await,
            Op::Reconnect { force } => self.reconnect(force).await,
            Op::InstallUpdate { .. } => {
                Err(ErrorBody { code: "update_unavailable".into(), message: "更新已变更或暂不可用".into() })
            }
            Op::Logout => self.logout().await,
        }
    }

    async fn state(&self) -> Reply {
        let device = self.inner.lock().unwrap().device_id.clone();
        let status = self.ipc_call(&Request::Status).await.ok();
        if let Some(status) = &status {
            let mut inner = self.inner.lock().unwrap();
            if inner.phase == Phase::Ready && inner.device_id == device && !same_device(status, &inner) {
                inner.phase = Phase::SignedOut;
                inner.device_id = None;
                inner.user_name = None;
                inner.tenant = None;
                inner.launching = None;
                inner.diagnostics = diagnostics::Session::default();
            }
        }
        self.snapshot(status.as_ref()).await
    }

    pub(crate) fn begin_diagnostic_action(&self, op: &Op) -> Option<(diagnostics::Action, time::OffsetDateTime)> {
        let action = match op {
            Op::Launch { agent_id } => diagnostics::Action::Launch(agent_launcher(agent_id)?.id),
            Op::Download { agent_id } => diagnostics::Action::Download(agent_launcher(agent_id)?.id),
            _ => return None,
        };
        let mut inner = self.inner.lock().unwrap();
        if let diagnostics::Action::Launch(agent) = action {
            inner.diagnostics.push(
                &self.version,
                "info",
                "launch_requested",
                Some(agent),
                diagnostics::Details::default(),
            );
        }
        Some((action, inner.diagnostics.since))
    }

    pub(crate) fn complete_diagnostic_action(
        &self,
        action: Option<(diagnostics::Action, time::OffsetDateTime)>,
        reply: &Reply,
    ) {
        let Some((action, since)) = action else { return };
        let (agent, level, event, code) = match (action, reply) {
            (diagnostics::Action::Launch(agent), Ok(_)) => (agent, "info", "launch_accepted", None),
            (diagnostics::Action::Launch(agent), Err(error)) if error.code == "launch_cancelled" => {
                (agent, "info", "launch_cancelled", None)
            }
            (diagnostics::Action::Launch(agent), Err(error)) => {
                (agent, "error", "launch_rejected", Some(diagnostic_error(error)))
            }
            (diagnostics::Action::Download(agent), Ok(_)) => (agent, "info", "download_accepted", None),
            (diagnostics::Action::Download(agent), Err(error)) => {
                (agent, "error", "download_rejected", Some(diagnostic_error(error)))
            }
        };
        let mut inner = self.inner.lock().unwrap();
        if since == inner.diagnostics.since {
            inner.diagnostics.push(
                &self.version,
                level,
                event,
                Some(agent),
                diagnostics::Details { code, ..Default::default() },
            );
        }
    }

    pub(crate) async fn diagnostics(&self) -> diagnostics::DiagnosticView {
        let status = self.ipc_call(&Request::Status).await.ok();
        let daemon_version =
            status.as_ref().and_then(|value| value["version"].as_str()).and_then(diagnostics::safe_version);
        let (since, account) = {
            let inner = self.inner.lock().unwrap();
            (
                inner.diagnostics.since,
                status.as_ref().is_some_and(|status| inner.phase == Phase::Ready && same_device(status, &inner)),
            )
        };
        let directory = self.socket_path.with_file_name("logs");
        let mut daemon = tokio::task::spawn_blocking(move || diagnostics::daemon_logs(&directory, since, account))
            .await
            .unwrap_or_default();
        let inner = self.inner.lock().unwrap();
        if since != inner.diagnostics.since {
            daemon.clear();
        }
        inner.diagnostics.view(&self.version, daemon_version, daemon)
    }

    pub(crate) async fn issue(&self, op: Op) -> Result<Value, ErrorBody> {
        let command = op.issue_command().ok_or_else(|| invalid("未知反馈操作"))?;
        let writes = matches!(command, "issue_submit" | "issue_comment");
        let since = self.inner.lock().unwrap().diagnostics.since;
        self.issue_exchange(op, command, writes).await.map_err(|failure| {
            let mut inner = self.inner.lock().unwrap();
            if since == inner.diagnostics.since {
                let event = if writes { "issue_submit_failed" } else { "issue_list_failed" };
                inner.diagnostics.push(&self.version, "error", event, None, failure.details);
            }
            failure.error
        })
    }

    async fn issue_exchange(&self, op: Op, command: &str, writes: bool) -> Result<Value, IssueFailure> {
        let _change = writes.then(|| self.mutation.try_lock()).transpose().map_err(|_| {
            IssueFailure::local(
                ErrorBody { code: "conflict".into(), message: "已有操作正在进行".into() },
                "issue_operation_pending",
                "ipc",
            )
        })?;
        let device_id =
            {
                let inner = self.inner.lock().unwrap();
                inner.device_id.clone().filter(|_| inner.phase == Phase::Ready).ok_or_else(|| {
                    IssueFailure::local(device_session_conflict(), "issue_identity_missing", "identity")
                })?
            };
        let active_device = device_id.clone();
        let request = match op {
            Op::IssueList { cursor } => Request::IssueList { device_id, cursor },
            Op::IssueDetail { id, before_revision } => Request::IssueDetail { device_id, id, before_revision },
            Op::IssueComment { id, revision, text, request_id } => {
                if text.trim().is_empty() || text.encode_utf16().count() > 1200 {
                    return Err(IssueFailure::local(invalid("回复内容无效"), "issue_input_invalid", "validate"));
                }
                Request::IssueComment { device_id, id, revision, text, request_id }
            }
            Op::IssueSubmit { text, images, include_logs } => {
                if text.trim().is_empty()
                    || text.len() > 80000
                    || images.len() > 3
                    || images.iter().any(|image| image.data.len() > 1398104)
                {
                    return Err(IssueFailure::local(
                        invalid("反馈内容或图片超过限制"),
                        "issue_input_invalid",
                        "validate",
                    ));
                }
                let logs = if include_logs {
                    self.diagnostics().await.entries.into_iter().take(28).map(|entry| json!(entry)).collect()
                } else {
                    Vec::new()
                };
                Request::IssueSubmit { device_id, text, images, logs }
            }
            _ => return Err(IssueFailure::local(invalid("未知反馈操作"), "issue_input_invalid", "validate")),
        };
        let reply = tokio::time::timeout(Duration::from_secs(25), ipc_call_with(&self.socket_path, &request))
            .await
            .map_err(|_| IssueFailure::local(unavailable(), "issue_ipc_timeout", "ipc"))?
            .map_err(|_| IssueFailure::local(unavailable(), "issue_ipc_failed", "ipc"))?;
        let inner = self.inner.lock().unwrap();
        if inner.phase != Phase::Ready || inner.device_id.as_ref() != Some(&active_device) {
            return Err(IssueFailure::local(device_session_conflict(), "issue_identity_changed", "identity"));
        }
        issue_reply(reply, command)
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
        let user_id = v.pointer("/user/id").and_then(Value::as_str).map(str::to_owned);
        let tenants: Vec<(String, String)> = v["tenants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| Some((t.get("id")?.as_str()?.to_string(), t.get("name")?.as_str()?.to_string())))
            .collect();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.user_name = Some(user_name);
            inner.pending = Some(PendingLogin { global_token, user_id, tenants });
            inner.phase = Phase::ChooseTenant;
            inner.send_code_target = None;
        }
        self.state().await
    }

    async fn select_tenant(&self, tenant_id: String) -> Reply {
        let (global_token, tenant_name, user_name, user_id) = {
            let inner = self.inner.lock().unwrap();
            if inner.phase != Phase::ChooseTenant {
                return Err(forbidden());
            }
            let Some(pending) = &inner.pending else { return Err(forbidden()) };
            let Some((_, name)) = pending.tenants.iter().find(|(id, _)| id == &tenant_id) else {
                return Err(forbidden());
            };
            (
                pending.global_token.clone(),
                name.clone(),
                inner.user_name.clone().unwrap_or_default(),
                pending.user_id.clone(),
            )
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
        let result = self
            .complete_login(
                &server,
                &scoped_token,
                Tenant { id: tenant_id, name: tenant_name },
                user_name,
                user_id.as_deref(),
            )
            .await;
        self.end_login_session(&server, &scoped_token).await;
        if result.is_ok() {
            self.end_login_session(&server, &global_token).await;
        }
        result
    }

    async fn password_login(&self, tenant: String, username: String, password: String) -> Reply {
        let tenant = tenant.trim();
        let username = username.trim();
        if tenant.is_empty() || username.is_empty() || password.is_empty() {
            return Err(invalid("请输入租户、用户名和密码"));
        }
        if self.inner.lock().unwrap().phase != Phase::SignedOut {
            return Err(forbidden());
        }
        let server = self.server_origin().await?;
        let resp = self
            .http
            .post(format!("{server}/v1/auth/password-login"))
            .json(&json!({"tenant": tenant, "username": username, "password": password, "kind": "desktop"}))
            .send()
            .await
            .map_err(|_| unavailable())?;
        let reply = map_http_error(resp).await?;
        let scoped_token = str_field(&reply, "token")?;
        let result = async {
            let tenants: Vec<Tenant> = serde_json::from_value(reply["tenants"].clone()).map_err(|_| unavailable())?;
            let [tenant] = tenants.as_slice() else { return Err(unavailable()) };
            let user_name = reply.pointer("/user/name").and_then(Value::as_str).unwrap_or(username).to_owned();
            let user_id = reply.pointer("/user/id").and_then(Value::as_str);
            self.complete_login(&server, &scoped_token, tenant.clone(), user_name, user_id).await
        }
        .await;
        self.end_login_session(&server, &scoped_token).await;
        result
    }

    async fn end_login_session(&self, server: &str, token: &str) {
        let _ = self.http.post(format!("{server}/v1/auth/logout")).bearer_auth(token).send().await;
    }

    async fn complete_login(
        &self,
        server: &str,
        scoped_token: &str,
        tenant: Tenant,
        user_name: String,
        user_id: Option<&str>,
    ) -> Reply {
        let initial = self.ipc_status().await.map_err(|_| unavailable())?;
        if !initial.logged_in || initial.ws == "unauthenticated" {
            let request = Request::ResumeDevice { server: server.to_owned(), session_token: scoped_token.to_owned() };
            let reply = tokio::time::timeout(Duration::from_secs(30), ipc_call_with(&self.socket_path, &request))
                .await
                .map_err(|_| history_unavailable())?
                .map_err(|_| history_unavailable())?;
            if reply["ok"] != true {
                return Err(match reply["error"]["code"].as_str() {
                    Some("conflict") => device_session_conflict(),
                    Some("agents_running") => agents_running(),
                    _ => history_unavailable(),
                });
            }
            if reply["resumed"] == true {
                let device_id = str_field(&reply, "device_id")?;
                if !onex_core::daemon::wait_for_device(&self.socket_path, &device_id).await {
                    return Err(history_unavailable());
                }
                self.persist_login(tenant, user_name, device_id)?;
                return self.state().await;
            }
            if reply["resumed"] != false {
                return Err(history_unavailable());
            }
            return self.register_device(server, scoped_token, tenant, user_name).await;
        }

        let device_id =
            initial.device_id.filter(|_| initial.ws != "unauthenticated").ok_or_else(device_session_conflict)?;
        let user_id = user_id.filter(|id| !id.is_empty()).ok_or_else(device_session_conflict)?;
        let mut url = reqwest::Url::parse(server).map_err(|_| unavailable())?;
        url.path_segments_mut().map_err(|_| unavailable())?.pop_if_empty().extend(["v1", "devices", &device_id]);
        // The scoped session can only look up devices in the selected tenant. The returned owner
        // must also match the account just authenticated, before Desktop can attach to this daemon.
        let response = self.http.get(url).bearer_auth(scoped_token).send().await.map_err(|_| unavailable())?;
        if matches!(response.status(), reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::FORBIDDEN) {
            return Err(device_session_conflict());
        }
        let device = map_http_error(response).await?;
        if device["id"] != device_id.as_str() || device["user_id"] != user_id || device["status"] != "active" {
            return Err(device_session_conflict());
        }
        let current = self.ipc_status().await.map_err(|_| unavailable())?;
        if !current.logged_in
            || current.ws == "unauthenticated"
            || current.device_id.as_deref() != Some(device_id.as_str())
        {
            return Err(device_session_conflict());
        }
        self.persist_login(tenant, user_name, device_id)?;
        self.state().await
    }

    async fn register_device(&self, server: &str, scoped_token: &str, tenant: Tenant, user_name: String) -> Reply {
        let info = self.ipc_call(&Request::DeviceInfo).await.map_err(|_| unavailable())?;
        let public_key = str_field(&info, "public_key")?;
        if public_key.len() != 44 {
            return Err(unavailable());
        }

        let resp = self
            .http
            .post(format!("{server}/v1/devices"))
            .bearer_auth(scoped_token)
            .json(&json!({"name": device_name(), "os": onex_core::ipc::os_name(),
                "arch": onex_core::ipc::arch_name(), "public_key": public_key}))
            .send()
            .await
            .map_err(|_| unavailable())?;
        let dev = map_http_error(resp).await?;
        let device_token = str_field(&dev, "device_token")?;
        let device_id = str_field(&dev, "device_id")?;
        let reply = self
            .ipc_reply(&Request::Login {
                token: device_token,
                server: Some(server.to_owned()),
                device_id: Some(device_id.clone()),
            })
            .await
            .map_err(|_| unavailable())?;
        if reply["ok"] != true {
            return Err(if reply.pointer("/error/code").and_then(Value::as_str) == Some("conflict") {
                device_session_conflict()
            } else {
                unavailable()
            });
        }
        if let Err(error) = self.persist_login(tenant, user_name, device_id) {
            let _ = self.ipc_call(&Request::Logout).await;
            return Err(error);
        }
        self.state().await
    }

    fn persist_login(&self, tenant: Tenant, user_name: String, device_id: String) -> Result<(), ErrorBody> {
        // device_token 不落盘；只存核对用的非敏感字段，供窗口重开时识别“同一台已登录设备”。
        let stored = profile::StoredProfile {
            device_id: device_id.clone(),
            tenant_id: tenant.id.clone(),
            tenant_name: tenant.name.clone(),
            user_name: user_name.clone(),
        };
        profile::store(&self.socket_path, &stored).map_err(|_| unavailable())?;
        let mut inner = self.inner.lock().unwrap();
        inner.tenant = Some(tenant);
        inner.user_name = Some(user_name);
        inner.device_id = Some(device_id);
        inner.pending = None;
        inner.phase = Phase::Ready;
        inner.send_code_target = None;
        inner.diagnostics = diagnostics::Session::default();
        Ok(())
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
        inner.diagnostics = diagnostics::Session::default();
    }

    async fn launch<F, P>(&self, agent_id: String, pick_workspace: F) -> Reply
    where
        F: FnOnce() -> P,
        P: Future<Output = Option<PathBuf>>,
    {
        let status = self.ipc_call(&Request::Status).await.map_err(|_| unavailable())?;
        let (launcher, already_launching, device_id) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.phase != Phase::Ready || !same_device(&status, &inner) {
                return Err(forbidden());
            }
            if !self.daemon_can_launch(&status) {
                return Err(ErrorBody {
                    code: "conflict".into(),
                    message: "OneX 后台正在切换版本，完成后即可启动 Agent".into(),
                });
            }
            let invalid_agent =
                || ErrorBody { code: "agent_not_allowed".into(), message: "OneX 暂不支持启动该 Agent".into() };
            let launcher = agent_launcher(&agent_id).ok_or_else(invalid_agent)?;
            let already = inner.launching.is_some_and(|(_, until)| until > Instant::now());
            if !already {
                if !self
                    .ready_agents(Some(&status), &inner)
                    .iter()
                    .any(|agent| agent.id == launcher.id && agent.actions.iter().any(|action| action == "launch"))
                {
                    return Err(invalid_agent());
                }
                if launcher.gui {
                    inner.launching = Some((launcher.id, Instant::now() + Duration::from_secs(5)));
                }
            }
            (launcher, already, inner.device_id.clone())
        };
        // 重复点击不另启进程：直接返回当前快照
        if already_launching {
            return self.state().await;
        }
        let result = if launcher.gui {
            self.start_native_desktop(launcher.id).await
        } else {
            let workspace = {
                self.inner.lock().unwrap().selecting_workspace = Some(launcher.id);
                let _selection = WorkspaceSelection(&self.inner);
                pick_workspace().await
            };
            match workspace {
                Some(cwd) if cwd.is_absolute() && cwd.is_dir() && cwd.to_str().is_some() => {
                    let status = self.ipc_call(&Request::Status).await.map_err(|_| unavailable())?;
                    {
                        let mut inner = self.inner.lock().unwrap();
                        if inner.phase != Phase::Ready || inner.device_id != device_id || !same_device(&status, &inner)
                        {
                            return Err(forbidden());
                        }
                        if !self.ready_agents(Some(&status), &inner).iter().any(|agent| {
                            agent.id == launcher.id && agent.actions.iter().any(|action| action == "launch")
                        }) {
                            return Err(ErrorBody {
                                code: "agent_not_allowed".into(),
                                message: "启动授权已变更".into(),
                            });
                        }
                        inner.launching = Some((launcher.id, Instant::now() + Duration::from_secs(5)));
                    }
                    spawn_managed_cli(launcher, &cwd).await.map_err(|error| {
                        tracing::warn!(agent = launcher.id, kind = ?error.kind(), "could not open managed Agent terminal");
                        ErrorBody { code: "terminal_unavailable".into(), message: "无法打开 Agent 终端".into() }
                    })
                }
                Some(_) => {
                    Err(ErrorBody { code: "cwd_required".into(), message: "请选择可用的工作目录".into() })
                }
                None => Err(ErrorBody { code: "launch_cancelled".into(), message: "已取消启动".into() }),
            }
        };
        if result.is_err() {
            self.inner.lock().unwrap().launching = None;
        }
        result?;
        self.state().await
    }

    async fn download(&self, agent_id: String) -> Reply {
        let status = self.ipc_call(&Request::Status).await.map_err(|_| unavailable())?;
        {
            let inner = self.inner.lock().unwrap();
            if inner.phase != Phase::Ready || !same_device(&status, &inner) {
                return Err(forbidden());
            }
            if !self
                .ready_agents(Some(&status), &inner)
                .iter()
                .any(|agent| agent.id == agent_id && agent.actions.iter().any(|action| action == "download"))
            {
                return Err(ErrorBody { code: "agent_not_allowed".into(), message: "此发行不可下载".into() });
            }
        }
        self.ipc_call(&Request::Download { agent: agent_id }).await.map_err(|_| unavailable())?;
        self.state().await
    }

    async fn start_native_desktop(&self, agent: &str) -> Result<(), ErrorBody> {
        let request = Request::Launch {
            agent: agent.to_owned(),
            cwd: String::new(),
            env: Default::default(),
            program: None,
            model: None,
            agent_version: None,
        };
        let reply = tokio::time::timeout(Duration::from_secs(420), ipc_call_with(&self.socket_path, &request))
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        if reply["ok"] == true {
            return Ok(());
        }
        Err(native_launch_error(&reply["error"]))
    }

    async fn settings(&self, hide_on_close: bool) -> Reply {
        self.inner.lock().unwrap().hide_on_close = hide_on_close;
        self.state().await
    }

    async fn reconnect(&self, force: bool) -> Reply {
        let device = self.inner.lock().unwrap().device_id.clone();
        #[cfg(target_os = "macos")]
        {
            let _transition = self.daemon_transition.lock().await;
            crate::macos_daemon_update::restart(&self.socket_path, &self.version, device.as_deref(), force).await?;
        }
        #[cfg(windows)]
        crate::windows_daemon_reconnect::restart(&self.socket_path, device.as_deref(), force).await?;
        self.state().await
    }

    pub(crate) fn hide_on_close(&self) -> bool {
        self.inner.lock().unwrap().hide_on_close
    }

    async fn logout(&self) -> Reply {
        let device = {
            let inner = self.inner.lock().unwrap();
            inner.device_id.clone().filter(|_| inner.phase == Phase::Ready)
        };
        #[cfg(windows)]
        let mut retired_key = None;
        if let Some(device_id) = &device {
            #[cfg(windows)]
            let key = {
                let info = self.ipc_call(&Request::DeviceInfo).await.map_err(|_| unavailable())?;
                str_field(&info, "public_key")?
            };
            let request = Request::LogoutDevice { device_id: device_id.clone() };
            let reply = self.ipc_reply(&request).await.map_err(|_| unavailable())?;
            if reply["error"]["code"] == "agents_running" {
                return Err(agents_running());
            }
            if reply["error"]["code"] == "history_unavailable" {
                return Err(history_unavailable());
            }
            if reply["ok"] != true && reply["error"]["code"] != "conflict" {
                return Err(unavailable());
            }
            #[cfg(windows)]
            if reply["ok"] == true {
                retired_key = Some(key);
            }
        }
        if let Some(device_id) = device.as_deref()
            && profile::load(&self.socket_path).is_some_and(|saved| saved.device_id == device_id)
        {
            let _ = profile::clear(&self.socket_path);
        }
        {
            let mut inner = self.inner.lock().unwrap();
            inner.phase = Phase::SignedOut;
            inner.user_name = None;
            inner.tenant = None;
            inner.device_id = None;
            inner.pending = None;
            inner.send_code_target = None;
            inner.launching = None;
            inner.diagnostics = diagnostics::Session::default();
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

    fn daemon_can_launch(&self, status: &Value) -> bool {
        !self.require_daemon_version || status["version"].as_str() == Some(self.version.as_str())
    }

    fn ready_agents(&self, status: Option<&Value>, inner: &Inner) -> Vec<Agent> {
        let starting = inner.launching.filter(|(_, until)| *until > Instant::now()).map(|(id, _)| id);
        let has_policy = status.is_some_and(|state| !state["policy"].is_null());
        let can_launch = status.is_some_and(|state| self.daemon_can_launch(state));
        status
            .filter(|s| same_device(s, inner))
            .and_then(|s| s["managed_agents"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|a| {
                let launcher = agent_launcher(a["id"].as_str()?)?;
                let version = a["version"].as_str()?.to_owned();
                let raw_status = a["status"].as_str()?;
                let status = match raw_status {
                    "available" | "cached" if starting == Some(launcher.id) => "starting",
                    "available" if has_policy => "not_downloaded",
                    "available" | "cached" => "available",
                    "preparing" if starting == Some(launcher.id) => "starting",
                    "preparing" | "downloading" => "downloading",
                    "verifying" => "verifying",
                    "download_failed" => "download_failed",
                    "starting" => "starting",
                    "running" => "running",
                    "policy_pending" => "policy_pending",
                    _ => return None,
                };
                let launchable = status == "available" || (status == "running" && !launcher.gui);
                let launch_blocked = if !launchable {
                    None
                } else if !can_launch {
                    Some(LaunchBlock::DaemonUpdatePending)
                } else if starting.is_some() {
                    Some(LaunchBlock::LaunchInProgress)
                } else {
                    None
                };
                let mut actions = vec![];
                if launchable && launch_blocked.is_none() {
                    actions.push("launch".into());
                }
                if has_policy && starting.is_none() && matches!(raw_status, "available" | "download_failed") {
                    actions.push("download".into());
                }
                Some(Agent {
                    id: launcher.id.into(),
                    name: launcher.name.into(),
                    version,
                    vendor: launcher.vendor.into(),
                    runtime_kind: if launcher.gui { "gui" } else { "cli" }.into(),
                    instance_count: a["instance_count"].as_u64().unwrap_or_default(),
                    progress: serde_json::from_value(a["progress"].clone()).ok(),
                    status: status.into(),
                    actions,
                    workspace_pending: inner.selecting_workspace == Some(launcher.id),
                    launch_blocked,
                    message: None,
                })
            })
            .collect()
    }

    async fn ipc_reply(&self, req: &Request) -> anyhow::Result<Value> {
        tokio::time::timeout(Duration::from_secs(3), ipc_call_with(&self.socket_path, req)).await?
    }

    async fn ipc_call(&self, req: &Request) -> anyhow::Result<Value> {
        let reply = self.ipc_reply(req).await?;
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
        let status = status.filter(|s| inner.phase == Phase::Ready && same_device(s, &inner));
        let policy = status.and_then(|status| {
            let summary: PolicySummary = serde_json::from_value(status.get("policy")?.clone()).ok()?;
            if Some(summary.tenant_id.as_str()) != inner.tenant.as_ref().map(|tenant| tenant.id.as_str())
                || Some(summary.device_id.as_str()) != inner.device_id.as_deref()
            {
                return None;
            }
            Some(PolicyView {
                config_revision: status["config_revision"].as_i64()?,
                policy_revision: summary.policy_revision,
                platform_revision: summary.platform_revision,
                tenant_revision: summary.tenant_revision,
                display: summary.display,
            })
        });
        let notices = status
            .filter(|_| policy.is_some())
            .and_then(|status| serde_json::from_value(status["notices"].clone()).ok())
            .unwrap_or_default();
        let local_usage = status.and_then(|status| serde_json::from_value(status["local_usage"].clone()).ok());
        Ok(Snapshot {
            version: self.version.clone(),
            phase,
            user: inner.user_name.clone().map(|name| User { name }),
            tenant: inner.tenant.clone(),
            tenants,
            connection,
            agents,
            policy_pending: status.is_some_and(|status| status["policy_blocked"] == true),
            policy,
            notices,
            local_usage,
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
fn launch_script_path(launcher: &AgentLauncher) -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let bundled = executable.parent()?.join("../Resources").join(launcher.script);
    bundled.is_file().then_some(bundled)
}

/// Terminal.app opens a command file as a document. A private, single-use wrapper passes
/// the selected directory as a literal argument to the fixed bundled launcher.
#[cfg(target_os = "macos")]
async fn spawn_managed_cli(launcher: &AgentLauncher, cwd: &Path) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let script = launch_script_path(launcher)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "OneX Agent terminal launcher not found"))?;
    let directory = tempfile::Builder::new().prefix("onex-terminal-").tempdir()?;
    let wrapper = directory.path().join("Launch OneX Agent.command");
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o700).open(&wrapper)?;
    file.write_all(terminal_command(&script, cwd)?.as_bytes())?;
    file.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    drop(file);
    let status = tokio::process::Command::new("/usr/bin/open")
        .args(["-a", "/System/Applications/Utilities/Terminal.app", "--"])
        .arg(&wrapper)
        .status()
        .await?;
    if !status.success() {
        return Err(std::io::Error::other(format!("Terminal.app launch failed: {status}")));
    }
    // Terminal opens the file asynchronously. Its wrapper removes this directory after opening.
    let _ = directory.keep();
    Ok(())
}

#[cfg(target_os = "macos")]
fn terminal_command(script: &Path, cwd: &Path) -> std::io::Result<String> {
    let quote = |path: &Path| {
        let value = path.to_str().ok_or_else(|| std::io::Error::other("path is not UTF-8"))?;
        Ok::<_, std::io::Error>(format!("'{}'", value.replace('\'', "'\\''")))
    };
    Ok(format!(
        "#!/bin/sh\nset -eu\n/bin/rm -f -- \"$0\" || :\n/bin/rmdir -- \"$(/usr/bin/dirname \"$0\")\" || :\nexec {} {}\n",
        quote(script)?,
        quote(cwd)?,
    ))
}

/// Windows：不经中间脚本，直接起装在 Desktop 同目录的 `onex.exe`（Tauri externalBin sidecar，
/// 和 `ensure_onexd_running` 解析 `onexd.exe` 用同一种"同目录"约定，见 `lib.rs`）。固定两个参数
/// `run <已知 Agent ID> --managed`，由固定的启动目录提供参数。`CREATE_NEW_CONSOLE` 给 Agent 自己的控制台。
#[cfg(windows)]
async fn spawn_managed_cli(launcher: &AgentLauncher, cwd: &Path) -> std::io::Result<()> {
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
        .args(["run", launcher.id, "--managed"])
        .current_dir(cwd)
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

fn diagnostic_error(error: &ErrorBody) -> &'static str {
    KNOWN_CODES
        .iter()
        .copied()
        .chain(["cwd_required", "terminal_unavailable", "tool_bundle_unavailable"])
        .find(|code| *code == error.code)
        .unwrap_or("internal")
}

impl Op {
    pub(crate) fn issue_command(&self) -> Option<&'static str> {
        match self {
            Self::IssueList { .. } => Some("issue_list"),
            Self::IssueSubmit { .. } => Some("issue_submit"),
            Self::IssueDetail { .. } => Some("issue_detail"),
            Self::IssueComment { .. } => Some("issue_comment"),
            _ => None,
        }
    }
}

fn issue_reply(reply: Value, command: &str) -> Result<Value, IssueFailure> {
    let info = &reply["issues"];
    let valid = match command {
        "issue_list" => info["items"].is_array(),
        "issue_detail" => info["id"].is_string() && info["activities"].is_array(),
        "issue_comment" => info["id"].is_string() && info["revision"].is_u64(),
        _ => info["id"].is_string(),
    };
    if reply["ok"] == true && valid {
        return Ok(reply);
    }
    let error = &reply["error"];
    let legacy_message = format!("无法解析请求：unknown variant `{command}`");
    if error["code"] == "invalid"
        && error["message"].as_str().is_some_and(|message| message.starts_with(&legacy_message))
    {
        return Err(IssueFailure::local(
            ErrorBody {
                code: "issue_update_required".into(), message: "当前后台版本不支持反馈，请先完成更新".into()
            },
            "issue_update_required",
            "compatibility",
        ));
    }
    let mut details = diagnostics::Details::issue(&error["detail"]);
    if details.code.is_none() {
        details.code =
            Some(if valid || error.is_object() { "issue_daemon_rejected" } else { "issue_daemon_reply_invalid" });
        details.stage = Some("ipc");
    }
    let code = error["code"].as_str().filter(|code| KNOWN_CODES.contains(code)).unwrap_or("internal");
    Err(IssueFailure { error: ErrorBody { code: code.into(), message: "反馈请求失败".into() }, details })
}

fn native_launch_error(error: &Value) -> ErrorBody {
    let Some(code) = error["code"].as_str().filter(|code| KNOWN_CODES.contains(code)) else {
        return unavailable();
    };
    let Some(message) = error["message"].as_str() else { return unavailable() };
    if code == "upstream_error"
        && (error
            .pointer("/detail/reason_code")
            .and_then(Value::as_str)
            .and_then(diagnostics::tool_failure_code)
            .is_some()
            || message == "无法下载或校验受管 Skill 或 MCP 制品")
    {
        return ErrorBody {
            code: "tool_bundle_unavailable".into(),
            message: "无法下载或校验受管工具制品，见底部诊断日志".into(),
        };
    }
    ErrorBody { code: code.into(), message: message.into() }
}

fn forbidden() -> ErrorBody {
    ErrorBody { code: "forbidden".into(), message: "没有权限执行此操作".into() }
}

fn device_session_conflict() -> ErrorBody {
    ErrorBody {
        code: "device_already_logged_in".into(),
        message: "本机 OneX 已登录。请用同一租户和账号登录，或先用 OneX 命令行退出。".into(),
    }
}

fn history_unavailable() -> ErrorBody {
    ErrorBody { code: "history_unavailable".into(), message: "暂时无法恢复当前账号的本机会话".into() }
}

fn agents_running() -> ErrorBody {
    ErrorBody { code: "agents_running".into(), message: "请先关闭已启动的 OneX Agent".into() }
}

pub(crate) fn reconnect_busy() -> ErrorBody {
    ErrorBody { code: "reconnect_busy".into(), message: "受管 Agent、下载或请求仍在运行".into() }
}

pub(crate) fn reconnect_failed() -> ErrorBody {
    ErrorBody { code: "reconnect_failed".into(), message: "重新连接失败，请稍后重试".into() }
}

fn unavailable() -> ErrorBody {
    ErrorBody { code: "internal".into(), message: "本机服务暂不可用，请稍后重试".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn feedback_ipc_failure_is_in_diagnostics() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("onexd.sock");
        let listener = onex_core::transport::bind(&socket).await.unwrap();
        let daemon = tokio::spawn(async move {
            let (reader, mut writer) = listener.accept().await.unwrap().into_split();
            let mut line = String::new();
            BufReader::new(reader).read_line(&mut line).await.unwrap();
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["cmd"], "issue_submit");
            writer.write_all(concat!(
                "{\"ok\":false,\"error\":{\"code\":\"upstream_error\",\"message\":\"SECRET_RAW_MESSAGE\",",
                "\"detail\":{\"reason_code\":\"issue_http_status\",\"stage\":\"response\",\"http_status\":502}}}\n"
            ).as_bytes()).await.unwrap();
        });
        let bridge = Bridge::new(socket);
        {
            let mut inner = bridge.inner.lock().unwrap();
            inner.phase = Phase::Ready;
            inner.device_id = Some("dev_test".into());
        }
        let failure = bridge
            .issue(Op::IssueSubmit { text: "SECRET_FEEDBACK_TEXT".into(), images: vec![], include_logs: false })
            .await
            .unwrap_err();
        assert!(!failure.message.contains("SECRET"));
        let history =
            serde_json::to_value(bridge.inner.lock().unwrap().diagnostics.view("0.1.0", None, vec![])).unwrap();
        let entry = &history["entries"][0];
        assert_eq!(entry["event"], "issue_submit_failed");
        assert_eq!(entry["code"], "issue_http_status");
        assert_eq!(entry["stage"], "response");
        assert_eq!(entry["http_status"], 502);
        assert!(!history.to_string().contains("SECRET"));
        daemon.await.unwrap();
    }

    #[test]
    fn unsupported_legacy_daemon_feedback_is_reported_as_update_required() {
        let failure = issue_reply(
            json!({"ok":false,"error":{"code":"invalid",
            "message":"无法解析请求：unknown variant `issue_submit`, expected one of SECRET_FIXTURE"}}),
            "issue_submit",
        )
        .unwrap_err();
        assert_eq!(failure.error.code, "issue_update_required");
        assert_eq!(failure.details.code, Some("issue_update_required"));
        assert_eq!(failure.details.stage, Some("compatibility"));
        assert!(!failure.error.message.contains("SECRET"));
    }

    #[test]
    fn desktop_launch_distinguishes_recognized_tool_bundle_failures() {
        let failure = native_launch_error(&json!({"code":"upstream_error", "message":"SECRET_MESSAGE",
            "detail":{"reason_code":"tool_http_status","stage":"response","http_status":403}}));
        assert_eq!(failure.code, "tool_bundle_unavailable");
        assert_eq!(diagnostic_error(&failure), "tool_bundle_unavailable");
        assert!(!serde_json::to_string(&failure).unwrap().contains("SECRET_MESSAGE"));
        assert_eq!(
            native_launch_error(&json!({"code":"upstream_error", "message":"无法下载或校验受管 Skill 或 MCP 制品"}))
                .code,
            "tool_bundle_unavailable"
        );
        assert_eq!(
            native_launch_error(
                &json!({"code":"upstream_error", "message":"failed", "detail":{"reason_code":"unknown"}})
            )
            .code,
            "upstream_error"
        );
    }

    #[test]
    fn desktop_launch_accepts_only_agent_id_from_webview() {
        assert!(matches!(
            serde_json::from_value::<Op>(json!({"op": "launch", "agent_id": "codex"})),
            Ok(Op::Launch { agent_id }) if agent_id == "codex"
        ));
        assert!(
            serde_json::from_value::<Op>(json!({
                "op": "launch", "agent_id": "codex", "cwd": "/tmp"
            }))
            .is_err()
        );
    }

    #[test]
    fn workspace_picker_is_visible_and_leaves_running_instances_intact() {
        let bridge = Bridge::new(PathBuf::from("unused/onexd.sock"));
        let agent_state = json!({"logged_in":true, "ws":"connected", "device_id":"dev_a",
            "version":env!("CARGO_PKG_VERSION"), "managed_agents":[{"id":"codex", "version":"1.0.0",
                "status":"running", "instance_count":2}]});
        {
            let mut inner = bridge.inner.lock().unwrap();
            inner.phase = Phase::Ready;
            inner.device_id = Some("dev_a".into());
            inner.selecting_workspace = Some("codex");
        }
        let picker = WorkspaceSelection(&bridge.inner);
        let agents = bridge.ready_agents(Some(&agent_state), &bridge.inner.lock().unwrap());
        assert!(agents[0].workspace_pending);
        assert_eq!(agents[0].status, "running");
        assert_eq!(agents[0].instance_count, 2);
        drop(picker);
        let agents = bridge.ready_agents(Some(&agent_state), &bridge.inner.lock().unwrap());
        assert!(!agents[0].workspace_pending);
        assert!(agents[0].actions.contains(&"launch".into()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_terminal_launchers_preserve_the_native_workspace() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let resources = temporary.path().join("OneX Desktop's Resources");
        let cli_dir = resources.join("onex/bin");
        let workspace = temporary.path().join("项目 with 'quotes' and $(printf untrusted)");
        std::fs::create_dir_all(&cli_dir).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let cli = cli_dir.join("onex");
        std::fs::write(
            &cli,
            "#!/bin/sh\nset -eu\n[ \"$1\" = run ] && [ \"$3\" = --managed ]\nprintf '%s\\n' \"$2\"\npwd -P\n",
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();

        for (id, launcher) in [
            ("claude-code", include_str!("../../../deploy/mac/onex-run-claude.command")),
            ("codex", include_str!("../../../deploy/mac/onex-run-codex.command")),
            ("kimi-code", include_str!("../../../deploy/mac/onex-run-kimi.command")),
        ] {
            let script = resources.join(format!("{id}.command"));
            std::fs::write(&script, launcher).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
            let directory = tempfile::tempdir_in(temporary.path()).unwrap();
            let wrapper = directory.path().join("Run OneX.command");
            std::fs::write(&wrapper, terminal_command(&script, &workspace).unwrap()).unwrap();
            let output = std::process::Command::new("/bin/sh").arg(&wrapper).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            assert_eq!(String::from_utf8(output.stdout).unwrap(), format!("{id}\n{}\n", workspace.display()));
            assert!(!directory.path().exists());
        }
    }

    #[test]
    fn desktop_projects_only_supported_agents_from_the_current_device() {
        let bridge = Bridge::new(PathBuf::new());
        let mut inner = Inner { device_id: Some("dev_a".into()), ..Default::default() };
        let mut status = json!({"logged_in": true, "ws": "connected", "device_id": "dev_a", "managed_agents": [
            {"id": "claude-code", "version": "2.1.311", "status": "cached"},
            {"id": "codex", "version": "0.164.0", "status": "available"},
            {"id": "kimi-code", "version": "2.3.0", "status": "running"},
            {"id": "../untrusted.command", "version": "1.0.0", "status": "available"}
        ]});
        let agents = bridge.ready_agents(Some(&status), &inner);
        assert_eq!(
            agents.iter().map(|agent| agent.name.as_str()).collect::<Vec<_>>(),
            ["Claude Code", "Codex", "Kimi Code"]
        );
        assert!(agents.iter().all(|agent| agent.actions == ["launch"]));

        inner.launching = Some(("codex", Instant::now() + Duration::from_secs(5)));
        let agents = bridge.ready_agents(Some(&status), &inner);
        assert_eq!(
            agents.iter().map(|agent| agent.status.as_str()).collect::<Vec<_>>(),
            ["available", "starting", "running"]
        );
        assert_eq!(agents[0].launch_blocked, Some(LaunchBlock::LaunchInProgress));
        assert_eq!(agents[1].launch_blocked, None);
        assert_eq!(agents[2].launch_blocked, Some(LaunchBlock::LaunchInProgress));

        status["device_id"] = json!("dev_other");
        assert!(bridge.ready_agents(Some(&status), &inner).is_empty());
    }

    #[test]
    fn desktop_with_pending_daemon_update_keeps_running_agents_and_blocks_new_launches() {
        let mut bridge = Bridge::with_version(PathBuf::new(), "0.1.0-rc25".into());
        bridge.require_daemon_version = true;
        let inner = Inner { device_id: Some("dev_a".into()), ..Default::default() };
        let mut status = json!({"logged_in":true, "ws":"connected", "device_id":"dev_a", "version":"0.1.0-rc24", "policy":{},
        "managed_agents":[
            {"id":"claude-code", "version":"2.1.311", "status":"running", "instance_count":1},
            {"id":"codex", "version":"0.164.0", "status":"cached"},
            {"id":"kimi-code", "version":"2.3.0", "status":"available"}
        ]});
        assert!(!bridge.daemon_can_launch(&status));
        let agents = bridge.ready_agents(Some(&status), &inner);
        assert_eq!((agents[0].status.as_str(), agents[0].instance_count), ("running", 1));
        assert!(agents[..2].iter().all(|agent| agent.actions.is_empty()
            && agent.launch_blocked == Some(LaunchBlock::DaemonUpdatePending)));
        assert_eq!(agents[2].launch_blocked, None);
        assert_eq!(agents[2].actions, ["download"]);
        status["version"] = json!("0.1.0-rc25");
        assert!(bridge.daemon_can_launch(&status));
        let agents = bridge.ready_agents(Some(&status), &inner);
        assert!(agents[..2].iter().all(|agent| agent.actions == ["launch"] && agent.launch_blocked.is_none()));
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn windows_workbench_projects_qualified_deepseek_actions() {
        let bridge = Bridge::new(PathBuf::new());
        let inner = Inner { device_id: Some("dev_a".into()), ..Default::default() };
        let mut status = json!({"logged_in": true, "ws": "connected", "device_id": "dev_a", "policy": {},
        "managed_agents": [
            {"id": "deepseek-desktop", "version": "0.2.1-rc.3", "status": "available"},
            {"id": "workbuddy", "version": "5.3.8", "status": "cached"},
            {"id": "codex-desktop", "version": "26.1117.41037", "status": "cached"},
            {"id": "claude-desktop", "version": "6.28899.6", "status": "cached"}
        ]});
        let agents = bridge.ready_agents(Some(&status), &inner);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "deepseek-desktop");
        assert_eq!(agents[0].runtime_kind, "gui");
        assert_eq!(agents[0].actions, ["download"]);

        status["managed_agents"][0]["status"] = json!("cached");
        let agents = bridge.ready_agents(Some(&status), &inner);
        assert_eq!(agents[0].actions, ["launch"]);
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn desktop_projects_newly_available_native_releases_from_the_daemon() {
        let bridge = Bridge::new(PathBuf::new());
        let inner = Inner { device_id: Some("dev_a".into()), ..Default::default() };
        let mut status = json!({"logged_in": true, "ws": "connected", "device_id": "dev_a",
            "managed_agents": []});
        assert!(bridge.ready_agents(Some(&status), &inner).is_empty());

        status["managed_agents"] = json!([
            {"id": "codex-desktop", "version": "26.1117.41037", "status": "available"},
            {"id": "claude-desktop", "version": "6.28899.6", "status": "cached"}
        ]);
        let agents = bridge.ready_agents(Some(&status), &inner);
        assert_eq!(
            agents.iter().map(|agent| (agent.name.as_str(), agent.version.as_str())).collect::<Vec<_>>(),
            [("Codex Desktop", "26.1117.41037"), ("Claude Desktop", "6.28899.6")]
        );
        assert!(
            agents
                .iter()
                .all(|agent| agent.status == "available" && agent.runtime_kind == "gui" && agent.actions == ["launch"])
        );
        status["policy"] = json!({});
        let agents = bridge.ready_agents(Some(&status), &inner);
        assert_eq!(agents[0].actions, ["download"]);
        assert_eq!(agents[1].actions, ["launch"]);
    }
}
