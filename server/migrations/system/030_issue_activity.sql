ALTER TABLE issues ADD COLUMN status TEXT NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'in_progress', 'resolved', 'closed'));
ALTER TABLE issues ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE issues ADD COLUMN updated_at TEXT;
UPDATE issues SET updated_at = created_at;
CREATE INDEX issues_status_created ON issues(status, created_at DESC, id DESC);

CREATE TABLE issue_activities (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 1),
  actor_id TEXT NOT NULL REFERENCES platform_users(id),
  role TEXT NOT NULL CHECK (role IN ('member', 'platform')),
  text TEXT,
  status TEXT CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at TEXT NOT NULL,
  CHECK (text IS NOT NULL OR status IS NOT NULL),
  CHECK (status IS NULL OR role = 'platform'),
  PRIMARY KEY (issue_id, revision)
) STRICT;
