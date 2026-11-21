CREATE TABLE policy_discount_leases (
  lease_id TEXT PRIMARY KEY REFERENCES leases(id),
  platform_revision INTEGER NOT NULL REFERENCES policy_signatures(revision),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  ratio_ppm INTEGER NOT NULL CHECK (ratio_ppm BETWEEN 0 AND 999999)
) STRICT;

CREATE TABLE policy_discount_periods (
  month TEXT PRIMARY KEY,
  gross_milli INTEGER NOT NULL CHECK (gross_milli >= 0),
  net_milli INTEGER NOT NULL CHECK (net_milli >= 0),
  discount_milli INTEGER NOT NULL CHECK (discount_milli >= 0 AND discount_milli = gross_milli - net_milli),
  buckets_json TEXT NOT NULL CHECK (json_valid(buckets_json)),
  adjustment_ledger_id TEXT UNIQUE REFERENCES ledger(id),
  closed_at TEXT NOT NULL,
  closed_by TEXT NOT NULL,
  CHECK ((discount_milli = 0) = (adjustment_ledger_id IS NULL))
) STRICT;
