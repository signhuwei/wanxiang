//! onexd 本机 IPC：Unix socket，每行一个 JSON 请求，每行一个 JSON 应答。
//!
//! 请求：`{"cmd":"status"}`、`{"cmd":"login","token":"..."}`、`{"cmd":"shutdown"}`。
//! 应答：成功 `{"ok":true,...}`；失败 `{"ok":false,"error":{"code":"...","message":"..."}}`，
//! code 用 `contracts/errors.md` 里的错误码。

use serde::{Deserialize, Serialize};

pub use crate::ws::ErrorBody;

pub const SOCKET_NAME: &str = "onexd.sock";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    Status,
    /// S0 只把 device_token 存在 daemon 内存里，随后用它连 Server。
    Login {
        token: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Status {
    pub version: String,
    pub logged_in: bool,
    /// `idle`（未登录）、`connecting`、`connected`、`backoff`
    pub ws: String,
    pub device_id: Option<String>,
    pub config_revision: i64,
    pub outbox_last_seq: u64,
    pub outbox_ack_seq: u64,
    pub router_addr: Option<String>,
}
