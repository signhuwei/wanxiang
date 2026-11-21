//! 本地 outbox：events 和 usage 共用一个 seq 空间，单调递增、无空洞。
//!
//! `meta.last_seq` 记录已分配的最大 seq，`meta.ack_seq` 记录 Server 已确认的最大 seq。
//! 确认过的行保留 72 小时（总量不超过 200 MB，超出先删最旧的），供 Server 丢数据时重传。
//! seq 从 meta 继续分配，所以删行和进程重启都不会让 seq 回退。

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use tokio::sync::watch;

pub const RETAIN_MS: i64 = 72 * 3600 * 1000;
pub const RETAIN_BYTES: u64 = 200 * 1024 * 1024;
/// 按总量清理要扫全表，最多每分钟做一次。
const SIZE_PRUNE_EVERY_MS: i64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Events,
    Usage,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Events => "events",
            Kind::Usage => "usage",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        match s {
            "events" => Ok(Kind::Events),
            "usage" => Ok(Kind::Usage),
            _ => anyhow::bail!("unknown outbox kind {s:?}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub seq: u64,
    pub kind: Kind,
    /// 含 `seq` 字段的完整条目，可直接放进 `batch[]`。
    pub item: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckOutcome {
    Advanced,
    /// 重复或乱序的确认，不大于当前 ack_seq，忽略。
    Stale,
    /// 确认了还没分配的 seq，按 last_seq 截断。说明 Server 有 bug。
    Clamped,
}

pub struct Outbox {
    conn: Mutex<Connection>,
    last_seq_tx: watch::Sender<u64>,
    retain_ms: i64,
    retain_bytes: u64,
    last_size_prune: Mutex<i64>,
}

impl Outbox {
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with(path, RETAIN_MS, RETAIN_BYTES)
    }

    pub fn open_with(path: &Path, retain_ms: i64, retain_bytes: u64) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("open outbox {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // 一次 fsync 换掉电不丢：events 和 usage 写入频率低，代价可以接受。
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
             INSERT OR IGNORE INTO meta (k, v) VALUES ('last_seq', 0), ('ack_seq', 0);
             CREATE TABLE IF NOT EXISTS outbox (
                 seq INTEGER PRIMARY KEY,
                 kind TEXT NOT NULL,
                 item TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS cursors (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
        )?;
        // 第一批的表没有 acked_at，补上。
        let has_acked_at: bool =
            conn.query_row("SELECT count(*) FROM pragma_table_info('outbox') WHERE name = 'acked_at'", [], |r| {
                r.get::<_, i64>(0)
            })? > 0;
        if !has_acked_at {
            conn.execute_batch(
                "ALTER TABLE outbox ADD COLUMN acked_at INTEGER;
                 CREATE INDEX IF NOT EXISTS outbox_acked_at ON outbox (acked_at) WHERE acked_at IS NOT NULL;",
            )?;
        }
        // Earlier native capture versions queued events without an `at`; the Server rejects the
        // whole batch, which otherwise prevents this device's ordered cursor from advancing.
        conn.execute(
            "UPDATE outbox SET item = json_set(item, '$.at', ?1)
             WHERE kind = 'events' AND seq > (SELECT v FROM meta WHERE k = 'ack_seq')
               AND coalesce(json_type(item, '$.at'), 'null') = 'null'",
            [crate::pricing::format_ms(now_ms())],
        )?;
        let last = meta(&conn, "last_seq")?;
        Ok(Self {
            conn: Mutex::new(conn),
            last_seq_tx: watch::Sender::new(last),
            retain_ms,
            retain_bytes,
            last_size_prune: Mutex::new(i64::MIN),
        })
    }

    /// 分配下一个 seq 并写入。`item` 必须是 JSON 对象，`seq` 字段由这里填。
    pub fn append(&self, kind: Kind, mut item: Value) -> Result<u64> {
        let obj = item.as_object_mut().context("outbox item must be a JSON object")?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let seq = meta(&tx, "last_seq")? + 1;
        obj.insert("seq".into(), seq.into());
        tx.execute(
            "INSERT INTO outbox (seq, kind, item) VALUES (?1, ?2, ?3)",
            params![seq as i64, kind.as_str(), item.to_string()],
        )?;
        tx.execute("UPDATE meta SET v = ?1 WHERE k = 'last_seq'", [seq as i64])?;
        tx.commit()?;
        drop(conn);
        self.last_seq_tx.send_replace(seq);
        Ok(seq)
    }

    /// 处理累计确认：所有 seq ≤ ack_seq 的条目都已被 Server 持久化。
    pub fn ack(&self, ack_seq: u64) -> Result<AckOutcome> {
        self.ack_at(ack_seq, now_ms())
    }

    pub fn ack_at(&self, ack_seq: u64, now: i64) -> Result<AckOutcome> {
        let outcome = {
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = meta(&tx, "ack_seq")?;
            if ack_seq <= current {
                return Ok(AckOutcome::Stale);
            }
            let last = meta(&tx, "last_seq")?;
            let (ack, outcome) =
                if ack_seq > last { (last, AckOutcome::Clamped) } else { (ack_seq, AckOutcome::Advanced) };
            tx.execute("UPDATE meta SET v = ?1 WHERE k = 'ack_seq'", [ack as i64])?;
            tx.execute(
                "UPDATE outbox SET acked_at = ?1 WHERE seq > ?2 AND seq <= ?3",
                params![now, current as i64, ack as i64],
            )?;
            tx.commit()?;
            outcome
        };
        self.prune(now)?;
        Ok(outcome)
    }

    /// 删掉超过保留期的已确认条目；总量超限时再从最旧的已确认条目删起。未确认的条目永远不删。
    pub fn prune(&self, now: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM outbox WHERE acked_at IS NOT NULL AND acked_at < ?1", [now - self.retain_ms])?;
        let mut last = self.last_size_prune.lock().unwrap();
        if now.saturating_sub(*last) < SIZE_PRUNE_EVERY_MS {
            return Ok(());
        }
        *last = now;
        let total: i64 = conn.query_row("SELECT coalesce(sum(length(item)), 0) FROM outbox", [], |r| r.get(0))?;
        let mut excess = total - self.retain_bytes as i64;
        if excess <= 0 {
            return Ok(());
        }
        let mut cut = None;
        {
            let mut stmt =
                conn.prepare("SELECT seq, length(item) FROM outbox WHERE acked_at IS NOT NULL ORDER BY seq")?;
            let mut rows = stmt.query([])?;
            while let Some(r) = rows.next()? {
                cut = Some(r.get::<_, i64>(0)?);
                excess -= r.get::<_, i64>(1)?;
                if excess <= 0 {
                    break;
                }
            }
        }
        if let Some(seq) = cut {
            conn.execute("DELETE FROM outbox WHERE acked_at IS NOT NULL AND seq <= ?1", [seq])?;
        }
        Ok(())
    }

    /// seq > `after` 的条目（含仍保留的已确认条目），按 seq 升序，最多 `limit` 条。
    pub fn pending(&self, after: u64, limit: usize) -> Result<Vec<Row>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare_cached("SELECT seq, kind, item FROM outbox WHERE seq > ?1 ORDER BY seq LIMIT ?2")?;
        let rows = stmt.query_map(params![after as i64, limit as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?;
        rows.map(|r| {
            let (seq, kind, item) = r?;
            Ok(Row { seq: seq as u64, kind: Kind::parse(&kind)?, item: serde_json::from_str(&item)? })
        })
        .collect()
    }

    /// 仍保留的最小 seq。
    pub fn first_seq(&self) -> Result<Option<u64>> {
        let conn = self.conn.lock().unwrap();
        let v: Option<i64> = conn.query_row("SELECT min(seq) FROM outbox", [], |r| r.get(0))?;
        Ok(v.map(|v| v as u64))
    }

    /// 未确认条目的总字节数。
    pub fn unacked_bytes(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let v: i64 =
            conn.query_row("SELECT coalesce(sum(length(item)), 0) FROM outbox WHERE acked_at IS NULL", [], |r| {
                r.get(0)
            })?;
        Ok(v as u64)
    }

    /// 某个租约下所有 usage 的 cost_milli 之和。重启后用它恢复租约已用额度。
    pub fn usage_cost_for_lease(&self, lease_id: &str) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let v: i64 = conn.query_row(
            "SELECT coalesce(sum(json_extract(item, '$.cost_milli')), 0) FROM outbox
             WHERE kind = 'usage' AND json_extract(item, '$.lease_id') = ?1",
            [lease_id],
            |r| r.get(0),
        )?;
        Ok(v)
    }

    pub fn model_usage_cost_for_lease(&self, lease: &str, model: &str) -> Result<i64> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT coalesce(sum(json_extract(item,'$.cost_milli')),0) FROM outbox WHERE kind='usage'
             AND json_extract(item,'$.lease_id')=?1 AND json_extract(item,'$.model_id')=?2",
            [lease, model],
            |row| row.get(0),
        )?)
    }

    pub fn last_seq(&self) -> u64 {
        *self.last_seq_tx.borrow()
    }

    pub fn ack_seq(&self) -> Result<u64> {
        meta(&self.conn.lock().unwrap(), "ack_seq")
    }

    /// last_seq 变化时通知，WS 客户端用它触发发送。
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.last_seq_tx.subscribe()
    }

    /// 会话采集的读取游标（JSON），没有时返回 None。
    pub fn cursor(&self, key: &str) -> Result<Option<Value>> {
        let conn = self.conn.lock().unwrap();
        let s: Option<String> = conn.query_row("SELECT v FROM cursors WHERE k = ?1", [key], |r| r.get(0)).optional()?;
        Ok(s.map(|s| serde_json::from_str(&s)).transpose()?)
    }

    /// 在一个事务里写入一批事件并推进游标：要么都提交，要么都不提交。
    pub fn append_events_with_cursor(&self, items: Vec<Value>, key: &str, cursor: &Value) -> Result<()> {
        self.append_if_cursor(items, key, cursor, None).map(|_| ())
    }

    /// A JSON null expectation means no prior cursor. A stale reader leaves both events and cursor untouched.
    pub(crate) fn append_if_cursor(
        &self,
        items: Vec<Value>,
        key: &str,
        cursor: &Value,
        expected: Option<&Value>,
    ) -> Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(expected) = expected {
            let saved: Option<String> =
                tx.query_row("SELECT v FROM cursors WHERE k = ?1", [key], |r| r.get(0)).optional()?;
            let saved = saved.map(|text| serde_json::from_str::<Value>(&text)).transpose()?.unwrap_or(Value::Null);
            if saved != *expected {
                return Ok(false);
            }
        }
        let mut seq = meta(&tx, "last_seq")?;
        for mut item in items {
            seq += 1;
            item.as_object_mut().context("outbox item must be a JSON object")?.insert("seq".into(), seq.into());
            tx.execute(
                "INSERT INTO outbox (seq, kind, item) VALUES (?1, ?2, ?3)",
                params![seq as i64, Kind::Events.as_str(), item.to_string()],
            )?;
        }
        tx.execute("UPDATE meta SET v = ?1 WHERE k = 'last_seq'", [seq as i64])?;
        tx.execute(
            "INSERT INTO cursors (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
            params![key, cursor.to_string()],
        )?;
        tx.commit()?;
        drop(conn);
        self.last_seq_tx.send_replace(seq);
        Ok(true)
    }
}

fn meta(conn: &Connection, k: &str) -> Result<u64> {
    let v: Option<i64> = conn.query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0)).optional()?;
    Ok(v.context("outbox meta missing")? as u64)
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn ev(n: u64) -> Value {
        json!({"session_id": "ses_1", "kind": "user_message", "at": "2026-11-19T08:00:00Z", "payload": {"n": n}})
    }

    fn seqs(ob: &Outbox, after: u64) -> Vec<u64> {
        ob.pending(after, 100).unwrap().iter().map(|r| r.seq).collect()
    }

    #[test]
    fn seq_is_contiguous_and_shared_between_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        assert_eq!(ob.append(Kind::Events, ev(1)).unwrap(), 1);
        assert_eq!(ob.append(Kind::Usage, json!({"request_id": "r1"})).unwrap(), 2);
        assert_eq!(ob.append(Kind::Events, ev(3)).unwrap(), 3);
        let rows = ob.pending(0, 10).unwrap();
        assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(rows[1].kind, Kind::Usage);
        assert_eq!(rows[1].item["seq"], 2);
        assert_eq!(ob.pending(1, 1).unwrap()[0].seq, 2);
    }

    #[test]
    fn reopening_repairs_missing_timestamps_without_changing_pending_sequences() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.sqlite");
        {
            let outbox = Outbox::open(&path).unwrap();
            outbox.append(Kind::Events, ev(1)).unwrap();
            outbox.ack(1).unwrap();
            let mut legacy = ev(2);
            legacy["at"] = Value::Null;
            outbox.append(Kind::Events, legacy).unwrap();
            outbox.append(Kind::Events, ev(3)).unwrap();
        }
        let outbox = Outbox::open(&path).unwrap();
        assert_eq!(outbox.ack_seq().unwrap(), 1);
        assert_eq!(outbox.last_seq(), 3);
        let rows = outbox.pending(1, 10).unwrap();
        assert!(rows[0].item["at"].as_str().and_then(crate::pricing::parse_ms).is_some());
        assert_eq!(rows[0].item["seq"], 2);
        assert_eq!(rows[1].item["at"], ev(3)["at"]);
    }

    #[test]
    fn seq_continues_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("o.sqlite");
        {
            let ob = Outbox::open(&path).unwrap();
            for i in 0..3 {
                ob.append(Kind::Events, ev(i)).unwrap();
            }
            assert_eq!(ob.ack(3).unwrap(), AckOutcome::Advanced);
            // 已确认的条目仍保留
            assert_eq!(seqs(&ob, 0), [1, 2, 3]);
            assert_eq!(seqs(&ob, 3), Vec::<u64>::new());
        }
        let ob = Outbox::open(&path).unwrap();
        assert_eq!(ob.last_seq(), 3);
        assert_eq!(ob.ack_seq().unwrap(), 3);
        assert_eq!(ob.append(Kind::Events, ev(4)).unwrap(), 4);
    }

    #[test]
    fn acked_rows_are_kept_for_retention_period() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        for i in 0..5 {
            ob.append(Kind::Events, ev(i)).unwrap();
        }
        let t0 = 1_000_000_000_000;
        ob.ack_at(2, t0).unwrap();
        ob.ack_at(4, t0 + 1000).unwrap();
        ob.prune(t0 + RETAIN_MS - 1).unwrap();
        assert_eq!(seqs(&ob, 0), [1, 2, 3, 4, 5]);
        ob.prune(t0 + RETAIN_MS + 1).unwrap();
        assert_eq!(seqs(&ob, 0), [3, 4, 5]);
        ob.prune(t0 + RETAIN_MS + 1001).unwrap();
        // 未确认的 5 永远不删
        assert_eq!(seqs(&ob, 0), [5]);
        assert_eq!(ob.first_seq().unwrap(), Some(5));
    }

    #[test]
    fn size_cap_drops_oldest_acked_only() {
        let dir = tempfile::tempdir().unwrap();
        let big = "x".repeat(1000);
        let ob = Outbox::open_with(&dir.path().join("o.sqlite"), RETAIN_MS, 3500).unwrap();
        for _ in 0..5 {
            ob.append(Kind::Events, json!({"p": big})).unwrap();
        }
        // 共约 5 KB，超出约 1.5 KB，要删 2 条最旧的已确认条目
        ob.ack_at(3, 1_000).unwrap();
        assert_eq!(seqs(&ob, 0), [3, 4, 5]);
        // 未确认的条目即使超限也不删
        let ob2 = Outbox::open_with(&dir.path().join("o2.sqlite"), RETAIN_MS, 10).unwrap();
        ob2.append(Kind::Events, json!({"p": big})).unwrap();
        ob2.prune(1_000).unwrap();
        assert_eq!(seqs(&ob2, 0), [1]);
        assert!(ob2.unacked_bytes().unwrap() > 1000);
    }

    #[test]
    fn upgrades_first_batch_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("o.sqlite");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
                 INSERT INTO meta VALUES ('last_seq', 2), ('ack_seq', 1);
                 CREATE TABLE outbox (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL);
                 INSERT INTO outbox VALUES (2, 'events', '{\"seq\":2}');",
            )
            .unwrap();
        }
        let ob = Outbox::open(&path).unwrap();
        assert_eq!(seqs(&ob, 0), [2]);
        ob.ack(2).unwrap();
        assert_eq!(ob.append(Kind::Events, ev(3)).unwrap(), 3);
        drop(ob);
        Outbox::open(&path).unwrap();
    }

    #[test]
    fn duplicate_and_out_of_order_acks_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        for i in 0..5 {
            ob.append(Kind::Events, ev(i)).unwrap();
        }
        assert_eq!(ob.ack(3).unwrap(), AckOutcome::Advanced);
        assert_eq!(ob.ack(3).unwrap(), AckOutcome::Stale);
        assert_eq!(ob.ack(1).unwrap(), AckOutcome::Stale);
        assert_eq!(ob.ack_seq().unwrap(), 3);
        assert_eq!(seqs(&ob, 3), [4, 5]);
        assert_eq!(ob.ack(5).unwrap(), AckOutcome::Advanced);
        assert_eq!(ob.unacked_bytes().unwrap(), 0);
    }

    #[test]
    fn ack_beyond_last_seq_is_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        ob.append(Kind::Events, ev(1)).unwrap();
        assert_eq!(ob.ack(100).unwrap(), AckOutcome::Clamped);
        assert_eq!(ob.ack_seq().unwrap(), 1);
        assert_eq!(ob.append(Kind::Events, ev(2)).unwrap(), 2);
        assert_eq!(seqs(&ob, 1), [2]);
    }

    #[test]
    fn usage_cost_by_lease() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        ob.append(Kind::Usage, json!({"lease_id": "l1", "cost_milli": 10})).unwrap();
        ob.append(Kind::Usage, json!({"lease_id": "l2", "cost_milli": 99})).unwrap();
        ob.append(Kind::Events, json!({"lease_id": "l1", "cost_milli": 1000})).unwrap();
        ob.append(Kind::Usage, json!({"lease_id": "l1", "cost_milli": 5})).unwrap();
        ob.ack(4).unwrap();
        assert_eq!(ob.usage_cost_for_lease("l1").unwrap(), 15);
        assert_eq!(ob.usage_cost_for_lease("nope").unwrap(), 0);
    }

    #[test]
    fn concurrent_appends_have_no_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Arc::new(Outbox::open(&dir.path().join("o.sqlite")).unwrap());
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let ob = ob.clone();
                std::thread::spawn(move || (0..25).map(|i| ob.append(Kind::Events, ev(i)).unwrap()).collect::<Vec<_>>())
            })
            .collect();
        let mut all: Vec<u64> = handles.into_iter().flat_map(|h| h.join().unwrap()).collect();
        all.sort();
        assert_eq!(all, (1..=100).collect::<Vec<_>>());
    }

    #[test]
    fn subscribe_sees_new_seq() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        let rx = ob.subscribe();
        ob.append(Kind::Events, ev(1)).unwrap();
        assert!(rx.has_changed().unwrap());
        assert_eq!(*rx.borrow(), 1);
    }
}
