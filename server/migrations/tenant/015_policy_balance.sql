CREATE TABLE policy_balance_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'warn', 'restricted', 'stopped'))
) STRICT;

CREATE TABLE policy_balance_notices (
  id TEXT PRIMARY KEY,
  policy_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('balance_warning', 'balance_restricted', 'balance_stopped', 'balance_restored')),
  title TEXT NOT NULL,
  at TEXT NOT NULL,
  user_ids_json TEXT NOT NULL CHECK (json_valid(user_ids_json))
) STRICT;

CREATE INDEX policy_balance_notices_recent ON policy_balance_notices (at);
