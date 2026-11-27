import { lstatSync, renameSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, invalid, json } from './api';
import { receiveArtifact } from './artifact-upload';
import { iso } from './credentials';
import { pagination, platformActor, type ManagementOptions } from './management';
import { commitPattern, DOCKER_RELEASE_FORMAT, DOCKER_RELEASE_UPLOAD_TIMEOUT_MS, isManifest, MAX_RELEASE_BYTES, releaseKey, verifyManifest,
  type ServerReleaseFormat } from './release-package';
import { activeRollout, openReleaseStore, releasePaths, type Rollout, type ServerRelease } from './release-store';
import { sqliteTransaction } from './sqlite-transaction';
import type { Store } from './store';

const base = '/v1/platform/server-releases';
const ageHeader = 'age-encryption.org/v1\n';
export const SERVER_ARTIFACT_UPLOAD_PATH = /^\/v1\/platform\/server-releases\/[0-9a-f]{40}\/artifact$/;
export type ReleaseRuntime = { publicKeyPath: string; heartbeatPath: string; format?: ServerReleaseFormat };

export function serverReleaseRoutes(app: Hono, store: Store, opts: ManagementOptions & { commit: string; releaseRuntime?: ReleaseRuntime }) {
  const db = openReleaseStore(opts.dataDir);
  const paths = releasePaths(opts.dataDir);
  const key = () => releaseKey(opts.releaseRuntime?.publicKeyPath);
  const format = opts.releaseRuntime?.format ?? null;
  const compatible = (release: { format?: ServerReleaseFormat | null }) => (release.format ?? null) === format;
  const requireFormat = (release: Parameters<typeof compatible>[0]) => {
    if (!compatible(release)) throw new ApiError('conflict', { reason: 'artifact_format_incompatible' });
  };
  const ready = () => {
    const heartbeat = opts.releaseRuntime?.heartbeatPath;
    const stat = heartbeat ? lstatSync(heartbeat, { throwIfNoEntry: false }) : undefined;
    return Boolean(stat?.isFile() && Math.abs(opts.now() - stat.mtimeMs) < 90_000 && key());
  };
  const checkActor = (c: Parameters<typeof platformActor>[1]) => platformActor(store, c, opts.now());
  const release = (commit: string) => {
    if (!commitPattern.test(commit)) invalid('commit');
    const row = db.query<ServerRelease, [string]>('SELECT * FROM server_releases WHERE "commit" = ?').get(commit);
    if (!row) throw new ApiError('not_found');
    return row;
  };
  const rolloutView = (row: Rollout) => ({
    id: row.id, commit: row.commit, expected_commit: row.expected_commit, observed_commit: row.observed_commit,
    actor_id: row.actor_id, status: row.status, error_code: row.error_code, created_at: row.created_at,
    started_at: row.started_at, finished_at: row.finished_at,
  });
  const view = (row: ServerRelease, canDeploy: boolean) => {
    const last = db.query<Rollout, [string]>(
      'SELECT * FROM server_rollouts WHERE "commit" = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(row.commit);
    const actions = ['read'];
    if (compatible(row) && row.uploaded_at && canDeploy) actions.push('deploy');
    if (compatible(row) && !row.uploaded_at && key()) actions.push('upload_artifact');
    return {
      id: row.commit, commit: row.commit, size: row.size, sha256: row.sha256, created_at: row.created_at,
      ...(row.format === DOCKER_RELEASE_FORMAT && { format: row.format, platform: row.platform, image_id: row.image_id }),
      uploaded_at: row.uploaded_at, active: row.commit === opts.commit, last_rollout: last ? rolloutView(last) : null,
      actions,
    };
  };

  app.get('/v1/platform/maintenance', (c) => {
    checkActor(c);
    const active = activeRollout(db);
    return c.json({ active_commit: opts.commit, runner_ready: ready(), active_rollout: active ? rolloutView(active) : null,
      ...(format && { release_format: format }),
      actions: key() ? ['create_server_release'] : [] });
  });
  app.get(base, (c) => {
    checkActor(c);
    const p = pagination(c);
    const where = 'WHERE instr("commit", lower(?)) > 0';
    const { n } = db.query<{ n: number }, [string]>(`SELECT count(*) AS n FROM server_releases ${where}`).get(p.query)!;
    const rows = db.query<ServerRelease, [string, number, number]>(
      `SELECT * FROM server_releases ${where} ORDER BY created_at DESC, "commit" LIMIT ? OFFSET ?`).all(p.query, p.limit, p.offset);
    const canDeploy = ready() && !activeRollout(db);
    return c.json(p.page(rows.map(row => view(row, canDeploy)), n, key() ? ['create_server_release'] : []));
  });
  app.post(base, async (c) => {
    const actor = checkActor(c);
    const body = await json(c);
    checkActor(c);
    if (!isManifest(body)) {
      if (body.format != null || body.platform != null || body.image_id != null) {
        invalid('commit', 'sha256', 'size', 'signature', 'format', 'platform', 'image_id');
      }
      invalid('commit', 'sha256', 'size', 'signature');
    }
    const signer = key();
    if (!signer) throw new ApiError('conflict', { reason: 'signer_unavailable' });
    if (!verifyManifest(signer, body)) invalid('signature');
    requireFormat(body);
    const result = sqliteTransaction(db, () => {
      const previous = db.query<ServerRelease, [string]>('SELECT * FROM server_releases WHERE "commit" = ?').get(body.commit);
      if (previous) {
        if (previous.size !== body.size || previous.sha256 !== body.sha256 || !compatible(previous)
          || previous.platform !== (body.platform ?? null) || previous.image_id !== (body.image_id ?? null)) {
          throw new ApiError('conflict', { reason: 'commit_has_other_artifact' });
        }
        if (previous.signature !== body.signature) {
          db.run('UPDATE server_releases SET signature = ? WHERE "commit" = ?', [body.signature, body.commit]);
        }
        return { item: view(previous, ready() && !activeRollout(db)), status: 200 as const };
      }
      db.run(`INSERT INTO server_releases ("commit", sha256, size, signature, created_at, created_by, format, platform, image_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [body.commit, body.sha256, body.size, body.signature, iso(opts.now()), actor, body.format ?? null, body.platform ?? null, body.image_id ?? null]);
      return { item: view(release(body.commit), false), status: 201 as const };
    });
    return c.json(result.item, result.status);
  });
  app.get(`${base}/:commit`, (c) => {
    checkActor(c);
    return c.json(view(release(c.req.param('commit')), ready() && !activeRollout(db)));
  });
  app.put(`${base}/:commit/artifact`, async (c) => {
    checkActor(c);
    const row = release(c.req.param('commit'));
    requireFormat(row);
    const signer = key();
    if (!signer || !verifyManifest(signer, row)) throw new ApiError('conflict', { reason: 'signer_unavailable' });
    if (row.uploaded_at) return c.json(view(row, ready() && !activeRollout(db)));
    const temp = join(paths.dir, `.${ulid()}.part`);
    try {
      const timeout = row.format === DOCKER_RELEASE_FORMAT ? DOCKER_RELEASE_UPLOAD_TIMEOUT_MS : undefined;
      const { sha256 } = await receiveArtifact(c.req.raw, temp, MAX_RELEASE_BYTES, row.size, timeout);
      if (sha256 !== row.sha256) invalid('artifact');
      if (row.format === DOCKER_RELEASE_FORMAT && await Bun.file(temp).slice(0, ageHeader.length).text() !== ageHeader) invalid('artifact');
      checkActor(c);
      const currentKey = key();
      if (!currentKey || !verifyManifest(currentKey, row)) throw new ApiError('conflict', { reason: 'signer_unavailable' });
      const updated = sqliteTransaction(db, () => {
        const current = release(row.commit);
        if (!current.uploaded_at) {
          renameSync(temp, paths.artifact(row.commit, row.format));
          db.run('UPDATE server_releases SET uploaded_at = ? WHERE "commit" = ?', [iso(opts.now()), row.commit]);
        }
        return release(row.commit);
      });
      return c.json(view(updated, ready() && !activeRollout(db)));
    } finally {
      await unlink(temp).catch(() => {});
    }
  });
  app.post(`${base}/:commit/deploy`, async (c) => {
    const actor = checkActor(c);
    const body = await json(c);
    checkActor(c);
    const expected = body.expected_commit;
    const requestKey = c.req.header('Idempotency-Key');
    if (typeof expected !== 'string' || !commitPattern.test(expected)) invalid('expected_commit');
    if (!requestKey || !/^[\x21-\x7e]{1,128}$/.test(requestKey)) invalid('Idempotency-Key');
    const commit = c.req.param('commit');
    const job = sqliteTransaction(db, () => {
      const prior = db.query<Rollout, [string, string]>('SELECT * FROM server_rollouts WHERE actor_id = ? AND request_key = ?').get(actor, requestKey);
      if (prior) {
        if (prior.commit !== commit || prior.expected_commit !== expected) throw new ApiError('conflict');
        return prior;
      }
      if (!ready()) throw new ApiError('conflict', { reason: 'runner_unavailable' });
      if (expected !== opts.commit) throw new ApiError('conflict', { reason: 'active_commit_changed', active_commit: opts.commit });
      const active = activeRollout(db);
      if (active) throw new ApiError('conflict', { reason: 'rollout_in_progress', rollout_id: active.id });
      const row = release(commit);
      requireFormat(row);
      const signer = key();
      if (!row.uploaded_at || !signer || !verifyManifest(signer, row)) throw new ApiError('conflict', { reason: 'artifact_unavailable' });
      const id = `roll_${ulid()}`;
      db.run(`INSERT INTO server_rollouts (id, "commit", expected_commit, actor_id, request_key, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?)`, [id, commit, expected, actor, requestKey, iso(opts.now())]);
      return db.query<Rollout, [string]>('SELECT * FROM server_rollouts WHERE id = ?').get(id)!;
    });
    return c.json(rolloutView(job), 202);
  });
  app.get('/v1/platform/server-rollouts/:id', (c) => {
    checkActor(c);
    const job = db.query<Rollout, [string]>('SELECT * FROM server_rollouts WHERE id = ?').get(c.req.param('id'));
    if (!job) throw new ApiError('not_found');
    return c.json(rolloutView(job));
  });
  return () => db.close(true);
}
