ALTER TABLE agent_sessions ADD COLUMN content_purged_at TEXT;
CREATE INDEX sessions_retention ON agent_sessions(ended_at) WHERE content_purged_at IS NULL;
CREATE TABLE session_shares (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id), recipient TEXT NOT NULL REFERENCES members(user_id),
  shared_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id,recipient)
) STRICT;
CREATE INDEX shares_recipient ON session_shares(recipient,created_at DESC);
ALTER TABLE policy_configurations ADD COLUMN restored_from_revision INTEGER;
CREATE TABLE tenant_upstreams (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL, name TEXT NOT NULL, upstream_name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK(protocol IN ('anthropic','openai_chat','openai_responses')), base_url TEXT NOT NULL,
  secret_ciphertext BLOB NOT NULL, priority INTEGER NOT NULL CHECK(priority >= 0), revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','disabled'))
) STRICT;
CREATE INDEX tenant_upstream_model ON tenant_upstreams(model_id,status,priority);
