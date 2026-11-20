import { createReadStream, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, invalid } from './api';
import { receiveArtifact } from './artifact-upload';
import { iso } from './credentials';
import { DESKTOP_ARTIFACT_MAX_BYTES } from './desktop-releases';
import { platformActor, type ManagementOptions } from './management';
import type { Store } from './store';

export const AGENT_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export const AGENT_ARTIFACT_UPLOAD_PATH = /^\/v1\/platform\/agent-releases\/[^/]+\/artifact$/;
export const AGENT_ARTIFACT_DOWNLOAD_PATH = /^\/v1\/agent-artifacts\/[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{64}$/;
type Release = { id: string; sha256: string; size: number; revision: number };

export function agentArtifactRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const dir = join(opts.dataDir, 'agent-artifacts');
  const active = "status = 'active'";

  app.put('/v1/platform/agent-releases/:id/artifact', async (c) => {
    const actor = platformActor(store, c, opts.now());
    const row = store.system.get<Release>(`SELECT id, sha256, size, revision FROM agent_releases WHERE id = ? AND ${active}`,
      [c.req.param('id')]);
    if (!row || !shaPattern.test(row.sha256)) throw new ApiError('not_found');
    if (row.size > AGENT_ARTIFACT_MAX_BYTES) throw new ApiError('too_large', { max_bytes: AGENT_ARTIFACT_MAX_BYTES });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${ulid()}.part`);
    const compressed = temp + '.gz';
    try {
      const unpack = c.req.header('content-type') === 'application/gzip';
      const artifact = unpack
        ? await receiveCompressed(c.req.raw, compressed, temp, row.size)
        : await receiveArtifact(c.req.raw, temp, AGENT_ARTIFACT_MAX_BYTES, row.size);
      if (artifact.sha256 !== row.sha256) invalid('artifact');
      platformActor(store, c, opts.now());
      await store.system.write((sql) => {
        if (!sql.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [actor])) throw new ApiError('forbidden');
        const unchanged = sql.get(`SELECT 1 FROM agent_releases WHERE id = ? AND revision = ? AND ${active}`, [row.id, row.revision]);
        if (!unchanged) throw new ApiError('conflict');
        renameSync(temp, join(dir, row.sha256));
        sql.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
          [`aud_${ulid()}`, actor, 'agent_release.artifact', row.id, JSON.stringify(artifact), iso(opts.now())]);
      });
      return c.json({ ...artifact, download_url: `/v1/agent-artifacts/${row.sha256}` });
    } finally {
      await Promise.all([unlink(temp).catch(() => {}), unlink(compressed).catch(() => {})]);
    }
  });

  app.get('/v1/agent-artifacts/:sha256', (c) => {
    const sha256 = c.req.param('sha256');
    if (!shaPattern.test(sha256)) throw new ApiError('not_found');
    const path = join(dir, sha256);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size > AGENT_ARTIFACT_MAX_BYTES
      || !store.system.get(`SELECT 1 FROM agent_releases WHERE sha256 = ? AND size = ? AND ${active}`, [sha256, info.size])) {
      throw new ApiError('not_found');
    }
    return new Response(Bun.file(path), { headers: { 'cache-control': 'no-store', 'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="onex-agent"', 'content-length': String(info.size),
      'x-content-type-options': 'nosniff' } });
  });
}

async function receiveCompressed(request: Request, compressed: string, target: string, size: number) {
  await receiveArtifact(request, compressed, DESKTOP_ARTIFACT_MAX_BYTES);
  const input = createReadStream(compressed);
  const output = createGunzip();
  input.on('error', error => output.destroy(error));
  input.pipe(output);
  try {
    const body = Readable.toWeb(output) as ReadableStream<Uint8Array>;
    return await receiveArtifact({ body, headers: new Headers() }, target, AGENT_ARTIFACT_MAX_BYTES, size);
  } catch (error) {
    if (error instanceof Error && 'code' in error && /^Z_/.test(String(error.code))) invalid('artifact');
    throw error;
  } finally {
    input.destroy();
    output.destroy();
  }
}
