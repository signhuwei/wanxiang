//! 到 Server 的 WebSocket 长连接：握手、心跳、配置下发、outbox 回流、指数退避重连。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use onex_core::ws::{
    Ack, BalanceMode, Config, ConfigApplied, DiagResult, ErrorBody, Hello, LeaseRenew, LeaseRequest, Msg,
    PROTOCOL_VERSION, Welcome,
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
use crate::route_apply::{AckMatch, AppliedRecord, Scope, Store as RouteStore};
use crate::state::{ConfigSnapshot, Phase, RouteApply, RouteView, SessionClock, State};
use crate::{diagnostics, id, route_apply, route_stage};
use onex_core::route_pool::{ApplyResult, ROUTE_POOL_V1};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Tx = SplitSink<Ws, Message>;
type Rx = SplitStream<Ws>;

const CLOSE_REPLACED: u16 = 4001;
/// `hello.capabilities`。`route_pool.v1` 在原子应用、信封和连续回执完成前不声明
/// （contracts/routing-p0.md）。
const DECLARED_CAPABILITIES: [&str; 0] = [];
const MISSED_PONGS: u32 = 3;

#[derive(Clone)]
pub struct WsOptions {
    /// 完整地址，例如 `wss://onex.example.com/v1/edge/ws`。
    pub url: String,
    /// 只在隔离测试入口设置：声明 `route_pool.v1` 并把应用结果写入这个本地库。生产 `main.rs` 不设。
    route_pool: Option<Arc<RouteStore>>,
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
            route_pool: None,
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

    /// 隔离测试入口：本连接声明 `route_pool.v1`，按 `contracts/routing-projection.md` 应用投影并回执。
    /// 生产握手、租约和扣费不经过这里。
    #[doc(hidden)]
    pub fn with_route_pool_for_isolated_test(mut self, store: Arc<RouteStore>) -> Self {
        self.route_pool = Some(store);
        self
    }

    fn declared_capabilities(&self) -> Vec<String> {
        let mut declared: Vec<String> = DECLARED_CAPABILITIES.map(String::from).to_vec();
        if self.route_pool.is_some() {
            declared.push(ROUTE_POOL_V1.into());
        }
        declared
    }
}

impl std::fmt::Debug for WsOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WsOptions")
            .field("url", &self.url)
            .field("route_pool", &self.route_pool.is_some())
            .finish_non_exhaustive()
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
                state.end_authentication();
                *state.config.write().unwrap() = ConfigSnapshot::default();
                state.lease.set_commercial_plan(None);
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
            capability_contract_v1: true,
            capability_policy_v2: true,
            policy_runtime_v1: true,
            mac_desktop_v1: cfg!(all(target_os = "macos", target_arch = "aarch64")),
            codex_desktop_v1: cfg!(all(target_os = "macos", target_arch = "aarch64")),
            claude_desktop_v1: cfg!(all(target_os = "macos", target_arch = "aarch64")),
            id: hello_id.clone(),
            edge_version: opts.edge_version.clone(),
            os: onex_core::ipc::os_name().into(),
            arch: onex_core::ipc::arch_name().into(),
            config_revision: state.config_revision(),
            lease_id: state.lease.lease_id(),
            outbox_last_seq: outbox.last_seq(),
            capabilities: opts.declared_capabilities(),
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
    // 读 token 之后再读代次：换号时代次先推进，任一不符都视为旧登录。
    let generation = state.generation();
    // 先于任何状态变更：welcome 选中未声明的能力时整条连接作废。
    let capabilities = negotiated(&opts.declared_capabilities(), welcome)?;
    let pool = match (&opts.route_pool, capabilities.iter().any(|c| c == ROUTE_POOL_V1)) {
        (Some(store), true) => Some(PoolSession::start(opts, state, store, welcome, token, generation)?),
        _ => None,
    };
    {
        let mut config = state.config.write().unwrap();
        if config.policy.as_ref().is_some_and(|policy| !crate::policy::matches_identity(&policy.summary, welcome)) {
            *config = ConfigSnapshot::default();
            state.secrets.write().unwrap().clear();
            state.upstream.lock().unwrap().local_usage = Default::default();
        }
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
    // 模型池测试连接本批不领、不续租约（Server 侧对 lease_request/lease_renew 回 forbidden）。
    let leases = pool.is_none();
    if leases {
        state.lease.on_connected();
        send_renew(state, tx).await?;
        send_lease_request(state, tx).await?;
    }

    flush(opts, outbox, tx, &mut sent, acked).await?;
    let mut token_rx = state.token.subscribe();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            // 模型池连接：登录变化立即结束本连接，旧投影已由 replace_token 封闭。
            r = token_rx.changed(), if pool.is_some() => {
                r.context("token closed")?;
                if !pool.as_ref().is_some_and(|p| p.current(state)) {
                    // 不是取消：断开后 run 按新 token 重连。
                    bail!("authentication changed");
                }
            }
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
            r = renew_rx.changed(), if leases => {
                r.context("lease closed")?;
                send_renew(state, tx).await?;
            }
            r = lease_request_rx.changed(), if leases => {
                r.context("lease closed")?;
                send_lease_request(state, tx).await?;
            }
            r = diagnostic_tasks.join_next(), if !diagnostic_tasks.is_empty() => {
                if let Some(Ok(result)) = r {
                    send(tx, &Msg::DiagResult(result)).await?;
                }
            }
            m = recv_frame(rx, &capabilities) => {
                missed = 0;
                let m = match m? {
                    Frame::Msg(m) => *m,
                    Frame::PoolConfig(value) => {
                        let Some(pool) = &pool else { continue };
                        if !pool.handle_config(state, tx, value).await? {
                            bail!("authentication changed");
                        }
                        continue;
                    }
                    Frame::PoolRefused { id, code, message, reason } => {
                        let detail = json!({"reason": reason});
                        send(tx, &Msg::Ack(Ack { re: id, ok: false, error: Some(ErrorBody {
                            code: code.into(), message: message.into(), detail: Some(detail) }) })).await?;
                        continue;
                    }
                    // 不应用配置、不发放租约、不停任何租约，只回拒绝。
                    Frame::Unnegotiated(u) => {
                        let message = match u.extension {
                            "config.route_pool" => "本连接未协商模型池配置",
                            "lease.signature_id" => "本连接未协商带签发的租约",
                            _ => "本连接未协商目标撤销",
                        };
                        send(tx, &ack_err(u.id, "unsupported_capability", message)).await?;
                        continue;
                    }
                };
                match m {
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
                        if state.token.borrow().as_deref() != Some(token) {
                            return Ok(());
                        }
                        match apply_config(state, welcome, c) {
                            Ok(applied) => {
                                send(tx, &ack_ok(id)).await?;
                                if let Some(proof) = applied
                                    && !cancel.is_cancelled()
                                    && state.token.borrow().as_deref() == Some(token)
                                {
                                    send(tx, &Msg::ConfigApplied(proof)).await?;
                                }
                            }
                            Err(error) => send(tx, &ack_err(id, "invalid", error)).await?,
                        }
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
                        let standalone_secret_allowed = {
                            let config = state.config.read().unwrap();
                            config.policy.is_none() && !config.policy_blocked
                        };
                        let reply = if !standalone_secret_allowed {
                            ack_err(s.id, "invalid", "设备策略要求密钥与快照一起下发")
                        } else { match state.device_key.open(&s.provider_id, &s.key_id, &s.nonce, &s.ciphertext) {
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
                        }};
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
                    Msg::Ack(a) if pool.as_ref().is_some_and(|p| p.handle_ack(&a)) => {}
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
        let m = LeaseRenew {
            id: id::new("msg"),
            op_id: r.op_id,
            lease_id: r.lease_id,
            used_milli: r.used_milli,
            model_used_milli: r.model_used_milli,
        };
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

/// V2 activation replaces routing, rates, releases and keys in one generation.
fn apply_config(state: &State, welcome: &Welcome, mut c: Config) -> Result<Option<ConfigApplied>, &'static str> {
    let mut cur = state.config.write().unwrap();
    if c.revision <= cur.revision {
        return Ok(None);
    }
    let policy = if let Some(policy) = c.policy.take() {
        if !crate::policy::matches_identity(&policy.summary, welcome) {
            return Err("设备策略与当前登录身份不符");
        }
        match crate::policy::stage(state, &c, policy, cur.policy.as_ref()) {
            Ok(applied) => Some(applied),
            Err(error) => {
                cur.policy_blocked = true;
                return Err(error);
            }
        }
    } else {
        if cur.policy.is_some() || cur.policy_blocked {
            return Err("不能以旧版配置覆盖当前设备策略");
        }
        if c.capability_contract.is_some_and(|contract| contract.platform_revision == 0) {
            return Err("平台合约修订号必须大于零");
        }
        None
    };
    let proof = policy.as_ref().map(|applied| ConfigApplied {
        id: id::new("msg"),
        config_revision: c.revision,
        policy_revision: applied.summary.policy_revision,
        projection_id: None,
        result: None,
        error: None,
    });
    if proof.is_some() {
        state.secrets.write().unwrap().clear();
    }
    let restored = !c.routes.is_empty()
        && cur.policy.as_ref().and_then(|value| value.balance.as_ref()).is_some_and(|value| {
            matches!(value.mode, BalanceMode::Restricted | BalanceMode::Stopped)
                && (cur.routes.is_empty()
                    || !policy
                        .as_ref()
                        .and_then(|value| value.balance.as_ref())
                        .is_some_and(|next| matches!(next.mode, BalanceMode::Restricted | BalanceMode::Stopped)))
        });
    info!(revision = c.revision, routes = c.routes.len(), rates = c.rates.len(), "config applied");
    let tools = if policy.is_some() { c.tools } else { Vec::new() };
    state.lease.set_commercial_plan(policy.as_ref().and_then(|p| p.commerce_plan_id.as_deref()));
    *cur = ConfigSnapshot {
        revision: c.revision,
        capability_contract: c.capability_contract,
        policy,
        policy_blocked: false,
        routes: c.routes,
        rates: c.rates,
        agents: c.agents,
        tools,
        agent_cache: c.agent_cache,
    };
    drop(cur);
    if restored {
        state.lease.request_lease_now();
    }
    Ok(proof)
}

/// 一条已协商 `route_pool.v1` 的连接上的设备应用（`contracts/routing-projection.md` 设备协议）。
struct PoolSession {
    store: Arc<RouteStore>,
    scope: Scope,
    tenant_id: String,
    user_id: String,
    device_id: String,
    token: String,
    generation: u64,
    clock: SessionClock,
}

/// `config` 帧里的投影身份。拿不到时只能对原消息回普通失败 ACK。
struct FrameIdentity {
    revision: u64,
    projection_id: String,
    policy_revision: u64,
}

impl FrameIdentity {
    fn of(value: &Value) -> Option<Self> {
        let revision = value.get("revision")?.as_u64().filter(|r| *r > 0)?;
        let projection_id = value.get("route_pool")?.get("projection_id")?.as_str().filter(|s| !s.is_empty())?;
        let policy_revision = value.get("policy")?.get("policy_revision")?.as_u64()?;
        value.get("id")?.as_str()?;
        Some(Self { revision, projection_id: projection_id.to_owned(), policy_revision })
    }
}

impl PoolSession {
    /// 新会话：作用域来自本次认证，可信时间来自本次 welcome。已持久的应用索引进入待同步，
    /// 等同投影的合法重封才恢复执行和重发成功回执。
    fn start(
        opts: &WsOptions,
        state: &State,
        store: &Arc<RouteStore>,
        welcome: &Welcome,
        token: &str,
        generation: u64,
    ) -> Result<Self> {
        let scope = Scope::new(&opts.url, &welcome.tenant_id, &welcome.user_id, &welcome.device_id)
            .context("server url has no origin")?;
        let clock =
            SessionClock::from_welcome(&welcome.server_time).context("welcome.server_time is not a valid time")?;
        let route = match store.load(&scope) {
            Ok(record) => {
                let applied = record.map(|r| r.identity);
                RouteApply::PendingSync { scope: scope.clone(), applied }
            }
            Err(e) => {
                warn!(error = %format!("{e:#}"), "route apply store unreadable; staying pending sync");
                RouteApply::PendingSync { scope: scope.clone(), applied: None }
            }
        };
        if state.generation() != generation {
            bail!(Special::Unauthenticated);
        }
        *state.route.write().unwrap() = route;
        Ok(Self {
            store: store.clone(),
            scope,
            tenant_id: welcome.tenant_id.clone(),
            user_id: welcome.user_id.clone(),
            device_id: welcome.device_id.clone(),
            token: token.to_owned(),
            generation,
            clock,
        })
    }

    /// 本连接的登录仍是当前登录。
    fn current(&self, state: &State) -> bool {
        state.token.borrow().as_deref() == Some(self.token.as_str()) && state.generation() == self.generation
    }

    /// 处理一帧 `config`。返回 false 表示登录已变化，连接应结束。
    async fn handle_config(&self, state: &State, tx: &mut Tx, value: Value) -> Result<bool> {
        if !self.current(state) {
            return Ok(false);
        }
        let Some(frame) = FrameIdentity::of(&value) else {
            let id = value.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
            let detail = json!({"reason": "projection_identity_unavailable"});
            let error =
                ErrorBody { code: "invalid_config".into(), message: "新配置无效".into(), detail: Some(detail) };
            send(tx, &Msg::Ack(Ack { re: id, ok: false, error: Some(error) })).await?;
            return Ok(true);
        };
        let record = match self.store.load(&self.scope) {
            Ok(record) => record,
            Err(e) => {
                self.store_failed(state, "load", &e);
                return Ok(true);
            }
        };
        let session =
            route_stage::Session { tenant_id: &self.tenant_id, user_id: &self.user_id, device_id: &self.device_id };
        let input = route_stage::Input {
            session,
            now_ms: self.clock.now_ms(),
            device_key: &state.device_key,
            applied: record.as_ref().map(|r| &r.identity),
            revocation_revision: record.as_ref().map_or(0, |r| r.revocation_revision),
            adapters: &route_stage::SUPPORTED_ADAPTERS,
        };
        let staged = match route_stage::stage(&value, &input) {
            Ok(staged) => staged,
            Err(e) => {
                let error = e.to_error_body();
                let receipt = ConfigApplied {
                    id: route_apply::rejection_id(
                        &self.scope,
                        frame.revision,
                        &frame.projection_id,
                        frame.policy_revision,
                        &error,
                    ),
                    config_revision: frame.revision as i64,
                    policy_revision: frame.policy_revision,
                    projection_id: Some(frame.projection_id),
                    result: Some(ApplyResult::Rejected),
                    error: Some(error),
                };
                info!(
                    revision = receipt.config_revision,
                    code = e.code,
                    reason = e.reason,
                    "route_pool config rejected"
                );
                if let Err(err) = self.store.record_rejection(&self.scope, &receipt, self.clock.now_ms()) {
                    warn!(error = %format!("{err:#}"), "could not record route_pool rejection");
                }
                if !self.current(state) {
                    return Ok(false);
                }
                send(tx, &Msg::ConfigApplied(receipt)).await?;
                return Ok(true);
            }
        };
        let identity = staged.identity.clone();
        let (policy_revision, expires_at_ms) = (staged.policy_revision, staged.expires_at_ms);
        let (signature_id, revocation_revision, resealed) =
            (staged.signature_id.clone(), staged.revocation_revision, staged.resealed);

        if resealed {
            // 同身份合法重封：换内存密钥并恢复执行；成功回执只在尚未得到成功 ACK 时用原 ID 重发。
            let pending = match self.store.pending_receipt(&self.scope, identity.revision, &identity.projection_id) {
                Ok(pending) => pending,
                Err(e) => {
                    self.store_failed(state, "pending_receipt", &e);
                    return Ok(true);
                }
            };
            let (config, keys) = staged.into_parts();
            let view = RouteView {
                scope: self.scope.clone(),
                identity,
                policy_revision,
                expires_at_ms,
                clock: self.clock,
                config,
                new_notice_ids: Vec::new(),
                keys,
            };
            if !self.switch(state, view) {
                return Ok(false);
            }
            if let Some(pending) = pending {
                send(tx, &Msg::ConfigApplied(pending.to_message())).await?;
            }
            return Ok(true);
        }

        let receipt = ConfigApplied {
            id: id::new("msg"),
            config_revision: identity.revision as i64,
            policy_revision,
            projection_id: Some(identity.projection_id.clone()),
            result: Some(ApplyResult::Applied),
            error: None,
        };
        let record = AppliedRecord {
            identity: identity.clone(),
            policy_revision,
            signature_id,
            revocation_revision,
            expires_at_ms,
            applied_at_ms: self.clock.now_ms(),
        };
        let notice_ids: Vec<&str> = staged.config.policy.notices.iter().map(|n| n.id.as_str()).collect();
        if !self.current(state) {
            return Ok(false);
        }
        let fresh = match self.store.commit_applied(&self.scope, &record, &notice_ids, &receipt) {
            Ok(fresh) => fresh,
            Err(e) => {
                self.store_failed(state, "commit", &e);
                return Ok(true);
            }
        };
        let (config, keys) = staged.into_parts();
        let view = RouteView {
            scope: self.scope.clone(),
            identity,
            policy_revision,
            expires_at_ms,
            clock: self.clock,
            config,
            new_notice_ids: fresh,
            keys,
        };
        if !self.switch(state, view) {
            return Ok(false);
        }
        info!(revision = receipt.config_revision, projection_id = ?receipt.projection_id, "route_pool config applied");
        send(tx, &Msg::ConfigApplied(receipt)).await?;
        Ok(true)
    }

    /// 切换单份可执行视图。登录已变化时不切换。
    fn switch(&self, state: &State, view: RouteView) -> bool {
        let mut route = state.route.write().unwrap();
        if !self.current(state) {
            return false;
        }
        *route = RouteApply::Ready(Arc::new(view));
        true
    }

    /// 本地存储失败：关闭执行门禁、保持待同步，只记脱敏故障，不发成功或拒绝。
    fn store_failed(&self, state: &State, step: &'static str, e: &anyhow::Error) {
        warn!(step, error = %format!("{e:#}"), "route apply store failed; staying pending sync");
        let mut route = state.route.write().unwrap();
        if self.current(state) {
            *route = RouteApply::PendingSync { scope: self.scope.clone(), applied: None };
        }
        state.conn.lock().unwrap().last_error = Some((format!("route_apply_store:{step}"), crate::outbox::now_ms()));
    }

    /// 回执的 ACK。返回 true 表示这是本作用域的回执 ID（已处理）。
    fn handle_ack(&self, ack: &Ack) -> bool {
        let outcome = if ack.ok {
            self.store.ack_ok(&self.scope, &ack.re, self.clock.now_ms())
        } else {
            let code = ack.error.as_ref().map_or("unknown", |e| e.code.as_str());
            self.store.ack_failed(&self.scope, &ack.re, code)
        };
        match outcome {
            Ok(AckMatch::Recorded) => {
                if !ack.ok {
                    warn!(re = %ack.re, error = ?ack.error, "server refused route_pool receipt; keeping it for replay");
                }
                true
            }
            Ok(AckMatch::Unknown) => false,
            Err(e) => {
                warn!(re = %ack.re, error = %format!("{e:#}"), "could not record route_pool receipt ack");
                true
            }
        }
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

/// 本连接 hello 声明且 welcome 选中的能力。只有两边都有的才生效。
fn negotiated(declared: &[String], welcome: &Welcome) -> Result<Vec<String>> {
    if let Some(extra) = welcome.capabilities.iter().find(|c| !declared.contains(c)) {
        bail!("welcome selected undeclared capability {extra}");
    }
    Ok(welcome.capabilities.clone())
}

/// 未协商 `route_pool.v1` 时收到的扩展帧。旧 `Msg` 解析会丢掉扩展字段，所以这些帧
/// 在原始 JSON 上拦截，不能当作旧配置、旧租约或整租约 cutoff 处理。
struct Unnegotiated {
    id: String,
    extension: &'static str,
}

enum Frame {
    Msg(Box<Msg>),
    Unnegotiated(Unnegotiated),
    /// 已协商 `route_pool.v1` 的连接上的 `config`，保留原始 JSON 交给投影应用。
    PoolConfig(Value),
    /// 已协商连接上本批不处理的帧：回失败 ACK，不改任何状态。
    PoolRefused {
        id: String,
        code: &'static str,
        message: &'static str,
        reason: &'static str,
    },
}

async fn recv(rx: &mut Rx) -> Result<Msg> {
    loop {
        if let Frame::Msg(m) = recv_frame(rx, &[]).await? {
            return Ok(*m);
        }
    }
}

async fn recv_frame(rx: &mut Rx, capabilities: &[String]) -> Result<Frame> {
    let pool = capabilities.iter().any(|c| c == onex_core::route_pool::ROUTE_POOL_V1);
    loop {
        match rx.next().await {
            None => bail!("connection closed"),
            Some(Err(e)) => return Err(e.into()),
            Some(Ok(Message::Text(t))) => {
                let value = match serde_json::from_str::<Value>(&t) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(error = %e, "bad frame from server");
                        continue;
                    }
                };
                if !pool && let Some(extension) = onex_core::route_pool::extension_of(&value) {
                    let id = value.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                    warn!(%id, extension, "server sent a route_pool extension on an unnegotiated connection");
                    return Ok(Frame::Unnegotiated(Unnegotiated { id, extension }));
                }
                if pool {
                    let id = || value.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                    match value.get("type").and_then(Value::as_str) {
                        Some("config") => return Ok(Frame::PoolConfig(value)),
                        Some("lease") => {
                            return Ok(Frame::PoolRefused {
                                id: id(),
                                code: "forbidden",
                                message: "模型池测试连接暂不发放租约",
                                reason: "route_pool_lease_pending",
                            });
                        }
                        Some("cutoff") if onex_core::route_pool::extension_of(&value).is_some() => {
                            return Ok(Frame::PoolRefused {
                                id: id(),
                                code: "unsupported_capability",
                                message: "本批未启用目标撤销",
                                reason: "targeted_cutoff_pending",
                            });
                        }
                        _ => {}
                    }
                }
                match serde_json::from_value::<Msg>(value) {
                    Ok(m) => return Ok(Frame::Msg(Box::new(m))),
                    Err(e) => warn!(error = %e, "bad frame from server"),
                }
            }
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
