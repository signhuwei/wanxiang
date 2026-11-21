//! daemon 各部分共享的运行状态。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use onex_core::ipc::LocalUsage;
use onex_core::ws::{
    AgentRelease, BalanceMode, BalanceRouting, CapabilityContract, PolicyNotice, PolicySummary, Rate, Route,
    ToolRelease,
};
use tokio::sync::watch;
use zeroize::Zeroizing;

use crate::lease::Ledger;
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

pub struct State {
    /// device_token。S0 只存内存，重启后需要重新 login。
    pub token: watch::Sender<Option<String>>,
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
}
