import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { managedAgents } from './agent-catalog';
import { ApiError, field, invalid } from './api';
import { monthUsageByUser } from './billing';
import { iso, monthBounds } from './credentials';
import type { IngestSummary } from './ingest';
import { enumField, int, pagination, tenantActor } from './management';
import type { Store } from './store';
import { visibility } from './visibility';

const groupFilter = `group_id IN (WITH RECURSIVE subtree(id) AS (VALUES (?) UNION
  SELECT g.id FROM groups g JOIN subtree s ON g.parent_id = s.id) SELECT id FROM subtree)`;
const encoder = new TextEncoder();
const readable = ['read'];
export const observedAgents = managedAgents;

type Scope = { group: string | null; self: string | null };
function permission(actor: ReturnType<typeof tenantActor>, body: boolean): Scope {
  const all = { group: null, self: null };
  if (actor.role === 'owner') return all;
  const own = { group: null, self: actor.userId };
  const role = actor.role;
  if (role !== 'admin' && role !== 'group_admin') return own;
  const row = actor.db.get<{ visibility_json: string }>('SELECT visibility_json FROM contract ORDER BY revision DESC LIMIT 1');
  const grant = row ? visibility(JSON.parse(row.visibility_json))[role] : null;
  if (!grant || !(body ? grant.content : grant.summary)) return own;
  return role === 'admin' ? all : actor.group_id ? { group: actor.group_id, self: null } : own;
}

function scoped(scope: Scope, column: string) {
  if (scope.self !== null) return { sql: `AND ${column} = ?`, params: [scope.self] };
  if (scope.group === null) return { sql: '', params: [] };
  return { sql: `AND ${column} IN (SELECT user_id FROM members WHERE ${groupFilter})`, params: [scope.group] };
}

export function summaryPeople(actor: ReturnType<typeof tenantActor>) {
  const scope = permission(actor, false);
  if (scope.self !== null) return [scope.self];
  if (scope.group === null) return null;
  return actor.db.all<{ user_id: string }>(`SELECT user_id FROM members WHERE ${groupFilter} ORDER BY user_id`, [scope.group]).map(row => row.user_id);
}

function pageNumber(value: string | undefined, name: string) {
  if (value === undefined) return 0;
  if (!/^\d{1,16}$/.test(value)) invalid(name);
  return int(Number(value), name);
}

type Subscriber = { push: (entries: IngestSummary[]) => void; close: () => void };

export function observationRoutes(app: Hono, store: Store, now: () => number) {
  const subscribers = new Map<string, Set<Subscriber>>();
  let closing = false;
  const reader = (c: Context, body = false) => {
    const actor = tenantActor(store, c, now());
    return { ...actor, scope: permission(actor, body) };
  };

  app.get('/v1/observe/people', (c) => {
    const { db, scope: permissionScope } = reader(c);
    const p = pagination(c);
    const scope = scoped(permissionScope, 'm.user_id');
    const profiles = p.query ? store.system.all<{ id: string }>(`SELECT id FROM platform_users WHERE
      instr(lower(name), lower(?)) > 0 OR instr(lower(coalesce(email, phone, '')), lower(?)) > 0 OR instr(id, ?) > 0`, [p.query, p.query, p.query]) : [];
    const match = p.query ? 'AND m.user_id IN (SELECT value FROM json_each(?))' : '';
    const params = [...scope.params, ...(p.query ? [JSON.stringify(profiles.map(({ id }) => id))] : [])];
    const where = `WHERE 1 ${scope.sql} ${match}`;
    const { n } = db.get<{ n: number }>(`SELECT count(*) AS n FROM members m ${where}`, params)!;
    const at = now();
    const rows = db.all<{ user_id: string; revision: number; session_count: number; cost_milli: number; month_cost_milli: number;
      last_active_at: string | null; last_agent: string | null; quota_milli: number | null }>(`
      SELECT m.user_id, m.quota_milli,
        m.revision + coalesce((SELECT sum(s.revision) FROM agent_sessions s WHERE s.user_id = m.user_id), 0) AS revision,
        (SELECT count(*) FROM agent_sessions s WHERE s.user_id = m.user_id) AS session_count,
        (SELECT s.agent FROM agent_sessions s WHERE s.user_id = m.user_id
          ORDER BY coalesce(s.last_event_at, s.started_at) DESC, s.id LIMIT 1) AS last_agent,
        (SELECT total(u.cost_milli) FROM usage u JOIN devices d ON d.id = u.device_id WHERE d.user_id = m.user_id) AS cost_milli,
        (SELECT total(u.cost_milli) FROM usage u JOIN devices d ON d.id = u.device_id WHERE d.user_id = m.user_id
          AND u.at >= ? AND u.at < ?) AS month_cost_milli,
        max(coalesce((SELECT max(coalesce(s.last_event_at, s.started_at)) FROM agent_sessions s WHERE s.user_id = m.user_id), ''),
          coalesce((SELECT max(u.at) FROM usage u JOIN devices d ON d.id = u.device_id WHERE d.user_id = m.user_id), '')) AS last_active_at
      FROM members m ${where} ORDER BY last_active_at DESC, m.user_id LIMIT ? OFFSET ?`, [...monthBounds(at), ...params, p.limit, p.offset]);
    const usage = monthUsageByUser(db, at);
    return c.json(p.page(rows.map((row) => ({ ...row, last_active_at: row.last_active_at || null,
      month_used_milli: usage.get(row.user_id) ?? 0,
      name: store.system.get<{ name: string }>('SELECT name FROM platform_users WHERE id = ?', [row.user_id])?.name ?? row.user_id,
      actions: readable })), n));
  });

  app.get('/v1/observe/sessions', (c) => {
    const actor = reader(c);
    const { db, scope: permissionScope } = actor;
    const content = permission(actor, true);
    const groupMembers = content.group === null ? null : new Set(db.all<{ user_id: string }>(
      `SELECT user_id FROM members WHERE ${groupFilter}`, [content.group]).map(({ user_id }) => user_id));
    const p = pagination(c);
    const id = c.req.query('user_id');
    const rawAgent = c.req.query('agent');
    const agent = rawAgent === undefined ? undefined : enumField(rawAgent, 'agent', observedAgents);
    const scope = scoped(permissionScope, 's.user_id');
    const where = `WHERE instr(lower(s.id || ' ' || s.agent || ' ' || coalesce(s.model, '')), lower(?)) > 0
      ${scope.sql} ${id ? 'AND s.user_id = ?' : ''} ${agent ? 'AND s.agent = ?' : ''}`;
    const params = [p.query, ...scope.params, ...(id ? [field(id, 'user_id')] : []), ...(agent ? [agent] : [])];
    const { n } = db.get<{ n: number }>(`SELECT count(*) AS n FROM agent_sessions s ${where}`, params)!;
    const rows = db.all<{ user_id: string } & Record<string, unknown>>(`WITH page AS (SELECT s.id, s.device_id, s.user_id, s.agent, s.agent_version,
      s.model, s.started_at, s.ended_at, s.event_count, s.revision FROM agent_sessions s ${where}
      ORDER BY s.started_at DESC, s.id LIMIT ? OFFSET ?)
      SELECT p.*, (SELECT count(*) FROM session_events e WHERE e.session_id = p.id AND e.kind = 'user_message'
        AND coalesce(json_extract(e.payload_json, '$.sidechain'), 0) = 0
        AND json_extract(e.payload_json, '$.agent_id') IS NULL
        AND coalesce(json_extract(e.payload_json, '$.system_injected'), 0) = 0) AS turn_count,
        total(u.cost_milli) AS cost_milli, total(u.input_tokens) AS input_tokens, total(u.output_tokens) AS output_tokens,
        total(u.cache_read_tokens) AS cache_read_tokens, total(u.cache_write_tokens) AS cache_write_tokens,
        count(CASE WHEN u.settlement_status = 'pending' OR u.settlement_status = 'unverified' THEN 1 END) AS pending_usage_count
      FROM page p LEFT JOIN usage u ON u.device_id = p.device_id AND u.session_id = p.id GROUP BY p.id
      ORDER BY p.started_at DESC, p.id`, [...params, p.limit, p.offset]);
    return c.json(p.page(rows.map((row) => {
      const canRead = content.self !== null ? row.user_id === content.self : groupMembers === null || groupMembers.has(row.user_id);
      return { ...row, actions: canRead ? ['read', 'read_content'] : readable };
    }), n));
  });

  app.get('/v1/observe/sessions/:id/events', async (c) => {
    const { db } = reader(c, true);
    const id = field(c.req.param('id'), 'session_id');
    const after = pageNumber(c.req.query('after_seq'), 'after_seq');
    const p = pagination(c);
    const result = await db.write((sql) => {
      const actor = reader(c, true);
      const scope = scoped(actor.scope, 'user_id');
      if (!sql.get(`SELECT 1 FROM agent_sessions WHERE id = ? ${scope.sql}`, [id, ...scope.params])) throw new ApiError('not_found');
      const params = [id, after, p.query];
      // Do not advance an after_seq reader past an event that might arrive out of order.
      const where = `WHERE session_id = ? AND seq > ? AND instr(lower(kind), lower(?)) > 0
        AND seq <= coalesce((SELECT ack_seq FROM ingest_cursors c WHERE c.device_id = session_events.device_id), 0)`;
      const { n } = sql.get<{ n: number }>(`SELECT count(*) AS n FROM session_events ${where}`, params)!;
      const rows = sql.all<{ payload_json: string; seq: number } & Record<string, unknown>>(`SELECT device_id, seq, session_id, kind, at,
        source_offset, payload_json, revision FROM session_events ${where} ORDER BY seq LIMIT ? OFFSET ?`, [...params, p.limit, p.offset]);
      sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${ulid()}`, actor.userId, 'observe.events.read', id, JSON.stringify({ after_seq: after, count: rows.length }), iso(now())]);
      return p.page(rows.map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(payload_json), actions: readable })), n);
    });
    return c.json(result);
  });

  app.get('/v1/observe/stream', (c) => {
    if (closing) throw new ApiError('forbidden');
    const initial = reader(c);
    let tenant = subscribers.get(initial.id);
    if (!tenant) subscribers.set(initial.id, tenant = new Set());
    const listeners = tenant;
    const signal = c.req.raw.signal;
    let close = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const emit = (value: string) => {
          if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
          controller.enqueue(encoder.encode(value));
        };
        const sub = {
          push(entries: IngestSummary[]) {
            try {
              const actor = reader(c);
              const { self, group } = actor.scope;
              const allowed = self ? new Set([self]) : group ? new Set(actor.db.all<{ user_id: string }>(
                `SELECT user_id FROM members WHERE ${groupFilter}`, [group]).map(({ user_id }) => user_id)) : null;
              const visible = allowed ? entries.filter((entry) => allowed.has(entry.user_id)) : entries;
              if (visible.length) emit(visible.map((row) => `data: ${JSON.stringify(row)}\n\n`).join(''));
            } catch { close(); }
          },
          close: () => close(),
        };
        const interval = setInterval(() => {
          try { reader(c); emit(': heartbeat\n\n'); } catch { close(); }
        }, 15_000);
        close = () => {
          if (closed) return;
          closed = true;
          clearInterval(interval);
          signal.removeEventListener('abort', close);
          listeners.delete(sub);
          if (!listeners.size) subscribers.delete(initial.id);
          try { controller.close(); } catch { /* Reader already canceled. */ }
        };
        listeners.add(sub);
        signal.addEventListener('abort', close, { once: true });
        if (signal.aborted) close();
        else emit(': connected\n\n');
      },
      cancel() { close(); },
    }, { highWaterMark: 32 });
    return c.body(stream, 200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
  });

  return {
    publish(tenant: string, entries: IngestSummary[]) {
      if (entries.length) for (const sub of subscribers.get(tenant) ?? []) sub.push(entries);
    },
    close() {
      closing = true;
      for (const subs of subscribers.values()) for (const sub of subs) sub.close();
    },
  };
}
