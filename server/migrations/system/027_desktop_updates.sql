CREATE TABLE desktop_release_updates (
  release_id TEXT PRIMARY KEY REFERENCES desktop_releases(id),
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 268435456),
  sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,
  artifact_path TEXT NOT NULL
);
