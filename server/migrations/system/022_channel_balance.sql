-- Management tokens are purpose-bound to a channel, relay account and endpoint revision.
CREATE TABLE provider_balance_profiles (
  account_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  endpoint_id TEXT NOT NULL,
  endpoint_revision INTEGER NOT NULL,
  funding_id TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('new_api', 'sub2api')),
  source_origin TEXT NOT NULL,
  expected_user_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  quota_per_unit INTEGER CHECK (quota_per_unit > 0),
  sync_wallet INTEGER NOT NULL CHECK (sync_wallet IN (0, 1)),
  credential_ciphertext BLOB,
  CHECK ((adapter = 'new_api' AND quota_per_unit IS NOT NULL AND sync_wallet = 0)
    OR (adapter = 'sub2api' AND quota_per_unit IS NULL AND currency = 'USD')),
  FOREIGN KEY (provider_id, account_id) REFERENCES provider_accounts(provider_id, account_id),
  FOREIGN KEY (account_id, endpoint_id) REFERENCES provider_account_endpoints(account_id, endpoint_id),
  FOREIGN KEY (endpoint_id, endpoint_revision) REFERENCES provider_endpoint_revisions(endpoint_id, endpoint_revision)
) STRICT;
CREATE UNIQUE INDEX provider_balance_sync_wallet_source ON provider_balance_profiles(adapter, source_origin, expected_user_id)
  WHERE sync_wallet=1 AND credential_ciphertext IS NOT NULL;

CREATE TABLE provider_balance_observations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  funding_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  adapter TEXT NOT NULL CHECK (adapter IN ('new_api', 'sub2api')),
  source_origin TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('account_quota', 'account_balance')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'exhausted', 'unknown', 'stale')),
  reason_code TEXT,
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  amount_micro INTEGER CHECK (amount_micro >= 0),
  quota_units INTEGER CHECK (quota_units >= 0),
  observed_at TEXT NOT NULL,
  valid_until TEXT,
  wallet_synced INTEGER NOT NULL CHECK (wallet_synced IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES platform_users(id),
  FOREIGN KEY (provider_id, account_id) REFERENCES provider_accounts(provider_id, account_id)
) STRICT;
CREATE INDEX provider_balance_observations_account ON provider_balance_observations(account_id, seq DESC);
CREATE TRIGGER provider_balance_observation_no_update BEFORE UPDATE ON provider_balance_observations
BEGIN SELECT RAISE(ABORT, 'provider balance observations are immutable'); END;
CREATE TRIGGER provider_balance_observation_no_delete BEFORE DELETE ON provider_balance_observations
BEGIN SELECT RAISE(ABORT, 'provider balance observations are immutable'); END;
