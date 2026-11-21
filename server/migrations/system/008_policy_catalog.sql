CREATE TABLE policy_definitions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  PRIMARY KEY (id, version)
) STRICT;

CREATE TABLE policy_templates (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  entries_json TEXT NOT NULL CHECK (json_valid(entries_json)),
  PRIMARY KEY (id, version)
) STRICT;
