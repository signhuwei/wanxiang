//! 到 Server 的 WebSocket 长连接：握手、心跳、配置下发、outbox 回流、指数退避重连。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use onex_core::ws::{
    Ack, Config, DiagResult, ErrorBody, Hello, LeaseRenew, LeaseRequest, Msg, PROTOCOL_VERSION, Welcome,
};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio::time::{Instant, interval_at, sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::outbox::{AckOutcome, Kind, Outbox};
use crate::state::{ConfigSnapshot, Phase, State};
use crate::{diagnostics, id};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Tx = SplitSink<Ws, Message>;
type Rx = SplitStream<Ws>;

const CLOSE_REPLACED: u16 = 4001;
const MISSED_PONGS: u32 = 3;

#[derive(Debug, Clone)]
pub struct WsOptions {
    /// 完整地址，例如 `wss://onex.example.com/v1/edge/ws`。
    pub url: String,
    pub edge_version: String,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    pub connect_timeout: Duration,
    /// 每条 events/usage 消息最多带多少条。
    pub batch_max: usize,
    /// 已发送未确认的条目上限，超过就等 events_ack。
    pub window: u64,
    logs: Option<diagnostics::LogSource>,
}

impl WsOptions {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            edge_version: env!("CARGO_PKG_VERSION").into(),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(10),
            batch_max: 500,
            window: 5000,
            logs: None,
        }
    }

    pub fn with_diagnostic_logs(mut self, directory: PathBuf, started_at: time::OffsetDateTime) -> Self {
        self.logs = Some(diagnostics::LogSource { directory, started_at });
        self
    }
}

enum End {
    Cancelled,
    Unauthenticated,
    Replaced,
    Lost { welcomed: bool, reason: anyhow::Error },
}

/// 一直运行到 `cancel`。没有 token 时等 login；token 被拒后等新 token。
pub async fn run(opts: WsOptions, state: Arc<State>, outbox: Arc<Outbox>, cancel: CancellationToken) {
    let mut token_rx = state.token.subscribe();
    let mut attempt: u32 = 0;
    loop {
        let token = token_rx.borrow_and_update().clone();
        let Some(token) = token else {
            state.set_phase(Phase::Idle);
            tokio::select! {
                _ = cancel.cancelled() => return,
                r = token_rx.changed() => if r.is_err() { return },
            }
            continue;
        };

        state.set_phase(Phase::Connecting);
        let end = session(&opts, &state, &outbox, &token, &cancel).await;
        // 控制连接断开不影响本机进行中的请求，只把等待中的续租记为不可达。
        state.lease.on_disconnected();
        let reason = match &end {
            End::Cancelled => None,
            End::Unauthenticated => Some("unauthenticated".to_string()),
            End::Replaced => Some("replaced".to_string()),
            End::Lost { reason, .. } => Some(format!("{reason:#}")),
        };
        if let Some(r) = reason {
            state.conn.lock().unwrap().last_error = Some((r, crate::outbox::now_ms()));
        }
        let delay = match end {
            End::Cancelled => return,
            End::Unauthenticated => {
                warn!("server rejected device token; waiting for a new login");
                *state.config.write().unwrap() = ConfigSnapshot::default();
                state.secrets.write().unwrap().clear();
                if let Err(e) = state.lease.cutoff("unauthenticated", None) {
                    warn!(error = %e, "could not persist authentication cutoff");
                }
                state.set_phase(Phase::Unauthenticated);
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    r = token_rx.changed() => if r.is_err() { return },
                }
                attempt = 0;
                continue;
            }
            End::Replaced => {
                // 另一条连接顶掉了我们，多半是同一设备上跑了两个 onexd。用最长间隔，免得互相顶。
                warn!("connection replaced by another session (4001)");
                opts.backoff_max
            }
            End::Lost { welcomed, reason } => {
                if welcomed {
                    attempt = 0;
                }
                let d = backoff(opts.backoff_min, opts.backoff_max, attempt);
                warn!(error = %format!("{reason:#}"), retry_in_ms = d.as_millis() as u64, "ws disconnected");
                d
            }
        };
        attempt = attempt.saturating_add(1);
        state.set_phase(Phase::Backoff);
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = sleep(delay) => {}
            // 新 token 立即重连
            r = token_rx.changed() => { if r.is_err() { return } attempt = 0; }
        }
    }
}

/// 第 `attempt` 次重试的等待时间：min·2^attempt，封顶 max，±20% 抖动，抖动后仍不超过 max。
pub fn backoff(min: Duration, max: Duration, attempt: u32) -> Duration {
    let base = min.saturating_mul(1u32 << attempt.min(16)).min(max);
    let jitter = rand::random_range(0.8..=1.2);
    base.mul_f64(jitter).min(max)
}

async fn session(opts: &WsOptions, state: &State, outbox: &Outbox, token: &str, cancel: &CancellationToken) -> End {
    let lost = |reason| End::Lost { welcomed: false, reason };
    let (mut tx, mut rx) = match tokio::select! {
        _ = cancel.cancelled() => return End::Cancelled,
        r = connect(opts, token) => r,
    } {
        Ok(ws) => ws.split(),
        Err(WsError::Http(resp)) if resp.status() == StatusCode::UNAUTHORIZED => return End::Unauthenticated,
        Err(e) => return lost(anyhow!(e).context("connect")),
    };

    let welcome = match tokio::select! {
        _ = cancel.cancelled() => return End::Cancelled,
        r = handshake(opts, state, outbox, &mut tx, &mut rx) => r,
    } {
        Ok(w) => w,
        Err(e) => return classify(e, false),
    };

    match connected(opts, state, outbox, (&mut tx, &mut rx), &welcome, token, cancel).await {
        Ok(()) => {
            let _ =
                tx.send(Message::Close(Some(CloseFrame { code: CloseCode::Normal, reason: "shutdown".into() }))).await;
            End::Cancelled
        }
        Err(e) => classify(e, true),
    }
}

/// 连接期间的特殊结局通过错误类型带出来。
#[derive(Debug)]
enum Special {
    Unauthenticated,
    Replaced,
}
impl std::fmt::Display for Special {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Special {}

fn classify(e: anyhow::Error, welcomed: bool) -> End {
    match e.downcast_ref::<Special>() {
        Some(Special::Unauthenticated) => End::Unauthenticated,
        Some(Special::Replaced) => End::Replaced,
        None => End::Lost { welcomed, reason: e },
    }
}

async fn connect(opts: &WsOptions, token: &str) -> Result<Ws, WsError> {
    let mut req = opts.url.as_str().into_client_request()?;
    let h = req.headers_mut();
    let bearer = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|e| WsError::HttpFormat(e.into()))?;
    h.insert("authorization", bearer);
    h.insert(
        "onex-edge-version",
        HeaderValue::from_str(&opts.edge_version).map_err(|e| WsError::HttpFormat(e.into()))?,
    );
    h.insert("onex-protocol", HeaderValue::from_static(PROTOCOL_VERSION));
    match timeout(opts.connect_timeout, connect_async(req)).await {
        Ok(r) => r.map(|(ws, _)| ws),
        Err(_) => Err(WsError::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, "connect timeout"))),
    }
}

async fn handshake(opts: &WsOptions, state: &State, outbox: &Outbox, tx: &mut Tx, rx: &mut Rx) -> Result<Welcome> {
    let hello_id = id::new("msg");
    send(
        tx,
        &Msg::Hello(Hello {
            agent_cache: true,
            id: hello_id.clone(),
            edge_version: opts.edge_version.clone(),
            os: onex_core::ipc::os_name().into(),
            arch: onex_core::ipc::arch_name().into(),
            config_revision: state.config_revision(),
            lease_id: state.lease.lease_id(),
            outbox_last_seq: outbox.last_seq(),
        }),
    )
    .await?;

    let wait = async {
        loop {
            match recv(rx).await? {
                Msg::Welcome(w) if w.re == hello_id => return Ok(w),
                Msg::Ack(Ack { re, ok: false, error }) if re == hello_id => {
                    let e = error.unwrap_or_else(|| ErrorBody {
                        code: "internal".into(),
                        message: String::new(),
                        detail: None,
                    });
                    if e.code == "unauthenticated" {
                        return Err(Special::Unauthenticated.into());
                    }
                    bail!("hello rejected: {} {}", e.code, e.message);
                }
                other => debug!(?other, "ignored before welcome"),
            }
        }
    };
    timeout(opts.connect_timeout, wait).await.context("welcome timeout")?
}

async fn connected(
    opts: &WsOptions,
    state: &State,
    outbox: &Outbox,
    socket: (&mut Tx, &mut Rx),
    welcome: &Welcome,
    token: &str,
    cancel: &CancellationToken,
) -> Result<()> {
    let (tx, rx) = socket;
    if state.expected_device_id.read().unwrap().as_ref().is_some_and(|id| id != &welcome.device_id) {
        return Err(Special::Unauthenticated.into());
    }
    {
        let mut c = state.conn.lock().unwrap();
        c.phase = Phase::Connected;
        c.device_id = Some(welcome.device_id.clone());
        c.user_id = Some(welcome.user_id.clone());
        c.tenant_id = Some(welcome.tenant_id.clone());
        c.connects += 1;
    }
    info!(device_id = %welcome.device_id, ack_seq = welcome.ack_seq, "ws connected");
    state.lease.on_welcome(&welcome.server_time, &welcome.tenant_id);

    // welcome.ack_seq 之前的都已持久化，等同一次 events_ack。
    note_ack(outbox, welcome.ack_seq)?;
    let local_acked = outbox.ack_seq()?;
    // `acked` 是这条连接上 Server 确认到的位置，补传从它之后开始。
    let mut acked = local_acked;
    if welcome.ack_seq < local_acked {
        acked = welcome.ack_seq;
        report_ack_regression(outbox, tx, welcome.ack_seq, local_acked).await?;
    }
    let mut sent = acked;

    let hb = Duration::from_millis(welcome.heartbeat_ms.max(100));
    let mut ticker = interval_at(Instant::now() + hb, hb);
    let mut missed: u32 = 0;
    let mut outbox_rx = outbox.subscribe();
    let mut renew_rx = state.lease.subscribe_renew();
    let mut lease_request_rx = state.lease.subscribe_lease_request();
    let mut diagnostic_tasks = JoinSet::new();
    state.lease.on_connected();
    send_renew(state, tx).await?;
    send_lease_request(state, tx).await?;

    flush(opts, outbox, tx, &mut sent, acked).await?;
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            _ = ticker.tick() => {
                if missed >= MISSED_PONGS {
                    bail!("heartbeat timeout");
                }
                missed += 1;
                send(tx, &Msg::Ping { id: id::new("msg") }).await?;
            }
            r = outbox_rx.changed() => {
                r.context("outbox closed")?;
                flush(opts, outbox, tx, &mut sent, acked).await?;
            }
            r = renew_rx.changed() => {
                r.context("lease closed")?;
                send_renew(state, tx).await?;
            }
            r = lease_request_rx.changed() => {
                r.context("lease closed")?;
                send_lease_request(state, tx).await?;
            }
            r = diagnostic_tasks.join_next(), if !diagnostic_tasks.is_empty() => {
                if let Some(Ok(result)) = r {
                    send(tx, &Msg::DiagResult(result)).await?;
                }
            }
            m = recv(rx) => {
                missed = 0;
                match m? {
                    Msg::Ping { id } => send(tx, &Msg::Pong { re: Some(id) }).await?,
                    Msg::Pong { .. } => {}
                    Msg::EventsAck(a) => {
                        note_ack(outbox, a.ack_seq)?;
                        acked = acked.max(a.ack_seq.min(outbox.last_seq()));
                        // 重连时可能还有更早发出的确认，sent 不能落到 acked 之后。
                        sent = sent.max(acked);
                        flush(opts, outbox, tx, &mut sent, acked).await?;
                    }
                    Msg::Config(c) => {
                        let id = c.id.clone();
                        apply_config(state, c);
                        send(tx, &ack_ok(id)).await?;
                    }
                    Msg::Lease(l) => {
                        let reply = match state.lease.grant(&l) {
                            Ok(_) => ack_ok(l.id),
                            Err(e) => {
                                warn!(error = %format!("{e:#}"), lease_id = %l.lease_id, "lease rejected");
                                ack_err(l.id, "invalid", "租约无法使用")
                            }
                        };
                        send(tx, &reply).await?;
                    }
                    Msg::Cutoff(c) => {
                        // 落盘失败也已经断流了，照样确认。cutoff 清不清续租快照见 lease::Ledger::cutoff。
                        if let Err(e) = state.lease.cutoff(&c.reason, c.settled_lease_id.as_deref()) {
                            warn!(error = %format!("{e:#}"), "persist cutoff");
                        }
                        send(tx, &ack_ok(c.id)).await?;
                    }
                    Msg::Secret(s) => {
                        let reply = match state.device_key.open(&s.provider_id, &s.key_id, &s.nonce, &s.ciphertext) {
                            Ok(key) => {
                                // 明文只进内存表，不写日志
                                state.secrets.write().unwrap().insert(s.provider_id.clone(), key.to_string());
                                info!(provider_id = %s.provider_id, "upstream secret installed");
                                ack_ok(s.id)
                            }
                            Err(e) => {
                                warn!(provider_id = %s.provider_id, error = ?e, "secret rejected");
                                ack_err(s.id, "invalid", "无法解密上游密钥，请重新登录 OneX 以重新注册设备")
                            }
                        };
                        send(tx, &reply).await?;
                    }
                    Msg::Diag(job) if diagnostic_tasks.is_empty() => {
                        let source = opts.logs.clone();
                        let server = opts.url.clone();
                        let token = token.to_string();
                        let status = json!({"connected": true, "outbox_last_seq": outbox.last_seq(),
                            "config_revision": state.config_revision()});
                        diagnostic_tasks.spawn(async move { diagnostics::run(job, source, &server, &token, status).await });
                    }
                    Msg::Diag(job) => {
                        let reply = DiagResult { id: id::new("msg"), diag_id: job.diag_id, ok: false, detail: json!({"reason": "busy"}) };
                        send(tx, &Msg::DiagResult(reply)).await?;
                    }
                    Msg::Ack(Ack { re, ok: false, error }) => warn!(%re, ?error, "server rejected message"),
                    other => debug!(?other, "ignored"),
                }
            }
        }
    }
}

async fn send_renew(state: &State, tx: &mut Tx) -> Result<()> {
    if let Some(r) = state.lease.take_renew() {
        info!(lease_id = %r.lease_id, used_milli = r.used_milli, op_id = %r.op_id, "lease_renew");
        let m = LeaseRenew { id: id::new("msg"), op_id: r.op_id, lease_id: r.lease_id, used_milli: r.used_milli };
        send(tx, &Msg::LeaseRenew(m)).await?;
    }
    Ok(())
}

/// 处于 cutoff 且没有租约时发一次 `lease_request`（v0.13）。
async fn send_lease_request(state: &State, tx: &mut Tx) -> Result<()> {
    if let Some(op_id) = state.lease.take_lease_request() {
        info!(op_id = %op_id, "lease_request");
        send(tx, &Msg::LeaseRequest(LeaseRequest { id: id::new("msg"), op_id })).await?;
    }
    Ok(())
}

/// Server 的 ack_seq 比本地已确认的小，说明 Server 丢了数据。从 server_ack + 1 重传仍保留的条目，并上报。
async fn report_ack_regression(outbox: &Outbox, tx: &mut Tx, server_ack: u64, local_ack: u64) -> Result<()> {
    let first = outbox.first_seq()?.unwrap_or(local_ack + 1);
    let resend_from = first.max(server_ack + 1);
    warn!(server_ack, local_ack, resend_from, "server ack_seq is behind local ack_seq; resending retained entries");
    let detail = json!({
        "server_ack_seq": server_ack,
        "local_ack_seq": local_ack,
        "resend_from": resend_from,
        "resend_to": local_ack,
        // 已过保留期删掉、补不回来的区间
        "lost": if resend_from > server_ack + 1 { json!([server_ack + 1, resend_from - 1]) } else { Value::Null },
    });
    send(tx, &Msg::DiagResult(DiagResult { id: id::new("msg"), diag_id: "ack_regression".into(), ok: false, detail }))
        .await
}

/// 原子替换；revision 不大于当前值时忽略。
fn apply_config(state: &State, c: Config) {
    let mut cur = state.config.write().unwrap();
    if c.revision > cur.revision {
        info!(revision = c.revision, routes = c.routes.len(), rates = c.rates.len(), "config applied");
        *cur = ConfigSnapshot {
            revision: c.revision,
            routes: c.routes,
            rates: c.rates,
            agents: c.agents,
            agent_cache: c.agent_cache,
        };
    }
}

fn note_ack(outbox: &Outbox, ack_seq: u64) -> Result<()> {
    if outbox.ack(ack_seq)? == AckOutcome::Clamped {
        warn!(ack_seq, last_seq = outbox.last_seq(), "server acked seq that was never sent");
    }
    Ok(())
}

/// 把 seq > sent 的条目按 batch 发出去，连续同类的放在一条消息里。
async fn flush(opts: &WsOptions, outbox: &Outbox, tx: &mut Tx, sent: &mut u64, acked: u64) -> Result<()> {
    while *sent - acked < opts.window {
        let limit = (opts.window - (*sent - acked)).min(opts.batch_max as u64) as usize;
        let rows = outbox.pending(*sent, limit)?;
        let Some(last) = rows.last().map(|r| r.seq) else { break };
        for group in rows.chunk_by(|a, b| a.kind == b.kind) {
            let ty = match group[0].kind {
                Kind::Events => "events",
                Kind::Usage => "usage",
            };
            let batch: Vec<&Value> = group.iter().map(|r| &r.item).collect();
            let text = json!({"type": ty, "id": id::new("msg"), "batch": batch}).to_string();
            tx.send(Message::text(text)).await?;
        }
        debug!(from = *sent + 1, to = last, "outbox sent");
        *sent = last;
    }
    Ok(())
}

async fn send(tx: &mut Tx, m: &Msg) -> Result<()> {
    tx.send(Message::text(serde_json::to_string(m)?)).await?;
    Ok(())
}

async fn recv(rx: &mut Rx) -> Result<Msg> {
    loop {
        match rx.next().await {
            None => bail!("connection closed"),
            Some(Err(e)) => return Err(e.into()),
            Some(Ok(Message::Text(t))) => match serde_json::from_str::<Msg>(&t) {
                Ok(m) => return Ok(m),
                Err(e) => warn!(error = %e, "bad frame from server"),
            },
            Some(Ok(Message::Close(frame))) => {
                if let Some(f) = &frame {
                    if u16::from(f.code) == CLOSE_REPLACED {
                        return Err(Special::Replaced.into());
                    }
                }
                bail!("closed by server: {frame:?}");
            }
            Some(Ok(_)) => {}
        }
    }
}

fn ack_ok(re: String) -> Msg {
    Msg::Ack(Ack { re, ok: true, error: None })
}

fn ack_err(re: String, code: &str, message: &str) -> Msg {
    Msg::Ack(Ack { re, ok: false, error: Some(ErrorBody { code: code.into(), message: message.into(), detail: None }) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps_with_jitter() {
        let (min, max) = (Duration::from_secs(1), Duration::from_secs(30));
        for _ in 0..200 {
            let d0 = backoff(min, max, 0);
            assert!(d0 >= Duration::from_millis(800) && d0 <= Duration::from_millis(1200), "{d0:?}");
            let d3 = backoff(min, max, 3);
            assert!(d3 >= Duration::from_millis(6400) && d3 <= Duration::from_millis(9600), "{d3:?}");
            let d = backoff(min, max, 40);
            assert!(d >= Duration::from_secs(24) && d <= max, "{d:?}");
        }
    }
}
