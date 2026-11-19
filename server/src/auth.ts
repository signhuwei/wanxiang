import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { bearer, day, hash, hmac, iso, normalizedTarget } from './credentials';
import { ensureUser, findUser, type User } from './seed';
import { indexDevice, indexMember, type Member, type Store, type Transaction } from './store';

const codeCooldown = 60_000;
const codeTtl = 10 * 60_000;
export const deviceTtl = 30 * day;
type Kind = 'web' | 'desktop';
type Session = { user_id: string; tenant_id: string | null; kind: Kind; expires_at: string };
type Tenant = { id: string; name: string; status: string; revision: number };

function kind(value: unknown): Kind | undefined {
  if (value === undefined || value === 'web' || value === 'desktop') return value;
  invalid('kind');
}

export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && /^ten_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

function insertSession(sql: Transaction, token: string, user: string, tenant: string | null, kind: Kind, now: number) {
  sql.run('DELETE FROM sessions WHERE expires_at <= ?', [iso(now)]);
  sql.run('INSERT INTO sessions (token_hash, user_id, tenant_id, kind, expires_at) VALUES (?, ?, ?, ?, ?)',
    [hash(token), user, tenant, kind, iso(now + (kind === 'desktop' ? 7 * day : day))]);
}

function tokenOf(c: Context) {
  const raw = bearer(c.req.header('Authorization'));
  if (!raw) throw new ApiError('unauthenticated');
  return hash(raw);
}

export function readSession(store: Store, tokenHash: string, at: number) {
  const s = store.system.get<Session>('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', [tokenHash, iso(at)]);
  if (!s) throw new ApiError('unauthenticated');
  return s;
}

export function authenticate(store: Store, c: Context, at: number) { return readSession(store, tokenOf(c), at); }

export function authRoutes(app: Hono, store: Store, opts: { codeSecret: string; now: () => number; deliverCode?: (target: string, code: string) => void }) {
  const { now, codeSecret } = opts;
  const pending = new Map<string, Promise<Response>>();
  const tenant = (id: string) => store.system.get<Tenant>("SELECT id, name, status, revision FROM tenants WHERE id = ? AND status = 'active'", [id]);
  const user = (id: string) => store.system.get<User>('SELECT * FROM platform_users WHERE id = ?', [id]);
  const publicUser = (u: User) => ({ ...u, actions: ['read'] });
  const publicTenant = (t: Tenant, m: Member) => ({ ...t, role: m.role, actions: ['select'] });
  const otpHash = (target: string, code: string) => hmac(codeSecret, ['login-code', target, code]);

  const session = (tokenHash: string, at: number) => readSession(store, tokenHash, at);
  async function requireMember(id: string, userId: string) {
    const t = tenant(id);
    const m = t ? await store.member(id, userId) : null;
    if (!t || m?.status !== 'active') throw new ApiError('forbidden');
    return { t, m };
  }

  app.post('/v1/auth/code', async (c) => {
    const body = await json(c);
    const target = normalizedTarget(body.target);
    if (!target) invalid('target');
    const deliverCode = opts.deliverCode;
    if (!deliverCode) throw new ApiError('forbidden');
    const at = now();
    const op = operation(c, codeSecret, at, target.value);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const { response, deliver } = await store.system.write((sql) => {
      const cached = op.read(sql);
      if (cached) return { response: cached, deliver: false };
      const previous = sql.get<{ issued_at: string; expires_at: string; attempts: number; consumed: number }>(
        'SELECT issued_at, expires_at, attempts, consumed FROM login_codes WHERE target = ?', [target.value]);
      const retry = previous ? Math.max(Date.parse(previous.issued_at) + codeCooldown,
        previous.attempts >= 5 && !previous.consumed ? Date.parse(previous.expires_at) : at) - at : 0;
      if (retry > 0) throw new ApiError('rate_limited', { retry_after_ms: retry });
      sql.run('DELETE FROM login_codes WHERE expires_at <= ?', [iso(at)]);
      sql.run(`INSERT INTO login_codes (target, code_hash, expires_at, issued_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (target) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
        issued_at = excluded.issued_at, attempts = 0, consumed = 0`, [target.value, otpHash(target.value, code), iso(at + codeTtl), iso(at)]);
      return { response: op.complete(sql, { status: 202 }, codeTtl), deliver: true };
    });
    if (deliver) deliverCode(target.value, code);
    return response;
  });

  app.post('/v1/auth/login', async (c) => {
    const body = await json(c);
    const target = normalizedTarget(body.target);
    if (!target) invalid('target');
    const code = body.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) invalid('code');
    const invite = body.invite_code === undefined ? null : field(body.invite_code, 'invite_code');
    const inviteHash = invite ? hash(invite) : null;
    const k = kind(body.kind) ?? 'web';
    const at = now();
    const op = operation(c, codeSecret, at, target.value, [code, inviteHash, k]);

    const execute = async () => {
      const cached = op.read(store.system);
      if (cached) return cached;
      const accepted = await store.system.write((sql) => {
        const row = sql.get<{ code_hash: string; attempts: number; expires_at: string }>(`SELECT code_hash, attempts, expires_at FROM login_codes
          WHERE target = ? AND expires_at > ? AND consumed = 0`, [target.value, iso(at)]);
        if (!row) return false;
        const retry = Date.parse(row.expires_at) - at;
        if (row.attempts >= 5) return retry;
        const ok = timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(otpHash(target.value, code)));
        sql.run('UPDATE login_codes SET attempts = attempts + 1, consumed = ? WHERE target = ?', [Number(ok), target.value]);
        return !ok && row.attempts === 4 ? retry : ok;
      });
      if (typeof accepted === 'number') throw new ApiError('rate_limited', { retry_after_ms: accepted });
      if (!accepted) throw new ApiError('unauthenticated');
      let u = findUser(store.system, target);
      if (inviteHash) {
        const id = await store.tenantForInvite(inviteHash);
        if (!id || !tenant(id)) throw new ApiError('not_found');
        const account = u ?? await store.system.write((sql) => ensureUser(sql, target, at));
        const member = await store.tenant(id).write((sql): Member => {
          const invitation = sql.get<{ used: number; max_uses: number; role: string; group_id: string | null }>(
            'SELECT used, max_uses, role, group_id FROM invites WHERE code_hash = ? AND expires_at > ?', [inviteHash, iso(at)]);
          if (!invitation) throw new ApiError('not_found');
          const existing = sql.get<Member>('SELECT user_id, role, status FROM members WHERE user_id = ?', [account.id]);
          if (existing?.status === 'active') return existing;
          if (existing) throw new ApiError('forbidden');
          if (invitation.used >= invitation.max_uses) throw new ApiError('not_found');
          const limit = sql.get<{ seat_limit: number }>('SELECT seat_limit FROM contract ORDER BY revision DESC LIMIT 1');
          const { n } = sql.get<{ n: number }>("SELECT count(*) AS n FROM members WHERE status = 'active'")!;
          if (!limit || n >= limit.seat_limit) throw new ApiError('seat_limit');
          sql.run('UPDATE invites SET used = used + 1, revision = revision + 1 WHERE code_hash = ?', [inviteHash]);
          sql.run("INSERT INTO members (user_id, role, group_id, status) VALUES (?, ?, ?, 'active')", [account.id, invitation.role, invitation.group_id]);
          return { user_id: account.id, role: invitation.role, status: 'active' };
        });
        await store.system.write((sql) => indexMember(sql, id, member));
        u = account;
      }
      if (!u) throw new ApiError('unauthenticated');
      const memberships: ReturnType<typeof publicTenant>[] = [];
      for (const id of await store.tenantIdsForUser(u.id)) {
        const t = tenant(id);
        const m = t ? await store.member(id, u.id) : null;
        if (t && m?.status === 'active') memberships.push(publicTenant(t, m));
      }
      // An account created before a failed invite must not become an active login.
      if (memberships.length === 0 && !store.system.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [u.id])) {
        throw new ApiError('unauthenticated');
      }
      const account = u;
      return store.system.write((sql) => {
        insertSession(sql, op.token, account.id, null, k, at);
        return op.complete(sql, { status: 200, credential: 'token', payload: { user: publicUser(account), tenants: memberships } }, codeTtl);
      });
    };

    if (!op.key) return execute();
    const lock = `${op.scope}:${op.key}`;
    const underway = pending.get(lock);
    if (underway) {
      await underway.catch(() => {});
      return op.read(store.system) ?? execute();
    }
    const result = execute();
    pending.set(lock, result);
    try { return await result; }
    finally { pending.delete(lock); }
  });

  app.post('/v1/auth/select-tenant', async (c) => {
    const at = now();
    const token = tokenOf(c);
    const s = session(token, at);
    const body = await json(c);
    const id = body.tenant_id;
    if (!isTenantId(id)) invalid('tenant_id');
    const k = kind(body.kind) ?? s.kind;
    await requireMember(id, s.user_id);
    const op = operation(c, codeSecret, at, token, [id, k]);
    return store.system.write((sql) => {
      if (!sql.get('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?', [token, iso(at)])) throw new ApiError('unauthenticated');
      const cached = op.read(sql);
      if (cached) return cached;
      insertSession(sql, op.token, s.user_id, id, k, at);
      return op.complete(sql, { status: 200, credential: 'token' });
    });
  });

  app.post('/v1/auth/logout', async (c) => {
    const at = now();
    const token = tokenOf(c);
    const op = operation(c, codeSecret, at, token);
    return store.system.write((sql) => {
      const cached = op.read(sql);
      if (cached) return cached;
      if (!sql.run('DELETE FROM sessions WHERE token_hash = ? AND expires_at > ?', [token, iso(at)]).changes) throw new ApiError('unauthenticated');
      return op.complete(sql, { status: 204 });
    });
  });

  app.get('/v1/me', async (c) => {
    const s = session(tokenOf(c), now());
    const u = user(s.user_id)!;
    const is_platform_admin = !!store.system.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [s.user_id]);
    if (!s.tenant_id) return c.json({ user: publicUser(u), tenant: null, role: null, agents: [], is_platform_admin });
    const { t, m } = await requireMember(s.tenant_id, s.user_id);
    const contract = store.tenant(t.id).get<{ allowed_agents_json: string }>('SELECT allowed_agents_json FROM contract ORDER BY revision DESC LIMIT 1');
    return c.json({ user: publicUser(u), tenant: publicTenant(t, m), role: m.role, agents: contract ? JSON.parse(contract.allowed_agents_json) : [], is_platform_admin });
  });

  app.post('/v1/devices', async (c) => {
    const at = now();
    const token = tokenOf(c);
    const s = session(token, at);
    if (!s.tenant_id) throw new ApiError('forbidden');
    const id = s.tenant_id;
    if (!tenant(id)) throw new ApiError('forbidden');
    const body = await json(c);
    const name = field(body.name, 'name');
    const os = field(body.os, 'os', 32);
    const arch = field(body.arch, 'arch', 32);
    const key = field(body.public_key, 'public_key', 44);
    // CONTRACT-PENDING: X25519 public_key is a 32-byte RFC 4648 base64 string.
    const decoded = Buffer.from(key, 'base64');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || decoded.length !== 32 || decoded.toString('base64') !== key || !decoded.some(Boolean)) invalid('public_key');
    const op = operation(c, codeSecret, at, token, [name, os, arch, key]);
    const tokenHash = hash(op.token);
    const deviceId = `dev_${ulid()}`;
    const result = await store.tenant(id).write((sql) => {
      if (!sql.get("SELECT 1 FROM members WHERE user_id = ? AND status = 'active'", [s.user_id])) throw new ApiError('forbidden');
      const cached = op.read(sql);
      if (cached) return cached;
      sql.run(`INSERT INTO devices (id, user_id, name, os, arch, public_key, token_hash, token_expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`, [deviceId, s.user_id, name, os, arch, key, tokenHash, iso(at + deviceTtl)]);
      return op.complete(sql, { status: 201, credential: 'device_token', payload: { device_id: deviceId } });
    });
    const issued = await result.clone().json() as { device_id: string; device_token: string };
    await store.system.write((sql) => indexDevice(sql, id, { id: issued.device_id, token_hash: hash(issued.device_token) }));
    return result;
  });
}
