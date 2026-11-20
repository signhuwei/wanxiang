import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { tenantAuditActions } from './actions';
import { ApiError, field, invalid, json, operation } from './api';
import { groupMonthUsage, monthUsageByGroup, monthUsageByUser, selfMonthUsage } from './billing';
import { day, hash, iso, randomToken } from './credentials';
import { enumField, expectRevision, int, pagination, tenantActor, type ManagementOptions } from './management';
import { indexInvite, indexMember, type Member, type Store, type Transaction } from './store';
import { defaultVisibility, visibility } from './visibility';

type MemberRow = Member & { group_id: string | null; quota_milli: number | null; revision: number };
type Profile = { id: string; name: string; email: string | null; phone: string | null };
type Group = { id: string; name: string; parent_id: string | null; quota_milli: number | null; revision: number };
type Contract = { revision: number; seat_limit: number; allowed_agents_json: string; allowed_models_json: string;
  lease_minutes: number; lease_budget_milli: number; visibility_json: string; updated_by: string; updated_at: string };
type AuditRow = { id: string; actor: string; action: string; target: string; at: string };
const roles = ['admin', 'group_admin', 'member'] as const;
const statuses = ['active', 'disabled'] as const;
const readContract = (sql: Pick<Transaction, 'get'>) => sql.get<Contract>('SELECT * FROM contract ORDER BY revision DESC LIMIT 1');
const contractView = ({ allowed_agents_json, allowed_models_json, visibility_json, ...row }: Contract, role: string) => ({
  ...row, allowed_agents: JSON.parse(allowed_agents_json), allowed_models: JSON.parse(allowed_models_json),
  visibility: visibility(JSON.parse(visibility_json)), actions: role === 'owner' ? ['read', 'update'] : ['read'],
});
const canManage = (role: string) => role === 'owner' || role === 'admin';
const canEditMember = (actor: string, subject: string) => subject !== 'owner' && (actor === 'owner' || (actor === 'admin' && subject === 'member'));

function groupId(sql: Pick<Transaction, 'get'>, value: unknown, name: string) {
  if (value === undefined || value === null) return null;
  const id = field(value, name);
  if (!sql.get('SELECT 1 FROM groups WHERE id = ?', [id])) invalid(name);
  return id;
}

function quota(value: unknown) { return value === undefined || value === null ? null : int(value, 'quota_milli'); }

function stringList(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length > 200) invalid(name);
  const items = value.map((item) => field(item, name));
  if (new Set(items).size !== items.length) invalid(name);
  return items;
}

export function tenantRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const profile = (id: string) => store.system.get<Profile>('SELECT id, name, email, phone FROM platform_users WHERE id = ?', [id]);
  const memberView = (row: MemberRow, role: string, month_used_milli: number) => {
    const user = profile(row.user_id);
    return { ...row, id: row.user_id, name: user?.name ?? row.user_id, email: user?.email ?? null, phone: user?.phone ?? null,
      month_used_milli, actions: canEditMember(role, row.role) ? ['read', 'update'] : ['read'] };
  };
  function manager(c: Context, at: number) {
    const actor = tenantActor(store, c, at);
    if (!canManage(actor.role)) throw new ApiError('forbidden');
    return actor;
  }
  // Auth can change while a write waits in the tenant queue.
  function writeRole(sql: Transaction, actor: ReturnType<typeof tenantActor>) {
    const member = sql.get<Member>("SELECT role FROM members WHERE user_id = ? AND status = 'active'", [actor.userId]);
    if (!member || !canManage(member.role) || !store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [actor.id])) {
      throw new ApiError('forbidden');
    }
    return member.role;
  }

  app.get('/v1/audit', (c) => {
    const { db, role } = tenantActor(store, c, opts.now());
    if (role !== 'owner') throw new ApiError('forbidden');
    const p = pagination(c);
    const action = c.req.query('action');
    const filters: string[] = [];
    const params: string[] = [];
    if (action !== undefined) {
      filters.push('action = ?');
      params.push(action);
    }
    if (p.query) {
      filters.push('(instr(lower(action), lower(?)) > 0 OR instr(lower(actor), lower(?)) > 0 OR instr(lower(target), lower(?)) > 0)');
      params.push(p.query, p.query, p.query);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { n } = db.get<{ n: number }>(`SELECT count(*) AS n FROM audit ${where}`, params)!;
    const rows = db.all<AuditRow>(`SELECT id, actor, action, target, at FROM audit ${where}
      ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`, [...params, p.limit, p.offset]);
    return c.json(p.page(rows.map((row) => ({ ...row, revision: 1, actions: ['read'] })), n, tenantAuditActions));
  });

  app.get('/v1/members', (c) => {
    const { db, role } = manager(c, opts.now());
    const p = pagination(c);
    const matching = p.query ? store.system.all<{ id: string }>(`SELECT id FROM platform_users
      WHERE instr(lower(name), lower(?)) OR instr(lower(coalesce(email, phone, '')), lower(?)) OR instr(id, ?)`, [p.query, p.query, p.query]) : [];
    const filters: string[] = [];
    const params: string[] = [];
    if (p.query) {
      filters.push('user_id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(matching.map(({ id }) => id)));
    }
    for (const [key, choices] of [['role', ['owner', ...roles]], ['status', statuses]] as const) {
      const value = c.req.query(key);
      if (value) { filters.push(`${key} = ?`); params.push(enumField(value, key, choices)); }
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { n } = db.get<{ n: number }>(`SELECT count(*) AS n FROM members ${where}`, params)!;
    const rows = db.all<MemberRow>(`SELECT * FROM members ${where} ORDER BY user_id LIMIT ? OFFSET ?`, [...params, p.limit, p.offset]);
    const at = opts.now();
    // 一次聚合查询取全体成员本月已用，避免每行各发两条查询（N+1）。
    const usage = monthUsageByUser(db, at);
    return c.json(p.page(rows.map((row) => memberView(row, role, usage.get(row.user_id) ?? 0)), n, ['create_member']));
  });
  app.get('/v1/members/:id', (c) => {
    const at = opts.now();
    const { db, role } = manager(c, at);
    const row = db.get<MemberRow>('SELECT * FROM members WHERE user_id = ?', [c.req.param('id')]);
    if (!row) throw new ApiError('not_found');
    return c.json(memberView(row, role, selfMonthUsage(db, row.user_id, at)));
  });
  // CONTRACT-PENDING: POST creates from a known user_id; POST/PATCH /:id updates.
  const writeMember = async (c: Context) => {
    const body = await json(c);
    const at = opts.now();
    const actor = manager(c, at);
    const existingId = c.req.param('id');
    const id = existingId ?? field(body.user_id, 'user_id');
    const op = operation(c, opts.codeSecret, at, actor.userId, body);
    const result = await actor.db.write((sql) => {
      const actorRole = writeRole(sql, actor);
      const previous = sql.get<MemberRow>('SELECT * FROM members WHERE user_id = ?', [id]);
      const role = body.role === undefined ? previous?.role ?? 'member' : enumField(body.role, 'role', roles);
      if (!canEditMember(actorRole, role) || (previous && !canEditMember(actorRole, previous.role))) throw new ApiError('forbidden');
      const cached = op.read(sql);
      if (cached) return { response: cached, member: previous };
      if (existingId && !previous) throw new ApiError('not_found');
      if (!existingId && previous) throw new ApiError('conflict');
      if (!profile(id)) throw new ApiError('not_found');
      if (previous) expectRevision(body.revision, previous.revision);
      const group_id = body.group_id === undefined && previous ? previous.group_id : groupId(sql, body.group_id, 'group_id');
      if (role === 'group_admin' && !group_id) invalid('group_id');
      const status = body.status === undefined ? previous?.status ?? 'active' : enumField(body.status, 'status', statuses);
      const quota_milli = body.quota_milli === undefined && previous ? previous.quota_milli : quota(body.quota_milli);
      if (status === 'active' && previous?.status !== 'active') {
        const { n } = sql.get<{ n: number }>("SELECT count(*) AS n FROM members WHERE status = 'active'")!;
        if (n >= (readContract(sql)?.seat_limit ?? 0)) throw new ApiError('seat_limit');
      }
      const revision = (previous?.revision ?? 0) + 1;
      const member = { user_id: id, role, status, group_id, quota_milli, revision };
      if (previous) sql.run('UPDATE members SET role = ?, status = ?, group_id = ?, quota_milli = ?, revision = ? WHERE user_id = ?', [role, status, group_id, quota_milli, revision, id]);
      else sql.run('INSERT INTO members (user_id, role, status, group_id, quota_milli) VALUES (?, ?, ?, ?, ?)', [id, role, status, group_id, quota_milli]);
      return { member, response: op.complete(sql, { status: previous ? 200 : 201, payload: memberView(member, actorRole, selfMonthUsage(sql, id, at)) }) };
    });
    if (result.member) {
      await store.system.write((sql) => indexMember(sql, actor.id, result.member!));
      opts.onConfigChange?.(actor.id);
    }
    return result.response;
  };
  app.post('/v1/members', writeMember);
  app.on(['POST', 'PATCH'], '/v1/members/:id', writeMember);

  const groupView = (group: Group, month_used_milli: number) => ({ ...group, month_used_milli, actions: ['read', 'update'] });
  app.get('/v1/groups', (c) => {
    const at = opts.now();
    const { db } = manager(c, at);
    const p = pagination(c);
    const where = 'WHERE instr(lower(name), lower(?)) > 0';
    const { n } = db.get<{ n: number }>(`SELECT count(*) AS n FROM groups ${where}`, [p.query])!;
    const rows = db.all<Group>(`SELECT * FROM groups ${where} ORDER BY id LIMIT ? OFFSET ?`, [p.query, p.limit, p.offset]);
    // 子树汇总在内存里做一次，避免每行各发子树 + 成员查询（N+1）。
    const usage = monthUsageByGroup(db, at);
    return c.json(p.page(rows.map((row) => groupView(row, usage.get(row.id) ?? 0)), n, ['create_group']));
  });
  app.get('/v1/groups/:id', (c) => {
    const at = opts.now();
    const { db } = manager(c, at);
    const row = db.get<Group>('SELECT * FROM groups WHERE id = ?', [c.req.param('id')]);
    if (!row) throw new ApiError('not_found');
    return c.json(groupView(row, groupMonthUsage(db, row.id, at)));
  });
  const writeGroup = async (c: Context) => {
    const body = await json(c);
    const at = opts.now();
    const actor = manager(c, at);
    const existingId = c.req.param('id');
    const op = operation(c, opts.codeSecret, at, actor.userId, body);
    return actor.db.write((sql) => {
      writeRole(sql, actor);
      const cached = op.read(sql);
      if (cached) return cached;
      const previous = existingId ? sql.get<Group>('SELECT * FROM groups WHERE id = ?', [existingId]) : null;
      if (existingId && !previous) throw new ApiError('not_found');
      if (previous) expectRevision(body.revision, previous.revision);
      const id = previous?.id ?? `grp_${ulid()}`;
      const name = body.name === undefined && previous ? previous.name : field(body.name, 'name');
      const parent_id = body.parent_id === undefined && previous ? previous.parent_id : groupId(sql, body.parent_id, 'parent_id');
      if (parent_id && sql.get(`WITH RECURSIVE ancestors(id) AS (VALUES (?) UNION SELECT g.parent_id FROM groups g
        JOIN ancestors a ON g.id = a.id WHERE g.parent_id IS NOT NULL) SELECT 1 FROM ancestors WHERE id = ?`, [parent_id, id])) invalid('parent_id');
      const quota_milli = body.quota_milli === undefined && previous ? previous.quota_milli : quota(body.quota_milli);
      const revision = (previous?.revision ?? 0) + 1;
      if (previous) sql.run('UPDATE groups SET name = ?, parent_id = ?, quota_milli = ?, revision = ? WHERE id = ?', [name, parent_id, quota_milli, revision, id]);
      else sql.run('INSERT INTO groups (id, name, parent_id, quota_milli) VALUES (?, ?, ?, ?)', [id, name, parent_id, quota_milli]);
      return op.complete(sql, { status: previous ? 200 : 201, payload: groupView({ id, name, parent_id, quota_milli, revision }, groupMonthUsage(sql, id, at)) });
    });
  };
  app.post('/v1/groups', writeGroup);
  app.on(['POST', 'PATCH'], '/v1/groups/:id', writeGroup);

  app.post('/v1/invites', async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = manager(c, at);
    const role = enumField(body.role, 'role', roles);
    const max_uses = int(body.max_uses, 'max_uses', 1);
    const expires_at = iso(at + int(body.expires_in_ms, 'expires_in_ms', 1, 365 * day));
    const op = operation(c, opts.codeSecret, at, actor.userId, body);
    const result = await actor.db.write((sql) => {
      if (!canEditMember(writeRole(sql, actor), role)) throw new ApiError('forbidden');
      const cached = op.read(sql);
      if (cached) return { response: cached };
      const group_id = groupId(sql, body.group_id, 'group_id');
      if (role === 'group_admin' && !group_id) invalid('group_id');
      const id = `inv_${ulid()}`;
      const code = randomToken();
      const codeHash = hash(code);
      sql.run('INSERT INTO invites (id, code_hash, role, group_id, max_uses, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, codeHash, role, group_id, max_uses, expires_at, actor.userId]);
      const payload = { id, role, group_id, max_uses, used: 0, expires_at, created_by: actor.userId, revision: 1, actions: [] };
      // CONTRACT-PENDING: creation is idempotent, but the credential is only disclosed on first success.
      op.complete(sql, { status: 201, payload: { ...payload, code_returned: false } });
      return { codeHash, response: c.json({ ...payload, invite_code: code, code_returned: true }, 201) };
    });
    if (result.codeHash) await store.system.write((sql) => indexInvite(sql, actor.id, result.codeHash!));
    return result.response;
  });

  app.get('/v1/contract', (c) => {
    const { db, role } = tenantActor(store, c, opts.now());
    const row = readContract(db);
    if (!row) throw new ApiError('not_found');
    return c.json(contractView(row, role));
  });
  app.put('/v1/contract', async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = tenantActor(store, c, at);
    if (actor.role !== 'owner') throw new ApiError('forbidden');
    const op = operation(c, opts.codeSecret, at, actor.userId, body);
    const result = await actor.db.write((sql) => {
      if (writeRole(sql, actor) !== 'owner') throw new ApiError('forbidden');
      const cached = op.read(sql);
      if (cached) return { response: cached, changed: false };
      const previous = readContract(sql);
      const current = previous?.revision ?? 0;
      expectRevision(body.revision, current, 0);
      const grants = visibility(body.visibility);
      const row = { revision: current + 1, seat_limit: int(body.seat_limit, 'seat_limit'),
        allowed_agents_json: JSON.stringify(stringList(body.allowed_agents, 'allowed_agents')),
        allowed_models_json: JSON.stringify(stringList(body.allowed_models, 'allowed_models')),
        lease_minutes: int(body.lease_minutes, 'lease_minutes', 1, 1440), lease_budget_milli: int(body.lease_budget_milli, 'lease_budget_milli'),
        visibility_json: JSON.stringify(grants), updated_by: actor.userId, updated_at: iso(at) };
      sql.run(`INSERT INTO contract (revision, seat_limit, allowed_agents_json, allowed_models_json, lease_minutes, lease_budget_milli,
        visibility_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.revision, row.seat_limit, row.allowed_agents_json, row.allowed_models_json, row.lease_minutes, row.lease_budget_milli, row.visibility_json, row.updated_by, row.updated_at]);
      const from = previous ? visibility(JSON.parse(previous.visibility_json)) : defaultVisibility;
      if (JSON.stringify(from) !== row.visibility_json) sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${ulid()}`, actor.userId, 'contract.visibility.update', actor.id, JSON.stringify({ from, to: grants, revision: row.revision }), iso(at)]);
      return { response: op.complete(sql, { status: 200, payload: contractView(row, 'owner') }), changed: true };
    });
    if (result.changed) opts.onConfigChange?.(actor.id);
    return result.response;
  });
}
