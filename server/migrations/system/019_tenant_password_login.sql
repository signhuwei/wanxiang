ALTER TABLE tenants ADD COLUMN short_name TEXT;
ALTER TABLE tenants ADD COLUMN short_name_key TEXT;
CREATE INDEX tenants_by_short_name ON tenants(short_name_key) WHERE status = 'active';

CREATE TABLE tenant_login_accounts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  username TEXT NOT NULL,
  username_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES platform_users(id),
  password_hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id, username_key),
  UNIQUE (tenant_id, user_id)
) STRICT;

ALTER TABLE sessions ADD COLUMN tenant_password_login INTEGER NOT NULL DEFAULT 0
  CHECK (tenant_password_login IN (0, 1) AND (tenant_password_login = 0 OR tenant_id IS NOT NULL));
