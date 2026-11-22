//! daemon 各部分共享的运行状态。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use onex_core::ipc::LocalUsage;
use onex_core::route_pool::{CredentialRef, PoolConfig};
use onex_core::ws::{
    AgentRelease, BalanceMode, BalanceRouting, CapabilityContract, PolicyNotice, PolicySummary, Rate, Route,
    ToolRelease,
};
use tokio::sync::watch;
use zeroize::Zeroizing;

use crate::lease::Ledger;
use crate::route_apply::Scope;
use crate::route_stage::{AppliedIdentity, ModelLabel};
use crate::secret::DeviceKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Phase {
    #[default]
    Idle,
    Connecting,
    Connected,
    Backoff,
    Unauthenticated,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Connecting => "connecting",
            Phase::Connected => "connected",
            Phase::Backoff => "backoff",
            Phase::Unauthenticated => "unauthenticated",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Conn {
    pub phase: Phase,
    pub device_id: Option<String>,
    pub user_id: Option<String>,
    pub tenant_id: Option<String>,
    pub connects: u64,
    /// 最近一次断开的原因和时间（毫秒）
    pub last_error: Option<(String, i64)>,
}

/// 本机 router 到上游的观测，和控制连接分开。
#[derive(Debug, Clone, Default)]
pub struct Upstream {
    pub inflight: u64,
    pub completed: u64,
    pub local_usage: LocalUsage,
    /// 最近一次结束的请求：(outcome, request_id, 时间毫秒)
    pub last: Option<(String, String, i64)>,
    /// 最近一次上游出错（连接失败、中途断流）的请求
    pub last_error: Option<(String, String, i64)>,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigSnapshot {
    pub agent_cache: bool,
    pub revision: i64,
    pub capability_contract: Option<CapabilityContract>,
    pub policy: Option<AppliedPolicy>,
    pub policy_blocked: bool,
    pub routes: Vec<Route>,
    pub rates: Vec<Rate>,
    pub agents: Vec<AgentRelease>,
    pub tools: Vec<ToolRelease>,
}

impl ConfigSnapshot {
    pub fn requires_managed_launch(&self) -> bool {
        self.agent_cache || self.capability_contract.is_some() || self.policy.is_some() || self.policy_blocked
    }

    pub(crate) fn balance_stopped(&self) -> bool {
        self.policy
            .as_ref()
            .and_then(|policy| policy.balance.as_ref())
            .is_some_and(|routing| routing.mode == BalanceMode::Stopped)
    }
}

#[derive(Clone)]
pub struct AppliedPolicy {
    pub summary: PolicySummary,
    pub notices: Vec<PolicyNotice>,
    pub(crate) balance: Option<BalanceRouting>,
    pub(crate) runtime: onex_core::ws::RuntimeRules,
    pub(crate) commerce_plan_id: Option<String>,
    pub(crate) search_tools: Vec<onex_core::ws::SearchTool>,
    pub(crate) keys: HashMap<String, Zeroizing<String>>,
}

impl std::fmt::Debug for AppliedPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppliedPolicy").field("revision", &self.summary.policy_revision).finish_non_exhaustive()
    }
}

pub(crate) fn is_desktop_agent(agent: &str) -> bool {
    matches!(agent, "workbuddy" | "deepseek-desktop" | "codex-desktop" | "claude-desktop")
}

#[derive(Clone, Debug)]
pub struct LaunchBinding {
    pub session_id: String,
    pub agent: String,
    pub release_id: Option<String>,
    pub approved_model: Option<String>,
    /// Shared only by requests that arrived before the first native transcript was discovered.
    pub first_native_session: Option<watch::Receiver<Option<String>>>,
}

/// 本会话认证时 Server 给出的时间，按本机单调时钟外推。只来自当前连接的 welcome。
#[derive(Debug, Clone, Copy)]
pub struct SessionClock {
    server_ms: i64,
    at: Instant,
}

impl SessionClock {
    pub fn from_welcome(server_time: &str) -> Option<Self> {
        crate::pricing::parse_ms(server_time).map(|server_ms| Self { server_ms, at: Instant::now() })
    }

    pub fn now_ms(&self) -> i64 {
        self.server_ms.saturating_add(self.at.elapsed().as_millis().min(i64::MAX as u128) as i64)
    }
}

/// 已应用的 `route_pool.v1` 投影：配置、内存密钥和应用身份是同一份，整份替换。
pub struct RouteView {
    pub scope: Scope,
    pub identity: AppliedIdentity,
    pub policy_revision: u64,
    pub expires_at_ms: i64,
    pub clock: SessionClock,
    pub config: PoolConfig,
    /// 本视图首次带来的通知 ID（按作用域去重后）。
    pub new_notice_ids: Vec<String>,
    /// 只在本 crate 构造；外部通过 [`RouteView::key`] 读取。
    pub(crate) keys: HashMap<CredentialRef, Zeroizing<String>>,
}

impl RouteView {
    pub fn key(&self, credential: &CredentialRef) -> Option<&str> {
        self.keys.get(credential).map(|k| k.as_str())
    }

    /// 按本视图的可信时点判断是否仍可执行。
    pub fn executable(&self) -> bool {
        self.clock.now_ms() < self.expires_at_ms
    }

    /// 标签与费率按同一可信时点选择。
    pub fn labels(&self) -> Vec<ModelLabel> {
        if !self.executable() {
            return Vec::new();
        }
        crate::route_stage::labels_at(&self.config, self.clock.now_ms())
    }

    /// 本视图首次带来的通知内容。
    pub fn new_notices(&self) -> Vec<&PolicyNotice> {
        self.config.policy.notices.iter().filter(|n| self.new_notice_ids.contains(&n.id)).collect()
    }
}

impl std::fmt::Debug for RouteView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RouteView")
            .field("scope", &self.scope)
            .field("identity", &self.identity)
            .field("credentials", &self.keys.len())
            .finish_non_exhaustive()
    }
}

/// `route_pool.v1` 的设备应用状态。
#[derive(Debug, Clone, Default)]
pub enum RouteApply {
    /// 未协商，或本作用域从未应用。
    #[default]
    None,
    /// 已持久的应用索引还缺本会话可信时间或同投影的合法重封；执行门禁关闭，不回落旧路由。
    PendingSync {
        scope: Scope,
        applied: Option<AppliedIdentity>,
    },
    Ready(Arc<RouteView>),
    /// 退出或认证变化后封闭，旧投影不得使用或发送。
    Closed,
}

impl RouteApply {
    pub fn ready(&self) -> Option<&Arc<RouteView>> {
        match self {
            RouteApply::Ready(view) => Some(view),
            _ => None,
        }
    }
}

pub struct State {
    /// device_token。S0 只存内存，重启后需要重新 login。改它用 [`State::replace_token`]。
    pub token: watch::Sender<Option<String>>,
    /// 登录代次：token 每变一次加一。投影提交、切换和回执发送前比对。
    pub auth_generation: AtomicU64,
    pub route: RwLock<RouteApply>,
    #[doc(hidden)]
    pub isolated_route_execution: AtomicBool,
    /// 设备 X25519 私钥，解密下发的上游密钥。每次启动新生成、只在内存，所以重启后要重新登录注册设备。
    pub device_key: DeviceKey,
    /// When set, only this registered device can acknowledge or replay this outbox.
    pub expected_device_id: RwLock<Option<String>>,
    pub conn: Mutex<Conn>,
    pub config: RwLock<ConfigSnapshot>,
    /// provider_id → 上游密钥明文。只在内存里，不写日志。
    pub secrets: RwLock<HashMap<String, String>>,
    /// 默认只在内存里；daemon 启动时换成落盘的。
    pub lease: Arc<Ledger>,
    pub upstream: Mutex<Upstream>,
    /// 当前受管 Agent 的会话，router 把 usage 记到它名下
    pub active_session: RwLock<Option<String>>,
    /// Each managed launch gets its own loopback route credential.
    pub launch_tokens: RwLock<HashMap<String, LaunchBinding>>,
    pub desktop_sessions: crate::desktop_sessions::DesktopSessions,
    pub workbuddy_turns: crate::workbuddy_turns::Turns,
}

impl Default for State {
    fn default() -> Self {
        Self {
            token: Default::default(),
            auth_generation: AtomicU64::new(0),
            route: Default::default(),
            isolated_route_execution: Default::default(),
            device_key: DeviceKey::generate(),
            expected_device_id: Default::default(),
            conn: Default::default(),
            config: Default::default(),
            secrets: Default::default(),
            lease: Default::default(),
            upstream: Default::default(),
            active_session: Default::default(),
            launch_tokens: Default::default(),
            desktop_sessions: Default::default(),
            workbuddy_turns: Default::default(),
        }
    }
}

impl State {
    pub fn set_phase(&self, phase: Phase) {
        self.conn.lock().unwrap().phase = phase;
    }

    pub fn phase(&self) -> Phase {
        self.conn.lock().unwrap().phase
    }

    pub fn config_revision(&self) -> i64 {
        self.config.read().unwrap().revision
    }

    /// 换登录：先封闭旧投影、推进代次，再换 token。读取方先读 token 再读代次，两者都比对。
    pub fn replace_token(&self, token: Option<String>) {
        self.end_authentication();
        self.token.send_replace(token);
    }

    /// 认证结束（退出、被拒或换号）：封闭旧投影并推进代次。从未进入模型池的设备保持 `None`，
    /// 生产路径的执行判断不受影响。
    pub fn end_authentication(&self) {
        {
            let mut route = self.route.write().unwrap();
            if !matches!(*route, RouteApply::None) {
                *route = RouteApply::Closed;
            }
        }
        self.auth_generation.fetch_add(1, Ordering::SeqCst);
    }

    /// 本进程已进入 `route_pool.v1` 隔离流程。此后真实模型入口一律拒绝：联验租约只消费合成账本，
    /// 路由执行等逐请求用量与按租约结清联验（`contracts/routing-lease-gate.md`）。残留的旧配置、
    /// 旧密钥或旧租约都不能借此访问上游。
    pub fn route_pool_engaged(&self) -> bool {
        !matches!(*self.route.read().unwrap(), RouteApply::None)
    }

    pub fn generation(&self) -> u64 {
        self.auth_generation.load(Ordering::SeqCst)
    }

    /// 当前可执行投影的型号标签；待同步、封闭或过期时为空。
    pub fn route_labels(&self) -> Vec<ModelLabel> {
        self.route.read().unwrap().ready().map(|view| view.labels()).unwrap_or_default()
    }
}
