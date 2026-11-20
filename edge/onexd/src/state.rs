//! daemon 各部分共享的运行状态。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use onex_core::ws::{AgentRelease, Rate, Route};
use tokio::sync::watch;

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
    /// 最近一次结束的请求：(outcome, request_id, 时间毫秒)
    pub last: Option<(String, String, i64)>,
    /// 最近一次上游出错（连接失败、中途断流）的请求
    pub last_error: Option<(String, String, i64)>,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigSnapshot {
    pub agent_cache: bool,
    pub revision: i64,
    pub routes: Vec<Route>,
    pub rates: Vec<Rate>,
    pub agents: Vec<AgentRelease>,
}

#[derive(Clone, Debug)]
pub struct LaunchBinding {
    pub session_id: String,
    pub agent: String,
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
