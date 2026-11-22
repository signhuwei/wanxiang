CREATE TABLE channel_wallets (
  funding_id TEXT PRIMARY KEY,
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE channel_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  funding_id TEXT NOT NULL REFERENCES channel_wallets(funding_id),
  account_id TEXT NOT NULL REFERENCES provider_accounts(account_id),
  kind TEXT NOT NULL CHECK (kind IN ('recharge','balance_observation','expense')),
  amount_micro INTEGER NOT NULL CHECK (amount_micro >= 0 AND (amount_micro > 0 OR kind <> 'recharge')),
  reference TEXT NOT NULL,
  note TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (funding_id, kind, reference)
) STRICT;
CREATE INDEX channel_ledger_by_funding ON channel_ledger(funding_id, seq DESC);
CREATE TRIGGER channel_ledger_no_update BEFORE UPDATE ON channel_ledger
BEGIN SELECT RAISE(ABORT, 'channel ledger records are immutable'); END;
CREATE TRIGGER channel_ledger_no_delete BEFORE DELETE ON channel_ledger
BEGIN SELECT RAISE(ABORT, 'channel ledger records are immutable'); END;
