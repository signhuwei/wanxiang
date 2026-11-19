//! 额度租约：放行、实时累计、断流、续租、落盘。
//!
//! 记账口径：`used` 是当前租约下已结束请求的花费，进行中的请求各自有一个实时花费 `live`，
//! 总花费 = used + Σ live。总花费越过 `budget_milli` 时，下一次更新的那条流被中断，之后的新请求被拒绝。
//!
//! 续租：总花费到 80% 或距过期不足 2 分钟（或已过期、已用完）时发 `lease_renew{used_milli=总花费}`，
//! 并记下这个快照。新租约到来时 `used -= 快照`，快照之后进行中的请求继续花的钱算到新租约上。
//! `used_milli` 是这个租约的累计绝对值，重连后重发同一租约的续租是幂等的。
//!
//! 落盘用 lastgood。从 `.bak` 恢复时，已用额度取文件与 outbox 里同租约 usage 之和的较大者，不让已花的钱变回没花。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use onex_core::ws::Lease;
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::lastgood;
use crate::outbox::{Outbox, now_ms};
use crate::pricing::parse_ms;

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

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Balance => "balance",
            Self::Disabled => "disabled",
            Self::Contract => "contract",
            Self::Other => "other",
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
    Cutoff(CutoffReason),
}

#[derive(Debug, Clone, Copy)]
pub struct LeaseOptions {
    pub renew_at_pct: i64,
    pub renew_before: Duration,
}

impl Default for LeaseOptions {
    fn default() -> Self {
        Self { renew_at_pct: 80, renew_before: Duration::from_secs(120) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub lease_id: String,
    /// Server 时间
    pub expires_at: String,
    /// 按收到租约时的时钟偏差换算成本机时间
    pub expires_local_ms: i64,
    pub budget_milli: i64,
    pub seq: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Saved {
    v: u32,
    lease: Option<Grant>,
    used_milli: i64,
    cutoff: Option<String>,
    /// 见过的最大租约 seq，小于等于它的租约是过时的
    lease_seq: u64,
}

const VERSION: u32 = 1;

fn parse_saved(b: &[u8]) -> Option<Saved> {
    serde_json::from_slice::<Saved>(b).ok().filter(|s| s.v == VERSION)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub lease: Option<Grant>,
    pub used_milli: i64,
    pub inflight_milli: i64,
    pub cutoff: Option<String>,
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
    /// 计入放行判断的花费：已见花费与预留取大
    live: i64,
    /// 已见的实际花费，只用它判断是否越过额度、中断流
    seen: i64,
    stop: Arc<StopSlot>,
}

struct Inner {
    saved: Saved,
    inflight: HashMap<u64, Flight>,
    next_ticket: u64,
    renew_sent: bool,
    /// 最近一次发出的 lease_renew 的 used_milli
    renew_snapshot: Option<i64>,
    /// Server 时间 − 本机时间
    skew_ms: i64,
    /// 本租约是否已经因过期中断过进行中的流
    expiry_handled: bool,
}

impl Inner {
    fn total(&self) -> i64 {
        self.saved.used_milli + self.inflight.values().map(|f| f.live).sum::<i64>()
    }

    fn total_seen(&self) -> i64 {
        self.saved.used_milli + self.inflight.values().map(|f| f.seen).sum::<i64>()
    }

    fn block(&self, now: i64) -> Option<Block> {
        if let Some(c) = &self.saved.cutoff {
            return Some(Block::Cutoff(CutoffReason::parse(c)));
        }
        let Some(g) = &self.saved.lease else { return Some(Block::NoLease) };
        if now >= g.expires_local_ms {
            return Some(Block::Expired);
        }
        if self.total() >= g.budget_milli {
            return Some(Block::Exhausted);
        }
        None
    }

    fn stop_all(&self, b: Block) {
        for f in self.inflight.values() {
            f.stop.stop(b);
        }
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
        Self {
            path,
            opts,
            inner: Mutex::new(Inner {
                saved,
                inflight: HashMap::new(),
                next_ticket: 0,
                renew_sent: false,
                renew_snapshot: None,
                skew_ms: 0,
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
            inflight_milli: i.total() - i.saved.used_milli,
            cutoff: i.saved.cutoff.clone(),
        }
    }

    pub fn lease_id(&self) -> Option<String> {
        self.inner.lock().unwrap().saved.lease.as_ref().map(|g| g.lease_id.clone())
    }

    /// 放行一个新请求。`initial` 是请求开始时的预留（只在终帧报用量的上游用），不要求剩余额度覆盖它。
    pub fn admit(self: &Arc<Self>, initial: i64) -> Result<Ticket, Block> {
        let now = now_ms();
        let mut i = self.inner.lock().unwrap();
        if let Some(b) = i.block(now) {
            self.check_renew(&mut i, now);
            return Err(b);
        }
        let id = i.next_ticket;
        i.next_ticket += 1;
        let stop = Arc::new(StopSlot { token: CancellationToken::new(), reason: Mutex::new(None) });
        i.inflight.insert(id, Flight { live: initial, seen: 0, stop: stop.clone() });
        self.check_renew(&mut i, now);
        Ok(Ticket { id, ledger: self.clone(), stop, live: initial, done: false })
    }

    /// 处理 Server 的 `lease`。返回 false 表示是过时的租约，已忽略。
    pub fn grant(&self, l: &Lease) -> Result<bool> {
        let expires = parse_ms(&l.expires_at).with_context(|| format!("bad expires_at {:?}", l.expires_at))?;
        let mut i = self.inner.lock().unwrap();
        if l.seq <= i.saved.lease_seq && i.saved.lease.is_some() {
            return Ok(false);
        }
        let carried = match i.renew_snapshot.take() {
            Some(s) => i.saved.used_milli - s,
            None => 0,
        };
        let mut next = i.saved.clone();
        next.lease = Some(Grant {
            lease_id: l.lease_id.clone(),
            expires_at: l.expires_at.clone(),
            expires_local_ms: expires - i.skew_ms,
            budget_milli: l.budget_milli,
            seq: l.seq,
        });
        next.lease_seq = next.lease_seq.max(l.seq);
        next.used_milli = carried;
        next.cutoff = None;
        self.persist(&next)?;
        i.saved = next;
        i.renew_sent = false;
        i.expiry_handled = false;
        info!(lease_id = %l.lease_id, budget_milli = l.budget_milli, expires_at = %l.expires_at, carried_milli = carried, "lease granted");
        self.check_renew(&mut i, now_ms());
        drop(i);
        self.changed.notify_one();
        Ok(true)
    }

    /// 处理 Server 的 `cutoff`：丢弃租约，拒绝新请求，中断进行中的流。
    pub fn cutoff(&self, reason: &str) -> Result<()> {
        let mut i = self.inner.lock().unwrap();
        let mut next = i.saved.clone();
        next.cutoff = Some(reason.to_string());
        next.lease = None;
        next.used_milli = 0;
        // 先中断再落盘：落盘失败也不能让流继续花钱。
        i.stop_all(Block::Cutoff(CutoffReason::parse(reason)));
        i.renew_snapshot = None;
        let r = self.persist(&next);
        i.saved = next;
        warn!(reason, inflight = i.inflight.len(), "cutoff");
        drop(i);
        self.changed.notify_one();
        r
    }

    /// 由 welcome 的 server_time 算时钟偏差，之后收到的租约按它换算到期时间。
    pub fn set_server_time(&self, server_time: &str) {
        if let Some(t) = parse_ms(server_time) {
            self.inner.lock().unwrap().skew_ms = t - now_ms();
        }
    }

    /// 新连接建立：之前发出的续租可能没送到，允许重发。
    pub fn on_connected(&self) {
        let mut i = self.inner.lock().unwrap();
        i.renew_sent = false;
        self.check_renew(&mut i, now_ms());
    }

    /// 需要续租时返回 `(lease_id, used_milli)`，并记为已发送。
    pub fn take_renew(&self) -> Option<(String, i64)> {
        let mut i = self.inner.lock().unwrap();
        if i.renew_sent || !self.renew_due(&i, now_ms()) {
            return None;
        }
        let lease_id = i.saved.lease.as_ref()?.lease_id.clone();
        let used = i.total();
        i.renew_sent = true;
        i.renew_snapshot = Some(used);
        Some((lease_id, used))
    }

    pub fn subscribe_renew(&self) -> watch::Receiver<u64> {
        self.renew_tx.subscribe()
    }

    /// 定时检查续租时间和过期。随 daemon 一直运行。
    pub async fn run(self: Arc<Self>, cancel: CancellationToken) {
        loop {
            let wait = self.tick(now_ms());
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = self.changed.notified() => {}
                _ = tokio::time::sleep(wait) => {}
            }
        }
    }

    /// 处理到期事件，返回距下一个时间点的等待时长。
    fn tick(&self, now: i64) -> Duration {
        let mut i = self.inner.lock().unwrap();
        self.check_renew(&mut i, now);
        let Some(g) = i.saved.lease.clone() else { return Duration::from_secs(3600) };
        if now >= g.expires_local_ms {
            if !i.expiry_handled {
                i.expiry_handled = true;
                warn!(lease_id = %g.lease_id, inflight = i.inflight.len(), "lease expired");
                i.stop_all(Block::Expired);
            }
            return Duration::from_secs(3600);
        }
        let renew_at = g.expires_local_ms - self.opts.renew_before.as_millis() as i64;
        let next = if now < renew_at { renew_at } else { g.expires_local_ms };
        Duration::from_millis((next - now).max(1) as u64)
    }

    fn renew_due(&self, i: &Inner, now: i64) -> bool {
        if i.saved.cutoff.is_some() {
            return false;
        }
        let Some(g) = &i.saved.lease else { return false };
        i.total() * 100 >= g.budget_milli * self.opts.renew_at_pct
            || now >= g.expires_local_ms - self.opts.renew_before.as_millis() as i64
    }

    fn check_renew(&self, i: &mut Inner, now: i64) {
        if !i.renew_sent && self.renew_due(i, now) {
            self.renew_tx.send_modify(|g| *g += 1);
        }
    }

    fn persist(&self, s: &Saved) -> Result<()> {
        let Some(p) = &self.path else { return Ok(()) };
        let data = serde_json::to_vec(s)?;
        lastgood::write(p, &data, |b| parse_saved(b).is_some())
    }

    fn update(&self, id: u64, live: i64, seen: i64) -> Result<(), Block> {
        let now = now_ms();
        let mut i = self.inner.lock().unwrap();
        if let Some(f) = i.inflight.get_mut(&id) {
            f.live = live.max(seen);
            f.seen = seen;
        }
        let over = i.saved.lease.as_ref().is_some_and(|g| i.total_seen() > g.budget_milli);
        self.check_renew(&mut i, now);
        if over {
            if let Some(f) = i.inflight.get(&id) {
                f.stop.stop(Block::Exhausted);
            }
            return Err(Block::Exhausted);
        }
        Ok(())
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
        self.check_renew(&mut i, now_ms());
    }
}

/// 一个进行中的请求。丢弃时按最后的实时花费结算。
pub struct Ticket {
    id: u64,
    ledger: Arc<Ledger>,
    stop: Arc<StopSlot>,
    live: i64,
    done: bool,
}

impl Ticket {
    /// 报告实时花费：`live` 含预留，计入放行判断；`seen` 是已见的实际花费。
    /// 实际花费越过租约额度时返回 `Exhausted`，调用方应中断这条流。
    pub fn update(&mut self, live: i64, seen: i64) -> Result<(), Block> {
        self.live = seen;
        if let Some(b) = *self.stop.reason.lock().unwrap() {
            return Err(b);
        }
        self.ledger.update(self.id, live, seen)
    }

    /// cutoff 或过期时完成。
    pub async fn stopped(&self) -> Block {
        self.stop.token.cancelled().await;
        self.stop.reason.lock().unwrap().unwrap_or(Block::Exhausted)
    }

    /// 结束请求，记最终花费，返回结算时的租约 id。
    pub fn finish(mut self, cost: i64) -> Option<String> {
        self.live = cost;
        self.done = true;
        self.ledger.release(self.id, cost);
        self.ledger.lease_id()
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.done {
            self.ledger.release(self.id, self.live);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outbox::Kind;
    use crate::pricing::format_ms;
    use serde_json::json;

    fn lease(id: &str, seq: u64, budget: i64, ttl_ms: i64) -> Lease {
        Lease {
            id: format!("m_{id}"),
            lease_id: id.into(),
            expires_at: format_ms(now_ms() + ttl_ms),
            budget_milli: budget,
            seq,
        }
    }

    fn ledger() -> Arc<Ledger> {
        Arc::new(Ledger::default())
    }

    #[test]
    fn no_lease_blocks() {
        let l = ledger();
        assert_eq!(l.admit(0).err(), Some(Block::NoLease));
    }

    #[test]
    fn admits_until_budget_used() {
        let l = ledger();
        l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
        let t = l.admit(0).unwrap();
        t.finish(60);
        let t = l.admit(0).unwrap();
        t.finish(40);
        assert_eq!(l.admit(0).err(), Some(Block::Exhausted));
        assert_eq!(l.snapshot().used_milli, 100);
    }

    #[test]
    fn live_cost_crossing_budget_stops_that_stream() {
        let l = ledger();
        l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
        let mut a = l.admit(0).unwrap();
        let mut b = l.admit(0).unwrap();
        a.update(50, 50).unwrap();
        b.update(50, 50).unwrap();
        // 正好用完不算越过
        assert_eq!(l.admit(0).err(), Some(Block::Exhausted));
        assert_eq!(b.update(51, 51), Err(Block::Exhausted));
        // a 的下一次更新也会失败，因为总额已越过
        assert_eq!(a.update(50, 50), Err(Block::Exhausted));
        drop(a);
        b.finish(51);
        assert_eq!(l.snapshot().used_milli, 101);
        assert_eq!(l.snapshot().inflight_milli, 0);
    }

    #[test]
    fn reservation_counts_but_does_not_gate_itself() {
        let l = ledger();
        l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
        // 预留超过剩余额度仍放行，也不因预留本身被中断
        let mut t = l.admit(500).unwrap();
        assert_eq!(l.admit(0).err(), Some(Block::Exhausted));
        t.update(500, 0).unwrap();
        t.update(500, 90).unwrap();
        // 已见的实际花费越过额度才中断
        assert_eq!(t.update(500, 101), Err(Block::Exhausted));
        // 实际只花 10，释放多余部分
        t.finish(10);
        assert!(l.admit(0).is_ok());
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
        t.update(15, 15).unwrap();
        assert!(rx.has_changed().unwrap());
        assert_eq!(l.take_renew(), Some(("l1".into(), 85)));
        // 只发一次
        assert!(l.take_renew().is_none());
        // 续租期间流继续花了 5
        t.update(20, 20).unwrap();
        l.grant(&lease("l2", 2, 100, 600_000)).unwrap();
        // 新租约：已结束的 70 和快照里的 15 都算旧租约，流后来多花的 5 算新租约
        t.finish(20);
        assert_eq!(l.snapshot().used_milli, 5);
        assert_eq!(l.lease_id().as_deref(), Some("l2"));
    }

    #[test]
    fn renew_near_expiry_and_resend_after_reconnect() {
        let l = Arc::new(Ledger::with_options(LeaseOptions {
            renew_before: Duration::from_secs(120),
            ..Default::default()
        }));
        l.grant(&lease("l1", 1, 100, 60_000)).unwrap();
        assert_eq!(l.take_renew(), Some(("l1".into(), 0)));
        assert!(l.take_renew().is_none());
        l.on_connected();
        assert_eq!(l.take_renew(), Some(("l1".into(), 0)));
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
        // 过期后仍要续租（同时上报最终用量）
        assert!(l.take_renew().is_some());
    }

    #[test]
    fn clock_skew_applies_to_expiry() {
        let l = ledger();
        // Server 时钟比本机快 1 小时；租约按 Server 时间还有 10 分钟，按本机时间也是 10 分钟后到期
        l.set_server_time(&format_ms(now_ms() + 3_600_000));
        l.grant(&Lease { expires_at: format_ms(now_ms() + 3_600_000 + 600_000), ..lease("l1", 1, 100, 0) }).unwrap();
        let g = l.snapshot().lease.unwrap();
        assert!((g.expires_local_ms - now_ms() - 600_000).abs() < 5_000);
        assert!(l.admit(0).is_ok());
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
    fn cutoff_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        let path = dir.path().join("lease.json");
        {
            let l = Arc::new(Ledger::open(path.clone(), LeaseOptions::default(), &ob).unwrap());
            l.grant(&lease("l1", 1, 100, 600_000)).unwrap();
            l.cutoff("disabled").unwrap();
        }
        let l = Arc::new(Ledger::open(path, LeaseOptions::default(), &ob).unwrap());
        assert_eq!(l.admit(0).err(), Some(Block::Cutoff(CutoffReason::Disabled)));
    }
}
