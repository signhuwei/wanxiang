//! 本地 outbox：events 和 usage 共用一个 seq 空间，单调递增、无空洞。
//!
//! `meta.last_seq` 记录已分配的最大 seq，`meta.ack_seq` 记录 Server 已确认的最大 seq。
//! 确认过的行直接删除；seq 从 meta 继续分配，所以删行和进程重启都不会让 seq 回退。

use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use tokio::sync::watch;

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
}

impl Outbox {
    pub fn open(path: &Path) -> Result<Self> {
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
             );",
        )?;
        let last = meta(&conn, "last_seq")?;
        Ok(Self { conn: Mutex::new(conn), last_seq_tx: watch::Sender::new(last) })
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
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = meta(&tx, "ack_seq")?;
        if ack_seq <= current {
            return Ok(AckOutcome::Stale);
        }
        let last = meta(&tx, "last_seq")?;
        let (ack, outcome) = if ack_seq > last { (last, AckOutcome::Clamped) } else { (ack_seq, AckOutcome::Advanced) };
        tx.execute("UPDATE meta SET v = ?1 WHERE k = 'ack_seq'", [ack as i64])?;
        tx.execute("DELETE FROM outbox WHERE seq <= ?1", [ack as i64])?;
        tx.commit()?;
        Ok(outcome)
    }

    /// seq > `after` 的未确认条目，按 seq 升序，最多 `limit` 条。
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
}

fn meta(conn: &Connection, k: &str) -> Result<u64> {
    let v: Option<i64> = conn.query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0)).optional()?;
    Ok(v.context("outbox meta missing")? as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn ev(n: u64) -> Value {
        json!({"session_id": "ses_1", "kind": "user_message", "at": "2026-11-19T08:00:00Z", "payload": {"n": n}})
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
    fn seq_continues_after_restart_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("o.sqlite");
        {
            let ob = Outbox::open(&path).unwrap();
            for i in 0..3 {
                ob.append(Kind::Events, ev(i)).unwrap();
            }
            // 全部确认后表为空，seq 仍须从 meta 继续。
            assert_eq!(ob.ack(3).unwrap(), AckOutcome::Advanced);
            assert!(ob.pending(0, 10).unwrap().is_empty());
        }
        let ob = Outbox::open(&path).unwrap();
        assert_eq!(ob.last_seq(), 3);
        assert_eq!(ob.ack_seq().unwrap(), 3);
        assert_eq!(ob.append(Kind::Events, ev(4)).unwrap(), 4);
    }

    #[test]
    fn unacked_rows_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("o.sqlite");
        {
            let ob = Outbox::open(&path).unwrap();
            for i in 0..5 {
                ob.append(Kind::Events, ev(i)).unwrap();
            }
            ob.ack(2).unwrap();
        }
        let ob = Outbox::open(&path).unwrap();
        assert_eq!(ob.pending(0, 10).unwrap().iter().map(|r| r.seq).collect::<Vec<_>>(), [3, 4, 5]);
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
        assert_eq!(ob.pending(0, 10).unwrap().iter().map(|r| r.seq).collect::<Vec<_>>(), [4, 5]);
        assert_eq!(ob.ack(5).unwrap(), AckOutcome::Advanced);
        assert!(ob.pending(0, 10).unwrap().is_empty());
    }

    #[test]
    fn ack_beyond_last_seq_is_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let ob = Outbox::open(&dir.path().join("o.sqlite")).unwrap();
        ob.append(Kind::Events, ev(1)).unwrap();
        assert_eq!(ob.ack(100).unwrap(), AckOutcome::Clamped);
        assert_eq!(ob.ack_seq().unwrap(), 1);
        assert_eq!(ob.append(Kind::Events, ev(2)).unwrap(), 2);
        assert_eq!(ob.pending(0, 10).unwrap().len(), 1);
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
