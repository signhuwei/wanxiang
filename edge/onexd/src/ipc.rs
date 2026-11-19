//! 本机 IPC：Unix socket 上的 JSON 行协议，见 `onex_core::ipc`。

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use onex_core::ipc::{ErrorBody, Request, Status};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::outbox::Outbox;
use crate::pricing::format_ms;
use crate::state::State;

/// 一行请求的长度上限，防止本机其他进程塞大包。
const MAX_LINE: u64 = 64 * 1024;

pub struct Ipc {
    pub state: Arc<State>,
    pub outbox: Arc<Outbox>,
    pub router_addr: Option<String>,
    pub shutdown: CancellationToken,
}

/// 绑定 socket，权限 0600。已有 socket 能连上说明另一个 onexd 在跑，报错退出；连不上就是残留文件，删掉重建。
pub async fn bind(path: &Path) -> Result<UnixListener> {
    if path.exists() {
        if UnixStream::connect(path).await.is_ok() {
            bail!("another onexd is listening on {}", path.display());
        }
        std::fs::remove_file(path).with_context(|| format!("remove stale socket {}", path.display()))?;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let l = UnixListener::bind(path).with_context(|| format!("bind {}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(l)
}

pub async fn serve(listener: UnixListener, path: PathBuf, ipc: Arc<Ipc>) {
    loop {
        tokio::select! {
            _ = ipc.shutdown.cancelled() => break,
            r = listener.accept() => match r {
                Ok((stream, _)) => {
                    let ipc = ipc.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle(stream, &ipc).await {
                            warn!(error = %format!("{e:#}"), "ipc connection");
                        }
                    });
                }
                Err(e) => warn!(error = %e, "ipc accept"),
            }
        }
    }
    let _ = std::fs::remove_file(&path);
}

async fn handle(stream: UnixStream, ipc: &Ipc) -> Result<()> {
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
        let (reply, stop) = match serde_json::from_str::<Request>(line.trim()) {
            Ok(req) => dispatch(req, ipc),
            Err(e) => (err("invalid", &format!("无法解析请求：{e}")), false),
        };
        write_line(&mut w, &reply).await?;
        if stop {
            ipc.shutdown.cancel();
            return Ok(());
        }
    }
}

fn dispatch(req: Request, ipc: &Ipc) -> (Value, bool) {
    match req {
        Request::Status => (ok(status(ipc)), false),
        Request::Login { token } => {
            let token = token.trim().to_string();
            if token.is_empty() {
                return (err("invalid", "token 不能为空"), false);
            }
            info!("device token updated via ipc");
            ipc.state.token.send_replace(Some(token));
            (json!({"ok": true}), false)
        }
        Request::Shutdown => {
            info!("shutdown requested via ipc");
            (json!({"ok": true}), true)
        }
    }
}

fn status(ipc: &Ipc) -> Status {
    let conn = ipc.state.conn.lock().unwrap().clone();
    let up = ipc.state.upstream.lock().unwrap().clone();
    let entry = |e: Option<(String, String, i64)>| {
        e.map(|(outcome, request_id, at)| json!({"outcome": outcome, "request_id": request_id, "at": format_ms(at)}))
    };
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
        device_id: conn.device_id,
        config_revision: ipc.state.config_revision(),
        outbox_last_seq: ipc.outbox.last_seq(),
        outbox_ack_seq: ipc.outbox.ack_seq().unwrap_or(0),
        router_addr: ipc.router_addr.clone(),
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
