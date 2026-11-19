CREATE TABLE platform_users (
  id TEXT PRIMARY KEY, email TEXT, phone TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL REFERENCES platform_users(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')), db_file TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE identities (
  user_id TEXT NOT NULL REFERENCES platform_users(id), kind TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
  value TEXT NOT NULL, PRIMARY KEY (kind, value)
) STRICT;

CREATE TABLE memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES platform_users(id),
  role TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (tenant_id, user_id)
) STRICT;
CREATE INDEX memberships_by_user ON memberships(user_id);

CREATE TABLE invite_directory (
  code_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id)
) STRICT;

CREATE TABLE device_directory (
  device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL REFERENCES tenants(id)
) STRICT;

CREATE TABLE login_codes (
  target TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  issued_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id),
  tenant_id TEXT REFERENCES tenants(id), kind TEXT NOT NULL CHECK (kind IN ('web', 'desktop')),
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX sessions_by_expiry ON sessions(expires_at);

CREATE TABLE providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('anthropic', 'openai_chat', 'openai_responses')),
  base_url TEXT NOT NULL, secret_ciphertext BLOB NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE models (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id), upstream_name TEXT NOT NULL,
  display_name TEXT NOT NULL, context_window INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE rates (
  model_id TEXT NOT NULL REFERENCES models(id), input_milli_per_mtok INTEGER NOT NULL, output_milli_per_mtok INTEGER NOT NULL,
  cache_read_milli_per_mtok INTEGER NOT NULL, cache_write_milli_per_mtok INTEGER NOT NULL, effective_from TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (model_id, effective_from)
) STRICT;

CREATE TABLE agent_releases (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, version TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL, url TEXT NOT NULL,
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE platform_audit (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT NOT NULL, at TEXT NOT NULL
) STRICT;

CREATE TABLE idempotency (
  scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER NOT NULL,
  payload_json TEXT, nonce TEXT, credential TEXT, expires_at TEXT NOT NULL, PRIMARY KEY (scope, key)
) STRICT;
CREATE INDEX idempotency_by_expiry ON idempotency(expires_at);
