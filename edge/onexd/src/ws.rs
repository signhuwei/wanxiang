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
// `Msg` 的 `lease`/`cutoff` 解析在模型池连接上不用：租约门禁打开时原始 JSON 交给隔离租约存储。
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
    /// 只在隔离测试入口设置：模型池连接上领取、结清隔离租约（`contracts/routing-lease-gate.md`）。
    /// 关闭时隔离连接照旧对租约回 `forbidden/route_pool_lease_pending`。
    route_pool_leases: bool,
    isolated_route_execution: bool,
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
            route_pool_leases: false,
            isolated_route_execution: false,
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

    /// 隔离测试入口的租约门禁开关，默认关闭。须与 [`Self::with_route_pool_for_isolated_test`] 同用。
    /// 租约只记在隔离租约存储里，不进生产 `Ledger`，也不打开真实模型入口。
    #[doc(hidden)]
    pub fn with_route_pool_leases_for_isolated_test(mut self) -> Self {
        self.route_pool_leases = true;
        self
    }

    /// Dedicated loopback fixture. Production clients never select this execution path.
    #[doc(hidden)]
    pub fn with_route_pool_execution_for_isolated_test(mut self) -> Self {
        self.isolated_route_execution = true;
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
            .field("route_pool_leases", &self.route_pool_leases)
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
        state.isolated_route_execution.store(false, std::sync::atomic::Ordering::Release);
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
    // 模型池测试连接不碰生产 Ledger：不领、不续旧租约。租约门禁打开时只用隔离租约存储。
    let leases = pool.is_none();
    let lease_gate = pool.is_some() && opts.route_pool_leases;
    let execution = lease_gate && opts.isolated_route_execution && crate::pool_execution::loopback(&opts.url, "ws");
    if execution && outbox.last_seq() != 0 {
        bail!("isolated route execution needs a fresh dedicated outbox");
    }
    state.isolated_route_execution.store(execution, std::sync::atomic::Ordering::Release);
    let mut runtime_poll = tokio::time::interval(Duration::from_millis(100));
    let mut sent_usage = None;
    if execution && let Some(p) = &pool {
        p.store.ack_isolated_usage(&p.scope, welcome.ack_seq)?;
    }
    let mut pool_leases = PoolLeases::new();
    if leases {
        state.lease.on_connected();
        send_renew(state, tx).await?;
        send_lease_request(state, tx).await?;
    }
    // 重连时先重发在途续租；首领要等同投影的合法重封恢复视图后再发。
    if lease_gate && let Some(p) = &pool {
        p.drive_leases(state, tx, &mut pool_leases).await?;
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
            _ = runtime_poll.tick(), if execution => {
                if let Some(p) = &pool {
                    if sent_usage.is_none() && let Some((seq, payload)) = p.store.pending_isolated_usage(&p.scope)? {
                        let id = id::new("usage");
                        send_value(tx, &json!({"type":"usage","id": id,"batch":[payload]})).await?;
                        sent_usage = Some((id, seq));
                    }
                    p.drive_leases(state, tx, &mut pool_leases).await?;
                }
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
            m = recv_frame(rx, &capabilities, lease_gate) => {
                missed = 0;
                let m = match m? {
                    Frame::Msg(m) => *m,
                    Frame::PoolConfig(value) => {
                        let Some(pool) = &pool else { continue };
                        let before = state.route.read().unwrap().ready().map(|v| v.identity.clone());
                        if !pool.handle_config(state, tx, value).await? {
                            bail!("authentication changed");
                        }
                        let after = state.route.read().unwrap().ready().map(|v| v.identity.clone());
                        if lease_gate {
                            // 新应用身份：之前的门禁拒绝不再适用。
                            if after.is_some() && after != before {
                                pool_leases.gated = None;
                            }
                            pool.drive_leases(state, tx, &mut pool_leases).await?;
                        }
                        continue;
                    }
                    Frame::PoolLease(value) => {
                        if let Some(pool) = &pool {
                            pool.handle_lease(state, tx, &mut pool_leases, value).await?;
                        }
                        continue;
                    }
                    Frame::PoolCutoff(value) => {
                        if let Some(pool) = &pool {
                            pool.handle_cutoff(state, tx, &mut pool_leases, value).await?;
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
                        if execution {
                            if let (Some(p), Some((id, seq))) = (&pool, &sent_usage)
                                && a.re.as_deref() == Some(id.as_str()) && a.ack_seq >= *seq
                            {
                                p.store.ack_isolated_usage(&p.scope, *seq)?;
                                sent_usage = None;
                            }
                            continue;
                        }
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
                    Msg::Ack(a) if pool.as_ref().is_some_and(|p| p.handle_ack(&a)) => {
                        // 成功回执得到匹配的成功 ACK 后，才对该身份首领。
                        if lease_gate && a.ok && let Some(p) = &pool {
                            p.drive_leases(state, tx, &mut pool_leases).await?;
                        }
                    }
                    Msg::Ack(a) if execution && !a.ok && sent_usage.as_ref().is_some_and(|(id, _)| id == &a.re) => {
                        bail!("isolated route usage rejected: {:?}", a.error);
                    }
                    Msg::Ack(a) if lease_gate && pool.is_some() => {
                        let p = pool.as_ref().unwrap();
                        if !p.handle_lease_ack(tx, &mut pool_leases, &a).await? && !a.ok {
                            warn!(re = %a.re, error = ?a.error, "server rejected message");
                        }
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

// ---------------------------------------------------------------------------
// 隔离租约（contracts/routing-lease-gate.md）。只记在 route_apply 库，不进生产 Ledger，
// 独立的回环联验启用实测用量；常规模型池入口继续由门禁保护。
// ---------------------------------------------------------------------------

/// 模型池连接上的隔离租约协调。
struct PoolLeases {
    /// 在途 `lease_request`：(msg id, op_id)。回复前不再发第二份。
    request: Option<(String, String)>,
    /// 最近一次门禁拒绝原因；新目标应用、回执确认后清除再请求。
    gated: Option<String>,
    sent_op: Option<String>,
}

impl PoolLeases {
    fn new() -> Self {
        Self { request: None, gated: None, sent_op: None }
    }
}

/// `lease` 帧里本批要核对的字段。
struct LeaseFrame {
    id: String,
    re: Option<String>,
    settled_lease_id: Option<String>,
    lease: route_apply::PoolLease,
}

impl LeaseFrame {
    fn parse(value: &Value) -> Option<Self> {
        let s = |k: &str| value.get(k).and_then(Value::as_str).map(str::to_owned);
        let expires_at_ms = crate::pricing::parse_ms(value.get("expires_at")?.as_str()?)?;
        let model_budgets = match value.get("model_budgets") {
            None | Some(Value::Null) => Default::default(),
            Some(v) => serde_json::from_value(v.clone()).ok()?,
        };
        Some(Self {
            id: s("id")?,
            re: s("re"),
            settled_lease_id: s("settled_lease_id"),
            lease: route_apply::PoolLease {
                lease_id: s("lease_id")?,
                state: route_apply::PoolLeaseState::Accepted,
                config_revision: value.get("config_revision")?.as_u64()?,
                projection_id: s("projection_id")?,
                signature_id: s("signature_id")?,
                commerce_plan_id: s("commerce_plan_id"),
                expires_at_ms,
                budget_milli: value.get("budget_milli")?.as_i64()?,
                model_budgets,
            },
        })
    }
}

impl PoolSession {
    /// 当前可接受租约的应用视图：Ready，且其成功回执已获得成功 ACK（含重启前持久的确认）。
    fn acked_view(&self, state: &State) -> Option<Arc<RouteView>> {
        let view = state.route.read().unwrap().ready().cloned()?;
        if !self.current(state) || !view.executable() {
            return None;
        }
        let acked = self.store.view_receipt_acked(&self.scope, view.identity.revision, &view.identity.projection_id);
        acked.ok().filter(|a| *a).map(|_| view)
    }

    fn signature_of(view: &RouteView) -> (&str, Option<&str>) {
        (view.config.route_pool.signature_id.as_str(), view.config.policy.commerce_plan_id.as_deref())
    }

    /// 首次接受：签发、方案、修订与投影 ID 必须和当前已确认应用视图精确匹配。
    fn matches_view(lease: &route_apply::PoolLease, view: &RouteView) -> bool {
        let (signature, plan) = Self::signature_of(view);
        lease.signature_id == signature
            && lease.commerce_plan_id.as_deref() == plan
            && lease.config_revision == view.identity.revision
            && lease.projection_id == view.identity.projection_id
            && lease.expires_at_ms <= view.expires_at_ms
    }

    /// 已接受的租约在纯换池后继续可用：同签发、同方案、未过期，且不早于本设备不再授权的边界。
    fn still_usable(lease: &route_apply::PoolLease, view: &RouteView) -> bool {
        let (signature, plan) = Self::signature_of(view);
        lease.signature_id == signature
            && lease.commerce_plan_id.as_deref() == plan
            && lease.config_revision <= view.identity.revision
            && view.clock.now_ms() < lease.expires_at_ms
    }

    /// 检查是否该发续租或首领。在连接建立、回执 ACK、lease/cutoff 处理后调用。
    async fn drive_leases(&self, state: &State, tx: &mut Tx, leases: &mut PoolLeases) -> Result<()> {
        if !self.current(state) {
            return Ok(());
        }
        // 1. 在途或待重发的续租，原样重发（同 msg id、op_id 和数值）。
        let ops = match self.store.pending_pool_ops(&self.scope) {
            Ok(ops) => ops,
            Err(e) => {
                warn!(error = %format!("{e:#}"), "could not read pending lease_renew");
                return Ok(());
            }
        };
        if let Some(op) = ops.first() {
            if leases.sent_op.as_deref() != Some(op.op_id.as_str()) {
                self.send_pool_operation(tx, op).await?;
                leases.sent_op = Some(op.op_id.clone());
            }
            return Ok(());
        }
        let Some(view) = self.acked_view(state) else { return Ok(()) };
        // 2. 已接受但不再可用的租约：先结清。
        if let Ok(Some(held)) = self.store.accepted_pool_lease(&self.scope) {
            if let Some((_, payload, acked)) = self.store.isolated_usage_for_lease(&self.scope, &held.lease_id)? {
                if acked && let Some(payload) = payload {
                    let op = self.store.begin_isolated_metered_settlement(
                        &self.scope,
                        &held,
                        &payload,
                        self.clock.now_ms(),
                    )?;
                    self.send_pool_operation(tx, &op).await?;
                    leases.sent_op = Some(op.op_id);
                }
                return Ok(());
            }
            if Self::still_usable(&held, &view) {
                return Ok(());
            }
            let op = self.store.begin_settlement(&self.scope, &held, self.clock.now_ms())?;
            info!(lease_id = %held.lease_id, op_id = %op.op_id, "settling route_pool lease no longer valid for the applied view");
            self.send_pool_operation(tx, &op).await?;
            leases.sent_op = Some(op.op_id);
            return Ok(());
        }
        // 3. 首领。门禁拒绝后等新目标应用再请求。
        if leases.request.is_some() || leases.gated.is_some() {
            return Ok(());
        }
        let request = (id::new("msg"), id::new("op"));
        info!(op_id = %request.1, revision = view.identity.revision, "route_pool lease_request");
        send(tx, &Msg::LeaseRequest(LeaseRequest { id: request.0.clone(), op_id: request.1.clone() })).await?;
        leases.request = Some(request);
        Ok(())
    }

    async fn send_pool_operation(&self, tx: &mut Tx, op: &route_apply::PoolLeaseOp) -> Result<()> {
        let mut frame = op.to_frame();
        if let Some((Some(seq), _, true)) = self.store.isolated_usage_for_lease(&self.scope, &op.lease_id)? {
            frame["usage_through_seq"] = seq.into();
        }
        send_value(tx, &frame).await
    }

    /// 处理租约门禁打开时的 `lease`。
    async fn handle_lease(&self, state: &State, tx: &mut Tx, leases: &mut PoolLeases, value: Value) -> Result<()> {
        let Some(frame) = LeaseFrame::parse(&value) else {
            let id = value.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
            send(tx, &lease_mismatch(id, "lease_fields_missing")).await?;
            return Ok(());
        };
        let now = self.clock.now_ms();
        // 本帧是对哪个在途操作的回复。
        let op = match frame.re.as_deref() {
            Some(re) => self.store.pending_pool_ops(&self.scope)?.into_iter().find(|op| op.msg_id == re),
            None => None,
        };
        let settled = op.filter(|op| frame.settled_lease_id.as_deref() == Some(op.lease_id.as_str()));
        if frame.re.is_some() && leases.request.as_ref().is_some_and(|(id, _)| Some(id) == frame.re.as_ref()) {
            leases.request = None;
        }
        // 重申：已接受的同一份租约。
        if let Ok(Some(existing)) = self.store.pool_lease(&self.scope, &frame.lease.lease_id) {
            match existing.state {
                route_apply::PoolLeaseState::Accepted => {
                    if let Some(op) = &settled {
                        self.store.complete_settlement(&self.scope, op, now)?;
                    }
                    send(tx, &ack_ok(frame.id)).await?;
                    return self.drive_leases(state, tx, leases).await;
                }
                // 已拒用或已结清的租约再出现：不再接受，按其在途操作处理。
                _ => {
                    send(tx, &lease_mismatch(frame.id, "lease_already_closed")).await?;
                    return self.drive_leases(state, tx, leases).await;
                }
            }
        }
        let view = self.acked_view(state);
        let accept = view.as_ref().is_some_and(|v| Self::matches_view(&frame.lease, v));
        if accept {
            if let Err(e) = self.store.accept_pool_lease(&self.scope, &frame.lease, settled.as_ref(), now) {
                warn!(error = %format!("{e:#}"), "could not persist route_pool lease; not using it");
                return Ok(());
            }
            leases.gated = None;
            info!(lease_id = %frame.lease.lease_id, revision = frame.lease.config_revision,
                projection_id = %frame.lease.projection_id, "route_pool lease accepted (synthetic ledger only)");
            send(tx, &ack_ok(frame.id)).await?;
            return Ok(());
        }
        // 拒用：拒用标记与零用量 release_only 先落盘，再发送；失败 ACK 本身不结清。
        let (view_revision, view_projection) = view
            .as_ref()
            .map(|v| (Some(v.identity.revision), Some(v.identity.projection_id.clone())))
            .unwrap_or_default();
        warn!(lease_id = %frame.lease.lease_id, lease_revision = frame.lease.config_revision,
            lease_projection_id = %frame.lease.projection_id, signature_id = %frame.lease.signature_id,
            ?view_revision, ?view_projection, "lease_projection_mismatch");
        let op = match self.store.refuse_pool_lease(
            &self.scope,
            &frame.lease,
            "lease_projection_mismatch",
            settled.as_ref(),
            now,
        ) {
            Ok(op) => op,
            Err(e) => {
                warn!(error = %format!("{e:#}"), "could not persist route_pool lease refusal");
                send(tx, &lease_mismatch(frame.id, "lease_projection_mismatch")).await?;
                return Ok(());
            }
        };
        send(tx, &lease_mismatch(frame.id, "lease_projection_mismatch")).await?;
        send_value(tx, &op.to_frame()).await?;
        Ok(())
    }

    /// 租约门禁打开时的普通 `cutoff`：只按在途操作的 `re` 和匹配的旧租约 ID 移除结清记录。
    async fn handle_cutoff(&self, state: &State, tx: &mut Tx, leases: &mut PoolLeases, value: Value) -> Result<()> {
        let id = value.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let re = value.get("re").and_then(Value::as_str);
        let settled = value.get("settled_lease_id").and_then(Value::as_str);
        let detail = value.get("detail").and_then(|d| d.get("reason")).and_then(Value::as_str);
        let next_lease = value.get("detail").and_then(|d| d.get("lease_id")).and_then(Value::as_str);
        let ops = self.store.pending_pool_ops(&self.scope)?;
        if let Some(op) = ops.iter().find(|op| Some(op.msg_id.as_str()) == re && Some(op.lease_id.as_str()) == settled)
        {
            self.store.complete_settlement(&self.scope, op, self.clock.now_ms())?;
            info!(lease_id = %op.lease_id, release_only = op.release_only, reason = ?detail, "route_pool lease settled");
        }
        send(tx, &ack_ok(id)).await?;
        // 重放回复里仍有待结清的后继：它是 Edge 可能从未见过的租约，按 lease_settlement_required 处理。
        if detail == Some("successor_lease_unavailable")
            && let Some(next) = next_lease
        {
            self.settle_unknown(tx, next).await?;
            return Ok(());
        }
        self.drive_leases(state, tx, leases).await
    }

    /// `lease_request` 的失败 ACK。返回 true 表示已处理。
    async fn handle_lease_ack(&self, tx: &mut Tx, leases: &mut PoolLeases, ack: &Ack) -> Result<bool> {
        if !ack.ok && leases.request.as_ref().is_some_and(|(id, _)| id == &ack.re) {
            leases.request = None;
            let reason = ack
                .error
                .as_ref()
                .and_then(|e| e.detail.as_ref())
                .and_then(|d| d.get("reason"))
                .and_then(Value::as_str);
            let lease_id = ack
                .error
                .as_ref()
                .and_then(|e| e.detail.as_ref())
                .and_then(|d| d.get("lease_id"))
                .and_then(Value::as_str);
            match (reason, lease_id) {
                (Some("lease_settlement_required"), Some(lease_id)) => {
                    match self.store.pool_lease(&self.scope, lease_id)? {
                        Some(held) if held.state == route_apply::PoolLeaseState::Accepted => {
                            if self.store.isolated_usage_for_lease(&self.scope, &held.lease_id)?.is_none() {
                                let op = self.store.begin_settlement(&self.scope, &held, self.clock.now_ms())?;
                                self.send_pool_operation(tx, &op).await?;
                                leases.sent_op = Some(op.op_id);
                            }
                        }
                        _ => self.settle_unknown(tx, lease_id).await?,
                    }
                }
                (reason, _) => {
                    // projection_* 及其余：保持门禁，等新目标应用、回执确认后再请求。
                    info!(?reason, "route_pool lease_request refused; waiting for a new applied target");
                    leases.gated = Some(reason.unwrap_or("unknown").to_owned());
                }
            }
            return Ok(true);
        }
        if !ack.ok
            && let Ok(AckMatch::Recorded) = self.store.pool_op_failed(
                &self.scope,
                &ack.re,
                ack.error.as_ref().map_or("unknown", |e| e.code.as_str()),
            )
        {
            warn!(re = %ack.re, error = ?ack.error, "server refused lease_renew; keeping the operation for replay");
            return Ok(true);
        }
        Ok(false)
    }

    /// 结清一份 Edge 从未见过的租约。Edge 不知道它的 model_budgets，也从未用它放行过请求；
    /// 冻结契约未给出这种形状，本批只记脱敏故障，不臆造用量。
    async fn settle_unknown(&self, _tx: &mut Tx, lease_id: &str) -> Result<()> {
        warn!(%lease_id, "server asks to settle a lease this device never saw; waiting for an authoritative resend");
        Ok(())
    }
}

fn lease_mismatch(re: String, reason: &str) -> Msg {
    Msg::Ack(Ack {
        re,
        ok: false,
        error: Some(ErrorBody {
            code: "invalid".into(),
            message: "租约与设备已应用的配置不符".into(),
            detail: Some(json!({"reason": reason})),
        }),
    })
}

async fn send_value(tx: &mut Tx, v: &Value) -> Result<()> {
    tx.send(Message::text(v.to_string())).await?;
    Ok(())
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
    /// 租约门禁打开时模型池连接上的 `lease`，交给隔离租约存储。
    PoolLease(Value),
    /// 租约门禁打开时模型池连接上的普通 `cutoff`（不含目标撤销）。
    PoolCutoff(Value),
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
        if let Frame::Msg(m) = recv_frame(rx, &[], false).await? {
            return Ok(*m);
        }
    }
}

async fn recv_frame(rx: &mut Rx, capabilities: &[String], lease_gate: bool) -> Result<Frame> {
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
                    let targeted = onex_core::route_pool::extension_of(&value) == Some("cutoff.targets");
                    match value.get("type").and_then(Value::as_str) {
                        Some("config") => return Ok(Frame::PoolConfig(value)),
                        // 隔离租约：交给模型池会话，决不进生产 Ledger。
                        Some("lease") if lease_gate => return Ok(Frame::PoolLease(value)),
                        Some("cutoff") if lease_gate && !targeted => return Ok(Frame::PoolCutoff(value)),
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
