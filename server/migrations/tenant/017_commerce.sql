CREATE TABLE commerce_packages (
  month TEXT PRIMARY KEY, plan_id TEXT NOT NULL, grant_milli INTEGER NOT NULL CHECK(grant_milli>=0),
  fee_fen INTEGER NOT NULL CHECK(fee_fen>=0), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE commerce_leases (
  lease_id TEXT PRIMARY KEY REFERENCES leases(id), month TEXT NOT NULL, plan_id TEXT NOT NULL,
  terms_json TEXT NOT NULL CHECK(json_valid(terms_json)), platform_revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL,
  package_reserved INTEGER NOT NULL CHECK(package_reserved>=0), package_used INTEGER NOT NULL DEFAULT 0 CHECK(package_used>=0 AND package_used<=package_reserved),
  issued_at TEXT NOT NULL, closed_at TEXT, tool_prices_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tool_prices_json))
) STRICT;
CREATE INDEX commerce_leases_month ON commerce_leases(month);
CREATE TABLE commerce_model_allocations (
  lease_id TEXT NOT NULL REFERENCES commerce_leases(lease_id), model_id TEXT NOT NULL,
  month TEXT NOT NULL, reserved INTEGER NOT NULL CHECK(reserved>=0), used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),
  PRIMARY KEY(lease_id,model_id)
) STRICT;
CREATE INDEX commerce_allocations_month ON commerce_model_allocations(month,model_id);
ALTER TABLE lease_operations ADD COLUMN model_used_json TEXT;
CREATE TABLE commerce_tool_calls (
  device_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, native_id TEXT NOT NULL,
  release_id TEXT NOT NULL, user_id TEXT NOT NULL, plan_id TEXT NOT NULL, month TEXT NOT NULL,
  fee_milli INTEGER NOT NULL CHECK(fee_milli>=0), package_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('awaiting_result','failed','pending_funds','charged')),
  called_at TEXT NOT NULL, settled_at TEXT, ledger_id TEXT UNIQUE REFERENCES ledger(id),
  PRIMARY KEY(device_id,session_id,agent_id,native_id)
) STRICT;
CREATE INDEX commerce_tool_month ON commerce_tool_calls(month,status);
CREATE TABLE commerce_tool_receipts (
  device_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, native_id TEXT NOT NULL,
  called_at TEXT, plan_id TEXT, candidates_json TEXT CHECK(candidates_json IS NULL OR json_valid(candidates_json)),
  result_error INTEGER CHECK(result_error IN(0,1)), PRIMARY KEY(device_id,session_id,agent_id,native_id)
) STRICT;
CREATE VIEW commerce_ledger AS
  SELECT id,kind,amount_milli,user_id,lease_id,request_ref,"by",at,revision,note FROM ledger
  UNION ALL
  SELECT 'pkg_'||month,'subscription_grant',grant_milli,NULL,NULL,month,'system',created_at,1,'月度橡皮包' FROM commerce_packages;
ALTER TABLE policy_discount_periods ADD COLUMN cash_credit_milli INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policy_discount_periods ADD COLUMN expired_package_credit_milli INTEGER NOT NULL DEFAULT 0;
UPDATE policy_discount_periods SET cash_credit_milli=discount_milli;
