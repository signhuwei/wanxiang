CREATE TABLE platform_model_test_quotas (
  user_id TEXT NOT NULL REFERENCES platform_users(id),
  period TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  limit_milli INTEGER NOT NULL CHECK (limit_milli >= 0),
  reserved_milli INTEGER NOT NULL DEFAULT 0 CHECK (reserved_milli >= 0),
  spent_milli INTEGER NOT NULL DEFAULT 0 CHECK (spent_milli >= 0),
  CHECK (reserved_milli <= limit_milli - spent_milli),
  PRIMARY KEY (user_id, period)
) STRICT;

CREATE TABLE platform_model_tests (
  id TEXT PRIMARY KEY,
  discovery_id TEXT NOT NULL,
  catalog_item_id TEXT NOT NULL,
  raw_model TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  provider_revision INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  endpoint_revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  period TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'pending_reconciliation')),
  reason_code TEXT,
  reserved_milli INTEGER NOT NULL CHECK (reserved_milli >= 0),
  charged_milli INTEGER CHECK (charged_milli >= 0 AND charged_milli <= reserved_milli),
  usage_json TEXT CHECK (json_valid(usage_json)),
  tariff_json TEXT NOT NULL CHECK (json_valid(tariff_json)),
  reconciliation_json TEXT CHECK (json_valid(reconciliation_json)),
  FOREIGN KEY (actor_id, period) REFERENCES platform_model_test_quotas(user_id, period),
  FOREIGN KEY (discovery_id, catalog_item_id) REFERENCES provider_channel_discoveries(discovery_id, catalog_item_id),
  FOREIGN KEY (account_id, endpoint_id) REFERENCES provider_account_endpoints(account_id, endpoint_id),
  FOREIGN KEY (endpoint_id, endpoint_revision) REFERENCES provider_endpoint_revisions(endpoint_id, endpoint_revision),
  UNIQUE (actor_id, request_key)
) STRICT;
CREATE INDEX platform_model_tests_recent ON platform_model_tests(discovery_id, created_at DESC, id DESC);
CREATE INDEX platform_model_tests_catalogue ON platform_model_tests(catalog_item_id, created_at DESC, id DESC);
CREATE INDEX platform_model_tests_quota ON platform_model_tests(actor_id, period, created_at DESC, id DESC);
