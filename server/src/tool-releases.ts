import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { receiveArtifact } from './artifact-upload';
import { bearer, hash, iso } from './credentials';
import { enumField, expectRevision, pagination, platformActor, type ManagementOptions } from './management';
import { readPolicyHot } from './policy-data';
import { encryptProviderSecret } from './provider-secret';
import { toolSearchRoutes } from './tool-search';
import type { RunSearch } from './tool-search-upstream';
import type { Store, Transaction } from './store';

const base = '/v1/platform/tool-releases';
export const TOOL_ARTIFACT_UPLOAD_PATH = /^\/v1\/platform\/tool-releases\/[^/]+\/artifact$/;
export const TOOL_ARTIFACT_DOWNLOAD_PATH = /^\/v1\/edge\/tool-artifacts\/[^/]+$/;
const maxWireBytes = 24 * 1024 * 1024;
const maxDecodedBytes = 16 * 1024 * 1024;
const maxFiles = 256;
const maxLaunchBytes = 96 * 1024 * 1024;
const releaseId = /^tool_[0-9A-HJKMNP-TV-Z]{26}$/;
const cliAgents = ['claude-code', 'codex', 'kimi-code'] as const;
type ToolAgent = typeof cliAgents[number];
type ToolKind = 'skill' | 'mcp' | 'hook' | 'http_search';
type ToothDelivery = 'system' | 'direct' | 'selected';
type ToolOS = 'macos' | 'windows';
type ToolArch = 'arm64' | 'x64';
type ToolStatus = 'draft' | 'published' | 'disabled';

export type ToolRelease = {
  id: string; name: string; version: string; kind: ToolKind; agents_json: string;
  os: ToolOS | null; arch: ToolArch | null; entrypoint: string | null; args_json: string;
  sha256: string | null; size: number | null; status: ToolStatus; delivery: ToothDelivery | null;
  revision: number; created_at: string;
};
export type ToolReleaseDescriptor = {
  id: string; name: string; version: string; kind: ToolKind; agents: ToolAgent[];
  os: ToolOS | null; arch: ToolArch | null; entrypoint: string | null; args: string[];
  sha256: string; size: number; delivery?: ToothDelivery;
};
export type ToolPolicy = { tool_release_ids_json: string; allowed_agents_json: string };

type Reader = Pick<Transaction, 'get'>;

function findToolRelease(db: Reader, id: string) {
  return db.get<ToolRelease>('SELECT * FROM tool_releases WHERE id = ?', [id]);
}

export function validateToolSet(db: Pick<Transaction, 'all'>, ids: string[], field: string) {
  if (ids.length > 64 || ids.some(id => !releaseId.test(id)) || new Set(ids).size !== ids.length) invalid(field);
  if (!ids.length) return;
  const rows = db.all<ToolRelease>(`SELECT * FROM tool_releases WHERE status = 'published'
    AND id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]);
  if (rows.length !== ids.length) invalid(field);

  const agents = rows.map(row => JSON.parse(row.agents_json) as ToolAgent[]);
  for (const agent of cliAgents) {
    for (const os of ['macos', 'windows']) {
      for (const arch of ['arm64', 'x64']) {
        const installed = new Set<string>();
        let bytes = 0;
        for (const [index, row] of rows.entries()) {
          if (row.kind === 'http_search' || !agents[index]?.includes(agent) || (row.kind !== 'skill' && (row.os !== os || row.arch !== arch))) continue;
          const key = `${row.kind}:${row.name.toLowerCase()}`;
          bytes += row.size ?? 0;
          if (installed.has(key) || bytes > maxLaunchBytes) invalid(field);
          installed.add(key);
        }
      }
    }
  }
}

function artifactPath(dataDir: string, sha256: string) {
  return join(dataDir, 'tool-artifacts', sha256);
}

export function hasToolArtifact(dataDir: string, row: Pick<ToolRelease, 'sha256' | 'size'>): row is { sha256: string; size: number } {
  if (!row.sha256 || !/^[0-9a-f]{64}$/.test(row.sha256) || !row.size || row.size > maxWireBytes) return false;
  const stat = lstatSync(artifactPath(dataDir, row.sha256), { throwIfNoEntry: false });
  return !!stat?.isFile() && stat.size === row.size;
}

function releaseMetadata(row: ToolRelease) {
  return { id: row.id, name: row.name, version: row.version, kind: row.kind, os: row.os, arch: row.arch,
    entrypoint: row.entrypoint, args: JSON.parse(row.args_json) as string[],
    ...(row.delivery && { delivery: row.delivery }) };
}

export function toolReleaseView(row: ToolRelease, dataDir: string, endpoint?: string) {
  const artifact_cached = hasToolArtifact(dataDir, row);
  const actions = ['read'];
  if (row.status === 'draft') {
    if (row.kind !== 'http_search' && row.sha256 === null) actions.push('upload');
    if (row.kind === 'http_search' ? !!endpoint : artifact_cached) actions.push('publish');
  }
  if (row.status !== 'disabled') actions.push('disable');
  return { ...releaseMetadata(row), agents: JSON.parse(row.agents_json) as ToolAgent[], sha256: row.sha256, size: row.size,
    status: row.status, revision: row.revision, created_at: row.created_at, artifact_cached,
    ...(endpoint && { endpoint, has_key: true }), actions };
}

export function allowedToolReleases(store: Store, dataDir: string, policy: ToolPolicy | null, os?: string, arch?: string,
  onUnavailable?: (id: string, reason: string) => void) {
  const releases: ToolReleaseDescriptor[] = [];
  if (!policy) return releases;
  const allowed = new Set<string>(JSON.parse(policy.allowed_agents_json) as string[]);
  const platform = os === 'darwin' ? 'macos' : os === 'win32' ? 'windows' : os;
  const rows = store.system.all<ToolRelease>(`SELECT * FROM tool_releases
    WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`, [policy.tool_release_ids_json]);
  if (onUnavailable) {
    const found = new Set(rows.map(row => row.id));
    for (const id of JSON.parse(policy.tool_release_ids_json) as string[]) {
      if (!found.has(id)) onUnavailable(id, 'tool_release_unavailable');
    }
  }
  for (const row of rows) {
    const agents = (JSON.parse(row.agents_json) as ToolAgent[]).filter(agent => allowed.has(agent));
    if (row.status !== 'published') onUnavailable?.(row.id, 'tool_release_disabled');
    else if (!agents.length) onUnavailable?.(row.id, 'tool_agent_denied');
    else if (row.kind === 'http_search') continue;
    else if (os !== undefined && row.kind !== 'skill' && (row.os !== platform || row.arch !== arch)) {
      onUnavailable?.(row.id, 'tool_platform_mismatch');
    } else if (!hasToolArtifact(dataDir, row)) onUnavailable?.(row.id, 'tool_artifact_missing');
    else releases.push({ ...releaseMetadata(row), kind: row.kind, agents, sha256: row.sha256, size: row.size });
  }
  return releases;
}

const reserved = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
function portablePath(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length > 240 || value.split('/').some(part =>
    !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,79}$/.test(part) || part.endsWith('.') || reserved.test(part))) invalid(name);
  return value;
}

function parseRelease(body: Record<string, unknown>) {
  if (Object.keys(body).some(key => !['name', 'version', 'kind', 'agents', 'os', 'arch', 'entrypoint', 'args', 'endpoint', 'secret', 'delivery'].includes(key))) invalid('body');
  const name = field(body.name, 'name', 48);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || reserved.test(name)) invalid('name');
  const version = field(body.version, 'version', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) invalid('version');
  const kind = enumField(body.kind, 'kind', ['skill', 'mcp', 'hook', 'http_search']);
  if (!Array.isArray(body.agents) || !body.agents.length || body.agents.length > cliAgents.length) invalid('agents');
  const agents = body.agents.map(agent => enumField(agent, 'agents', cliAgents));
  if (new Set(agents).size !== agents.length) invalid('agents');
  const common = { name, version, kind, agents_json: JSON.stringify(agents), args_json: '[]', delivery: null as ToothDelivery | null };
  if (kind === 'http_search') {
    for (const key of ['os', 'arch', 'entrypoint', 'args']) if (body[key] !== undefined) invalid(key);
    const endpoint = URL.parse(field(body.endpoint, 'endpoint', 1024));
    if (!endpoint || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) invalid('endpoint');
    const secret = field(body.secret, 'secret', 8192);
    if (!/^[\x21-\x7e]+$/.test(secret)) invalid('secret');
    return { metadata: { ...common, os: null, arch: null, entrypoint: null }, target: { endpoint: endpoint.href, secret } };
  }
  if (body.endpoint !== undefined || body.secret !== undefined) invalid('body');
  const delivery = body.delivery !== undefined
    ? enumField(body.delivery, 'delivery', ['system', 'direct', 'selected'] as const)
    : null;
  if (kind === 'skill') {
    for (const key of ['os', 'arch', 'entrypoint', 'args']) if (body[key] !== undefined) invalid(key);
    return { metadata: { ...common, os: null, arch: null, entrypoint: null, delivery } };
  }
  const os = enumField(body.os, 'os', ['macos', 'windows']);
  const arch = enumField(body.arch, 'arch', ['arm64', 'x64']);
  const entrypoint = portablePath(body.entrypoint, 'entrypoint');
  if (os === 'windows' && !entrypoint.toLowerCase().endsWith('.exe')) invalid('entrypoint');
  const args = body.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || !arg.isWellFormed()
    || Buffer.byteLength(arg) > 256 || /[\x00-\x1f\x7f]/.test(arg))) invalid('args');
  if (kind === 'hook' && (os !== 'macos' || agents.length !== 1 || agents[0] !== 'claude-code' || args.length)) invalid('agents', 'os', 'args');
  if (Buffer.byteLength(JSON.stringify(args)) > 4096) invalid('args');
  return { metadata: { ...common, os, arch, entrypoint, args_json: JSON.stringify(args), delivery } };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// JSON.parse alone discards duplicate keys while the Edge's typed reader rejects them. Count
// property tokens in syntactically valid JSON so neither reader can see a different package.
function countJsonProperties(text: string) {
  let count = 0;
  for (let start = text.indexOf('"'); start !== -1;) {
    let end = start + 1;
    for (; text[end] !== '"'; end++) if (text[end] === '\\') end++;
    let next = end + 1;
    while (' \n\r\t'.includes(text[next] ?? '\0')) next++;
    if (text[next] === ':') count++;
    start = text.indexOf('"', end + 1);
  }
  return count;
}

function validateBundle(raw: ArrayBuffer, release: ToolRelease) {
  let text: string;
  let bundle: unknown;
  try { text = utf8.decode(raw); bundle = JSON.parse(text); } catch { invalid('artifact'); }
  if (!record(bundle) || Object.keys(bundle).length !== 1 || !Array.isArray(bundle.files)
    || !bundle.files.length || bundle.files.length > maxFiles || countJsonProperties(text) !== 1 + 2 * bundle.files.length) invalid('artifact');

  let bytes = 0;
  let entryFound = false;
  const paths = new Map<string, string>();
  const directories = new Map<string, string>();
  const entry = release.kind === 'skill' ? 'SKILL.md' : release.entrypoint;
  for (const file of bundle.files) {
    if (!record(file) || Object.keys(file).length !== 2 || typeof file.data !== 'string') invalid('artifact');
    const path = portablePath(file.path, 'artifact');
    const folded = path.toLowerCase();
    if (paths.has(folded) || directories.has(folded)) invalid('artifact');
    const parts = path.split('/');
    parts.pop();
    let parent = '';
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      const key = parent.toLowerCase();
      const existing = directories.get(key);
      if (paths.has(key) || (existing !== undefined && existing !== parent)) invalid('artifact');
      directories.set(key, parent);
    }
    paths.set(folded, path);

    // Node's Base64 decoder accepts ignored bytes and alternate alphabets. Round-trip to
    // the canonical standard encoding accepted by the Edge, then check the expanded total.
    const content = Buffer.from(file.data, 'base64');
    if (content.toString('base64') !== file.data) invalid('artifact');
    bytes += content.byteLength;
    if (bytes > maxDecodedBytes) throw new ApiError('too_large', { max_bytes: maxDecodedBytes, field: 'artifact.files' });
    if (path !== entry) continue;
    if (content.byteLength === 0) invalid('artifact');
    if (release.kind === 'skill') {
      let markdown: string;
      try { markdown = utf8.decode(content); } catch { invalid('artifact'); }
      if (!markdown.trim() || markdown.includes('\0')) invalid('artifact');
    }
    entryFound = true;
  }
  if (!entryFound) invalid('artifact');
}

function requirePlatform(sql: Transaction, actor: string) {
  if (!sql.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [actor])) throw new ApiError('forbidden');
}

function audit(sql: Transaction, actor: string, action: string, row: ToolRelease, at: number) {
  const detail = { revision: row.revision, status: row.status, sha256: row.sha256, size: row.size };
  sql.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
    [`aud_${ulid()}`, actor, `tool_release.${action}`, row.id, JSON.stringify(detail), iso(at)]);
}

function requireRelease(db: Reader, id: string) {
  const row = findToolRelease(db, id);
  if (!row) throw new ApiError('not_found');
  return row;
}

function requireUploadable(row: ToolRelease, revision: string | undefined) {
  if (!revision || !/^[1-9]\d{0,15}$/.test(revision)) invalid('revision');
  expectRevision(Number(revision), row.revision);
  if (row.kind === 'http_search' || row.status !== 'draft' || row.sha256 !== null) throw new ApiError('conflict', { revision: row.revision });
}

export function toolReleaseRoutes(app: Hono, store: Store, opts: ManagementOptions, runSearch?: RunSearch) {
  const endpoint = (row: ToolRelease) => row.kind === 'http_search'
    ? store.system.get<{ endpoint: string }>('SELECT endpoint FROM tool_search_targets WHERE release_id=?', [row.id])?.endpoint : undefined;
  const view = (row: ToolRelease) => toolReleaseView(row, opts.dataDir, endpoint(row));
  const directory = join(opts.dataDir, 'tool-artifacts');
  app.get(base, (c) => {
    platformActor(store, c, opts.now());
    const page = pagination(c);
    const params = [page.query];
    const where = "WHERE instr(lower(id || ' ' || name || ' ' || kind || ' ' || version || ' ' || status), lower(?)) > 0";
    const { n } = store.system.get<{ n: number }>(`SELECT count(*) AS n FROM tool_releases ${where}`, params)!;
    const rows = store.system.all<ToolRelease>(`SELECT * FROM tool_releases ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, page.limit, page.offset]);
    return c.json(page.page(rows.map(view), n, ['create_tool_release']));
  });

  app.post(base, async (c) => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const { metadata, target } = parseRelease(await json(c));
    const op = operation(c, opts.codeSecret, at, actor, target ? { metadata, target } : metadata);
    return store.system.write((sql) => {
      requirePlatform(sql, actor);
      const cached = op.read(sql);
      if (cached) return cached;
      const row = { ...metadata, id: `tool_${ulid()}`, status: 'draft' as const, revision: 1, sha256: null, size: null, created_at: iso(at) };
      if (sql.get(`SELECT 1 FROM tool_releases WHERE kind = ? AND name = ? COLLATE NOCASE AND version = ? AND os IS ? AND arch IS ?`,
        [row.kind, row.name, row.version, row.os, row.arch])) throw new ApiError('conflict');
      sql.run(`INSERT INTO tool_releases (id, name, version, kind, agents_json, os, arch, entrypoint, args_json, status, delivery, revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.name, row.version, row.kind, row.agents_json, row.os, row.arch, row.entrypoint, row.args_json, row.status, row.delivery ?? null, row.revision, row.created_at]);
      if (target) {
        if (!opts.masterKey) throw new ApiError('conflict', { reason: 'master_key_required' });
        sql.run('INSERT INTO tool_search_targets(release_id,endpoint,secret_ciphertext) VALUES(?,?,?)',
          [row.id, target.endpoint, encryptProviderSecret(opts.masterKey, row.id, target.secret)]);
      }
      audit(sql, actor, 'create', row, at);
      return op.complete(sql, { status: 201, payload: toolReleaseView(row, opts.dataDir, target?.endpoint) });
    });
  });

  app.get(`${base}/:id`, (c) => {
    platformActor(store, c, opts.now());
    return c.json(view(requireRelease(store.system, c.req.param('id'))));
  });

  app.put(`${base}/:id/artifact`, async (c) => {
    const actor = platformActor(store, c, opts.now());
    const id = c.req.param('id');
    const revision = c.req.query('revision');
    const previous = requireRelease(store.system, id);
    requireUploadable(previous, revision);
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type') ?? '')
      || ![undefined, 'identity'].includes(c.req.header('Content-Encoding'))) invalid('artifact');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${ulid()}.part`);
    try {
      const artifact = await receiveArtifact(c.req.raw, temporary, maxWireBytes);
      validateBundle(await Bun.file(temporary).arrayBuffer(), previous);
      const at = opts.now();
      platformActor(store, c, at);
      const row = await store.system.write((sql) => {
        requirePlatform(sql, actor);
        const current = requireRelease(sql, id);
        requireUploadable(current, revision);
        const next = { ...current, ...artifact, revision: current.revision + 1 };
        renameSync(temporary, artifactPath(opts.dataDir, artifact.sha256));
        sql.run('UPDATE tool_releases SET sha256 = ?, size = ?, revision = ? WHERE id = ?', [next.sha256, next.size, next.revision, id]);
        audit(sql, actor, 'upload', next, at);
        return next;
      });
      return c.json(view(row));
    } finally { await unlink(temporary).catch(() => {}); }
  });

  function changeStatus(action: 'publish' | 'disable', status: ToolStatus) {
    return async (c: Context) => {
      const at = opts.now();
      const actor = platformActor(store, c, at);
      const id = field(c.req.param('id'), 'id');
      const body = await json(c);
      if (Object.keys(body).some(key => key !== 'revision')) invalid('body');
      const op = operation(c, opts.codeSecret, at, actor, body);
      const result = await store.system.write((sql) => {
        requirePlatform(sql, actor);
        const cached = op.read(sql);
        if (cached) return { response: cached, changed: false };
        const row = requireRelease(sql, id);
        expectRevision(body.revision, row.revision);
        const configured = row.kind === 'http_search' ? !!endpoint(row) : hasToolArtifact(opts.dataDir, row);
        if (row.status === 'disabled' || (action === 'publish' && (row.status !== 'draft' || !configured))) {
          throw new ApiError('conflict', { revision: row.revision });
        }
        const next = { ...row, status, revision: row.revision + 1 };
        sql.run('UPDATE tool_releases SET status = ?, revision = ? WHERE id = ?', [status, next.revision, id]);
        audit(sql, actor, action, next, at);
        return { response: op.complete(sql, { status: 200, payload: view(next) }), changed: true };
      });
      if (result.changed) opts.onConfigChange?.();
      return result.response;
    };
  }
  app.post(`${base}/:id/publish`, changeStatus('publish', 'published'));
  app.post(`${base}/:id/disable`, changeStatus('disable', 'disabled'));

  app.get('/v1/edge/tool-artifacts/:id', async (c) => {
    const token = bearer(c.req.header('Authorization'));
    if (!token) throw new ApiError('unauthenticated');
    const tokenHash = hash(token);
    const match = await store.device(tokenHash);
    if (!match || !store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [match.id])) throw new ApiError('unauthenticated');
    const db = store.tenant(match.id);
    const device = db.get<{ user_id: string; os: string; arch: string }>(`SELECT d.user_id, d.os, d.arch FROM devices d JOIN members m ON m.user_id = d.user_id
      WHERE d.token_hash = ? AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`, [tokenHash, iso(opts.now())]);
    if (!device) throw new ApiError('unauthenticated');
    const policy = readPolicyHot(db, device.user_id);
    const row = allowedToolReleases(store, opts.dataDir, policy, device.os, device.arch).find(tool => tool.id === c.req.param('id'));
    if (!row) throw new ApiError('not_found');
    return new Response(Bun.file(artifactPath(opts.dataDir, row.sha256)), { headers: {
      'cache-control': 'no-store', 'content-type': 'application/json', 'content-length': String(row.size),
      'content-disposition': 'attachment; filename="onex-tool.json"', 'x-content-type-options': 'nosniff',
    } });
  });
  toolSearchRoutes(app, store, opts, runSearch);
}
