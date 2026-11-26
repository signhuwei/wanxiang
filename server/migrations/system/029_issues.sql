CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES platform_users(id),
  device_id TEXT NOT NULL,
  text TEXT NOT NULL,
  logs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  image_count INTEGER NOT NULL,
  log_count INTEGER NOT NULL
) STRICT;
CREATE INDEX issues_created ON issues(created_at DESC);
CREATE TABLE issue_images (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  image_index INTEGER NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (issue_id, image_index)
) STRICT;
CREATE INDEX issues_owner ON issues(tenant_id,user_id,created_at DESC);
