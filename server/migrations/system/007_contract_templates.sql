CREATE TABLE contract_templates (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  entitlements_json TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
) STRICT;
