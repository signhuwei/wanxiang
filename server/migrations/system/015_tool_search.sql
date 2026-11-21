CREATE TABLE tool_releases_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'mcp', 'hook', 'http_search')),
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
  CHECK ((kind IN ('skill', 'http_search') AND os IS NULL AND arch IS NULL AND entrypoint IS NULL)
    OR (kind IN ('mcp', 'hook') AND os IS NOT NULL AND arch IS NOT NULL AND entrypoint IS NOT NULL)),
  CHECK ((sha256 IS NULL AND size IS NULL) OR (sha256 IS NOT NULL AND length(sha256) = 64
    AND size IS NOT NULL AND size BETWEEN 1 AND 25165824)),
  CHECK (status != 'published' OR kind = 'http_search' OR sha256 IS NOT NULL)
) STRICT;
INSERT INTO tool_releases_next SELECT * FROM tool_releases;
DROP TABLE tool_releases;
ALTER TABLE tool_releases_next RENAME TO tool_releases;
CREATE UNIQUE INDEX tool_releases_version ON tool_releases(kind, name COLLATE NOCASE, version, coalesce(os, ''), coalesce(arch, ''));
CREATE TABLE tool_search_targets (
  release_id TEXT PRIMARY KEY REFERENCES tool_releases(id),
  endpoint TEXT NOT NULL,
  secret_ciphertext BLOB NOT NULL
) STRICT;
