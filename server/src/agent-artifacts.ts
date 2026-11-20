import { createReadStream, mkdirSync, renameSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, invalid } from './api';
import { receiveArtifact } from './artifact-upload';
import { bearer, hash, iso } from './credentials';
import { AGENT_ARTIFACT_MAX_BYTES, agentDigest, allowedAgentReleases, artifactPath, hasArtifact, officialArtifactSource, readAgentPolicy, type AgentRelease } from './agent-catalog';
import { DESKTOP_ARTIFACT_MAX_BYTES } from './desktop-releases';
import { platformActor, type ManagementOptions } from './management';
import type { Store } from './store';

export const AGENT_ARTIFACT_UPLOAD_PATH = /^\/v1\/platform\/agent-releases\/[^/]+\/artifact$/;
export const AGENT_ARTIFACT_DOWNLOAD_PATH = /^\/v1\/(?:edge\/)?agent-artifacts\/[^/]+$/;

export function agentArtifactRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const dir = join(opts.dataDir, 'agent-artifacts');
  const active = "status = 'active'";
  const pulls = new Set<string>();

  function getRelease(id: string) {
    const row = store.system.get<AgentRelease>('SELECT * FROM agent_releases WHERE id = ?', [id]);
    if (!row || !agentDigest.test(row.sha256)) throw new ApiError('not_found');
    if (row.size > AGENT_ARTIFACT_MAX_BYTES) throw new ApiError('too_large', { max_bytes: AGENT_ARTIFACT_MAX_BYTES });
    return row;
  }

  async function storeArtifact(c: Context, row: AgentRelease, actor: string, input: Request | Response, unpack: boolean, source: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${ulid()}.part`);
    const compressed = temp + '.gz';
    try {
      const artifact = unpack
        ? await receiveCompressed(input, compressed, temp, row.size)
        : await receiveArtifact(input, temp, AGENT_ARTIFACT_MAX_BYTES, row.size);
      if (artifact.sha256 !== row.sha256) invalid('artifact');
      platformActor(store, c, opts.now());
      await store.system.write((sql) => {
        if (!sql.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [actor])) throw new ApiError('forbidden');
        const unchanged = sql.get('SELECT 1 FROM agent_releases WHERE id = ? AND revision = ?', [row.id, row.revision]);
        if (!unchanged) throw new ApiError('conflict');
        renameSync(temp, artifactPath(opts.dataDir, row.sha256));
        sql.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
          [`aud_${ulid()}`, actor, 'agent_release.artifact', row.id, JSON.stringify({ ...artifact, source }), iso(opts.now())]);
      });
      opts.onConfigChange?.();
      return c.json({ ...artifact, artifact_cached: true, download_url: `/v1/agent-artifacts/${row.sha256}` });
    } finally {
      await Promise.all([unlink(temp).catch(() => {}), unlink(compressed).catch(() => {})]);
    }
  }

  app.put('/v1/platform/agent-releases/:id/artifact', (c) => {
    const actor = platformActor(store, c, opts.now());
    const row = getRelease(c.req.param('id'));
    return storeArtifact(c, row, actor, c.req.raw, c.req.header('content-type') === 'application/gzip', 'upload');
  });

  app.post('/v1/platform/agent-releases/:id/pull', async (c) => {
    const actor = platformActor(store, c, opts.now());
    const row = getRelease(c.req.param('id'));
    const url = officialArtifactSource(row);
    if (!url) throw new ApiError('invalid', { fields: ['url'], reason: 'unsupported_official_source' });
    if (hasArtifact(opts.dataDir, row)) {
      return c.json({ sha256: row.sha256, size: row.size, artifact_cached: true, download_url: `/v1/agent-artifacts/${row.sha256}` });
    }
    if (pulls.has(row.id)) throw new ApiError('conflict', { reason: 'pull_in_progress' });
    pulls.add(row.id);
    try {
      const response = await fetch(url, { redirect: 'error', headers: { 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(120_000) }).catch(() => null);
      if (response?.status !== 200) {
        void response?.body?.cancel().catch(() => {});
        throw new ApiError('conflict', { reason: 'source_unavailable' });
      }
      return await storeArtifact(c, row, actor, response, false, 'official');
    } finally { pulls.delete(row.id); }
  });

  const download = (row: Pick<AgentRelease, 'sha256' | 'size'>) => {
    if (!hasArtifact(opts.dataDir, row)) throw new ApiError('not_found');
    return new Response(Bun.file(artifactPath(opts.dataDir, row.sha256)), { headers: {
      'cache-control': 'no-store', 'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="onex-agent"', 'content-length': String(row.size),
      'x-content-type-options': 'nosniff',
    } });
  };

  app.get('/v1/agent-artifacts/:sha256', (c) => {
    platformActor(store, c, opts.now());
    const sha256 = c.req.param('sha256');
    if (!agentDigest.test(sha256)) throw new ApiError('not_found');
    const row = store.system.get<AgentRelease>(`SELECT * FROM agent_releases WHERE sha256 = ? AND ${active} LIMIT 1`, [sha256]);
    if (!row) throw new ApiError('not_found');
    return download(row);
  });

  app.get('/v1/edge/agent-artifacts/:id', async (c) => {
    const token = bearer(c.req.header('Authorization'));
    if (!token) throw new ApiError('unauthenticated');
    const tokenHash = hash(token);
    const match = await store.device(tokenHash);
    if (!match || !store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [match.id])) throw new ApiError('unauthenticated');
    const db = store.tenant(match.id);
    const device = db.get<{ os: string; arch: string }>(`SELECT d.os, d.arch FROM devices d JOIN members m ON m.user_id = d.user_id
      WHERE d.token_hash = ? AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`,
      [tokenHash, iso(opts.now())]);
    if (!device) throw new ApiError('unauthenticated');
    const rows = allowedAgentReleases(store, opts.dataDir, readAgentPolicy(db), device.os, device.arch, true);
    const row = rows.find(entry => entry.id === c.req.param('id'));
    if (!row) throw new ApiError('not_found');
    return download(row);
  });
}

async function receiveCompressed(request: Pick<Request, 'body' | 'headers'>, compressed: string, target: string, size: number) {
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
