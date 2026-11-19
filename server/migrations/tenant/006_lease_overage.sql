-- 允许 ledger.kind 记一笔 'overage_pending'：Edge 诚实上报的实际用量超出租约额度时，
-- 差额（实报 - 实扣）单独挂账待核对，不计入余额、消费或预留（server/src/billing.ts 的 balance() 只认
-- topup/adjust/settle，本迁移不改它的 SQL）。SQLite 的内联 CHECK 不能直接改，整表重建，保留全部列、行、
-- 外键和 ledger_by_kind_and_at 索引。
CREATE TABLE ledger_new (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('topup', 'reserve', 'settle', 'release', 'adjust', 'overage_pending')),
  amount_milli INTEGER NOT NULL, user_id TEXT REFERENCES members(user_id), lease_id TEXT REFERENCES leases(id),
  request_ref TEXT, "by" TEXT, at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, note TEXT
) STRICT;
INSERT INTO ledger_new (id, kind, amount_milli, user_id, lease_id, request_ref, "by", at, revision, note)
  SELECT id, kind, amount_milli, user_id, lease_id, request_ref, "by", at, revision, note FROM ledger;
DROP TABLE ledger;
ALTER TABLE ledger_new RENAME TO ledger;
CREATE INDEX ledger_by_kind_and_at ON ledger(kind, at);
