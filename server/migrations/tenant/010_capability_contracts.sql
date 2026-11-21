CREATE TABLE platform_contracts (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  entitlements_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  effective_at TEXT NOT NULL
) STRICT;

CREATE TABLE tenant_configurations (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  platform_revision INTEGER NOT NULL REFERENCES platform_contracts(revision),
  configuration_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

ALTER TABLE contract ADD COLUMN platform_revision INTEGER NOT NULL DEFAULT 0 CHECK (platform_revision >= 0);
ALTER TABLE contract ADD COLUMN tenant_revision INTEGER NOT NULL DEFAULT 0 CHECK (tenant_revision >= 0);
ALTER TABLE contract ADD COLUMN quota_distribution INTEGER NOT NULL DEFAULT 1 CHECK (quota_distribution IN (0, 1));
