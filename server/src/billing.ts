import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { isTenantId } from './auth';
import { day, iso } from './credentials';
import { int, pagination, platformActor, tenantActor, type ManagementOptions } from './management';
import type { Store, Transaction } from './store';

type Reader = Pick<Transaction, 'get'>;
type LedgerKind = 'topup' | 'reserve' | 'settle' | 'release';
type LeaseRow = { id: string; device_id: string; user_id: string; budget_milli: number; used_milli: number; expires_at: string; status: string; seq: number };
export type Cutoff = { type: 'cutoff'; id: string; reason: 'balance' | 'contract' | 'disabled' };
type Lease = { type: 'lease'; id: string; lease_id: string; expires_at: string; budget_milli: number; seq: number };
type LeaseReply = Cutoff | Lease;
const leaseView = (row: LeaseRow): Lease => ({ type: 'lease', id: `msg_${ulid()}`, lease_id: row.id,
  expires_at: row.expires_at, budget_milli: row.budget_milli, seq: row.seq });
export const cutoff = (reason: Cutoff['reason']): Cutoff => ({ type: 'cutoff', id: `msg_${ulid()}`, reason });

export function balance(sql: Reader, now: number) {
  const date = new Date(now);
  const month = iso(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const { credits, month_used_milli } = sql.get<{ credits: number; month_used_milli: number }>(`SELECT
    coalesce(sum(CASE WHEN kind IN ('topup', 'adjust') THEN amount_milli WHEN kind = 'settle' THEN -amount_milli ELSE 0 END), 0) AS credits,
    coalesce(sum(CASE WHEN kind = 'settle' AND at >= ? THEN amount_milli ELSE 0 END), 0) AS month_used_milli FROM ledger`, [month])!;
  const { reserved_milli } = sql.get<{ reserved_milli: number }>("SELECT coalesce(sum(budget_milli), 0) AS reserved_milli FROM leases WHERE status = 'active'")!;
  return { balance_milli: credits - reserved_milli, reserved_milli, month_used_milli };
}

function entry(sql: Transaction, kind: LedgerKind, amount_milli: number, at: number, options: {
  lease?: Pick<LeaseRow, 'id' | 'user_id'>; requestRef?: string; actor?: string; note?: string;
} = {}) {
  const row = { id: `led_${ulid()}`, kind, amount_milli, user_id: options.lease?.user_id ?? null, lease_id: options.lease?.id ?? null,
    request_ref: options.requestRef ?? null, by: options.actor ?? null, at: iso(at), note: options.note ?? null, revision: 1 };
  sql.run(`INSERT INTO ledger (id, kind, amount_milli, user_id, lease_id, request_ref, "by", at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.kind, row.amount_milli, row.user_id, row.lease_id, row.request_ref, row.by, row.at, row.note]);
  return { ...row, actions: ['read'] };
}

export function deviceAllowed(store: Store, sql: Reader, tenantId: string, deviceId: string, at: number) {
  return !!(store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [tenantId])
    && sql.get(`SELECT 1 FROM devices d JOIN members m ON m.user_id = d.user_id WHERE d.id = ?
      AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`, [deviceId, iso(at)]));
}

function issue(sql: Transaction, deviceId: string, userId: string, at: number): LeaseReply {
  const contract = sql.get<{ lease_budget_milli: number; lease_minutes: number }>(
    'SELECT lease_budget_milli, lease_minutes FROM contract ORDER BY revision DESC LIMIT 1');
  if (!contract || contract.lease_budget_milli <= 0) return cutoff('contract');
  const outstanding = sql.get<LeaseRow>("SELECT * FROM leases WHERE device_id = ? AND status = 'active'", [deviceId]);
  if (outstanding) return leaseView(outstanding);
  const { balance_milli: available } = balance(sql, at);
  if (available <= 0) return cutoff('balance');
  const budget = Math.min(available, contract.lease_budget_milli, Math.max(1, Math.floor(available / 20)));
  const last = sql.get<{ seq: number }>('SELECT seq FROM leases WHERE device_id = ? ORDER BY seq DESC LIMIT 1', [deviceId]);
  const row: LeaseRow = { id: `lse_${ulid()}`, device_id: deviceId, user_id: userId, budget_milli: budget, used_milli: 0,
    expires_at: iso(at + contract.lease_minutes * 60_000), status: 'active', seq: (last?.seq ?? 0) + 1 };
  sql.run('INSERT INTO leases (id, device_id, user_id, budget_milli, expires_at, status, seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [row.id, deviceId, userId, budget, row.expires_at, row.status, row.seq]);
  entry(sql, 'reserve', budget, at, { lease: row });
  return leaseView(row);
}

export function initialLease(store: Store, tenantId: string, deviceId: string, userId: string, at: number, live: () => boolean) {
  return store.tenant(tenantId).write((sql) => {
    if (!live() || !deviceAllowed(store, sql, tenantId, deviceId, at)) return cutoff('disabled');
    return issue(sql, deviceId, userId, at);
  });
}

export function reconcileUsage(sql: Transaction, deviceId: string) {
  const { settled } = sql.get<{ settled: number }>("SELECT coalesce(sum(used_milli), 0) AS settled FROM leases WHERE device_id = ? AND status = 'settled'", [deviceId])!;
  // A stream can finish on a later lease but keep its original lease_id in usage.
  const { reported } = sql.get<{ reported: number }>(`SELECT total(cost_milli) AS reported FROM usage
    WHERE device_id = ? AND lease_id IS NOT NULL AND complete = 1`, [deviceId])!;
  const status = reported === settled ? 'reconciled' : 'pending';
  sql.run(`UPDATE usage SET settlement_status = ? WHERE device_id = ? AND lease_id IS NOT NULL
    AND complete = 1 AND settlement_status <> ?`, [status, deviceId, status]);
}

export function renewLease(store: Store, tenantId: string, deviceId: string, userId: string, at: number, live: () => boolean,
  leaseId: string, used: number, opId: string) {
  return store.tenant(tenantId).write((sql) => {
    if (!live() || !deviceAllowed(store, sql, tenantId, deviceId, at)) return cutoff('disabled');
    const cached = sql.get<{ lease_id: string; used_milli: number; result_json: string }>(
      'SELECT lease_id, used_milli, result_json FROM lease_operations WHERE device_id = ? AND op_id = ?', [deviceId, opId]);
    if (cached) {
      if (cached.lease_id !== leaseId || cached.used_milli !== used) throw new ApiError('conflict');
      return JSON.parse(cached.result_json) as LeaseReply;
    }
    const lease = sql.get<LeaseRow>('SELECT * FROM leases WHERE id = ? AND device_id = ?', [leaseId, deviceId]);
    if (!lease) throw new ApiError('not_found');
    if (lease.status !== 'active') throw new ApiError('conflict');
    if (used > lease.budget_milli) invalid('used_milli');
    sql.run("UPDATE leases SET used_milli = ?, status = 'settled', revision = revision + 1 WHERE id = ?", [used, leaseId]);
    if (used) entry(sql, 'settle', used, at, { lease, requestRef: opId });
    if (used < lease.budget_milli) entry(sql, 'release', lease.budget_milli - used, at, { lease, requestRef: opId });
    reconcileUsage(sql, deviceId);
    const response = issue(sql, deviceId, userId, at);
    sql.run('INSERT INTO lease_operations (device_id, op_id, lease_id, used_milli, result_json) VALUES (?, ?, ?, ?, ?)',
      [deviceId, opId, leaseId, used, JSON.stringify(response)]);
    return response;
  });
}

export function billingRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  app.get('/v1/balance', (c) => {
    const at = opts.now();
    const { db, role } = tenantActor(store, c, at);
    if (role !== 'owner' && role !== 'admin') throw new ApiError('forbidden');
    // The immutable ledger advances the balance object's revision.
    const { revision } = db.get<{ revision: number }>('SELECT count(*) + 1 AS revision FROM ledger')!;
    return c.json({ ...balance(db, at), revision, actions: ['read'] });
  });
  app.get('/v1/ledger', (c) => {
    const { db, role } = tenantActor(store, c, opts.now());
    if (role !== 'owner' && role !== 'admin') throw new ApiError('forbidden');
    const p = pagination(c);
    const where = "WHERE instr(lower(kind || ' ' || coalesce(note, '')), lower(?)) > 0";
    const { n } = db.get<{ n: number }>(`SELECT count(*) AS n FROM ledger ${where}`, [p.query])!;
    const rows = db.all<Record<string, unknown>>(`SELECT * FROM ledger ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`, [p.query, p.limit, p.offset]);
    return c.json(p.page(rows.map((row) => ({ ...row, actions: ['read'] })), n));
  });
  app.post('/v1/platform/ledger/topup', async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const id = body.tenant_id;
    if (!isTenantId(id)) invalid('tenant_id');
    if (!store.system.get('SELECT 1 FROM tenants WHERE id = ?', [id])) throw new ApiError('not_found');
    const amount = int(body.amount_milli, 'amount_milli', 1);
    const note = body.note === undefined ? undefined : field(body.note, 'note', 500);
    const op = operation(c, opts.codeSecret, at, actor, [id, amount, note]);
    return store.tenant(id).write((sql) => {
      if (!store.system.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [actor])) throw new ApiError('forbidden');
      const cached = op.read(sql);
      if (cached) return cached;
      // Keep aggregate ledger arithmetic exactly representable by the API's integers.
      const { total } = sql.get<{ total: number }>("SELECT coalesce(sum(amount_milli), 0) AS total FROM ledger WHERE kind = 'topup'")!;
      if (!Number.isSafeInteger(total + amount)) invalid('amount_milli');
      const row = entry(sql, 'topup', amount, at, { actor, note });
      sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${ulid()}`, actor, 'ledger.topup', row.id, JSON.stringify({ amount_milli: amount, note }), iso(at)]);
      return op.complete(sql, { status: 201, payload: { ...row, tenant_id: id } });
    });
  });
  app.get('/v1/observe/stale-leases', (c) => {
    const at = opts.now();
    const { db, role } = tenantActor(store, c, at);
    if (role !== 'owner' && role !== 'admin') throw new ApiError('forbidden');
    const p = pagination(c);
    const where = `WHERE l.status = 'active' AND l.expires_at < ? AND coalesce(d.last_seen_at, '') < ?
      AND instr(lower(l.id || ' ' || d.name), lower(?)) > 0`;
    const params = [iso(at), iso(at - day), p.query];
    const { n } = db.get<{ n: number }>(`SELECT count(*) AS n FROM leases l JOIN devices d ON d.id = l.device_id ${where}`, params)!;
    const rows = db.all<Record<string, unknown>>(`SELECT l.*, d.last_seen_at FROM leases l JOIN devices d ON d.id = l.device_id ${where}
      ORDER BY l.expires_at, l.id LIMIT ? OFFSET ?`, [...params, p.limit, p.offset]);
    return c.json(p.page(rows.map((row) => ({ ...row, actions: ['read'] })), n));
  });
}
