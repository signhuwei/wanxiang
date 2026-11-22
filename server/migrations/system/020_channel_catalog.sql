-- First channel operations slice. Defaults bind the existing Provider key to its registered endpoint.
CREATE TABLE provider_channel_defaults (
  provider_id TEXT PRIMARY KEY REFERENCES providers(id),
  account_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  FOREIGN KEY (provider_id, account_id) REFERENCES provider_accounts(provider_id, account_id),
  FOREIGN KEY (provider_id, endpoint_id) REFERENCES provider_endpoints(provider_id, endpoint_id),
  FOREIGN KEY (account_id, endpoint_id) REFERENCES provider_account_endpoints(account_id, endpoint_id)
) STRICT;

CREATE TABLE provider_channel_jobs (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id),
  provider_revision INTEGER NOT NULL CHECK (provider_revision > 0), account_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL, endpoint_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connectivity', 'discovery')),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'partial', 'failed')),
  reason TEXT, model_count INTEGER NOT NULL CHECK (model_count >= 0),
  observed_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES platform_users(id),
  FOREIGN KEY (provider_id, account_id) REFERENCES provider_accounts(provider_id, account_id),
  FOREIGN KEY (provider_id, endpoint_id) REFERENCES provider_endpoints(provider_id, endpoint_id),
  FOREIGN KEY (endpoint_id, endpoint_revision) REFERENCES provider_endpoint_revisions(endpoint_id, endpoint_revision)
) STRICT;
CREATE INDEX provider_channel_jobs_recent ON provider_channel_jobs(provider_id, kind, observed_at DESC, id DESC);

CREATE TABLE provider_channel_catalog (
  catalog_item_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
  raw_model TEXT NOT NULL COLLATE BINARY,
  UNIQUE (account_id, endpoint_id, raw_model),
  FOREIGN KEY (account_id, endpoint_id) REFERENCES provider_account_endpoints(account_id, endpoint_id)
) STRICT;

CREATE TABLE provider_channel_discoveries (
  discovery_id TEXT NOT NULL REFERENCES provider_channel_jobs(id),
  catalog_item_id TEXT NOT NULL REFERENCES provider_channel_catalog(catalog_item_id),
  context_tokens INTEGER, capabilities_claim_json TEXT NOT NULL CHECK (json_valid(capabilities_claim_json)),
  snapshot_claim TEXT, variant_claim TEXT,
  PRIMARY KEY (discovery_id, catalog_item_id)
) STRICT;

CREATE TABLE provider_channel_reviews (
  model_id TEXT NOT NULL, identity_revision INTEGER NOT NULL,
  discovery_id TEXT NOT NULL, catalog_item_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES model_discovery_matches(candidate_id),
  PRIMARY KEY (model_id, identity_revision, discovery_id, catalog_item_id),
  FOREIGN KEY (model_id, identity_revision) REFERENCES model_identity_revisions(model_id, identity_revision),
  FOREIGN KEY (discovery_id, catalog_item_id) REFERENCES provider_channel_discoveries(discovery_id, catalog_item_id)
) STRICT;
