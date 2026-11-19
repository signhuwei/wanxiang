import type { SQLQueryBindings } from 'bun:sqlite';
import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { iso } from './credentials';
import { enumField, expectRevision, int, pagination, platformActor, urlField, type ManagementOptions } from './management';
import { encryptProviderSecret } from './provider-secret';
import { insertInitialContract } from './seed';
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
  function list(path: string, table: string, columns: string, search: string, order: string) {
    app.get(path, (c) => {
      platformActor(store, c, opts.now());
      const p = pagination(c);
      const where = `WHERE instr(lower(${search}), lower(?)) > 0`;
      const { n } = store.system.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} ${where}`, [p.query])!;
      return c.json(p.page(store.system.all<RecordRow>(`SELECT ${columns} FROM ${table} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
        [p.query, p.limit, p.offset]).map(view), n));
    });
  }

  function register(entry: { path: string; table: string; columns: string; search: string; prefix: string;
    parse: (input: Input, row: RecordRow | null, sql: Transaction) => Record<string, SQLQueryBindings> }) {
    const path = `/v1/platform/${entry.path}`;
    list(path, entry.table, entry.columns, entry.search, 'id');
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
        return { response: op.complete(sql, { status: previous ? 200 : 201, payload: view(row) }), changed: true };
      });
      if (result.changed) opts.onConfigChange?.();
      return result.response;
    };
    app.post(path, write);
    app.on(['POST', 'PATCH'], `${path}/:id`, write);
  }

  register({ path: 'providers', table: 'providers', columns: 'id, name, protocol, base_url, status, revision', search: 'name', prefix: 'prv',
    parse: (body, row) => ({ name: text(body, row, 'name'), protocol: enumField(value(body, row, 'protocol'), 'protocol', protocols),
      base_url: urlField(value(body, row, 'base_url'), 'base_url'), status: status(body, row) }) });
  register({ path: 'models', table: 'models', columns: '*', search: "display_name || ' ' || upstream_name", prefix: 'mod',
    parse: (body, row, sql) => {
      const provider_id = text(body, row, 'provider_id');
      if (!sql.get('SELECT 1 FROM providers WHERE id = ?', [provider_id])) invalid('provider_id');
      return { provider_id, upstream_name: text(body, row, 'upstream_name'), display_name: text(body, row, 'display_name'),
        context_window: number(body, row, 'context_window', 1), status: status(body, row) };
    } });
  register({ path: 'agent-releases', table: 'agent_releases', columns: '*', search: "agent || ' ' || version", prefix: 'rel',
    parse: (body, row) => {
      const sha256 = text(body, row, 'sha256').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) invalid('sha256');
      return { agent: text(body, row, 'agent'), version: text(body, row, 'version'), os: text(body, row, 'os'), arch: text(body, row, 'arch'),
        url: urlField(value(body, row, 'url'), 'url'), sha256, size: number(body, row, 'size', 1), status: status(body, row) };
    } });

  list('/v1/platform/rates', 'rates', '*', 'model_id', 'model_id, effective_from');
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
  list('/v1/platform/tenants', 'tenants', tenantColumns, 'name', 'id');
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
      const seatLimit = body.seat_limit === undefined ? 10 : int(body.seat_limit, 'seat_limit', 1);
      const newStatus = enumField(body.status ?? 'active', 'status', ['active', 'suspended']);
      const id = `ten_${ulid()}`;
      const member = { user_id: owner, role: 'owner', status: 'active' };
      // Publish the directory only after the tenant facts have committed.
      await store.tenant(id, true).write((sql) => {
        sql.run('INSERT INTO members (user_id, role, status) VALUES (?, ?, ?)', [owner, member.role, member.status]);
        insertInitialContract(sql, owner, seatLimit, at);
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
