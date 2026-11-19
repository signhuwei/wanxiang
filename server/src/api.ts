import type { Context } from 'hono';
import { hash, hmac, iso, randomToken, day } from './credentials';
import type { Transaction } from './store';

const errors = {
  unauthenticated: [401, '登录凭据无效或已过期'],
  forbidden: [403, '没有权限执行此操作'],
  not_found: [404, '对象不存在'],
  conflict: [409, '对象版本或重复请求的参数不一致'],
  invalid: [422, '请求参数无效'],
  seat_limit: [403, '租户人数已达合约上限'],
  rate_limited: [429, '请求过快，请稍后再试'],
  internal: [500, '服务内部错误'],
} as const;

export class ApiError extends Error {
  constructor(readonly code: keyof typeof errors, readonly detail?: Record<string, unknown>) { super(errors[code][1]); }
  get status() { return errors[this.code][0]; }
  body() { return { code: this.code, message: this.message, ...(this.detail && { detail: this.detail }) }; }
}

export function invalid(...fields: string[]): never { throw new ApiError('invalid', { fields }); }

export async function json(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) invalid('body');
  return body;
}

export function field(value: unknown, name: string, max = 128) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) invalid(name);
  return value;
}

type Result = { status: 200 | 201 | 202 | 204; payload?: Record<string, unknown>; credential?: 'token' | 'device_token' };
type Cached = { fingerprint: string; status: Result['status']; payload_json: string | null; nonce: string | null; credential: Result['credential'] };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonical(row[key])]));
  }
  return value;
}

export function operation(c: Context, secret: string, now: number, scopeValue: string, params?: unknown) {
  const key = c.req.header('Idempotency-Key');
  if (key !== undefined && !/^[\x21-\x7e]{1,128}$/.test(key)) invalid('Idempotency-Key');
  const scope = hash(`${c.req.path}:${scopeValue}`);
  const fingerprint = hmac(secret, ['request', canonical(params ?? null)]);
  const nonce = key === undefined ? null : randomToken();
  const token = nonce ? hmac(secret, ['credential', nonce]) : randomToken();
  const time = iso(now);
  function read(sql: Pick<Transaction, 'get'>) {
    if (!key) return;
    const result = sql.get<Cached>(`SELECT fingerprint, status, payload_json, nonce, credential FROM idempotency
      WHERE scope = ? AND key = ? AND expires_at > ?`, [scope, key, time]);
    if (!result) return;
    if (result.fingerprint !== fingerprint) throw new ApiError('conflict');
    return response({ status: result.status, credential: result.credential, payload: result.payload_json ? JSON.parse(result.payload_json) : undefined },
      result.nonce ? hmac(secret, ['credential', result.nonce]) : undefined);
  }
  function complete(sql: Transaction, result: Result, ttl = day) {
    if (key) {
      sql.run('DELETE FROM idempotency WHERE expires_at <= ?', [time]);
      sql.run(`INSERT INTO idempotency (scope, key, fingerprint, status, payload_json, nonce, credential, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [scope, key, fingerprint, result.status, result.payload ? JSON.stringify(result.payload) : null,
        result.credential ? nonce : null, result.credential ?? null, iso(now + ttl)]);
    }
    return response(result, token);
  }
  function response(result: Result, value?: string) {
    if (result.status === 204) return c.body(null, 204);
    const payload = result.credential ? { ...result.payload, [result.credential]: value } : result.payload;
    return c.json(payload ?? {}, result.status);
  }
  return { token, read, complete, scope, key };
}
