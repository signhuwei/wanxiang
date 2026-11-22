import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { ApiError, field, invalid } from './api';
import { hmac, iso } from './credentials';
import { int } from './management';
import type { Transaction } from './store';

/** Shared rules for the multi-channel routing platform API. */
export const routeIdPattern = /^[A-Za-z0-9_.-]{1,128}$/;
export function routeId(value: unknown, name: string) {
  const text = field(value, name);
  if (!routeIdPattern.test(text)) invalid(name);
  return text;
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonical(row[key])]));
  }
  return value;
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function strictObject(value: unknown, name: string, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(name);
  const row = value as Record<string, unknown>;
  const extra = Object.keys(row).filter((key) => !keys.includes(key));
  if (extra.length) invalid(...extra.map((key) => `${name}.${key}`));
  return row;
}

/** UTC RFC 3339 with at most millisecond precision, normalized to the stored form. */
export function utcTime(value: unknown, name: string) {
  const raw = field(value, name, 40);
  const at = Date.parse(raw);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(raw) || !Number.isFinite(at) || iso(at).slice(0, 19) !== raw.slice(0, 19)) invalid(name);
  return iso(at);
}

/** Canonical unsigned base-10 string, at most 38 digits. */
export function decimalText(value: unknown, name: string, positive = false) {
  if (typeof value !== 'string' || value.length > 38 || !/^(?:0|[1-9][0-9]*)$/.test(value) || (positive && value === '0')) invalid(name);
  return value;
}

export function currencyCode(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) invalid(name);
  return value;
}

export const conflict = (reason: string, current_revision?: number | string | null, changed: string[] = []) =>
  new ApiError('conflict', { reason, ...(current_revision !== undefined && { current_revision }), ...(changed.length && { changed }) });

/** Replays a stored success before any revision check; a reused key with another body is idempotency_mismatch. */
export function replay(op: { read: (sql: Pick<Transaction, 'get'>) => Response | undefined }, sql: Transaction) {
  try { return op.read(sql); } catch (error) {
    if (error instanceof ApiError && error.code === 'conflict') throw new ApiError('conflict', { reason: 'idempotency_mismatch' });
    throw error;
  }
}

export const queryValue = (c: Context, name: string) => {
  const value = c.req.query(name);
  return value === undefined || value === '' ? undefined : value;
};

/** Cursor signed over caller, path, filters, sort and the page offset; edits to any part are rejected. */
export function boundPage(c: Context, secret: string, actor: string, scope: unknown) {
  const raw = c.req.query('limit') ?? '50';
  if (!/^\d{1,3}$/.test(raw)) invalid('limit');
  const limit = int(Number(raw), 'limit', 1, 200);
  const sign = (offset: number) => hmac(secret, ['cursor', actor, c.req.path, canonical(scope), offset]).slice(0, 22);
  const cursor = c.req.query('cursor');
  let offset = 0;
  if (cursor !== undefined) {
    const match = /^(\d{1,9})\.([A-Za-z0-9_-]{22})$/.exec(cursor);
    if (!match || match[2] !== sign(Number(match[1]))) invalid('cursor');
    offset = Number(match![1]);
  }
  return {
    limit, offset,
    page<T>(items: T[], total: number, actions: readonly string[]) {
      const next = offset + items.length;
      return { items, total, next_cursor: items.length && next < total ? `${next}.${sign(next)}` : null, actions };
    },
  };
}

export const requirePlatformAdmin = (sql: Pick<Transaction, 'get'>, actor: string) => {
  if (!sql.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [actor])) throw new ApiError('forbidden');
};
