CREATE TABLE tool_releases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'mcp')),
  agents_json TEXT NOT NULL CHECK (json_valid(agents_json)),
  os TEXT CHECK (os IN ('macos', 'windows')),
  arch TEXT CHECK (arch IN ('arm64', 'x64')),
  entrypoint TEXT,
  args_json TEXT NOT NULL CHECK (json_valid(args_json)),
  sha256 TEXT,
  size INTEGER,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'disabled')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'skill' AND os IS NULL AND arch IS NULL AND entrypoint IS NULL)
    OR (kind = 'mcp' AND os IS NOT NULL AND arch IS NOT NULL AND entrypoint IS NOT NULL)),
  CHECK ((sha256 IS NULL AND size IS NULL) OR (sha256 IS NOT NULL AND length(sha256) = 64
    AND size IS NOT NULL AND size BETWEEN 1 AND 25165824)),
  CHECK (status != 'published' OR sha256 IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX tool_releases_version ON tool_releases(kind, name COLLATE NOCASE, version, coalesce(os, ''), coalesce(arch, ''));
