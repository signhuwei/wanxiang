import { createReadStream, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, invalid } from './api';
import { receiveArtifact } from './artifact-upload';
import { readContract } from './capability-data';
import { bearer, hash, iso } from './credentials';
import { agentArtifactMaxBytes, DESKTOP_AGENT_PART_BYTES, agentDigest, allDesktopCapabilities, allowedAgentReleases, artifactFormat, artifactPath, hasArtifact, officialArtifactSource, requiresDesktopQualification, runtimeArtifact, type AgentRelease } from './agent-catalog';
import { DESKTOP_ARTIFACT_MAX_BYTES } from './desktop-releases';
import { platformActor, type ManagementOptions } from './management';
import type { Store } from './store';
import { readPolicyHot } from './policy-data';

export const AGENT_ARTIFACT_UPLOAD_PATH = /^\/v1\/platform\/agent-releases\/[^/]+\/(?:artifact|runtime)$/;
export const AGENT_ARTIFACT_DOWNLOAD_PATH = /^\/v1\/(?:(?:edge\/)?agent-artifacts\/[^/]+(?:\/runtime)?|platform\/agent-releases\/[^/]+\/runtime)$/;

// Ignore unsupported headers and serve the whole object. A syntactically valid
// single range with no overlap is distinct from an unsupported header.
function byteRange(header: string | null, size: number) {
  const range = /^bytes=(\d*)-(\d*)$/i.exec(header ?? '');
  if (!range || (!range[1] && !range[2])) return undefined;
  if (!range[1]) {
    const length = Number(range[2]);
    return length ? { start: Math.max(0, size - length), end: size - 1 } : null;
  }
  const start = Number(range[1]);
  const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  return start <= end ? { start, end } : null;
}

export function agentArtifactRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const dir = join(opts.dataDir, 'agent-artifacts');
  const pulls = new Set<string>();
  const uploadingParts = new Set<string>();
  const cached = (c: Context, row: AgentRelease) =>
    c.json({ sha256: row.sha256, size: row.size, artifact_cached: true, download_url: `/v1/agent-artifacts/${row.sha256}` });
  const partDir = (row: AgentRelease) => join(dir, '.chunks', row.id);

  function joinedParts(paths: string[]) {
    async function* read() {
      for (const path of paths) for await (const chunk of createReadStream(path)) yield chunk;
    }
    return { body: Readable.toWeb(Readable.from(read(), { objectMode: false })) as ReadableStream<Uint8Array>, headers: new Headers() };
  }

  function getRelease(id: string) {
    const row = store.system.get<AgentRelease>('SELECT * FROM agent_releases WHERE id = ?', [id]);
    if (!row || !agentDigest.test(row.sha256)) throw new ApiError('not_found');
    const limit = agentArtifactMaxBytes(row.agent);
    if (row.size > limit) throw new ApiError('too_large', { max_bytes: limit });
    return row;
  }

  async function storeArtifact(c: Context, row: AgentRelease, actor: string, input: Pick<Request, 'body' | 'headers'>, unpack: boolean, source: string, runtime?: NonNullable<ReturnType<typeof runtimeArtifact>>) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${ulid()}.part`);
    const compressed = temp + '.gz';
    const expected = runtime ?? row;
    const limit = runtime?.size ?? agentArtifactMaxBytes(row.agent);
    try {
      const artifact = unpack
        ? await receiveCompressed(input, compressed, temp, row.size, limit)
        : await receiveArtifact(input, temp, limit, expected.size);
      if (artifact.sha256 !== expected.sha256) invalid('artifact');
      const format = runtime ? 'tar.zst' : artifactFormat(row);
      const file = Bun.file(temp);
      if (!format || (format === 'dmg' && (file.size < 512 || await file.slice(-512, -508).text() !== 'koly'))
        || (format === 'nsis' && await file.slice(0, 2).text() !== 'MZ')) invalid('artifact');
      platformActor(store, c, opts.now());
      await store.system.write((sql) => {
        if (!sql.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [actor])) throw new ApiError('forbidden');
        const unchanged = sql.get('SELECT 1 FROM agent_releases WHERE id = ? AND revision = ?', [row.id, row.revision]);
        if (!unchanged) throw new ApiError('conflict');
        renameSync(temp, artifactPath(opts.dataDir, expected.sha256));
        sql.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
          [`aud_${ulid()}`, actor, runtime ? 'agent_release.runtime' : 'agent_release.artifact', row.id, JSON.stringify({ ...artifact, source }), iso(opts.now())]);
      });
      opts.onConfigChange?.();
      return runtime ? c.json({ ...runtime, artifact_cached: true }) : cached(c, row);
    } finally {
      await Promise.all([unlink(temp).catch(() => {}), unlink(compressed).catch(() => {})]);
    }
  }

  app.put('/v1/platform/agent-releases/:id/artifact', async (c) => {
    const actor = platformActor(store, c, opts.now());
    const row = getRelease(c.req.param('id'));
    const uploadPart = c.req.query('part');
    if (uploadPart === undefined) {
      return storeArtifact(c, row, actor, c.req.raw, c.req.header('content-type') === 'application/gzip', 'upload');
    }
    const count = Math.ceil(row.size / DESKTOP_AGENT_PART_BYTES);
    const index = Number(uploadPart);
    if (!requiresDesktopQualification(row.agent) || !/^(0|[1-9]\d*)$/.test(uploadPart) || index >= count) invalid('part');
    if (String(row.revision) !== c.req.query('revision')) throw new ApiError('conflict', { revision: row.revision });
    if (hasArtifact(opts.dataDir, row)) return cached(c, row);
    if (uploadingParts.has(row.id)) throw new ApiError('conflict', { reason: 'upload_in_progress' });
    uploadingParts.add(row.id);
    const directory = partDir(row);
    const temp = join(directory, `.${ulid()}.part`);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const paths = Array.from({ length: count }, (_, part) => join(directory, String(part)));
      const size = Math.min(DESKTOP_AGENT_PART_BYTES, row.size - index * DESKTOP_AGENT_PART_BYTES);
      await receiveArtifact(c.req.raw, temp, size, size);
      platformActor(store, c, opts.now());
      if (getRelease(row.id).revision !== row.revision) throw new ApiError('conflict');
      renameSync(temp, paths[index]!);
      if (!paths.every(path => lstatSync(path, { throwIfNoEntry: false })?.isFile())) {
        return c.json({ artifact_cached: false, part: index, count }, 202);
      }
      try {
        return await storeArtifact(c, row, actor, joinedParts(paths), false, 'multipart');
      } finally { await rm(directory, { recursive: true, force: true }); }
    } finally {
      await unlink(temp).catch(() => {});
      uploadingParts.delete(row.id);
    }
  });

  app.post('/v1/platform/agent-releases/:id/pull', async (c) => {
    const actor = platformActor(store, c, opts.now());
    const row = getRelease(c.req.param('id'));
    const url = officialArtifactSource(row);
    if (!url) throw new ApiError('invalid', { fields: ['url'], reason: 'unsupported_official_source' });
    if (hasArtifact(opts.dataDir, row)) return cached(c, row);
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

  function getRuntime(row: AgentRelease) {
    const runtime = runtimeArtifact(row);
    if (!runtime) throw new ApiError('not_found');
    return { ...runtime, agent: row.agent };
  }

  app.put('/v1/platform/agent-releases/:id/runtime', async (c) => {
    const actor = platformActor(store, c, opts.now());
    const row = getRelease(c.req.param('id'));
    const { size, sha256 } = getRuntime(row);
    if (String(row.revision) !== c.req.query('revision')) throw new ApiError('conflict', { revision: row.revision });
    return storeArtifact(c, row, actor, c.req.raw, false, 'upload', { size, sha256 });
  });

  const downloadArtifact = (row: Pick<AgentRelease, 'agent' | 'sha256' | 'size'>, filename: string, request?: Request) => {
    if (!hasArtifact(opts.dataDir, row)) throw new ApiError('not_found');
    const file = Bun.file(artifactPath(opts.dataDir, row.sha256));
    const headers = new Headers({
      'cache-control': 'no-store', 'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`, 'content-length': String(row.size),
      'x-content-type-options': 'nosniff',
    });
    if (!request) return new Response(file, { headers });
    const etag = `"${row.sha256}"`;
    headers.set('accept-ranges', 'bytes');
    headers.set('etag', etag);
    const validator = request.headers.get('if-range');
    const range = validator === null || validator === etag ? byteRange(request.headers.get('range'), row.size) : undefined;
    if (range === null) {
      headers.set('content-range', `bytes */${row.size}`);
      headers.set('content-length', '0');
      return new Response(null, { status: 416, headers });
    }
    if (!range) return new Response(file, { headers });
    const { start, end } = range;
    headers.set('content-range', `bytes ${start}-${end}/${row.size}`);
    headers.set('content-length', String(end - start + 1));
    return new Response(file.slice(start, end + 1), { status: 206, headers });
  };
  const download = (row: AgentRelease, request?: Request) => {
    const format = artifactFormat(row);
    const filename = format === 'dmg' ? 'onex-agent.dmg' : format === 'nsis' ? 'onex-agent.exe' : 'onex-agent';
    return downloadArtifact(row, filename, request);
  };

  app.get('/v1/agent-artifacts/:sha256', (c) => {
    platformActor(store, c, opts.now());
    const sha256 = c.req.param('sha256');
    if (!agentDigest.test(sha256)) throw new ApiError('not_found');
    const rows = store.system.all<AgentRelease>('SELECT * FROM agent_releases WHERE sha256 = ? ORDER BY id', [sha256]);
    const row = rows.find(row => row.status === 'active' || requiresDesktopQualification(row.agent));
    if (!row) throw new ApiError('not_found');
    return download(row);
  });

  app.get('/v1/platform/agent-releases/:id/runtime', (c) => {
    platformActor(store, c, opts.now());
    return downloadArtifact(getRuntime(getRelease(c.req.param('id'))), 'onex-agent-runtime.tar.zst');
  });

  async function deviceRelease(c: Context) {
    const token = bearer(c.req.header('Authorization'));
    if (!token) throw new ApiError('unauthenticated');
    const tokenHash = hash(token);
    const match = await store.device(tokenHash);
    if (!match || !store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [match.id])) throw new ApiError('unauthenticated');
    const db = store.tenant(match.id);
    const device = db.get<{ os: string; arch: string; user_id: string }>(`SELECT d.os, d.arch, d.user_id FROM devices d JOIN members m ON m.user_id = d.user_id
      WHERE d.token_hash = ? AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`,
      [tokenHash, iso(opts.now())]);
    if (!device) throw new ApiError('unauthenticated');
    const rows = allowedAgentReleases(store, opts.dataDir, readPolicyHot(db,device.user_id)??readContract(db), device.os, device.arch, true, allDesktopCapabilities);
    const row = rows.find(entry => entry.id === c.req.param('id'));
    if (!row) throw new ApiError('not_found');
    return row;
  }

  app.get('/v1/edge/agent-artifacts/:id', async (c) => download(await deviceRelease(c), c.req.raw));
  app.get('/v1/edge/agent-artifacts/:id/runtime', async (c) =>
    downloadArtifact(getRuntime(await deviceRelease(c)), 'onex-agent-runtime.tar.zst', c.req.raw));
}

async function receiveCompressed(request: Pick<Request, 'body' | 'headers'>, compressed: string, target: string, size: number, limit: number) {
  await receiveArtifact(request, compressed, DESKTOP_ARTIFACT_MAX_BYTES);
  const input = createReadStream(compressed);
  const output = createGunzip();
  input.on('error', error => output.destroy(error));
  input.pipe(output);
  try {
    const body = Readable.toWeb(output) as ReadableStream<Uint8Array>;
    return await receiveArtifact({ body, headers: new Headers() }, target, limit, size);
  } catch (error) {
    if (error instanceof Error && 'code' in error && /^Z_/.test(String(error.code))) invalid('artifact');
    throw error;
  } finally {
    input.destroy();
    output.destroy();
  }
}
