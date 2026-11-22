-- Multi-channel routing, batch 1: supply topology, deployments and evidence, stable model pools.
-- Legacy providers/models/rates stay as they are; existing model IDs act as the pool foreign key.

CREATE TABLE provider_accounts (
  account_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id), name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  balance_mode TEXT NOT NULL DEFAULT 'prepaid' CHECK (balance_mode IN ('prepaid', 'postpaid', 'quota', 'unmetered')),
  funding_id TEXT, edit_revision INTEGER NOT NULL DEFAULT 1 CHECK (edit_revision > 0), created_at TEXT NOT NULL,
  UNIQUE (provider_id, account_id)
) STRICT;
CREATE INDEX provider_accounts_by_provider ON provider_accounts(provider_id, status, account_id);

CREATE TABLE provider_endpoints (
  endpoint_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  current_revision INTEGER NOT NULL CHECK (current_revision > 0), created_at TEXT NOT NULL,
  UNIQUE (provider_id, endpoint_id)
) STRICT;
CREATE INDEX provider_endpoints_by_provider ON provider_endpoints(provider_id, status, endpoint_id);

CREATE TABLE provider_endpoint_revisions (
  endpoint_id TEXT NOT NULL REFERENCES provider_endpoints(endpoint_id), endpoint_revision INTEGER NOT NULL CHECK (endpoint_revision > 0),
  protocol TEXT NOT NULL CHECK (protocol IN ('anthropic', 'openai_chat', 'openai_responses')), base_url TEXT NOT NULL,
  region TEXT, fault_domain_id TEXT, auth_adapter TEXT NOT NULL CHECK (auth_adapter IN ('x_api_key', 'bearer')),
  created_at TEXT NOT NULL, PRIMARY KEY (endpoint_id, endpoint_revision)
) STRICT;

CREATE TABLE provider_account_endpoints (
  provider_id TEXT NOT NULL, account_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('enabled', 'disabled')), PRIMARY KEY (account_id, endpoint_id),
  FOREIGN KEY (provider_id, account_id) REFERENCES provider_accounts(provider_id, account_id),
  FOREIGN KEY (provider_id, endpoint_id) REFERENCES provider_endpoints(provider_id, endpoint_id)
) STRICT;

CREATE TABLE model_identity_revisions (
  model_id TEXT NOT NULL REFERENCES models(id), identity_revision INTEGER NOT NULL CHECK (identity_revision > 0),
  maker_id TEXT NOT NULL, model_family TEXT NOT NULL, model_variant TEXT NOT NULL,
  identity_mode TEXT NOT NULL CHECK (identity_mode IN ('pinned_snapshot', 'family_follow')), model_snapshot TEXT,
  capability_floor_json TEXT NOT NULL CHECK (json_valid(capability_floor_json)), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (model_id, identity_revision),
  CHECK (identity_mode != 'pinned_snapshot' OR model_snapshot IS NOT NULL)
) STRICT;
CREATE INDEX model_identity_by_family ON model_identity_revisions(maker_id, model_family, model_variant, model_id);
-- Explicit identity head: a higher identity revision is not authoritative until this pointer moves.
ALTER TABLE models ADD COLUMN current_identity_revision INTEGER;

CREATE TABLE model_deployments (
  deployment_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, account_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
  catalog_item_id TEXT, display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'archived')),
  current_revision INTEGER NOT NULL CHECK (current_revision > 0), edit_revision INTEGER NOT NULL DEFAULT 1 CHECK (edit_revision > 0),
  archived_at TEXT, archived_by TEXT, created_at TEXT NOT NULL,
  UNIQUE (deployment_id, endpoint_id),
  FOREIGN KEY (account_id, endpoint_id) REFERENCES provider_account_endpoints(account_id, endpoint_id),
  FOREIGN KEY (provider_id, account_id) REFERENCES provider_accounts(provider_id, account_id),
  FOREIGN KEY (provider_id, endpoint_id) REFERENCES provider_endpoints(provider_id, endpoint_id),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
) STRICT;
CREATE INDEX model_deployments_by_provider ON model_deployments(provider_id, status, deployment_id);

CREATE TABLE model_deployment_revisions (
  deployment_id TEXT NOT NULL, deployment_revision INTEGER NOT NULL CHECK (deployment_revision > 0),
  endpoint_id TEXT NOT NULL, endpoint_revision INTEGER NOT NULL, upstream_model TEXT NOT NULL COLLATE BINARY,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)), context_tokens INTEGER, max_output_tokens INTEGER,
  maker_claim TEXT, snapshot_claim TEXT, quantization_claim TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, deployment_revision),
  FOREIGN KEY (deployment_id, endpoint_id) REFERENCES model_deployments(deployment_id, endpoint_id),
  FOREIGN KEY (endpoint_id, endpoint_revision) REFERENCES provider_endpoint_revisions(endpoint_id, endpoint_revision)
) STRICT;

CREATE TABLE model_evidence (
  evidence_id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, deployment_revision INTEGER NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('maker_documentation', 'channel_declaration', 'runtime_probe', 'manual_review')),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'unknown')),
  identity_verified INTEGER NOT NULL CHECK (identity_verified IN (0, 1)),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)), key_fields_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(key_fields_json)),
  observed_at TEXT NOT NULL, valid_until TEXT, supersedes_id TEXT REFERENCES model_evidence(evidence_id), created_by TEXT NOT NULL,
  FOREIGN KEY (deployment_id, deployment_revision) REFERENCES model_deployment_revisions(deployment_id, deployment_revision)
) STRICT;
CREATE INDEX model_evidence_by_deployment ON model_evidence(deployment_id, source_kind, observed_at DESC, evidence_id);

CREATE TABLE model_discovery_matches (
  candidate_id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES models(id), identity_revision INTEGER NOT NULL,
  deployment_id TEXT NOT NULL, deployment_revision INTEGER NOT NULL, catalog_item_id TEXT, discovery_id TEXT,
  match_rule_id TEXT, rule_revision INTEGER,
  match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'catalog', 'manual', 'normalized')),
  normalized_key TEXT NOT NULL, confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
  status TEXT NOT NULL CHECK (status IN ('suggested', 'needs_review', 'accepted', 'rejected', 'superseded')),
  decided_by TEXT, decided_at TEXT, decision_reason TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY (model_id, identity_revision) REFERENCES model_identity_revisions(model_id, identity_revision),
  FOREIGN KEY (deployment_id, deployment_revision) REFERENCES model_deployment_revisions(deployment_id, deployment_revision),
  CHECK ((status IN ('accepted', 'rejected')) = (decided_at IS NOT NULL))
) STRICT;
CREATE INDEX model_matches_by_model ON model_discovery_matches(model_id, status, candidate_id);

CREATE TABLE model_pool_revisions (
  model_id TEXT NOT NULL REFERENCES models(id), pool_revision INTEGER NOT NULL CHECK (pool_revision > 0),
  based_on_revision INTEGER, identity_revision INTEGER NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy = 'ordered'), max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 8),
  attempt_timeout_ms INTEGER NOT NULL CHECK (attempt_timeout_ms > 0), total_timeout_ms INTEGER NOT NULL CHECK (total_timeout_ms >= attempt_timeout_ms),
  reason TEXT NOT NULL, digest TEXT NOT NULL, released_by TEXT NOT NULL, released_at TEXT NOT NULL, rollback_of INTEGER,
  PRIMARY KEY (model_id, pool_revision),
  FOREIGN KEY (model_id, identity_revision) REFERENCES model_identity_revisions(model_id, identity_revision)
) STRICT;

CREATE TABLE model_pool_deployments (
  model_id TEXT NOT NULL, pool_revision INTEGER NOT NULL, deployment_id TEXT NOT NULL, deployment_revision INTEGER NOT NULL,
  approved_match_id TEXT NOT NULL REFERENCES model_discovery_matches(candidate_id), priority INTEGER NOT NULL CHECK (priority >= 0),
  evidence_ids_json TEXT NOT NULL CHECK (json_valid(evidence_ids_json)),
  PRIMARY KEY (model_id, pool_revision, deployment_id),
  FOREIGN KEY (model_id, pool_revision) REFERENCES model_pool_revisions(model_id, pool_revision),
  FOREIGN KEY (deployment_id, deployment_revision) REFERENCES model_deployment_revisions(deployment_id, deployment_revision)
) STRICT;
CREATE INDEX model_pool_deployments_by_deployment ON model_pool_deployments(deployment_id, model_id, pool_revision);

CREATE TABLE model_pool_heads (
  model_id TEXT PRIMARY KEY REFERENCES models(id), pool_revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (model_id, pool_revision) REFERENCES model_pool_revisions(model_id, pool_revision)
) STRICT;

CREATE TABLE route_release_jobs (
  job_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, pool_revision INTEGER NOT NULL,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('project')), source_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')), created_at TEXT NOT NULL,
  UNIQUE (model_id, pool_revision, job_kind),
  FOREIGN KEY (model_id, pool_revision) REFERENCES model_pool_revisions(model_id, pool_revision)
) STRICT;
CREATE INDEX route_release_jobs_pending ON route_release_jobs(status, created_at) WHERE status IN ('pending', 'running');
