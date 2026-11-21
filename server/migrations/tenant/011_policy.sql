CREATE TABLE policy_signatures (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  reason TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  entries_json TEXT NOT NULL CHECK (json_valid(entries_json))
) STRICT;

CREATE TABLE policy_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  platform_revision INTEGER NOT NULL REFERENCES policy_signatures(revision),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0)
) STRICT;

CREATE TABLE policy_configuration_templates (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('group', 'member')),
  entries_json TEXT NOT NULL CHECK (json_valid(entries_json)),
  PRIMARY KEY (id, version)
) STRICT;

CREATE TABLE policy_configurations (
  scope TEXT NOT NULL CHECK (scope IN ('tenant', 'group', 'member')),
  subject_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  platform_revision INTEGER NOT NULL REFERENCES policy_signatures(revision),
  template_id TEXT,
  template_version INTEGER,
  selections_json TEXT NOT NULL CHECK (json_valid(selections_json)),
  revoked_json TEXT NOT NULL CHECK (json_valid(revoked_json)),
  retained_json TEXT NOT NULL CHECK (json_valid(retained_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, subject_id, revision),
  FOREIGN KEY (template_id, template_version) REFERENCES policy_configuration_templates(id, version),
  CHECK ((template_id IS NULL) = (template_version IS NULL))
) STRICT;

CREATE TABLE policy_effective (
  scope TEXT NOT NULL CHECK (scope IN ('tenant', 'group', 'member')),
  subject_id TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  PRIMARY KEY (scope, subject_id)
) STRICT;

CREATE TABLE policy_notices (
  id TEXT PRIMARY KEY,
  policy_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'policy_changed'),
  title TEXT NOT NULL,
  at TEXT NOT NULL,
  user_ids_json TEXT NOT NULL CHECK (json_valid(user_ids_json))
) STRICT;
CREATE INDEX policy_notices_by_revision ON policy_notices(policy_revision DESC);

CREATE TABLE policy_recharges (
  ledger_id TEXT PRIMARY KEY REFERENCES ledger(id),
  platform_revision INTEGER REFERENCES policy_signatures(revision),
  balance_before_milli INTEGER NOT NULL,
  balance_after_milli INTEGER NOT NULL,
  command_key TEXT NOT NULL UNIQUE,
  command_fingerprint TEXT NOT NULL
) STRICT;
