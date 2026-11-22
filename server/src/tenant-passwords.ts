import { ApiError } from './api';

const passwordOptions = { algorithm: 'argon2id', memoryCost: 32_768, timeCost: 3 } as const;
const dummyHash = '$argon2id$v=19$m=32768,t=3,p=1$HxAYRUC83bX3UotxWhQpLRnjj5TMmlWVkAs3url6xtc$Oj3MGTHocfgpGIXs2Jcn5STY0KwF4fIQyXTPhDS0qjA';
const utf8 = new TextEncoder();

export function normalizeLoginName(value: unknown, max = 64) {
  if (typeof value !== 'string' || value.length > max * 2) return null;
  const display = value.trim();
  const normalized = display.normalize('NFKC');
  if (Array.from(normalized).length > max || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*$/u.test(normalized)) return null;
  return { display, key: normalized.toLowerCase() };
}

export function validLoginPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && utf8.encode(value).length <= 256;
}

export function hashLoginPassword(password: string): Promise<string> {
  if (!validLoginPassword(password)) throw new Error('Invalid login password length');
  return Bun.password.hash(password, passwordOptions);
}

export function verifyLoginPassword(password: string, hash?: string): Promise<boolean> {
  return Bun.password.verify(password, hash ?? dummyHash, 'argon2id');
}

export function passwordLoginLimiter() {
  const windowMs = 60_000;
  const attempts = new Map<string, number>();
  let currentWindow = -1;
  let checking = 0;
  return (at: number, address: string, pair: string) => {
    const window = Math.floor(at / windowMs);
    if (window !== currentWindow) {
      currentWindow = window;
      attempts.clear();
    }
    const ipKey = `network:${address}`;
    const accountKey = `account:${pair}`;
    const fromIp = attempts.get(ipKey) ?? 0;
    const forAccount = attempts.get(accountKey) ?? 0;
    if (fromIp >= 60 || forAccount >= 8 || attempts.size >= 4096) {
      throw new ApiError('rate_limited', { retry_after_ms: (window + 1) * windowMs - at });
    }
    if (checking >= 4) throw new ApiError('rate_limited', { retry_after_ms: 1000 });
    attempts.set(ipKey, fromIp + 1);
    attempts.set(accountKey, forAccount + 1);
    checking++;
    return () => { checking--; };
  };
}
