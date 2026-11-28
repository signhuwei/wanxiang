ALTER TABLE personal_login_tokens ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
ALTER TABLE personal_login_tokens ADD COLUMN parent_token_id TEXT REFERENCES personal_login_tokens(id)
  CHECK (parent_token_id IS NULL OR tenant_id IS NOT NULL);
CREATE INDEX personal_login_tokens_by_parent ON personal_login_tokens(parent_token_id) WHERE parent_token_id IS NOT NULL;
