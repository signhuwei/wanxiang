CREATE TABLE policy_device_applications (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  config_revision INTEGER NOT NULL CHECK (config_revision > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  applied_at TEXT NOT NULL
) STRICT;
