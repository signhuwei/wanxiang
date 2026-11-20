import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerManifest } from './release-package';

export type ServerRelease = ServerManifest & { uploaded_at: string | null; created_at: string; created_by: string };
export type Rollout = {
  id: string; commit: string; expected_commit: string; observed_commit: string | null;
  actor_id: string; request_key: string; status: 'queued' | 'running' | 'succeeded' | 'failed';
  error_code: string | null; created_at: string; started_at: string | null; finished_at: string | null;
};

export function releasePaths(dataDir: string) {
  const dir = join(dataDir, 'maintenance');
  return { dir, database: join(dir, 'releases.sqlite'), artifact: (commit: string) => join(dir, `${commit}.tar.gz`) };
}

export function openReleaseStore(dataDir: string) {
  const paths = releasePaths(dataDir);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const db = new Database(paths.database, { create: true, strict: true });
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS server_releases (
      "commit" TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, signature TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL, uploaded_at TEXT
    );
    CREATE TABLE IF NOT EXISTS server_rollouts (
      id TEXT PRIMARY KEY, "commit" TEXT NOT NULL REFERENCES server_releases("commit"), expected_commit TEXT NOT NULL,
      observed_commit TEXT, actor_id TEXT NOT NULL, request_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')), error_code TEXT,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      UNIQUE(actor_id, request_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS server_rollouts_single_active ON server_rollouts ((1))
      WHERE status IN ('queued', 'running');
    CREATE INDEX IF NOT EXISTS server_rollouts_by_commit ON server_rollouts ("commit", created_at DESC, id DESC);
  `);
  return db;
}

export function activeRollout(db: Database) {
  return db.query<Rollout, []>("SELECT * FROM server_rollouts WHERE status IN ('queued', 'running')").get();
}
