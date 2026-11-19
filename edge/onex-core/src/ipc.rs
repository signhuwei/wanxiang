//! onexd 本机 IPC：Unix socket，每行一个 JSON 请求，每行一个 JSON 应答。
//!
//! 请求：`{"cmd":"status"}`、`{"cmd":"login","token":"..."}`、`{"cmd":"shutdown"}`。
//! 应答：成功 `{"ok":true,...}`；失败 `{"ok":false,"error":{"code":"...","message":"..."}}`，
//! code 用 `contracts/errors.md` 里的错误码。

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    /// 注册设备用的信息：`{public_key, server_url}`。`server_url` 是 Server 的 HTTP 根地址，onexd 没配置 Server 时为 null。
    DeviceInfo,
    /// 准备一次受管启动。onexd 建好目录和策略文件，回 `{launch_id, session_id, program, args, env, cwd, model}`，
    /// 由调用方在自己的终端里用这份 env（清空后设置）前台启动。
    Launch {
        agent: String,
        /// claude 的绝对路径
        program: String,
        cwd: String,
        /// 调用方终端的环境，onexd 只取终端相关的几项和 PATH
        env: std::collections::BTreeMap<String, String>,
        /// 不填用第一个获准模型
        #[serde(default)]
        model: Option<String>,
        /// `claude --version` 的输出，记日志
        #[serde(default)]
        agent_version: Option<String>,
    },
    /// Agent 退出：删除本次策略文件
    LaunchDone {
        launch_id: String,
        #[serde(default)]
        exit_code: Option<i32>,
    },
    Shutdown,
}

/// 设备的 os、arch，hello 和设备注册用同一套写法（`darwin`/`arm64`）。
pub fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

pub fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

/// `wss://host/v1/edge/ws` → `https://host`
pub fn http_base(ws_url: &str) -> Option<String> {
    let (scheme, rest) = ws_url.split_once("://")?;
    let scheme = match scheme {
        "wss" => "https",
        "ws" => "http",
        _ => return None,
    };
    let host = rest.split('/').next().filter(|h| !h.is_empty())?;
    Some(format!("{scheme}://{host}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_base_from_ws_url() {
        assert_eq!(http_base("wss://onex.example.com/v1/edge/ws").as_deref(), Some("https://onex.example.com"));
        assert_eq!(http_base("ws://192.168.3.211:8080/v1/edge/ws").as_deref(), Some("http://192.168.3.211:8080"));
        assert_eq!(http_base("http://x/v1"), None);
        assert_eq!(http_base("ws:///v1"), None);
    }
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
    /// 控制连接最近一次断开的原因和时间
    #[serde(default)]
    pub ws_last_error: Option<String>,
    #[serde(default)]
    pub ws_last_error_at: Option<String>,
    /// 租约：state（active、none、expired、exhausted、cutoff）、额度、剩余租期、最近一次续租结果
    #[serde(default)]
    pub lease: Value,
    /// 本机 router 到上游：进行中的流数、最近一次结束的结果（ok、upstream_error、client_cancelled 等）
    #[serde(default)]
    pub upstream: Value,
}
