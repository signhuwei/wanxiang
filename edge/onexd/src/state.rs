//! daemon 各部分共享的运行状态。

use std::collections::HashMap;
use std::sync::{Mutex, RwLock};

use onex_core::ws::Route;
use tokio::sync::watch;

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
}

#[derive(Debug, Clone, Default)]
pub struct ConfigSnapshot {
    pub revision: i64,
    pub routes: Vec<Route>,
}

#[derive(Default)]
pub struct State {
    /// device_token。S0 只存内存，重启后需要重新 login。
    pub token: watch::Sender<Option<String>>,
    pub conn: Mutex<Conn>,
    pub config: RwLock<ConfigSnapshot>,
    /// provider_id → 上游密钥明文。只在内存里，不写日志。
    pub secrets: RwLock<HashMap<String, String>>,
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
