//! onexd 本机 IPC：按行分隔的 JSON 协议（Unix socket 或 Windows 具名管道，见 `transport` 模块），
//! 每行一个 JSON 请求，每行一个 JSON 应答。
//!
//! 请求：`{"cmd":"status"}`、`{"cmd":"login","token":"..."}`、`{"cmd":"logout"}`、`{"cmd":"shutdown"}`。
//! 应答：成功 `{"ok":true,...}`；失败 `{"ok":false,"error":{"code":"...","message":"..."}}`，
//! code 用 `contracts/errors.md` 里的错误码。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::ws::ErrorBody;

pub const SOCKET_NAME: &str = "onexd.sock";

/// `onexd`、`onex-cli`、Desktop 三处都要用同一套默认数据目录；显式设了 `ONEX_HOME` 一律优先。
/// macOS 用 `~/Library/Application Support/OneX`，Windows 用 `%LOCALAPPDATA%\OneX`
/// （每用户、不漫游，和受管 Agent 缓存、设备凭据的体量相符）。
pub fn default_home() -> Result<PathBuf, &'static str> {
    if let Some(h) = std::env::var_os("ONEX_HOME") {
        return Ok(PathBuf::from(h));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or("HOME not set")?;
        Ok(PathBuf::from(home).join("Library/Application Support/OneX"))
    }
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA not set")?;
        Ok(PathBuf::from(local).join("OneX"))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let home = std::env::var_os("HOME").ok_or("HOME not set")?;
        Ok(PathBuf::from(home).join(".local/share/onex"))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    Status,
    /// 登录成功后交给 onexd 的设备身份。只带 token 时（旧用法／调试）只存内存，不落 Keychain，
    /// daemon 重启要重新登录。带齐 `server`/`device_id` 时额外持久化到 macOS Keychain（私钥是
    /// daemon 自己内存里生成的那把，从不经 IPC 输入或输出），daemon 重启后自动恢复同一个已登录
    /// 设备身份，不需要重新走验证码登录。
    ///
    /// `device_id` 和当前控制连接已用的设备身份不一致时，说明是另一个设备身份登录；onexd 拒绝这次 Login
    /// （`invalid`），请先 `logout` 或重启 onexd，避免旧身份的 outbox 被新身份的 hello 误续传。
    Login {
        token: String,
        #[serde(default)]
        server: Option<String>,
        #[serde(default)]
        device_id: Option<String>,
    },
    /// 注销：先删 Keychain 里持久化的设备身份（失败则整体失败，不报告已注销），
    /// 再断流、清内存里的配置和密钥、停掉正在跑的受管启动，和 `shutdown` 一样让 daemon 退出。
    /// 打包环境由 LaunchAgent 用新设备身份重新拉起；手工调试按原来的方式重新执行 onexd。
    Logout,
    /// 注册设备用的信息：`{public_key, server_url}`。`server_url` 是 Server 的 HTTP 根地址，onexd 没配置 Server 时为 null。
    DeviceInfo,
    /// 准备一次受管启动。onexd 建好目录和策略文件，回 `{launch_id, session_id, program, args, env, cwd, model}`，
    /// 由调用方在自己的终端里用这份 env（清空后设置）前台启动。
    Launch {
        agent: String,
        /// claude 的绝对路径。不填时 onexd 按 Server 下发的发行目录（`config.agents`）自己选型、下载、
        /// 校验 SHA-256 并原子缓存，返回缓存里已校验好的绝对路径；没有匹配发行或下载失败时整个请求失败。
        #[serde(default)]
        program: Option<String>,
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

/// 设备的 os、arch，hello 和设备注册用同一套写法（`darwin`/`arm64`、`win32`/`x64`）。
/// `win32` 沿用 Node.js 的平台键：受管 CLI 发行目录（`AgentRelease.os`）按这个键匹配，
/// 和 `docs/specs/agents/kimi-code.md` 的 `win32-x64` 一致；Desktop 安装包发布契约
/// （`contracts/desktop-releases.md`）是独立的一套字段，用 `windows`/`x64`，不混用。
pub fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
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
    #[serde(default)]
    pub agent_cache: bool,
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
    /// Server 下发、本机已知的受管 Agent 发行目录，只给公开信息：`{id, version, status}`。
    /// 不含下载地址、摘要或本机缓存路径，避免诊断信息里带着能绕过校验的材料。
    #[serde(default)]
    pub managed_agents: Vec<ManagedAgent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManagedAgent {
    pub id: String,
    pub version: String,
    /// `available`（已选型，未必已下载）、`cached`（本机已校验缓存）
    pub status: String,
}
