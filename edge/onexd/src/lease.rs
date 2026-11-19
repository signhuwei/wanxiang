//! 额度租约：放行、实时累计、断流、续租、落盘。
//!
//! 三种金额分开记：
//! - `used`：当前租约下已结束请求的实际花费（按上游报的用量计价）。续租只上报它。
//! - 预留：请求开始时的上限估计，只占放行额度，结束时释放，绝不进 `used`。
//! - 实时花费：进行中的流按已见用量和输出字节估算，只用来判断是否越过额度、中断流。
//!
//! 放行：`used + Σ max(预留, 实时花费) + 本次预留 ≤ budget`。本次预留大于整个租约额度时直接拒绝。
//! 断流：`used + Σ 实时花费 > budget` 时中断那条流。
//! usage 记在请求放行时的租约名下（`Ticket::lease_id`）；结算以 `lease_renew.used_milli` 为准。
//!
//! 续租：实时花费到 80%、放行因额度被拒且已有花费、或剩余租期不足 2 分钟时发 `lease_renew`，
//! `used_milli` 取当时的 `used`（快照）。快照落盘，收到回应（lease 或 cutoff）之前，
//! 重连、重发、重启都原样重放同一份（同一 `op_id`），Server 按第一次的结果回。
//! 新租约到来时 `used -= 快照`，即快照之后才结束的请求记到新租约，不会为负。
//! 没有回应时按 `renew_retry` 重发，等待不超过剩余租期的一半。
//!
//! cutoff：立即拒绝新请求、中断进行中的流。如果它回应的是续租，旧租约已结算，丢弃；
//! 如果是 Server 主动发的，旧租约还没结算，保留它，等进行中的流结束后发一次续租报最终用量。
//!
//! 时间：剩余租期用单调时钟算。收到租约时按 Server 时间换算出剩余时长，之后本机挂钟跳变不影响。
//! 重启后只能从落盘的本机时间恢复，等下一次 welcome 再用 Server 时间校正（只会提前，不会延后）。
//!
//! 落盘用 lastgood。从 `.bak` 恢复时，已用额度取文件与 outbox 里同租约 usage 之和的较大者，不让已花的钱变回没花。
//! 租约绑定签发时的租户；换了租户（重新登录到别的账号）时丢弃旧租约。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use onex_core::ws::Lease;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::lastgood;
use crate::outbox::{Outbox, now_ms};
use crate::pricing::{format_ms, parse_ms};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CutoffReason {
    Balance,
    Disabled,
    Contract,
    Other,
}

impl CutoffReason {
    pub fn parse(s: &str) -> Self {
        match s {
            "balance" => Self::Balance,
            "disabled" => Self::Disabled,
            "contract" => Self::Contract,
            _ => Self::Other,
        }
    }
}

/// 拒绝新请求或中断进行中的流的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Block {
    /// 从没拿到过租约
    NoLease,
    Expired,
    Exhausted,
    /// 单个请求的预留比整个租约额度还大，续租也放不进去
    TooLarge {
        reserve: i64,
        budget: i64,
    },
    Cutoff(CutoffReason),
}

/// 最近一次续租的结果。和过期、上游断流分开记录。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenewResult {
    Granted,
    /// Server 回了 cutoff
    Rejected,
    /// 连接还在，但超时没有回应
    NoResponse,
    /// 续租时控制连接断了
    Unreachable,
}

impl RenewResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Rejected => "rejected",
            Self::NoResponse => "no_response",
            Self::Unreachable => "unreachable",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LeaseOptions {
    pub renew_at_pct: i64,
    pub renew_before: Duration,
    /// 续租没有回应时多久重发；实际等待不超过剩余租期的一半
    pub renew_retry: Duration,
}

impl Default for LeaseOptions {
    fn default() -> Self {
        Self { renew_at_pct: 80, renew_before: Duration::from_secs(120), renew_retry: Duration::from_secs(10) }
    }
}

const MIN_RETRY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub lease_id: String,
    /// Server 时间
    pub expires_at: String,
    /// 本机挂钟下的到期时间，只用于重启后恢复
    pub expires_local_ms: i64,
    pub budget_milli: i64,
    pub seq: u64,
    #[serde(default)]
    pub tenant_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Saved {
    v: u32,
    lease: Option<Grant>,
    used_milli: i64,
    cutoff: Option<String>,
    /// 见过的最大租约 seq，小于等于它的租约是过时的
    lease_seq: u64,
    /// 已发出、还没收到回应的续租。Server 可能已经提交，回应之前只原样重放这一份。
    #[serde(default)]
    renew: Option<PendingRenew>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PendingRenew {
    op_id: String,
    lease_id: String,
    used_milli: i64,
}

const VERSION: u32 = 1;

fn parse_saved(b: &[u8]) -> Option<Saved> {
    serde_json::from_slice::<Saved>(b).ok().filter(|s| s.v == VERSION)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub lease: Option<Grant>,
    /// 已结束请求的实际花费
    pub used_milli: i64,
    /// 进行中请求占用的放行额度（预留与实时花费取大）
    pub inflight_milli: i64,
    pub cutoff: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenewRequest {
    pub lease_id: String,
    pub used_milli: i64,
    pub op_id: String,
}

struct StopSlot {
    token: CancellationToken,
    reason: Mutex<Option<Block>>,
}

impl StopSlot {
    fn stop(&self, b: Block) {
        let mut r = self.reason.lock().unwrap();
        if r.is_none() {
            *r = Some(b);
            self.token.cancel();
        }
    }
}

struct Flight {
    /// 请求开始时的预留，只占放行额度
    reserve: i64,
    /// 实时花费（含输出字节估算），只用来判断是否越过额度
    gate: i64,
    stop: Arc<StopSlot>,
}

impl Flight {
    fn hold(&self) -> i64 {
        self.reserve.max(self.gate)
    }
}

#[derive(Default)]
struct Renew {
    /// 上一次发送续租的时刻；None 表示可以立即发（新连接、刚重启）
    sent_at: Option<Instant>,
    sent: u64,
    last_result: Option<(RenewResult, i64)>,
    /// 放行因额度被拒，且已有花费可以结算
    wanted: bool,
    /// 续租等来的是 cutoff：这条连接上不再重放，下次连上再试
    parked: bool,
}

struct Inner {
    saved: Saved,
    inflight: HashMap<u64, Flight>,
    next_ticket: u64,
    /// 单调时钟下的到期时间
    deadline: Option<Instant>,
    /// deadline 来自重启前落盘的本机挂钟，等 welcome 校正
    deadline_from_wall: bool,
    /// welcome 里的 Server 时间和收到它的单调时刻
    server_ref: Option<(i64, Instant)>,
    tenant_id: Option<String>,
    renew: Renew,
    /// 本租约是否已经因过期中断过进行中的流
    expiry_handled: bool,
}

impl Inner {
    /// 已占用的放行额度
    fn committed(&self) -> i64 {
        self.saved.used_milli + self.inflight.values().map(Flight::hold).sum::<i64>()
    }

    /// 已结束的实际花费加进行中的实时花费
    fn gate_total(&self) -> i64 {
        self.saved.used_milli + self.inflight.values().map(|f| f.gate).sum::<i64>()
    }

    fn remaining(&self, now: Instant) -> Duration {
        self.deadline.map(|d| d.saturating_duration_since(now)).unwrap_or_default()
    }

    fn block(&self, now: Instant) -> Option<Block> {
        if let Some(c) = &self.saved.cutoff {
            return Some(Block::Cutoff(CutoffReason::parse(c)));
        }
        let Some(g) = &self.saved.lease else { return Some(Block::NoLease) };
        if self.remaining(now).is_zero() {
            return Some(Block::Expired);
        }
        if self.committed() >= g.budget_milli {
            return Some(Block::Exhausted);
        }
        None
    }

    fn server_now_ms(&self) -> i64 {
        match self.server_ref {
            Some((ms, at)) => ms + at.elapsed().as_millis() as i64,
            None => now_ms(),
        }
    }

    fn stop_all(&self, b: Block) {
        for f in self.inflight.values() {
            f.stop.stop(b);
        }
    }

    fn set_result(&mut self, r: RenewResult) {
        self.renew.last_result = Some((r, now_ms()));
    }
}

pub struct Ledger {
    path: Option<PathBuf>,
    opts: LeaseOptions,
    inner: Mutex<Inner>,
    /// 有续租要发时加一，WS 客户端监听它
    renew_tx: watch::Sender<u64>,
    /// 租约变化时唤醒定时任务
    changed: Notify,
}

impl Default for Ledger {
    /// 只在内存里，不落盘。测试用。
    fn default() -> Self {
        Self::new(None, LeaseOptions::default(), Saved { v: VERSION, ..Default::default() })
    }
}

impl Ledger {
    fn new(path: Option<PathBuf>, opts: LeaseOptions, saved: Saved) -> Self {
        let now = Instant::now();
        let deadline =
            saved.lease.as_ref().map(|g| now + Duration::from_millis((g.expires_local_ms - now_ms()).max(0) as u64));
        Self {
            path,
            opts,
            inner: Mutex::new(Inner {
                deadline_from_wall: deadline.is_some(),
                deadline,
                saved,
                inflight: HashMap::new(),
                next_ticket: 0,
                server_ref: None,
                tenant_id: None,
                renew: Renew::default(),
                expiry_handled: false,
            }),
            renew_tx: watch::Sender::new(0),
            changed: Notify::new(),
        }
    }

    /// 读取落盘的租约。文件损坏且没有可用备份时不带租约启动（拒绝付费请求），等 Server 下发新租约。
    pub fn open(path: PathBuf, opts: LeaseOptions, outbox: &Outbox) -> Result<Self> {
        let mut saved = match lastgood::read(&path, parse_saved)? {
            lastgood::Read::Missing => Saved { v: VERSION, ..Default::default() },
            lastgood::Read::Valid(s) => s,
            lastgood::Read::Recovered(s) => {
                warn!(path = %path.display(), "lease state was corrupt; recovered from backup");
                s
            }
            lastgood::Read::Unreadable => {
                error!(path = %path.display(), "lease state unreadable; refusing paid requests until server sends a new lease");
                Saved { v: VERSION, ..Default::default() }
            }
        };
        if let Some(g) = &saved.lease {
            // 落盘之后、崩溃之前结束的请求只在 outbox 里；备份恢复也可能比真实花费少。
            let recorded = outbox.usage_cost_for_lease(&g.lease_id)?;
            if recorded > saved.used_milli {
                warn!(lease_id = %g.lease_id, file = saved.used_milli, outbox = recorded, "lease used_milli raised from outbox");
                saved.used_milli = recorded;
            }
            info!(lease_id = %g.lease_id, used_milli = saved.used_milli, budget_milli = g.budget_milli, expires_at = %g.expires_at, "lease restored");
        }
        Ok(Self::new(Some(path), opts, saved))
    }

    pub fn with_options(opts: LeaseOptions) -> Self {
        Self { opts, ..Self::default() }
    }

    pub fn snapshot(&self) -> Snapshot {
        let i = self.inner.lock().unwrap();
        Snapshot {
            lease: i.saved.lease.clone(),
            used_milli: i.saved.used_milli,
            inflight_milli: i.committed() - i.saved.used_milli,
            cutoff: i.saved.cutoff.clone(),
        }
    }

    pub fn lease_id(&self) -> Option<String> {
        self.inner.lock().unwrap().saved.lease.as_ref().map(|g| g.lease_id.clone())
    }

    /// 给 IPC status 用：租约状态和最近一次续租结果，不含凭据。
    pub fn status(&self) -> Value {
        let now = Instant::now();
        let i = self.inner.lock().unwrap();
        let state = match i.block(now) {
            None => "active",
            Some(Block::NoLease) => "none",
            Some(Block::Expired) => "expired",
            Some(Block::Exhausted | Block::TooLarge { .. }) => "exhausted",
            Some(Block::Cutoff(_)) => "cutoff",
        };
        let g = i.saved.lease.as_ref();
        json!({
            "state": state,
            "cutoff_reason": i.saved.cutoff,
            "lease_id": g.map(|g| &g.lease_id),
            "budget_milli": g.map(|g| g.budget_milli),
            "used_milli": i.saved.used_milli,
            "inflight_milli": i.committed() - i.saved.used_milli,
            "expires_at": g.map(|g| &g.expires_at),
            "remaining_ms": g.map(|_| i.remaining(now).as_millis() as u64),
            "renew": {
                "pending": i.saved.renew.is_some(),
                "sent": i.renew.sent,
                "last_result": i.renew.last_result.map(|(r, _)| r.as_str()),
                "last_result_at": i.renew.last_result.map(|(_, at)| format_ms(at)),
            },
        })
    }

    /// 放行一个新请求。剩余额度必须覆盖本次预留 `reserve`。
    pub fn admit(self: &Arc<Self>, reserve: i64) -> Result<Ticket, Block> {
        let now = Instant::now();
        let mut i = self.inner.lock().unwrap();
        let blocked = i.block(now).or_else(|| {
            let budget = i.saved.lease.as_ref().map_or(0, |g| g.budget_milli);
            if reserve > budget {
                Some(Block::TooLarge { reserve, budget })
            } else if i.committed() + reserve > budget {
                Some(Block::Exhausted)
            } else {
                None
            }
        });
        if let Some(b) = blocked {
            // 已结束的花费可以结算掉，腾出额度；只有在途预留时续租也腾不出来
            if b == Block::Exhausted && i.saved.used_milli > 0 {
                i.renew.wanted = true;
            }
            self.check_renew(&i, now);
            return Err(b);
        }
        let id = i.next_ticket;
        i.next_ticket += 1;
        let stop = Arc::new(StopSlot { token: CancellationToken::new(), reason: Mutex::new(None) });
        i.inflight.insert(id, Flight { reserve, gate: 0, stop: stop.clone() });
        let lease_id = i.saved.lease.as_ref().map(|g| g.lease_id.clone());
        Ok(Ticket { id, ledger: self.clone(), stop, lease_id, seen: 0, done: false })
    }

    /// 处理 Server 的 `lease`。返回 false 表示是过时的租约，已忽略。
    /// 已结算的部分（续租快照）从 used 里扣掉，其余的花费记到新租约，包括 cutoff 之后才结束的请求。
    pub fn grant(&self, l: &Lease) -> Result<bool> {
        let expires = parse_ms(&l.expires_at).with_context(|| format!("bad expires_at {:?}", l.expires_at))?;
        let mut i = self.inner.lock().unwrap();
        if l.seq <= i.saved.lease_seq {
            // Server 重发当前租约（设备恢复后 Server 返回仍有效的同一份）：只解除 cutoff，不结算
            let same = i.saved.lease.as_ref().is_some_and(|g| g.seq == l.seq && g.lease_id == l.lease_id);
            if same && i.saved.cutoff.is_some() {
                let mut next = i.saved.clone();
                next.cutoff = None;
                self.persist(&next)?;
                i.saved = next;
                i.renew.parked = false;
                info!(lease_id = %l.lease_id, "current lease reaffirmed; cutoff cleared");
                self.check_renew(&i, Instant::now());
                return Ok(true);
            }
            return Ok(false);
        }
        let remaining_ms = expires - i.server_now_ms();
        let settled = i.saved.renew.as_ref().map(|p| p.used_milli);
        if settled.is_some() {
            i.set_result(RenewResult::Granted);
        }
        let settled = settled.unwrap_or(0);
        let carried = i.saved.used_milli - settled;
        let mut next = i.saved.clone();
        next.renew = None;
        next.lease = Some(Grant {
            lease_id: l.lease_id.clone(),
            expires_at: l.expires_at.clone(),
            expires_local_ms: now_ms() + remaining_ms,
            budget_milli: l.budget_milli,
            seq: l.seq,
            tenant_id: i.tenant_id.clone(),
        });
        next.lease_seq = next.lease_seq.max(l.seq);
        next.used_milli = carried;
        next.cutoff = None;
        // 落盘失败时不改内存状态，等待中的续租快照保留，下次重放
        self.persist(&next)?;
        i.saved = next;
        i.renew.sent_at = None;
        i.renew.wanted = false;
        i.renew.parked = false;
        i.deadline = Some(Instant::now() + Duration::from_millis(remaining_ms.max(0) as u64));
        i.deadline_from_wall = false;
        i.expiry_handled = false;
        info!(lease_id = %l.lease_id, budget_milli = l.budget_milli, expires_at = %l.expires_at, remaining_ms, settled_milli = settled, carried_milli = carried, "lease granted");
        self.check_renew(&i, Instant::now());
        drop(i);
        self.changed.notify_one();
        Ok(true)
    }

    /// 处理 Server 的 `cutoff`：拒绝新请求，中断进行中的流。
    /// 租约、已用额度和续租快照都不动：cutoff 不能说明旧租约已结算（Server 停用设备时不看续租就回 cutoff），
    /// 新租约（seq 更大）到来才说明已结算。等待中的续租在下次连上时再重放；
    /// 没有等待中的续租时，等流都结束后发一次续租报最终用量。
    pub fn cutoff(&self, reason: &str) -> Result<()> {
        let mut i = self.inner.lock().unwrap();
        // 先中断再落盘：落盘失败也不能让流继续花钱。
        i.stop_all(Block::Cutoff(CutoffReason::parse(reason)));
        if i.saved.renew.is_some() {
            i.set_result(RenewResult::Rejected);
            i.renew.parked = true;
        }
        i.renew.sent_at = None;
        i.renew.wanted = false;
        let mut next = i.saved.clone();
        next.cutoff = Some(reason.to_string());
        let r = self.persist(&next);
        i.saved = next;
        warn!(reason, inflight = i.inflight.len(), unsettled_milli = i.saved.used_milli, "cutoff");
        drop(i);
        self.changed.notify_one();
        r
    }

    /// 处理 welcome：记 Server 时间；租户变了就丢弃旧租约；重启恢复的到期时间按 Server 时间校正。
    pub fn on_welcome(&self, server_time: &str, tenant_id: &str) {
        let mut i = self.inner.lock().unwrap();
        let now = Instant::now();
        if let Some(t) = parse_ms(server_time) {
            i.server_ref = Some((t, now));
        }
        i.tenant_id = Some(tenant_id.to_string());
        let Some(g) = i.saved.lease.clone() else { return };
        if g.tenant_id.as_deref().is_some_and(|t| t != tenant_id) {
            warn!(lease_id = %g.lease_id, "lease belongs to another tenant; dropped");
            i.stop_all(Block::NoLease);
            let mut next = i.saved.clone();
            next.lease = None;
            next.used_milli = 0;
            next.renew = None;
            if let Err(e) = self.persist(&next) {
                error!(error = %format!("{e:#}"), "persist lease state");
            }
            i.saved = next;
            i.deadline = None;
            i.renew.sent_at = None;
            return;
        }
        if i.deadline_from_wall {
            if let (Some(exp), Some((st, _))) = (parse_ms(&g.expires_at), i.server_ref) {
                let by_server = now + Duration::from_millis((exp - st).max(0) as u64);
                i.deadline = Some(i.deadline.map_or(by_server, |d| d.min(by_server)));
            }
            i.deadline_from_wall = false;
        }
        drop(i);
        self.changed.notify_one();
    }

    /// 新连接建立：之前发出的续租可能没送到，允许立即重发。
    pub fn on_connected(&self) {
        let mut i = self.inner.lock().unwrap();
        i.renew.sent_at = None;
        i.renew.parked = false;
        self.check_renew(&i, Instant::now());
    }

    /// 控制连接断开：等待中的续租记为网络不可达。不影响进行中的请求。
    pub fn on_disconnected(&self) {
        let mut i = self.inner.lock().unwrap();
        if i.renew.sent_at.take().is_some() && i.saved.renew.is_some() {
            i.set_result(RenewResult::Unreachable);
        }
    }

    /// 需要续租时返回续租请求，并记为已发送。`used_milli` 只含已结束请求的实际花费。
    /// 已有发出但没收到回应的续租时，原样重放它（同一 op_id、同一金额），
    /// 因为 Server 可能已经提交，换一份会被当作冲突。快照先落盘再发，落盘失败就不发。
    pub fn take_renew(&self) -> Option<RenewRequest> {
        let now = Instant::now();
        let mut i = self.inner.lock().unwrap();
        if !self.renew_ready(&i, now) {
            return None;
        }
        if i.renew.sent_at.is_some() {
            i.set_result(RenewResult::NoResponse);
        }
        let p = match &i.saved.renew {
            Some(p) => p.clone(),
            None => {
                let lease_id = i.saved.lease.as_ref()?.lease_id.clone();
                let used = i.saved.used_milli;
                let p = PendingRenew { op_id: format!("{lease_id}:{used}"), lease_id, used_milli: used };
                let mut next = i.saved.clone();
                next.renew = Some(p.clone());
                if let Err(e) = self.persist(&next) {
                    error!(error = %format!("{e:#}"), "persist renew snapshot; not sending lease_renew");
                    return None;
                }
                i.saved = next;
                p
            }
        };
        i.renew.sent_at = Some(now);
        i.renew.sent += 1;
        drop(i);
        // 让定时任务按重发时间重新排程
        self.changed.notify_one();
        Some(RenewRequest { lease_id: p.lease_id, used_milli: p.used_milli, op_id: p.op_id })
    }

    pub fn subscribe_renew(&self) -> watch::Receiver<u64> {
        self.renew_tx.subscribe()
    }

    /// 定时检查续租时间、续租重发和过期。随 daemon 一直运行。
    pub async fn run(self: Arc<Self>, cancel: CancellationToken) {
        loop {
            let wait = self.tick(Instant::now());
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = self.changed.notified() => {}
                _ = tokio::time::sleep(wait) => {}
            }
        }
    }

    /// 处理到期事件，返回距下一个时间点的等待时长。
    fn tick(&self, now: Instant) -> Duration {
        let mut i = self.inner.lock().unwrap();
        self.check_renew(&i, now);
        let idle = Duration::from_secs(3600);
        let (Some(g), Some(deadline)) = (i.saved.lease.clone(), i.deadline) else { return idle };
        let mut next = idle;
        if now >= deadline {
            if !i.expiry_handled {
                i.expiry_handled = true;
                warn!(lease_id = %g.lease_id, inflight = i.inflight.len(), "lease expired");
                i.stop_all(Block::Expired);
            }
        } else {
            next = next.min(deadline - now);
            let renew_at = deadline.checked_sub(self.opts.renew_before).unwrap_or(now);
            if renew_at > now {
                next = next.min(renew_at - now);
            }
        }
        if let Some(at) = i.renew.sent_at {
            let retry_at = at + self.retry_wait(&i, now);
            next = next.min(retry_at.saturating_duration_since(now));
        }
        next.max(Duration::from_millis(1))
    }

    fn retry_wait(&self, i: &Inner, now: Instant) -> Duration {
        let r = i.remaining(now);
        if r.is_zero() { self.opts.renew_retry } else { self.opts.renew_retry.min(r / 2).max(MIN_RETRY) }
    }

    fn renew_due(&self, i: &Inner, now: Instant) -> bool {
        let Some(g) = &i.saved.lease else { return false };
        if i.renew.parked {
            return false;
        }
        if i.saved.renew.is_some() {
            return true;
        }
        if i.saved.cutoff.is_some() {
            // 被主动 cutoff 的租约：流都结束后报一次最终用量
            return i.inflight.is_empty() && i.saved.used_milli > 0;
        }
        i.renew.wanted
            || i.gate_total() * 100 >= g.budget_milli * self.opts.renew_at_pct
            || i.remaining(now) <= self.opts.renew_before
    }

    fn renew_ready(&self, i: &Inner, now: Instant) -> bool {
        self.renew_due(i, now) && i.renew.sent_at.is_none_or(|at| now.duration_since(at) >= self.retry_wait(i, now))
    }

    fn check_renew(&self, i: &Inner, now: Instant) {
        if self.renew_ready(i, now) {
            self.renew_tx.send_modify(|g| *g += 1);
        }
    }

    fn persist(&self, s: &Saved) -> Result<()> {
        let Some(p) = &self.path else { return Ok(()) };
        let data = serde_json::to_vec(s)?;
        lastgood::write(p, &data, |b| parse_saved(b).is_some())
    }

    fn update(&self, id: u64, gate: i64) -> Result<(), Block> {
        let mut i = self.inner.lock().unwrap();
        if let Some(f) = i.inflight.get_mut(&id) {
            f.gate = gate;
        }
        let over = i.saved.lease.as_ref().is_some_and(|g| i.gate_total() > g.budget_milli);
        if over {
            i.renew.wanted = true;
            if let Some(f) = i.inflight.get(&id) {
                f.stop.stop(Block::Exhausted);
            }
        }
        self.check_renew(&i, Instant::now());
        if over { Err(Block::Exhausted) } else { Ok(()) }
    }

    fn release(&self, id: u64, cost: i64) {
        let mut i = self.inner.lock().unwrap();
        if i.inflight.remove(&id).is_none() {
            return;
        }
        let mut next = i.saved.clone();
        next.used_milli += cost;
        if let Err(e) = self.persist(&next) {
            // 内存里照样记账，下次成功落盘或重启时从 outbox 补回。
            error!(error = %format!("{e:#}"), "persist lease state");
        }
        i.saved = next;
        self.check_renew(&i, Instant::now());
    }
}

/// 一个进行中的请求。丢弃时按最后的实际花费结算。
pub struct Ticket {
    id: u64,
    ledger: Arc<Ledger>,
    stop: Arc<StopSlot>,
    lease_id: Option<String>,
    /// 已见花费；没调 finish 就丢弃时按它结算
    seen: i64,
    done: bool,
}

impl Ticket {
    /// 报告进行中的实时花费（已见用量加输出字节估算，不含预留）。
    /// 越过租约额度时返回 `Exhausted`，调用方应中断这条流。
    pub fn update(&mut self, gate: i64) -> Result<(), Block> {
        self.seen = gate;
        if let Some(b) = *self.stop.reason.lock().unwrap() {
            return Err(b);
        }
        self.ledger.update(self.id, gate)
    }

    /// 放行时的租约 id，usage 记在它名下。
    pub fn lease_id(&self) -> Option<&str> {
        self.lease_id.as_deref()
    }

    /// cutoff 或过期时完成。
    pub async fn stopped(&self) -> Block {
        self.stop.token.cancelled().await;
        self.stop.reason.lock().unwrap().unwrap_or(Block::Exhausted)
    }

    /// 结束请求，记最终花费，返回放行时的租约 id。
    pub fn finish(mut self, cost: i64) -> Option<String> {
        self.done = true;
        self.ledger.release(self.id, cost);
        self.lease_id.take()
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.done {
            self.ledger.release(self.id, self.seen);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outbox::Kind;
    use serde_json::json;

    fn lease(id: &str, seq: u64, budget: i64, ttl_ms: i64) -> Lease {
        Lease {
            id: format!("m_{id}"),
            re: None,
            lease_id: id.into(),
            expires_at: format_ms(now_ms() + ttl_ms),
            budget_milli: budget,
            seq,
        }
    }

    fn ledger() -> Arc<Ledger> {
        Arc::new(Ledger::default())
    }

    fn renew(l: &Ledger) -> Option<(String, i64)> {
        l.take_renew().map(|r| (r.lease_id, r.used_milli))
    }

    #[test]
    fn no_lease_blocks() {
        let l = ledger();
        assert_eq!(l.admit(0).err(), Some(Block::NoLease));
        assert_eq!(l.status()["state"], "none");
    }

    #[test]
    fn admits_until_budget_used() {
        let l = ledger();
        l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
        assert_eq!(l.status()["state"], "active");
        let t = l.admit(0).unwrap();
        assert_eq!(t.finish(60).as_deref(), Some("l1"));
        l.admit(0).unwrap().finish(40);
        assert_eq!(l.admit(0).err(), Some(Block::Exhausted));
        assert_eq!(l.snapshot().used_milli, 100);
        assert_eq!(l.status()["state"], "exhausted");
    }

    #[test]
    fn live_cost_crossing_budget_stops_that_stream() {
        let l = ledger();
        l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
        let mut a = l.admit(0).unwrap();
        let mut b = l.admit(0).unwrap();
        a.update(50).unwrap();
        b.update(50).unwrap();
        // 正好用完不算越过
        assert_eq!(l.admit(0).err(), Some(Block::Exhausted));
        assert_eq!(b.update(51), Err(Block::Exhausted));
        // a 的下一次更新也会失败，因为总额已越过
        assert_eq!(a.update(50), Err(Block::Exhausted));
        drop(a);
        b.finish(51);
        assert_eq!(l.snapshot().used_milli, 101);
        assert_eq!(l.snapshot().inflight_milli, 0);
    }

    #[test]
    fn reservation_must_fit_remaining_budget() {
        let l = ledger();
        l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
        // 比整个租约还大：续租也放不进去
        assert_eq!(l.admit(101).err(), Some(Block::TooLarge { reserve: 101, budget: 100 }));
        let mut a = l.admit(60).unwrap();
        // 60 + 50 > 100；只有在途预留，续租腾不出额度，不触发续租
        assert_eq!(l.admit(50).err(), Some(Block::Exhausted));
        assert!(l.take_renew().is_none());
        // 正好用满可以
        let b = l.admit(40).unwrap();
        assert_eq!(l.snapshot().used_milli, 0);
        assert_eq!(l.snapshot().inflight_milli, 100);
        // 实时花费超过预留时按实时花费占放行额度；断流只看实时花费（70 + 0 ≤ 100）
        a.update(70).unwrap();
        assert_eq!(l.snapshot().inflight_milli, 110);
        drop(b);
        // 实际只花 10：预留释放，used 只含 10
        a.finish(10);
        assert_eq!((l.snapshot().used_milli, l.snapshot().inflight_milli), (10, 0));
        assert!(l.admit(90).is_ok());
    }

    #[test]
    fn renew_reports_only_finished_cost_never_reservation() {
        // magpie 阻塞 1 的算例：额度 100，已完成 70，在途预留 20，最后实际只用 5
        let l = ledger();
        l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
        l.admit(0).unwrap().finish(70);
        let t = l.admit(20).unwrap();
        // 90 的放行占用到了 80%，但实时花费只有 70，还不续租
        assert!(l.take_renew().is_none());
        // 下一单放不进去，触发续租；上报 70，不含预留
        assert_eq!(l.admit(20).err(), Some(Block::Exhausted));
        let r = l.take_renew().unwrap();
        assert_eq!((r.used_milli, r.op_id.as_str()), (70, "l1:70"));
        l.grant(&lease("l2", 2, 100, 600_000)).unwrap();
        assert_eq!(l.snapshot().used_milli, 0);
        assert_eq!(t.finish(5).as_deref(), Some("l1"));
        // 快照之后结束的 5 记到新租约，不会为负
        assert_eq!(l.snapshot().used_milli, 5);
        assert_eq!(l.snapshot().inflight_milli, 0);
    }

    #[test]
    fn reservation_alone_cannot_exceed_budget_in_renew() {
        // magpie 阻塞 1 的另一算例：额度 150，预留 200，实际 0。现在预留放不进去，不会出站。
        let l = ledger();
        l.grant(&lease("l1", 1, 150, 600_000)).unwrap();
        assert!(matches!(l.admit(200), Err(Block::TooLarge { .. })));
        let t = l.admit(150).unwrap();
        drop(t);
        assert_eq!(l.snapshot().used_milli, 0);
        assert!(l.take_renew().is_none());
    }

    #[tokio::test]
    async fn cutoff_stops_inflight_and_blocks_new() {
        let l = ledger();
        l.grant(&lease("l1", 1, 1000, 600_000)).unwrap();
        let t = l.admit(0).unwrap();
        l.cutoff("balance").unwrap();
        assert_eq!(t.stopped().await, Block::Cutoff(CutoffReason::Balance));
        assert_eq!(l.admit(0).err(), Some(Block::Cutoff(CutoffReason::Balance)));
        assert!(l.take_renew().is_none());
        assert_eq!(l.status()["state"], "cutoff");
        // 新租约解除 cutoff
        l.grant(&lease("l2", 2, 1000, 600_000)).unwrap();
        assert!(l.admit(0).is_ok());
    }

    #[test]
    fn renew_at_80_percent_and_carry_over() {
        let l = ledger();
        let rx = l.subscribe_renew();
        l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
        assert!(l.take_renew().is_none());
        l.admit(0).unwrap().finish(70);
        assert!(l.take_renew().is_none());
        let mut t = l.admit(0).unwrap();
        t.update(15).unwrap();
        assert!(rx.has_changed().unwrap());
        // 实时花费到 85% 触发续租，但只上报已结束的 70
        let r = l.take_renew().unwrap();
        assert_eq!((r.lease_id.as_str(), r.used_milli, r.op_id.as_str()), ("l1", 70, "l1:70"));
        // 没到重发时间不再发
        assert!(l.take_renew().is_none());
        t.update(20).unwrap();
        l.grant(&lease("l2", 2, 100, 600_000)).unwrap();
        assert_eq!(l.status()["renew"]["last_result"], "granted");
        // 快照之后才结束的流记到新租约；usage 仍记在放行时的租约名下
        assert_eq!(t.finish(20).as_deref(), Some("l1"));
        assert_eq!(l.snapshot().used_milli, 20);
        assert_eq!(l.lease_id().as_deref(), Some("l2"));
    }

    #[test]
    fn renew_near_expiry_and_resend_after_reconnect() {
        let l = ledger();
        l.grant(&lease("l1", 1, 100, 60_000)).unwrap();
        assert_eq!(renew(&l), Some(("l1".into(), 0)));
        assert!(l.take_renew().is_none());
        l.on_disconnected();
        assert_eq!(l.status()["renew"]["last_result"], "unreachable");
        l.on_connected();
        let r = l.take_renew().unwrap();
        // 用量没变，op_id 相同，Server 按第一次的结果回
        assert_eq!(r.op_id, "l1:0");
    }

    #[test]
    fn unanswered_renew_is_replayed_unchanged_even_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        let path = dir.path().join("lease.json");
        {
            let l = Arc::new(Ledger::open(path.clone(), LeaseOptions::default(), &ob).unwrap());
            l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
            l.admit(0).unwrap().finish(85);
            assert_eq!(l.take_renew().unwrap().op_id, "l1:85");
            // 回应之前又花了 10：重连后仍重放 85 那一份，不换 op_id
            l.admit(0).unwrap().finish(10);
            l.on_disconnected();
            l.on_connected();
            let r = l.take_renew().unwrap();
            assert_eq!((r.used_milli, r.op_id.as_str()), (85, "l1:85"));
        }
        // 重启后也一样
        let l = Arc::new(Ledger::open(path, LeaseOptions::default(), &ob).unwrap());
        let r = l.take_renew().unwrap();
        assert_eq!((r.used_milli, r.op_id.as_str()), (85, "l1:85"));
        // 新租约到来后，85 之后的 10 记到新租约，下一次续租按新租约算
        l.grant(&lease("l2", 2, 100, 600_000)).unwrap();
        assert_eq!(l.snapshot().used_milli, 10);
        assert!(l.take_renew().is_none());
    }

    #[test]
    fn renew_retry_wait_is_bounded_by_remaining_lease() {
        let l =
            Arc::new(Ledger::with_options(LeaseOptions { renew_retry: Duration::from_secs(60), ..Default::default() }));
        // 剩余 1.2 秒：重发等待不能是 60 秒，按剩余的一半，最少 0.5 秒
        l.grant(&lease("l1", 1, 100, 1_200)).unwrap();
        assert!(l.take_renew().is_some());
        assert!(l.take_renew().is_none());
        std::thread::sleep(Duration::from_millis(650));
        assert!(l.take_renew().is_some());
        assert_eq!(l.status()["renew"]["last_result"], "no_response");
        assert_eq!(l.status()["renew"]["sent"], 2);
    }

    #[test]
    fn stale_lease_is_ignored() {
        let l = ledger();
        assert!(l.grant(&lease("l2", 2, 100, 600_000)).unwrap());
        assert!(!l.grant(&lease("l1", 1, 999, 600_000)).unwrap());
        assert!(!l.grant(&lease("l2", 2, 999, 600_000)).unwrap());
        assert_eq!(l.snapshot().lease.unwrap().budget_milli, 100);
        assert!(l.grant(&Lease { expires_at: "soon".into(), ..lease("l3", 3, 1, 1) }).is_err());
    }

    #[tokio::test]
    async fn expiry_blocks_new_and_stops_inflight() {
        let l = ledger();
        tokio::spawn(l.clone().run(CancellationToken::new()));
        l.grant(&lease("l1", 1, 1000, 150)).unwrap();
        let t = l.admit(0).unwrap();
        let b = tokio::time::timeout(Duration::from_secs(2), t.stopped()).await.unwrap();
        assert_eq!(b, Block::Expired);
        assert_eq!(l.admit(0).err(), Some(Block::Expired));
        assert_eq!(l.status()["state"], "expired");
        // 过期后仍要续租（同时上报最终用量）
        assert!(l.take_renew().is_some());
    }

    #[test]
    fn remaining_uses_server_time_and_monotonic_clock() {
        let l = ledger();
        // Server 时钟比本机快 1 小时；租约按 Server 时间还有 10 分钟
        l.on_welcome(&format_ms(now_ms() + 3_600_000), "ten_1");
        l.grant(&Lease { expires_at: format_ms(now_ms() + 3_600_000 + 600_000), ..lease("l1", 1, 100, 0) }).unwrap();
        let rem = l.status()["remaining_ms"].as_u64().unwrap();
        assert!((595_000..=600_000).contains(&rem), "{rem}");
        assert!(l.admit(0).is_ok());
        assert_eq!(l.snapshot().lease.unwrap().tenant_id.as_deref(), Some("ten_1"));
    }

    #[test]
    fn restart_restores_lease_and_used() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        let path = dir.path().join("lease.json");
        {
            let l = Arc::new(Ledger::open(path.clone(), LeaseOptions::default(), &ob).unwrap());
            l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
            l.admit(0).unwrap().finish(30);
            l.admit(0).unwrap().finish(20);
        }
        let l = Arc::new(Ledger::open(path.clone(), LeaseOptions::default(), &ob).unwrap());
        let s = l.snapshot();
        assert_eq!((s.lease.unwrap().lease_id.as_str(), s.used_milli), ("l1", 50));
        assert!(l.admit(0).is_ok());
        // 旧租约不能复活
        assert!(!l.grant(&lease("l0", 1, 999, 600_000)).unwrap());

        // 当前文件损坏，从 .bak 恢复的是 used=30 的旧版本；outbox 里有 50，取较大者
        ob.append(Kind::Usage, json!({"lease_id":"l1","cost_milli":30})).unwrap();
        ob.append(Kind::Usage, json!({"lease_id":"l1","cost_milli":20})).unwrap();
        std::fs::write(&path, b"{\"v\":1,").unwrap();
        let l = Arc::new(Ledger::open(path.clone(), LeaseOptions::default(), &ob).unwrap());
        assert_eq!(l.snapshot().used_milli, 50);

        // 文件和备份都坏：不带租约启动
        std::fs::write(&path, b"x").unwrap();
        std::fs::write(dir.path().join("lease.json.bak"), b"x").unwrap();
        let l = Arc::new(Ledger::open(path, LeaseOptions::default(), &ob).unwrap());
        assert_eq!(l.admit(0).err(), Some(Block::NoLease));
    }

    #[test]
    fn restored_deadline_is_corrected_by_server_time_but_never_extended() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        let path = dir.path().join("lease.json");
        {
            let l = Arc::new(Ledger::open(path.clone(), LeaseOptions::default(), &ob).unwrap());
            l.on_welcome(&format_ms(now_ms()), "ten_1");
            l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
        }
        // 重启后 Server 说已经过了 9 分 59 秒：按 Server 时间提前到期
        let l = Arc::new(Ledger::open(path.clone(), LeaseOptions::default(), &ob).unwrap());
        l.on_welcome(&format_ms(now_ms() + 599_000), "ten_1");
        assert!(l.status()["remaining_ms"].as_u64().unwrap() <= 1_000);
        // Server 时间比本机慢：不延长
        let l = Arc::new(Ledger::open(path, LeaseOptions::default(), &ob).unwrap());
        l.on_welcome(&format_ms(now_ms() - 3_600_000), "ten_1");
        assert!(l.status()["remaining_ms"].as_u64().unwrap() <= 600_000);
    }

    #[test]
    fn lease_of_another_tenant_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        let path = dir.path().join("lease.json");
        {
            let l = Arc::new(Ledger::open(path.clone(), LeaseOptions::default(), &ob).unwrap());
            l.on_welcome(&format_ms(now_ms()), "ten_1");
            l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
        }
        let l = Arc::new(Ledger::open(path.clone(), LeaseOptions::default(), &ob).unwrap());
        // 离线时照常使用
        assert!(l.admit(0).is_ok());
        l.on_welcome(&format_ms(now_ms()), "ten_2");
        assert_eq!(l.admit(0).err(), Some(Block::NoLease));
        let l = Arc::new(Ledger::open(path, LeaseOptions::default(), &ob).unwrap());
        assert!(l.lease_id().is_none());
    }

    #[test]
    fn cutoff_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        let path = dir.path().join("lease.json");
        {
            let l = Arc::new(Ledger::open(path.clone(), LeaseOptions::default(), &ob).unwrap());
            l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
            l.admit(0).unwrap().finish(90);
            assert!(l.take_renew().is_some());
            l.cutoff("disabled").unwrap();
            assert_eq!(l.status()["renew"]["last_result"], "rejected");
            // 这条连接上不再重放
            assert!(l.take_renew().is_none());
        }
        let l = Arc::new(Ledger::open(path, LeaseOptions::default(), &ob).unwrap());
        assert_eq!(l.admit(0).err(), Some(Block::Cutoff(CutoffReason::Disabled)));
        // cutoff 不能证明已结算：重启后仍重放同一份续租
        let r = l.take_renew().unwrap();
        assert_eq!((r.used_milli, r.op_id.as_str()), (90, "l1:90"));
    }

    #[test]
    fn unsolicited_cutoff_reports_final_usage_after_streams_end() {
        let l = ledger();
        l.grant(&lease("l1", 1, 1000, 600_000)).unwrap();
        l.admit(0).unwrap().finish(30);
        let mut t = l.admit(0).unwrap();
        t.update(10).unwrap();
        l.cutoff("contract").unwrap();
        // 流还没结束，先不报
        assert!(l.take_renew().is_none());
        drop(t);
        // 中断时已见 10：最终 40 记在旧租约下上报
        let r = l.take_renew().unwrap();
        assert_eq!((r.lease_id.as_str(), r.used_milli), ("l1", 40));
        assert_eq!(l.admit(0).err(), Some(Block::Cutoff(CutoffReason::Contract)));
    }

    #[test]
    fn reaffirmed_lease_clears_cutoff_without_settling() {
        // 设备停用后恢复：Server 在连接时重发同一份仍有效的租约
        let l = ledger();
        let g = lease("l1", 1, 1000, 600_000);
        l.grant(&g).unwrap();
        l.admit(0).unwrap().finish(30);
        l.cutoff("disabled").unwrap();
        l.on_connected();
        assert!(l.grant(&g).unwrap());
        assert!(l.admit(0).is_ok());
        assert_eq!(l.snapshot().used_milli, 30);
    }
}
