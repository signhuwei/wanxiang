CREATE TABLE groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES groups(id), quota_milli INTEGER,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE members (
  user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'group_admin', 'member')),
  group_id TEXT REFERENCES groups(id), status TEXT NOT NULL, quota_milli INTEGER, revision INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX members_by_status ON members(status);

CREATE TABLE contract (
  revision INTEGER PRIMARY KEY, seat_limit INTEGER NOT NULL CHECK (seat_limit >= 0),
  allowed_agents_json TEXT NOT NULL, allowed_models_json TEXT NOT NULL, lease_minutes INTEGER NOT NULL DEFAULT 10,
  lease_budget_milli INTEGER NOT NULL DEFAULT 2000, visibility_json TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES members(user_id), name TEXT NOT NULL, os TEXT NOT NULL,
  arch TEXT NOT NULL, edge_version TEXT, public_key TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  token_expires_at TEXT NOT NULL, last_seen_at TEXT, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX devices_by_user ON devices(user_id);

CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('admin', 'group_admin', 'member')),
  group_id TEXT REFERENCES groups(id), max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= max_uses), expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(user_id), revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE leases (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), user_id TEXT NOT NULL REFERENCES members(user_id),
  budget_milli INTEGER NOT NULL, used_milli INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE ledger (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('topup', 'reserve', 'settle', 'release', 'adjust')),
  amount_milli INTEGER NOT NULL, user_id TEXT REFERENCES members(user_id), lease_id TEXT REFERENCES leases(id),
  request_ref TEXT, "by" TEXT, at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), user_id TEXT NOT NULL REFERENCES members(user_id),
  agent TEXT NOT NULL, agent_version TEXT NOT NULL, model TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  event_count INTEGER NOT NULL DEFAULT 0, cost_milli INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE session_events (
  device_id TEXT NOT NULL REFERENCES devices(id), seq INTEGER NOT NULL CHECK (seq > 0),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id), kind TEXT NOT NULL, at TEXT NOT NULL, payload_json TEXT NOT NULL,
  PRIMARY KEY (device_id, seq)
) STRICT;
CREATE INDEX session_events_by_session ON session_events(session_id, seq);

CREATE TABLE usage (
  device_id TEXT NOT NULL REFERENCES devices(id), seq INTEGER NOT NULL CHECK (seq > 0), request_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id), model_id TEXT NOT NULL, input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
  cost_milli INTEGER, status TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (device_id, seq)
) STRICT;

CREATE TABLE diag_jobs (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), kind TEXT NOT NULL, status TEXT NOT NULL,
  object_key TEXT, requested_by TEXT NOT NULL REFERENCES members(user_id), at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE idempotency (
  scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER NOT NULL,
  payload_json TEXT, nonce TEXT, credential TEXT, expires_at TEXT NOT NULL, PRIMARY KEY (scope, key)
) STRICT;
CREATE INDEX idempotency_by_expiry ON idempotency(expires_at);

CREATE TABLE audit (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT NOT NULL, at TEXT NOT NULL
) STRICT;
