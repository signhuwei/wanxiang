import { readContract } from './capability-data';
import { readPolicyHot, refreshPolicyForOrganization } from './policy-data';
import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { platformCreateActions, tenantActions } from './actions';
import { quotaBinding, selfMonthUsage } from './billing';
import { bearer, day, hash, hmac, iso, normalizedTarget, personalLoginTokenPattern, randomToken } from './credentials';
import { encryptEdgeSecret } from './edge-secret';
import { ensureUser, findUser, type User } from './seed';
import { indexDevice, indexMember, type Member, type Store, type Transaction } from './store';
import { normalizeLoginName, passwordLoginLimiter, validLoginPassword, verifyLoginPassword } from './tenant-passwords';

const codeCooldown = 60_000;
const codeTtl = 10 * 60_000;
const resumeTtl = 2 * 60_000;
const resumeContext = 'onex-device-resume-v1';
const deviceIdPattern = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
export const deviceTtl = 30 * day;
type Kind = 'web' | 'desktop';
type Session = { user_id: string; tenant_id: string | null; kind: Kind; expires_at: string; login_token_id: string | null; tenant_password_login: number };
type LoginTokenLink = { id: string; expires_at: string };
type ResumeDevice = { id: string; public_key: string; token_hash: string };
type Tenant = { id: string; name: string; status: string; revision: number };

function kind(value: unknown): Kind | undefined {
  if (value === undefined || value === 'web' || value === 'desktop') return value;
  invalid('kind');
}

export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && /^ten_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

function insertSession(sql: Transaction, token: string, user: string, tenant: string | null, kind: Kind, now: number,
  loginToken?: LoginTokenLink, tenantPasswordLogin = false) {
  const expiresAt = iso(now + (kind === 'desktop' ? 7 * day : day));
  const expiry = loginToken && loginToken.expires_at < expiresAt ? loginToken.expires_at : expiresAt;
  sql.run('DELETE FROM sessions WHERE expires_at <= ?', [iso(now)]);
  sql.run('INSERT INTO sessions (token_hash, user_id, tenant_id, kind, expires_at, login_token_id, tenant_password_login) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [hash(token), user, tenant, kind, expiry, loginToken?.id ?? null, Number(tenantPasswordLogin)]);
}

function tokenOf(c: Context) {
  const raw = bearer(c.req.header('Authorization'));
  if (!raw) throw new ApiError('unauthenticated');
  return hash(raw);
}

function readSession(sql: Pick<Transaction, 'get'>, tokenHash: string, at: number) {
  const s = sql.get<Session>(`SELECT user_id, tenant_id, kind, expires_at, login_token_id, tenant_password_login
    FROM sessions WHERE token_hash = ? AND expires_at > ?`, [tokenHash, iso(at)]);
  if (!s) throw new ApiError('unauthenticated');
  return s;
}

export function authenticate(store: Store, c: Context, at: number) { return readSession(store.system, tokenOf(c), at); }

export function authRoutes(app: Hono, store: Store, opts: { codeSecret: string; now: () => number;
  deliverCode?: (target: string, code: string) => void; onConfigChange?: (tenantId: string) => void;
  onDeviceTokenRotated?: (deviceId: string, previousTokenHash: string) => void }) {
  const { now, codeSecret } = opts;
  const pending = new Map<string, Promise<Response>>();
  const limitPasswordLogin = passwordLoginLimiter();
  const tenant = (id: string, sql: Pick<Transaction, 'get'> = store.system) =>
    sql.get<Tenant>("SELECT id, name, status, revision FROM tenants WHERE id = ? AND status = 'active'", [id]);
  const user = (id: string) => store.system.get<User>('SELECT * FROM platform_users WHERE id = ?', [id]);
  const publicUser = (u: User) => ({ ...u, actions: ['read'] });
  const publicTenant = (t: Tenant, m: Member) => ({ ...t, role: m.role, actions: ['select'] });
  const otpHash = (target: string, code: string) => hmac(codeSecret, ['login-code', target, code]);

  const session = (tokenHash: string, at: number) => readSession(store.system, tokenHash, at);
  async function requireMember(id: string, userId: string) {
    const t = tenant(id);
    const m = t ? await store.member(id, userId) : null;
    if (!t || m?.status !== 'active') throw new ApiError('forbidden');
    return { t, m };
  }

  function loginMemberships(sql: Pick<Transaction, 'get'>, userId: string, tenantIds: string[]) {
    const memberships: ReturnType<typeof publicTenant>[] = [];
    for (const id of tenantIds) {
      const t = tenant(id, sql);
      if (!t) continue;
      const m = store.tenant(id).get<Member>("SELECT user_id, role, status FROM members WHERE user_id = ? AND status = 'active'", [userId]);
      if (m) memberships.push(publicTenant(t, m));
    }
    if (memberships.length === 0 && !sql.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [userId])) {
      throw new ApiError('unauthenticated');
    }
    return memberships;
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
          const limit = readContract(sql);
          const { n } = sql.get<{ n: number }>("SELECT count(*) AS n FROM members WHERE status = 'active'")!;
          if (!limit || n >= limit.seat_limit) throw new ApiError('seat_limit');
          sql.run('UPDATE invites SET used = used + 1, revision = revision + 1 WHERE code_hash = ?', [inviteHash]);
          sql.run("INSERT INTO members (user_id, role, group_id, status) VALUES (?, ?, ?, 'active')", [account.id, invitation.role, invitation.group_id]);
          refreshPolicyForOrganization(sql,id,account.id,at);
          return { user_id: account.id, role: invitation.role, status: 'active' };
        });
        await store.system.write((sql) => indexMember(sql, id, member));
        opts.onConfigChange?.(id);
        u = account;
      }
      if (!u) throw new ApiError('unauthenticated');
      const account = u;
      const tenantIds = await store.tenantIdsForUser(account.id);
      return store.system.write((sql) => {
        const memberships = loginMemberships(sql, account.id, tenantIds);
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

  app.post('/v1/auth/password-login', async (c) => {
    const body = await json(c);
    const tenantName = normalizeLoginName(body.tenant);
    const username = normalizeLoginName(body.username);
    if (!tenantName) invalid('tenant');
    if (!username) invalid('username');
    const password = body.password;
    if (!validLoginPassword(password)) invalid('password');
    const k = kind(body.kind) ?? 'web';
    const server = c.env as Pick<Bun.Server<unknown>, 'requestIP'> | undefined;
    const address = server?.requestIP(c.req.raw)?.address ?? '';
    const release = limitPasswordLogin(now(), address, `${tenantName.key}:${username.key}`);
    try {
      type Candidate = { tenant_id: string; user_id: string; password_hash: string };
      // Treat full IDs as exact selectors. An alias needs a single credential
      // match, since administrators may assign the same alias to multiple tenants.
      const byId = isTenantId(tenantName.display);
      const candidates = (sql: Pick<Transaction, 'all'>) => sql.all<Candidate>(`
        SELECT a.tenant_id, a.user_id, a.password_hash
        FROM tenant_login_accounts a JOIN tenants t ON t.id = a.tenant_id
        WHERE t.status = 'active' AND ${byId ? 't.id' : 't.short_name_key'} = ? AND a.username_key = ?
        ORDER BY a.tenant_id LIMIT 17`, [byId ? tenantName.display : tenantName.key, username.key]);
      const checked = candidates(store.system);
      if (checked.length === 0 || checked.length > 16) {
        await verifyLoginPassword(password);
        throw new ApiError('unauthenticated');
      }
      const matching: Candidate[] = [];
      for (const row of checked) {
        if (await verifyLoginPassword(password, row.password_hash)) matching.push(row);
      }
      if (!matching.length) throw new ApiError('unauthenticated');
      return await store.system.write((sql) => {
        const current = candidates(sql);
        if (current.length !== checked.length || current.some((row, i) => {
          const previous = checked[i]!;
          return row.tenant_id !== previous.tenant_id || row.user_id !== previous.user_id || row.password_hash !== previous.password_hash;
        })) throw new ApiError('unauthenticated');
        const active = matching.flatMap((row) => {
          const t = tenant(row.tenant_id, sql);
          const m = t && store.tenant(t.id).get<Member>(`SELECT user_id, role, status FROM members
            WHERE user_id = ? AND status = 'active'`, [row.user_id]);
          return t && m ? [{ t, m }] : [];
        });
        if (active.length !== 1) throw new ApiError('unauthenticated');
        const { t, m } = active[0]!;
        const account = sql.get<User>('SELECT * FROM platform_users WHERE id = ?', [m.user_id]);
        if (!account) throw new ApiError('unauthenticated');
        const token = randomToken();
        insertSession(sql, token, account.id, t.id, k, now(), undefined, true);
        return c.json({ token, user: publicUser(account), tenants: [publicTenant(t, m)] });
      });
    } finally { release(); }
  });

  app.post('/v1/auth/token-login', async (c) => {
    const body = await json(c);
    if (typeof body.token !== 'string' || !personalLoginTokenPattern.test(body.token)) invalid('token');
    if (body.kind !== undefined && body.kind !== 'web') invalid('kind');
    const tokenHash = hash(body.token);
    const activeToken = (sql: Pick<Transaction, 'get'>, at: number) =>
      sql.get<LoginTokenLink & { user_id: string }>(`SELECT id, user_id, expires_at FROM personal_login_tokens
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`, [tokenHash, iso(at)]);
    const personal = activeToken(store.system, now());
    if (!personal) throw new ApiError('unauthenticated');
    const tenantIds = await store.tenantIdsForUser(personal.user_id);
    return store.system.write((sql) => {
      const at = now();
      const current = activeToken(sql, at);
      if (!current || current.id !== personal.id || current.user_id !== personal.user_id) throw new ApiError('unauthenticated');
      const account = sql.get<User>('SELECT * FROM platform_users WHERE id = ?', [current.user_id]);
      if (!account) throw new ApiError('unauthenticated');
      const memberships = loginMemberships(sql, account.id, tenantIds);
      const token = randomToken();
      insertSession(sql, token, account.id, null, 'web', at, current);
      sql.run('UPDATE personal_login_tokens SET last_used_at = ? WHERE id = ?', [iso(at), current.id]);
      return c.json({ token, user: publicUser(account), tenants: memberships });
    });
  });

  app.post('/v1/auth/select-tenant', async (c) => {
    const at = now();
    const token = tokenOf(c);
    const s = session(token, at);
    if (s.tenant_password_login) throw new ApiError('forbidden');
    const body = await json(c);
    const id = body.tenant_id;
    if (!isTenantId(id)) invalid('tenant_id');
    const k = kind(body.kind) ?? s.kind;
    if (s.login_token_id && k !== 'web') throw new ApiError('forbidden');
    await requireMember(id, s.user_id);
    const op = operation(c, codeSecret, at, token, [id, k]);
    return store.system.write((sql) => {
      const checkedAt = now();
      const current = readSession(sql, token, checkedAt);
      const loginToken = current.login_token_id ? sql.get<LoginTokenLink>(`SELECT id, expires_at FROM personal_login_tokens
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`, [current.login_token_id, current.user_id, iso(checkedAt)]) : null;
      if (current.login_token_id && !loginToken) throw new ApiError('unauthenticated');
      const cached = op.read(sql);
      if (cached) return cached;
      insertSession(sql, op.token, current.user_id, id, k, checkedAt, loginToken ?? undefined);
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
    const is_platform_admin = !s.tenant_password_login && !!store.system.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [s.user_id]);
    if (!s.tenant_id) return c.json({ user: publicUser(u), tenant: null, role: null, agents: [], is_platform_admin,
      actions: is_platform_admin ? platformCreateActions : [] });
    const { t, m } = await requireMember(s.tenant_id, s.user_id);
    const db=store.tenant(t.id);
    const contract=readPolicyHot(db,s.user_id)??readContract(db);
    const binding = quotaBinding(store.tenant(t.id), s.user_id, now());
    const quota = { quota_milli: binding?.quota_milli ?? null, month_used_milli: binding?.used_milli ?? selfMonthUsage(store.tenant(t.id), s.user_id, now()),
      remaining_milli: binding?.remaining_milli ?? null, limited_by: binding?.limited_by ?? null };
    return c.json({ user: publicUser(u), tenant: publicTenant(t, m), role: m.role, agents: contract ? JSON.parse(contract.allowed_agents_json) : [], is_platform_admin,
      actions: tenantActions(m.role), quota, ...(s.tenant_password_login && { tenant_password_login: true }) });
  });

  app.post('/v1/devices', async (c) => {
    const at = now();
    const token = tokenOf(c);
    const s = session(token, at);
    if (!s.tenant_id || s.login_token_id) throw new ApiError('forbidden');
    const id = s.tenant_id;
    if (!tenant(id)) throw new ApiError('forbidden');
    const body = await json(c);
    const name = field(body.name, 'name');
    const os = field(body.os, 'os', 32);
    const arch = field(body.arch, 'arch', 32);
    const key = body.public_key == null ? '' : field(body.public_key, 'public_key', 44);
    const decoded = Buffer.from(key, 'base64');
    if (key && (!/^[A-Za-z0-9+/]{43}=$/.test(key) || decoded.length !== 32 || decoded.toString('base64') !== key || !decoded.some(Boolean))) invalid('public_key');
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

  function resumeActor(token: string, at: number) {
    const actor = session(token, at);
    if (!actor.tenant_id || actor.login_token_id || actor.kind !== 'desktop' || !tenant(actor.tenant_id)) {
      throw new ApiError('forbidden');
    }
    return { tenantId: actor.tenant_id, userId: actor.user_id };
  }

  function resumeDevice(sql: Pick<Transaction, 'get'>, userId: string, deviceId: string) {
    const row = sql.get<ResumeDevice>(`SELECT d.id, d.public_key, d.token_hash FROM devices d
      JOIN members m ON m.user_id = d.user_id
      WHERE d.id = ? AND d.user_id = ? AND d.status = 'active' AND m.status = 'active' AND d.public_key != ''`, [deviceId, userId]);
    if (!row) throw new ApiError('not_found');
    return row;
  }

  const resumeMac = (token: string, tenantId: string, userId: string, row: ResumeDevice, expires: number) =>
    hmac(codeSecret, [resumeContext, token, tenantId, userId, row.id, row.public_key, row.token_hash, expires]);

  app.post('/v1/devices/:id/resume-challenge', async (c) => {
    const deviceId = c.req.param('id');
    if (!deviceIdPattern.test(deviceId)) invalid('id');
    if (Object.keys(await json(c)).length !== 0) invalid('body');
    const at = now();
    const token = tokenOf(c);
    const { tenantId, userId } = resumeActor(token, at);
    const row = resumeDevice(store.tenant(tenantId), userId, deviceId);
    const expires = at + resumeTtl;
    const proof = Buffer.from(`${expires}.${resumeMac(token, tenantId, userId, row, expires)}`);
    try {
      return c.json(encryptEdgeSecret(row.public_key, resumeContext, proof));
    } catch {
      // Legacy registrations permitted a syntactically valid low-order X25519 key.
      throw new ApiError('not_found');
    } finally {
      proof.fill(0);
    }
  });

  app.post('/v1/devices/:id/resume', async (c) => {
    const deviceId = c.req.param('id');
    if (!deviceIdPattern.test(deviceId)) invalid('id');
    const body = await json(c);
    if (Object.keys(body).length !== 1) invalid('body');
    const proof = field(body.proof, 'proof', 64);
    const parsed = /^([1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/.exec(proof);
    if (!parsed || parsed[0] !== proof) invalid('proof');
    const expires = Number(parsed[1]);
    const at = now();
    const token = tokenOf(c);
    const { tenantId, userId } = resumeActor(token, at);
    const op = operation(c, codeSecret, at, token, [deviceId, proof]);
    if (!op.key) invalid('Idempotency-Key');
    const result = await store.tenant(tenantId).write((sql) => {
      const checkedAt = now();
      resumeActor(token, checkedAt);
      const row = resumeDevice(sql, userId, deviceId);
      const cached = op.read(sql);
      if (cached) return { response: cached };
      const expected = resumeMac(token, tenantId, userId, row, expires);
      if (!Number.isSafeInteger(expires) || expires <= checkedAt || expires > checkedAt + resumeTtl ||
          !timingSafeEqual(Buffer.from(expected), Buffer.from(parsed[2]!))) throw new ApiError('unauthenticated');
      sql.run('UPDATE devices SET token_hash = ?, token_expires_at = ? WHERE id = ?', [hash(op.token), iso(checkedAt + deviceTtl), deviceId]);
      return { response: op.complete(sql, { status: 200, credential: 'device_token', payload: { device_id: deviceId } }, resumeTtl),
        previousTokenHash: row.token_hash };
    });
    if (result.previousTokenHash) opts.onDeviceTokenRotated?.(deviceId, result.previousTokenHash);
    const issued = await result.response.clone().json() as { device_token: string };
    await store.system.write((sql) => {
      resumeActor(token, now());
      // The tenant row is authoritative; a retry repairs an interrupted directory update.
      const current = resumeDevice(store.tenant(tenantId), userId, deviceId);
      if (current.token_hash !== hash(issued.device_token)) throw new ApiError('conflict');
      indexDevice(sql, tenantId, current);
    });
    return result.response;
  });
}
