-- contracts/desktop-releases.md: one row per (os, arch, version); `artifact_path` is the private,
-- persisted location of the uploaded installer bytes under dataDir and is never returned to callers.
-- The contract only defines two platform combinations (darwin+arm64, windows+x64); the table CHECK
-- below pins that pairing as a second line of defense behind desktop-releases.ts's own validation.
-- SQLite has no built-in regex to also pin SemVer here, so that stays an application-layer check.
CREATE TABLE desktop_releases (
  id TEXT PRIMARY KEY, version TEXT NOT NULL,
  os TEXT NOT NULL CHECK (os IN ('darwin', 'windows')), arch TEXT NOT NULL CHECK (arch IN ('arm64', 'x64')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'unlisted')),
  size INTEGER, sha256 TEXT, artifact_path TEXT, published_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE (os, arch, version),
  CHECK ((os = 'darwin' AND arch = 'arm64') OR (os = 'windows' AND arch = 'x64'))
) STRICT;
-- At most one published row per platform; enforced again in application code within the publish
-- transaction (the partial unique index alone can't move the old current row to unlisted for us).
CREATE UNIQUE INDEX desktop_releases_current ON desktop_releases(os, arch) WHERE status = 'published';
