import type { SQLQueryBindings } from 'bun:sqlite';
import type { Context, Hono } from 'hono';
import { agentArtifactMaxBytes, DESKTOP_AGENT_PART_BYTES, artifactFormat, hasArtifact, hasReleaseArtifacts, runtimeArtifact, managedAgents, officialArtifactSource, qualifiedDesktopRelease, releaseIdentity, requiresDesktopQualification } from './agent-catalog';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import type { platformCreateActions } from './actions';
import { iso } from './credentials';
import { enumField, expectRevision, int, pagination, platformActor, urlField, type ManagementOptions } from './management';
import { encryptProviderSecret } from './provider-secret';
import { modelPoolSummary } from './model-pool';
import { modelPricingSummary } from './input-multiplier';
import { indexMember, type Store, type Transaction } from './store';

const statuses = ['active', 'disabled'] as const;
const protocols = ['anthropic', 'openai_chat', 'openai_responses'] as const;
type RecordRow = Record<string, SQLQueryBindings> & { revision: number };
type Input = Record<string, unknown>;
const view = <T extends RecordRow>(row: T) => ({ ...row, actions: ['read', 'update'] });
const value = (input: Input, row: RecordRow | null, key: string) => input[key] === undefined ? row?.[key] : input[key];
const text = (input: Input, row: RecordRow | null, key: string) => field(value(input, row, key), key);
const number = (input: Input, row: RecordRow | null, key: string, min = 0) => int(value(input, row, key), key, min);
const status = (input: Input, row: RecordRow | null) => enumField(value(input, row, 'status') ?? 'active', 'status', statuses);

function add(sql: Transaction, table: string, row: RecordRow) {
  const keys = Object.keys(row);
  sql.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(row));
}
function change(sql: Transaction, table: string, row: RecordRow, where: string, keys: SQLQueryBindings[]) {
  sql.run(`UPDATE ${table} SET ${Object.keys(row).map((key) => `${key} = ?`).join(',')} WHERE ${where}`, [...Object.values(row), ...keys]);
}

export function platformRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const requirePlatform = (sql: Transaction, userId: string) => {
    if (!sql.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [userId])) throw new ApiError('forbidden');
  };
  function list(path: string, table: string, columns: string, search: string, order: string, action: typeof platformCreateActions[number], parent?: 'provider_id' | 'model_id',
    project: (row: RecordRow) => Record<string, SQLQueryBindings | string[] | boolean> = view) {
    app.get(path, (c) => {
      platformActor(store, c, opts.now());
      const p = pagination(c);
      const filter = parent && c.req.query(parent);
      const where = `WHERE instr(lower(${search}), lower(?)) > 0${filter ? ` AND ${parent} = ?` : ''}`;
      const params = filter ? [p.query, field(filter, parent!)] : [p.query];
      const { n } = store.system.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} ${where}`, params)!;
      return c.json(p.page(store.system.all<RecordRow>(`SELECT ${columns} FROM ${table} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
        [...params, p.limit, p.offset]).map(project), n, [action]));
    });
  }

  function register(entry: { path: string; table: string; columns: string; search: string; prefix: string; action: typeof platformCreateActions[number];
    project?: (row: RecordRow) => Record<string, SQLQueryBindings | string[] | boolean>;
    listProject?: (row: RecordRow) => Record<string, SQLQueryBindings | string[] | boolean>;
    parse: (input: Input, row: RecordRow | null, sql: Transaction) => Record<string, SQLQueryBindings> }) {
    const path = `/v1/platform/${entry.path}`;
    const project = entry.project ?? view;
    list(path, entry.table, entry.columns, entry.search, 'id', entry.action, entry.table === 'models' ? 'provider_id' : undefined, entry.listProject ?? project);
    if (entry.project) app.get(`${path}/:id`, (c) => {
      platformActor(store, c, opts.now());
      const row = store.system.get<RecordRow>(`SELECT ${entry.columns} FROM ${entry.table} WHERE id = ?`, [c.req.param('id')]);
      if (!row) throw new ApiError('not_found');
      return c.json(project(row));
    });
    // CONTRACT-PENDING: platform collection POST can also update by id; item PATCH aliases item POST.
    const write = async (c: Context) => {
      const body = await json(c);
      const at = opts.now();
      const actor = platformActor(store, c, at);
      const requested = c.req.param('id') ?? (body.id === undefined ? undefined : field(body.id, 'id'));
      const id = requested ?? `${entry.prefix}_${ulid()}`;
      const op = operation(c, opts.codeSecret, at, actor, body);
      const result = await store.system.write((sql) => {
        requirePlatform(sql, actor);
        const cached = op.read(sql);
        if (cached) return { response: cached, changed: false };
        const previous = requested ? sql.get<RecordRow>(`SELECT ${entry.columns} FROM ${entry.table} WHERE id = ?`, [id]) : null;
        if (requested && !previous) throw new ApiError('not_found');
        if (previous) expectRevision(body.revision, previous.revision);
        const row = { id, ...entry.parse(body, previous, sql), revision: (previous?.revision ?? 0) + 1 };
        const secret = entry.table === 'providers' && (!previous || body.secret !== undefined)
          ? field(body.secret, 'secret', 4096) : undefined;
        if (secret !== undefined && !opts.masterKey) throw new ApiError('internal', { trace_id: `trc_${ulid()}` });
        const stored = secret === undefined ? row : { ...row, secret_ciphertext: encryptProviderSecret(opts.masterKey!, id, secret) };
        if (previous) change(sql, entry.table, stored, 'id = ?', [id]);
        else add(sql, entry.table, stored);
        return { response: op.complete(sql, { status: previous ? 200 : 201, payload: project(row) }), changed: true };
      });
      if (result.changed) opts.onConfigChange?.();
      return result.response;
    };
    app.post(path, write);
    app.on(['POST', 'PATCH'], `${path}/:id`, write);
  }

  register({ path: 'providers', table: 'providers', columns: 'id, name, protocol, base_url, status, revision, auth, proxy', search: 'name', prefix: 'prv', action: 'create_provider',
    parse: (body, row) => {
      const auth = value(body, row, 'auth');
      const proxy = value(body, row, 'proxy');
      return { name: text(body, row, 'name'), protocol: enumField(value(body, row, 'protocol'), 'protocol', protocols),
        base_url: urlField(value(body, row, 'base_url'), 'base_url'), status: status(body, row),
        auth: auth == null ? null : enumField(auth, 'auth', ['x_api_key', 'bearer']),
        proxy: proxy == null || proxy === 'none' ? proxy ?? null : urlField(proxy, 'proxy') };
    } });
  register({ path: 'models', table: 'models', columns: '*', search: "display_name || ' ' || upstream_name", prefix: 'mod', action: 'create_model',
    // Pool fields are read-only additions; legacy writes and responses keep their shape.
    listProject: (row) => {
      const base = view(row);
      const pricing = modelPricingSummary(store.system, String(row.id), row.status === 'active', iso(opts.now()));
      return { ...base, ...modelPoolSummary(store.system, String(row.id)), current_source_rate_key: pricing.current_source_rate_key,
        input_multiplier_ppm: pricing.input_multiplier_ppm, actions: [...base.actions, ...pricing.actions] };
    },
    parse: (body, row, sql) => {
      const provider_id = text(body, row, 'provider_id');
      if (!sql.get('SELECT 1 FROM providers WHERE id = ?', [provider_id])) invalid('provider_id');
      const upstream_name = text(body, row, 'upstream_name');
      if (upstream_name.includes('*')) invalid('upstream_name');
      const rawPattern = value(body, row, 'route_model');
      const route_model = rawPattern == null ? null : field(rawPattern, 'route_model');
      if (route_model && !/^[^*]*\*?$/.test(route_model)) invalid('route_model');
      return { provider_id, upstream_name, route_model, display_name: text(body, row, 'display_name'),
        context_window: number(body, row, 'context_window', 1), status: status(body, row) };
    } });
  register({ path: 'agent-releases', table: 'agent_releases', columns: '*',
    search: "agent || ' ' || version || ' ' || os || ' ' || arch", prefix: 'rel', action: 'create_agent_release',
    project: (row) => {
      const release = { agent: String(row.agent), version: String(row.version), os: String(row.os),
        arch: String(row.arch), size: Number(row.size), sha256: String(row.sha256) };
      const artifact_cached = hasArtifact(opts.dataDir, release);
      const companion = runtimeArtifact(release);
      const runtime = companion && { ...companion, artifact_cached: hasArtifact(opts.dataDir, { ...companion, agent: release.agent }) };
      const desktop = requiresDesktopQualification(release.agent);
      const qualification_required = desktop && !qualifiedDesktopRelease(release);
      return { ...row, artifact_cached, runtime, qualification_required, part_bytes: desktop ? DESKTOP_AGENT_PART_BYTES : null,
        format: artifactFormat(release),
        actions: ['read', 'update', 'upload_artifact', ...(runtime ? ['upload_runtime'] : []),
          ...(officialArtifactSource({ agent: String(row.agent), url: String(row.url) }) ? ['pull_artifact'] : []),
          ...(row.status === 'active' ? ['disable'] : artifact_cached && (!runtime || runtime.artifact_cached) && !qualification_required ? ['activate'] : [])] };
    },
    parse: (body, row, sql) => {
      const sha256 = text(body, row, 'sha256').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) invalid('sha256');
      const next = {
        agent: enumField(value(body, row, 'agent'), 'agent', managedAgents), version: text(body, row, 'version'),
        os: enumField(value(body, row, 'os'), 'os', ['darwin', 'linux', 'win32'] as const),
        arch: enumField(value(body, row, 'arch'), 'arch', ['arm64', 'x64'] as const),
        url: urlField(value(body, row, 'url'), 'url'), sha256, size: number(body, row, 'size', 1), status: status(body, row),
      };
      if (next.size > agentArtifactMaxBytes(next.agent)) invalid('size');
      if (!artifactFormat(next)) invalid('os', 'arch');
      if (requiresDesktopQualification(next.agent) && !qualifiedDesktopRelease(next) && next.status === 'active') {
        throw new ApiError('conflict', { reason: 'desktop_qualification_required' });
      }
      if (row && releaseIdentity.some(key => key !== 'id' && row[key] !== next[key])) {
        throw new ApiError('conflict', { reason: 'release_identity_immutable' });
      }
      if (!row && sql.get('SELECT 1 FROM agent_releases WHERE agent = ? AND version = ? AND os = ? AND arch = ?',
        [next.agent, next.version, next.os, next.arch])) throw new ApiError('conflict', { reason: 'release_exists' });
      if ((row?.status === 'disabled' || requiresDesktopQualification(next.agent)) && next.status === 'active' && !hasReleaseArtifacts(opts.dataDir, next)) {
        throw new ApiError('conflict', { reason: 'artifact_unavailable' });
      }
      return next;
    } });

  list('/v1/platform/rates', 'rates', '*', 'model_id', 'model_id, effective_from', 'create_rate', 'model_id');
  app.post('/v1/platform/rates', async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const model_id = field(body.model_id, 'model_id');
    const rawDate = field(body.effective_from, 'effective_from');
    const parsedDate = Date.parse(rawDate);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(rawDate) || !Number.isFinite(parsedDate)
      || iso(parsedDate).slice(0, 19) !== rawDate.slice(0, 19)) invalid('effective_from');
    const effective_from = iso(parsedDate);
    const op = operation(c, opts.codeSecret, at, actor, body);
    const result = await store.system.write((sql) => {
      requirePlatform(sql, actor);
      const cached = op.read(sql);
      if (cached) return { response: cached, changed: false };
      if (!sql.get('SELECT 1 FROM models WHERE id = ?', [model_id])) invalid('model_id');
      const where = 'model_id = ? AND effective_from = ?';
      const keys = [model_id, effective_from];
      const previous = sql.get<RecordRow>(`SELECT * FROM rates WHERE ${where}`, keys);
      if (previous && body.revision === undefined) throw new ApiError('conflict');
      if (body.revision !== undefined) expectRevision(body.revision, previous?.revision ?? 0);
      const row = { model_id, effective_from, input_milli_per_mtok: number(body, previous, 'input_milli_per_mtok'),
        output_milli_per_mtok: number(body, previous, 'output_milli_per_mtok'), cache_read_milli_per_mtok: number(body, previous, 'cache_read_milli_per_mtok'),
        cache_write_milli_per_mtok: number(body, previous, 'cache_write_milli_per_mtok'), revision: (previous?.revision ?? 0) + 1 };
      if (previous) change(sql, 'rates', row, where, keys);
      else add(sql, 'rates', row);
      return { response: op.complete(sql, { status: previous ? 200 : 201, payload: view(row) }), changed: true };
    });
    if (result.changed) opts.onConfigChange?.();
    return result.response;
  });

  const tenantColumns = 'id, name, owner_user_id, status, created_at, revision';
  list('/v1/platform/tenants', 'tenants', tenantColumns, 'name', 'id', 'create_tenant');
  const provisioning = new Map<string, Promise<Response>>();
  const writeTenant = async (c: Context) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const requested = c.req.param('id') ?? (body.id === undefined ? undefined : field(body.id, 'id'));
    const op = operation(c, opts.codeSecret, at, actor, body);
    if (requested) {
      const result = await store.system.write((sql) => {
        requirePlatform(sql, actor);
        const cached = op.read(sql);
        if (cached) return { response: cached, changed: false };
        const previous = sql.get<RecordRow>(`SELECT ${tenantColumns} FROM tenants WHERE id = ?`, [requested]);
        if (!previous) throw new ApiError('not_found');
        expectRevision(body.revision, previous.revision);
        if (body.owner_user_id !== undefined && body.owner_user_id !== previous.owner_user_id) invalid('owner_user_id');
        const row = { ...previous, name: text(body, previous, 'name'),
          status: enumField(value(body, previous, 'status'), 'status', ['active', 'suspended']), revision: previous.revision + 1 };
        change(sql, 'tenants', row, 'id = ?', [requested]);
        return { response: op.complete(sql, { status: 200, payload: view(row) }), changed: true };
      });
      if (result.changed) opts.onConfigChange?.(requested);
      return result.response;
    }
    const execute = async () => {
      const cached = op.read(store.system);
      if (cached) return cached;
      const name = field(body.name, 'name');
      const owner = field(body.owner_user_id, 'owner_user_id');
      if (!store.system.get('SELECT 1 FROM platform_users WHERE id = ?', [owner])) invalid('owner_user_id');
      if (body.seat_limit !== undefined) invalid('seat_limit');
      const newStatus = enumField(body.status ?? 'active', 'status', ['active', 'suspended']);
      const id = `ten_${ulid()}`;
      const member = { user_id: owner, role: 'owner', status: 'active' };
      // Publish the directory only after the tenant facts have committed.
      await store.tenant(id, true).write((sql) => {
        sql.run('INSERT INTO members (user_id, role, status) VALUES (?, ?, ?)', [owner, member.role, member.status]);
      });
      return store.system.write((sql) => {
        requirePlatform(sql, actor);
        const replay = op.read(sql);
        if (replay) return replay;
        const row = { id, name, owner_user_id: owner, status: newStatus, created_at: iso(at), revision: 1 };
        add(sql, 'tenants', { ...row, db_file: `tenant-${id}.sqlite` });
        indexMember(sql, id, member);
        return op.complete(sql, { status: 201, payload: view(row) });
      });
    };
    if (!op.key) return execute();
    const key = `${op.scope}:${op.key}`;
    while (provisioning.has(key)) await provisioning.get(key)!.catch(() => {});
    const pending = execute();
    provisioning.set(key, pending);
    try { return await pending; }
    finally { provisioning.delete(key); }
  };
  app.post('/v1/platform/tenants', writeTenant);
  app.on(['POST', 'PATCH'], '/v1/platform/tenants/:id', writeTenant);
}
