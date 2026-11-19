//! 到 Server 的 WebSocket 长连接：握手、心跳、配置下发、outbox 回流、指数退避重连。

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use onex_core::ws::{Ack, Config, ErrorBody, Hello, Msg, PROTOCOL_VERSION, Welcome};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::time::{Instant, interval_at, sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::id;
use crate::outbox::{AckOutcome, Kind, Outbox};
use crate::state::{ConfigSnapshot, Phase, State};

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
        }
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
        let delay = match session(&opts, &state, &outbox, &token, &cancel).await {
            End::Cancelled => return,
            End::Unauthenticated => {
                warn!("server rejected device token; waiting for a new login");
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

    match connected(opts, state, outbox, &mut tx, &mut rx, &welcome, cancel).await {
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
            id: hello_id.clone(),
            edge_version: opts.edge_version.clone(),
            os: os_name().into(),
            arch: std::env::consts::ARCH.into(),
            config_revision: state.config_revision(),
            // TODO(S1-E2): 租约
            lease_id: None,
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
    tx: &mut Tx,
    rx: &mut Rx,
    welcome: &Welcome,
    cancel: &CancellationToken,
) -> Result<()> {
    {
        let mut c = state.conn.lock().unwrap();
        c.phase = Phase::Connected;
        c.device_id = Some(welcome.device_id.clone());
        c.user_id = Some(welcome.user_id.clone());
        c.tenant_id = Some(welcome.tenant_id.clone());
        c.connects += 1;
    }
    info!(device_id = %welcome.device_id, ack_seq = welcome.ack_seq, "ws connected");

    // welcome.ack_seq 之前的都已持久化，等同一次 events_ack。
    note_ack(outbox, welcome.ack_seq)?;
    let mut acked = outbox.ack_seq()?;
    if welcome.ack_seq < acked {
        // Server 丢了已确认的数据，本地已删，补不回来。
        warn!(server = welcome.ack_seq, local = acked, "server ack_seq is behind local ack_seq");
    }
    let mut sent = acked;

    let hb = Duration::from_millis(welcome.heartbeat_ms.max(100));
    let mut ticker = interval_at(Instant::now() + hb, hb);
    let mut missed: u32 = 0;
    let mut outbox_rx = outbox.subscribe();

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
            m = recv(rx) => {
                missed = 0;
                match m? {
                    Msg::Ping { id } => send(tx, &Msg::Pong { re: Some(id) }).await?,
                    Msg::Pong { .. } => {}
                    Msg::EventsAck(a) => {
                        note_ack(outbox, a.ack_seq)?;
                        acked = outbox.ack_seq()?;
                        // 重连时可能还有更早发出的确认，sent 不能落到 acked 之后。
                        sent = sent.max(acked);
                        flush(opts, outbox, tx, &mut sent, acked).await?;
                    }
                    Msg::Config(c) => {
                        let id = c.id.clone();
                        apply_config(state, c);
                        send(tx, &ack_ok(id)).await?;
                    }
                    Msg::Secret(s) => {
                        // TODO(S1-E2): X25519 + XChaCha20-Poly1305 解密，等设备注册交换公钥后实现。
                        warn!(provider_id = %s.provider_id, "secret decryption not implemented");
                        send(tx, &ack_err(s.id, "internal", "Edge 暂不支持解密上游密钥")).await?;
                    }
                    Msg::Ack(Ack { re, ok: false, error }) => warn!(%re, ?error, "server rejected message"),
                    // TODO(S1-E2, S1-E5): lease、cutoff、diag、agent_cmd
                    other => debug!(?other, "ignored"),
                }
            }
        }
    }
}

/// 原子替换；revision 不大于当前值时忽略。
fn apply_config(state: &State, c: Config) {
    let mut cur = state.config.write().unwrap();
    if c.revision > cur.revision {
        info!(revision = c.revision, routes = c.routes.len(), "config applied");
        *cur = ConfigSnapshot { revision: c.revision, routes: c.routes };
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

fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
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
