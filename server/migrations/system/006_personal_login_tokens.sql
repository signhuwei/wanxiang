CREATE TABLE personal_login_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id), name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  last_used_at TEXT, revoked_at TEXT, revision INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX personal_login_tokens_by_user ON personal_login_tokens(user_id, created_at DESC, id DESC);

ALTER TABLE sessions ADD COLUMN login_token_id TEXT REFERENCES personal_login_tokens(id);
CREATE INDEX sessions_by_login_token ON sessions(login_token_id) WHERE login_token_id IS NOT NULL;
