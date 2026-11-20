import { createHash, createHmac, randomBytes } from 'node:crypto';

export const day = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const hmac = (secret: string, value: unknown) => createHmac('sha256', secret).update(JSON.stringify(value)).digest('base64url');
export const randomToken = () => randomBytes(32).toString('base64url');
export const personalLoginTokenPattern = /^onex_login_[A-Za-z0-9_-]{43}$/;

export function normalizedTarget(value: unknown) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const trimmed = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return { value: trimmed.toLowerCase(), kind: 'email' as const };
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return { value: trimmed, kind: 'phone' as const };
  return null;
}

export function bearer(header?: string | null) {
  return /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1];
}

// 租户月份口径固定 Asia/Shanghai（S2 仍未做按租户时区配置），config observe.month_cost_milli 和配额都走这个函数。
const shanghaiOffset = 8 * 60 * 60_000;
export function monthBounds(now: number): [string, string] {
  const local = new Date(now + shanghaiOffset);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return [iso(Date.UTC(year, month, 1) - shanghaiOffset), iso(Date.UTC(year, month + 1, 1) - shanghaiOffset)];
}
