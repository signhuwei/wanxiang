CREATE TABLE master_login_accounts (
  user_id TEXT PRIMARY KEY REFERENCES platform_admins(user_id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;

ALTER TABLE sessions ADD COLUMN master_password_login INTEGER NOT NULL DEFAULT 0 CHECK(master_password_login IN (0, 1));
