import type { Context } from 'hono';
import { ApiError, field, invalid } from './api';
import { authenticate } from './auth';
import type { Store } from './store';

export type ManagementOptions = { codeSecret: string; now: () => number; masterKey?: Uint8Array; dataDir: string;
  onConfigChange?: (tenantId?: string) => void; onBalanceChange?: (tenantId: string) => void };

export function tenantActor(store: Store, c: Context, at: number) {
  const session = authenticate(store, c, at);
  const id = session.tenant_id;
  if (!id || !store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [id])) throw new ApiError('forbidden');
  const db = store.tenant(id);
  const member = db.get<{ role: string; group_id: string | null }>("SELECT role, group_id FROM members WHERE user_id = ? AND status = 'active'", [session.user_id]);
  if (!member) throw new ApiError('forbidden');
  return { id, db, userId: session.user_id, ...member };
}

export function platformActor(store: Store, c: Context, at: number) {
  const session = authenticate(store, c, at);
  if (session.tenant_id || !store.system.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [session.user_id])) throw new ApiError('forbidden');
  return session.user_id;
}

export function int(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(name);
  return value;
}

export function enumField<const T extends readonly string[]>(value: unknown, name: string, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) invalid(name);
  return value;
}

export function expectRevision(value: unknown, current: number, min = 1) {
  if (int(value, 'revision', min) !== current) throw new ApiError('conflict', { revision: current });
}

export function urlField(value: unknown, name: string) {
  const raw = field(value, name, 2048);
  const url = URL.parse(raw);
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) invalid(name);
  return raw;
}

export function pagination(c: Context) {
  const query = c.req.query('q') ?? '';
  if (query.length > 200) invalid('q');
  const rawLimit = c.req.query('limit') ?? '50';
  if (!/^\d{1,3}$/.test(rawLimit)) invalid('limit');
  const limit = int(Number(rawLimit), 'limit', 1, 200);
  const cursor = c.req.query('cursor');
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = Buffer.from(cursor, 'base64url');
    if (cursor.length > 24 || decoded.toString('base64url') !== cursor || !/^\d+$/.test(decoded.toString())) invalid('cursor');
    offset = int(Number(decoded), 'cursor');
  }
  return {
    query, limit, offset,
    page<T>(items: T[], total: number, actions: readonly string[] = []) {
      const next = offset + items.length;
      return { items, total, next_cursor: items.length && next < total ? Buffer.from(String(next)).toString('base64url') : null, actions };
    },
  };
}
