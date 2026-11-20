import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server';
import { seedTenant } from '../src/seed';
import { seedMvp } from '../src/seed-mvp';
import { MemoryPresence } from '../src/presence';
import { day, hash, iso } from '../src/credentials';
import { decryptProviderSecret } from '../src/provider-secret';
import { diffieHellman, generateKeyPairSync, hkdfSync, createPublicKey } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

type DeviceReply = { device_id: string; device_token: string };

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); });

async function fixture(heartbeatMs = 15_000, testTime?: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-server-'));
  clean.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const codes = new Map<string, string>();
  const presence = new MemoryPresence();
  let time = testTime ?? Date.now();
  const service = await createServer({
    dataDir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 2, heartbeatMs, commit: 'test',
    codeSecret: 'test-only-secret', masterKey: Buffer.alloc(32, 41), deliverCode: (target, code) => { codes.set(target, code); },
    now: () => time, presence,
  });
  clean.push(() => service.close());
  const owner = 'owner@example.test';
  const seeded = await seedTenant(service.store, { target: owner, seats: 2, maxUses: 3, now: time });
  function request(path: string, body?: Record<string, unknown>, token?: string, key?: string, method = body ? 'POST' : 'GET') {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (key) headers.set('idempotency-key', key);
    if (body) headers.set('content-type', 'application/json');
    return fetch(new URL(`/v1${path}`, service.server.url), {
      method, headers, body: body && JSON.stringify(body),
    });
  }
  async function code(target: string) {
    const response = await request('/auth/code', { target });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({});
    return codes.get(target)!;
  }
  async function login(target = owner, kind: 'web' | 'desktop' = 'desktop') {
    const response = await request('/auth/login', { target, code: await code(target), kind });
    expect(response.status).toBe(200);
    return (await response.json() as { token: string }).token;
  }
  async function select(token: string) {
    const response = await request('/auth/select-tenant', { tenant_id: seeded.tenantId }, token);
    expect(response.status).toBe(200);
    return (await response.json() as { token: string }).token;
  }
  const publicKey = Buffer.alloc(32, 5).toString('base64');
  const device = { name: 'Mac', os: 'darwin', arch: 'arm64', public_key: publicKey };
  return { ...service, ...seeded, owner, device, presence, request, code, login, select, advance: (ms: number) => { time += ms; }, now: () => time };
}

test('server shutdown drains accepted writes and can be awaited concurrently', async () => {
  const f = await fixture();
  const owner = await f.select(await f.login());
  const edge = await linkedEdge(f, owner);
  await edge.nextOf('cutoff');
  const write = f.store.tenant(f.tenantId).write((sql) => sql.run("INSERT INTO groups (id, name) VALUES ('closing', 'persisted')"));
  await Promise.all([f.close(), f.close()]);
  expect(await write).toMatchObject({ changes: 1 });
  await edge.closed;
  expect(await f.presence.get(edge.device_id)).toBeNull();
});

test('health, OpenAPI, one-use codes, tenant selection and logout', async () => {
  const f = await fixture();
  expect(await (await f.request('/healthz')).json()).toMatchObject({ status: 'ok', commit: 'test' });
  const spec = await (await f.request('/openapi.json')).json() as { paths: object };
  const consolePage = await fetch(f.server.url);
  expect(consolePage.status).toBe(200);
  expect(await consolePage.text()).toContain('app.js');
  expect((await fetch(new URL('/app.js', f.server.url))).status).toBe(200);
  expect((await fetch(new URL('/tests/package.json', f.server.url))).status).toBe(404);
  expect(Object.keys(spec.paths)).toContain('/v1/auth/login');
  expect(Object.keys(spec.paths)).toContain('/v1/platform/providers');
  expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
    '/v1/auth/token-login', '/v1/auth/personal-tokens', '/v1/auth/personal-tokens/{id}/revoke',
  ]));
  const code = await f.code(f.owner);
  const body = { target: f.owner, code, kind: 'desktop' };
  const res = await f.request('/auth/login', body, undefined, 'one-login');
  expect(res.status).toBe(200);
  const signed = await res.json() as { token: string; tenants: unknown[] };
  expect(signed.tenants).toMatchObject([{ id: f.tenantId, revision: 1, actions: ['select'] }]);
  expect(await (await f.request('/auth/login', body, undefined, 'one-login')).json()).toEqual(signed);
  expect((await f.request('/auth/login', body)).status).toBe(401);
  expect(await (await f.request('/me', undefined, signed.token)).json()).toMatchObject({ tenant: null, role: null, agents: [] });
  expect(f.store.system.get('SELECT token_hash, kind FROM sessions')).toEqual({ token_hash: hash(signed.token), kind: 'desktop' });
  const scoped = await f.select(signed.token);
  expect(scoped).not.toBe(signed.token);
  expect(await (await f.request('/me', undefined, scoped)).json()).toMatchObject({ tenant: { id: f.tenantId }, role: 'owner', agents: ['claude-code'] });
  expect((await f.request('/auth/logout', {}, scoped, 'bye')).status).toBe(204);
  expect((await f.request('/auth/logout', {}, scoped, 'bye')).status).toBe(204);
  expect((await f.request('/me', undefined, scoped)).status).toBe(401);
});

const personalTokens = '/auth/personal-tokens';
const tokenLogin = '/auth/token-login';
type PersonalTokenReply = { id: string; token: string; name: string; created_at: string; expires_at: string;
  last_used_at: string | null; revoked_at: string | null; revision: number; actions: string[] };

test('personal tokens are account-owned, disclosed once, and can be managed by ordinary members', async () => {
  const f = await fixture();
  const global = await f.login(f.owner, 'web');
  const owner = await f.select(global);
  expect((await f.request(personalTokens)).status).toBe(401);
  expect(await (await f.request(personalTokens, undefined, owner)).json()).toEqual({
    items: [], total: 0, next_cursor: null, actions: ['create_personal_token'],
  });
  const body = { name: 'Browser lab' };
  const issued = await f.request(personalTokens, body, owner, 'once');
  expect(issued.status).toBe(201);
  expect(issued.headers.get('cache-control')).toBe('no-store');
  const { token, ...metadata } = await issued.json() as PersonalTokenReply;
  expect(token).toMatch(/^onex_login_[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(token.slice('onex_login_'.length), 'base64url')).toHaveLength(32);
  expect(metadata).toEqual({ id: metadata.id, name: 'Browser lab', created_at: iso(f.now()), expires_at: iso(f.now() + 7 * day),
    last_used_at: null, revoked_at: null, revision: 1, actions: ['read', 'revoke'] });
  const replay = await f.request(personalTokens, body, global, 'once');
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(metadata);
  expect((await f.request(personalTokens, { name: 'Different request' }, owner, 'once')).status).toBe(409);
  expect(JSON.stringify(f.store.system.all('SELECT * FROM personal_login_tokens'))).not.toContain(token);
  expect(JSON.stringify(f.store.system.all('SELECT * FROM idempotency'))).not.toContain(token);
  expect(f.store.system.get('SELECT token_hash FROM personal_login_tokens')).toEqual({ token_hash: hash(token) });

  const target = 'personal-member@example.test';
  const joined = await f.request('/auth/login', { target, code: await f.code(target), invite_code: f.inviteCode });
  expect(joined.status).toBe(200);
  const account = await joined.json() as { token: string; user: { id: string } };
  const member = await f.select(account.token);
  expect((await f.request(`${personalTokens}/${metadata.id}/revoke`, { revision: 1 }, member)).status).toBe(404);
  expect(await (await f.request(personalTokens, undefined, member)).json()).toMatchObject({ total: 0, items: [] });
  const memberIssued = await f.request(personalTokens, { name: 'Member token' }, member);
  expect(memberIssued.status).toBe(201);
  const memberToken = (await memberIssued.json() as PersonalTokenReply).token;
  expect(await (await f.request(tokenLogin, { token: memberToken })).json()).toMatchObject({
    tenants: [{ id: f.tenantId, role: 'member' }],
  });
  expect(await (await f.request(`${personalTokens}?q=lab&limit=1`, undefined, global)).json()).toEqual({
    items: [metadata], total: 1, next_cursor: null, actions: ['create_personal_token'],
  });
  const group = await f.request('/groups', { name: 'Test group' }, owner);
  expect(group.status).toBe(201);
  const { id: group_id } = await group.json() as { id: string };
  for (const [role, revision] of [['admin', 1], ['group_admin', 2]] as const) {
    expect((await f.request(`/members/${account.user.id}`, { role, revision, group_id }, owner)).status).toBe(200);
    const roleIssue = await f.request(personalTokens, { name: `${role} token` }, member);
    expect(roleIssue.status).toBe(201);
    const { token } = await roleIssue.json() as PersonalTokenReply;
    expect(await (await f.request(tokenLogin, { token })).json()).toMatchObject({ tenants: [{ id: f.tenantId, role }] });
  }
});

test('token exchange is web-only and revokes all derived sessions at once', async () => {
  const f = await fixture();
  const otp = await f.login(f.owner, 'web');
  const issued = await f.request(personalTokens, { name: 'Revocable' }, otp);
  expect(issued.status).toBe(201);
  const personal = await issued.json() as PersonalTokenReply;
  expect((await f.request('/me', undefined, personal.token)).status).toBe(401);
  expect((await f.request(tokenLogin, { token: personal.token, kind: 'desktop' })).status).toBe(422);
  const loggedIn = await f.request(tokenLogin, { token: personal.token });
  expect(loggedIn.status).toBe(200);
  const result = await loggedIn.json() as { token: string; user: { id: string }; tenants: { id: string }[] };
  expect(result).toMatchObject({ user: { id: f.userId }, tenants: [{ id: f.tenantId }] });
  const global = result.token;
  expect(global).not.toBe(personal.token);
  const scoped = await f.select(global);
  expect((await f.request('/auth/select-tenant', { tenant_id: f.tenantId, kind: 'desktop' }, global)).status).toBe(403);
  expect((await f.request('/devices', f.device, scoped)).status).toBe(403);
  expect((await f.request('/me', undefined, scoped)).status).toBe(200);
  expect(f.store.system.all('SELECT kind, expires_at, login_token_id FROM sessions WHERE login_token_id = ?', [personal.id]))
    .toEqual(Array.from({ length: 2 }, () => ({ kind: 'web', expires_at: iso(f.now() + day), login_token_id: personal.id })));
  expect(await (await f.request(personalTokens, undefined, global)).json()).toMatchObject({
    items: [{ id: personal.id, last_used_at: iso(f.now()), revision: 1 }],
  });
  const other = await f.request(personalTokens, { name: 'Second personal token' }, scoped);
  expect(other.status).toBe(201);
  const child = await other.json() as PersonalTokenReply;
  expect((await f.request(`${personalTokens}/${personal.id}/revoke`, { revision: 2 }, otp)).status).toBe(409);
  expect((await f.request(`${personalTokens}/${personal.id}/revoke`, { revision: personal.revision }, otp, 'revoke')).status).toBe(204);
  expect((await f.request(`${personalTokens}/${personal.id}/revoke`, { revision: personal.revision }, otp, 'revoke')).status).toBe(204);
  expect((await f.request(tokenLogin, { token: personal.token })).status).toBe(401);
  for (const stale of [global, scoped]) expect((await f.request('/me', undefined, stale)).status).toBe(401);
  expect((await f.request('/me', undefined, otp)).status).toBe(200);
  expect((await f.request(tokenLogin, { token: child.token })).status).toBe(200);
  expect(await (await f.request(`${personalTokens}?q=revocable`, undefined, otp)).json()).toMatchObject({
    items: [{ id: personal.id, revision: 2, actions: ['read'], revoked_at: iso(f.now()) }],
  });
});

test('personal tokens cap concurrent issuance and bound web session expiry to the original token', async () => {
  const f = await fixture();
  const session = await f.login(f.owner, 'web');
  const issued = await Promise.all(Array.from({ length: 11 }, (_, i) => f.request(personalTokens, { name: `Browser ${i}` }, session)));
  expect(issued.map(({ status }) => status).sort()).toEqual([...Array.from({ length: 10 }, () => 201), 409]);
  const personal = await issued.find(({ status }) => status === 201)!.json() as PersonalTokenReply;
  expect(await (await f.request(`${personalTokens}?limit=2`, undefined, session)).json()).toMatchObject({
    items: [expect.any(Object), expect.any(Object)], total: 10, next_cursor: expect.any(String),
  });
  f.advance(7 * day - 60_000);
  const exchange = await f.request(tokenLogin, { token: personal.token });
  expect(exchange.status).toBe(200);
  const { token: global } = await exchange.json() as { token: string };
  const scoped = await f.select(global);
  expect(f.store.system.all('SELECT expires_at FROM sessions WHERE login_token_id = ?', [personal.id]))
    .toEqual([{ expires_at: personal.expires_at }, { expires_at: personal.expires_at }]);
  f.advance(60_000);
  expect((await f.request(tokenLogin, { token: personal.token })).status).toBe(401);
  expect((await f.request('/me', undefined, global)).status).toBe(401);
  expect((await f.request('/me', undefined, scoped)).status).toBe(401);
  const desktop = await f.login();
  expect((await f.request(personalTokens, { name: 'Desktop' }, desktop)).status).toBe(403);
  f.advance(60_000);
  expect((await f.request(personalTokens, { name: 'New after expiry' }, await f.login(f.owner, 'web'))).status).toBe(201);
});

test('token exchange requires active membership or platform privilege and rechecks revocation during login', async () => {
  const f = await fixture();
  const session = await f.login(f.owner, 'web');
  const issue = await f.request(personalTokens, { name: 'Platform test' }, session);
  expect(issue.status).toBe(201);
  const personal = await issue.json() as PersonalTokenReply;
  await f.store.system.write((sql) => sql.run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [f.tenantId]));
  expect((await f.request(tokenLogin, { token: personal.token })).status).toBe(401);
  await f.store.system.write((sql) => sql.run('INSERT INTO platform_admins (user_id) VALUES (?)', [f.userId]));
  const exchange = await f.request(tokenLogin, { token: personal.token });
  expect(exchange.status).toBe(200);
  const result = await exchange.json() as { token: string; tenants: unknown[] };
  expect(result.tenants).toEqual([]);
  expect((await f.request('/platform/tenants', undefined, result.token)).status).toBe(200);

  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const memberships = f.store.tenantIdsForUser.bind(f.store);
  f.store.tenantIdsForUser = async (userId) => {
    entered.resolve();
    await resume.promise;
    return memberships(userId);
  };
  const pending = f.request(tokenLogin, { token: personal.token });
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Exchange did not check membership'); })]);
    expect((await f.request(`${personalTokens}/${personal.id}/revoke`, { revision: 1 }, session)).status).toBe(204);
  } finally { resume.resolve(); }
  expect((await pending).status).toBe(401);
  expect(f.store.system.get('SELECT token_hash FROM sessions WHERE login_token_id = ?', [personal.id])).toBeNull();
});

test('expired and over-attempted codes cannot log in; code issuance is rate-limited', async () => {
  const f = await fixture();
  const code = await f.code(f.owner);
  const retry = await f.request('/auth/code', { target: f.owner });
  expect(retry.status).toBe(429);
  expect(await retry.json()).toMatchObject({ error: { code: 'rate_limited' } });
  const wrong = code === '111111' ? '222222' : '111111';
  for (let i = 0; i < 4; i++) expect((await f.request('/auth/login', { target: f.owner, code: wrong })).status).toBe(401);
  expect((await f.request('/auth/login', { target: f.owner, code: wrong })).status).toBe(429);
  const locked = await f.request('/auth/login', { target: f.owner, code });
  expect(locked.status).toBe(429);
  expect(await locked.json()).toMatchObject({ error: { code: 'rate_limited', detail: { retry_after_ms: 600_000 } } });
  f.advance(60_000);
  expect((await f.request('/auth/code', { target: f.owner })).status).toBe(429);
  f.advance(540_000);
  const fresh = await f.code(f.owner);
  f.advance(600_001);
  expect((await f.request('/auth/login', { target: f.owner, code: fresh })).status).toBe(401);
});

test('racing invite redemptions cannot exceed seats and the loser does not consume a use', async () => {
  const f = await fixture();
  const targets = ['a@example.test', '+8613800000000'];
  const codes = await Promise.all(targets.map(f.code));
  const res = await Promise.all(targets.map((target, i) => f.request('/auth/login', { target, code: codes[i], invite_code: f.inviteCode })));
  expect(res.map((r) => r.status).sort()).toEqual([200, 403]);
  expect(await res.find((r) => r.status === 403)!.json()).toMatchObject({ error: { code: 'seat_limit' } });
  expect(f.store.tenant(f.tenantId).get('SELECT used FROM invites')).toEqual({ used: 1 });
  expect(f.store.tenant(f.tenantId).get('SELECT count(*) AS n FROM members')).toEqual({ n: 2 });
});

test('tenant management enforces scope, revisions, pagination, and one-time invite disclosure', async () => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  expect((await f.request('/members', undefined, global)).status).toBe(403);
  expect(await (await f.request('/me', undefined, scoped)).json()).toMatchObject({
    actions: ['create_member', 'create_group', 'create_invite', 'update_contract', 'assign_role:admin', 'assign_role:group_admin', 'assign_role:member'],
  });
  expect(await (await f.request('/members?role=member&status=disabled', undefined, scoped)).json()).toMatchObject({
    items: [], total: 0, actions: ['create_member'],
  });
  expect(await (await f.request('/groups', undefined, scoped)).json()).toMatchObject({ items: [], actions: ['create_group'] });
  const body = { name: 'Engineering', quota_milli: 200 };
  const created = await f.request('/groups', body, scoped, 'group');
  expect(created.status).toBe(201);
  const group = await created.json() as { id: string; revision: number };
  expect(await (await f.request('/groups', body, scoped, 'group')).json()).toEqual(group);
  expect((await f.request(`/groups/${group.id}`, { revision: 1, parent_id: group.id }, scoped)).status).toBe(422);
  expect((await f.request('/groups', { name: 'Support', parent_id: group.id }, scoped)).status).toBe(201);
  const page = await (await f.request('/groups?limit=1', undefined, scoped)).json() as { items: unknown[]; total: number; next_cursor: string };
  expect(page).toMatchObject({ total: 2, items: [{ revision: 1, actions: ['read', 'update'] }] });
  expect((await (await f.request(`/groups?limit=1&cursor=${page.next_cursor}`, undefined, scoped)).json())).toMatchObject({ total: 2, next_cursor: null });
  const invite = { role: 'member', group_id: group.id, max_uses: 1, expires_in_ms: 60_000 };
  const res = await f.request('/invites', invite, scoped, 'join');
  expect(res.status).toBe(201);
  const issued = await res.json() as { invite_code: string; id: string };
  expect(issued.invite_code).toBeString();
  expect(await (await f.request('/invites', invite, scoped, 'join')).json()).toMatchObject({ id: issued.id, code_returned: false });
  expect(await (await f.request('/invites', invite, scoped, 'join')).json()).not.toHaveProperty('invite_code');
  expect((await f.request('/invites', { ...invite, max_uses: 2 }, scoped, 'join')).status).toBe(409);
  const target = 'engineer@example.test';
  const joined = await f.request('/auth/login', { target, code: await f.code(target), invite_code: issued.invite_code });
  expect(joined.status).toBe(200);
  const { token, user } = await joined.json() as { token: string; user: { id: string } };
  const employee = await f.select(token);
  expect((await f.request('/members', undefined, employee)).status).toBe(403);
  const update = { revision: 1, quota_milli: 100 };
  expect(await (await f.request(`/members/${user.id}`, update, scoped, undefined, 'PATCH')).json()).toMatchObject({ revision: 2, group_id: group.id, quota_milli: 100 });
  expect((await f.request(`/members/${user.id}`, update, scoped)).status).toBe(409);
  const set = { revision: 1, seat_limit: 3, allowed_agents: ['claude-code'], allowed_models: [], lease_minutes: 10, lease_budget_milli: 2000, visibility: {} };
  expect((await f.request('/contract', set, employee, undefined, 'PUT')).status).toBe(403);
  expect(await (await f.request('/contract', set, scoped, undefined, 'PUT')).json()).toMatchObject({ ...set, revision: 2, visibility: {
    admin: { summary: true, content: false }, group_admin: { summary: true, content: false },
  } });
  expect((await f.request('/contract', set, scoped, undefined, 'PUT')).status).toBe(409);
});

test('admin may manage ordinary members but cannot grant privileged roles', async () => {
  const f = await fixture();
  const owner = await f.select(await f.login());
  const created = await (await f.request('/invites', { role: 'admin', max_uses: 1, expires_in_ms: 60_000 }, owner)).json() as { invite_code: string };
  const target = 'manager@example.test';
  const login = await f.request('/auth/login', { target, code: await f.code(target), invite_code: created.invite_code });
  expect(login.status).toBe(200);
  const admin = await f.select((await login.json() as { token: string }).token);
  expect(await (await f.request('/me', undefined, admin)).json()).toMatchObject({ role: 'admin',
    actions: ['create_member', 'create_group', 'create_invite', 'assign_role:member'] });
  expect((await f.request('/invites', { role: 'admin', max_uses: 1, expires_in_ms: 60_000 }, admin)).status).toBe(403);
});

test('platform privileges are independent and provider secrets are never returned or stored in plaintext', async () => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  expect((await f.request('/platform/tenants', undefined, global)).status).toBe(403);
  await f.store.system.write((sql) => sql.run('INSERT INTO platform_admins (user_id) VALUES (?)', [f.userId]));
  expect(await (await f.request('/me', undefined, global)).json()).toMatchObject({ is_platform_admin: true,
    actions: expect.arrayContaining(['topup', 'create_provider']) });
  expect(await (await f.request('/platform/providers', undefined, global)).json()).toMatchObject({ items: [], actions: ['create_provider'] });
  expect((await f.request('/platform/tenants', undefined, scoped)).status).toBe(403);
  const secret = 'fake-secret-not-for-storage';
  const provider = { name: 'Fake', protocol: 'anthropic', base_url: 'http://127.0.0.1:3333', secret };
  const result = await f.request('/platform/providers', provider, global, 'provider');
  expect(result.status).toBe(201);
  const resultText = await result.text();
  expect(resultText).not.toContain(secret);
  expect(await (await f.request('/platform/providers', undefined, global)).text()).not.toContain(secret);
  expect(await (await f.request('/platform/providers', provider, global, 'provider')).text()).toBe(resultText);
  const stored = f.store.system.get<{ secret_ciphertext: Uint8Array }>('SELECT secret_ciphertext FROM providers')!;
  expect(Buffer.from(stored.secret_ciphertext).includes(secret)).toBe(false);
  const { id } = JSON.parse(resultText) as { id: string };
  expect(decryptProviderSecret(Buffer.alloc(32, 41), id, stored.secret_ciphertext).toString()).toBe(secret);
  expect(() => decryptProviderSecret(Buffer.alloc(32, 41), 'different-provider', stored.secret_ciphertext)).toThrow();
  const model = await f.request('/platform/models', { provider_id: id, upstream_name: 'fake', display_name: 'Fake', context_window: 1024 }, global);
  expect(model.status).toBe(201);
  const { id: model_id } = await model.json() as { id: string };
  const rate = { model_id, effective_from: '2026-11-19T00:00:00Z', input_milli_per_mtok: 1, output_milli_per_mtok: 2, cache_read_milli_per_mtok: 0, cache_write_milli_per_mtok: 0 };
  expect((await f.request('/platform/rates', rate, global)).status).toBe(201);
  expect((await f.request('/platform/rates', rate, global)).status).toBe(409);
  const other = await (await f.request('/platform/providers', { ...provider, name: 'Other' }, global)).json() as { id: string };
  const otherModel = await (await f.request('/platform/models', { provider_id: other.id, upstream_name: 'other',
    display_name: 'Other', context_window: 1024 }, global)).json() as { id: string };
  expect((await f.request('/platform/rates', { ...rate, model_id: otherModel.id }, global)).status).toBe(201);
  expect(await (await f.request(`/platform/models?provider_id=${id}&limit=1`, undefined, global)).json())
    .toMatchObject({ total: 1, next_cursor: null, items: [{ id: model_id }] });
  expect(await (await f.request(`/platform/rates?model_id=${model_id}&limit=1`, undefined, global)).json())
    .toMatchObject({ total: 1, next_cursor: null, items: [{ model_id }] });
  expect((await f.request('/platform/agent-releases', { agent: 'claude-code', version: '1', os: 'darwin', arch: 'arm64', url: 'http://127.0.0.1/fake', sha256: 'a'.repeat(64), size: 1 }, global)).status).toBe(201);
  const tenant = { name: 'Second', owner_user_id: f.userId };
  const created = await f.request('/platform/tenants', tenant, global, 'tenant');
  expect(created.status).toBe(201);
  const second = await created.json() as { id: string };
  expect(await (await f.request('/platform/tenants', tenant, global, 'tenant')).json()).toEqual(second);
  expect(f.store.tenant(second.id).get('SELECT revision FROM contract')).toEqual({ revision: 1 });
});

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 1_500;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for WebSocket state');
    await Bun.sleep(5);
  }
}

function connect(f: Awaited<ReturnType<typeof fixture>>, token: string, version = '0.1.0') {
  const ws = new WebSocket(`ws://${f.server.hostname}:${f.server.port}/v1/edge/ws`, {
    headers: { Authorization: `Bearer ${token}`, 'OneX-Edge-Version': version, 'OneX-Protocol': '0' },
  });
  clean.push(() => ws.close());
  const queue: any[] = [];
  ws.onmessage = (event) => queue.push(JSON.parse(String(event.data)));
  const opened = new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
  const closed = new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });
  async function next() {
    await until(() => queue.length > 0);
    return queue.shift();
  }
  function send(message: unknown) { ws.send(JSON.stringify(message)); }
  function hello(leaseId?: string, outboxLastSeq = 0, configRevision = 0) { send({ type: 'hello', id: 'edge-hello', edge_version: version, os: 'darwin', arch: 'arm64', config_revision: configRevision, outbox_last_seq: outboxLastSeq, lease_id: leaseId }); }
  async function nextOf(type: string) {
    for (;;) {
      const message = await next();
      if (message.type === type) return message;
      if (message.type !== 'config' && message.type !== 'secret') throw new Error(`Expected ${type}, received ${message.type}`);
    }
  }
  return { ws, opened, closed, next, nextOf, send, hello };
}

test('device credentials are scoped, hashed, repaired on lookup, and renewed only after hello', async () => {
  const f = await fixture();
  const global = await f.login();
  expect((await f.request('/devices', f.device, global)).status).toBe(403);
  const scoped = await f.select(global);
  const first = await f.request('/devices', f.device, scoped, 'register');
  expect(first.status).toBe(201);
  const created = await first.json() as DeviceReply;
  expect(await (await f.request('/devices', f.device, scoped, 'register')).json()).toEqual(created);
  expect((await f.request('/devices', { ...f.device, name: 'Other' }, scoped, 'register')).status).toBe(409);
  expect(f.store.tenant(f.tenantId).get('SELECT token_hash FROM devices')).toEqual({ token_hash: hash(created.device_token) });
  expect((await f.request('/me', undefined, created.device_token)).status).toBe(401);
  expect(await connect(f, scoped).opened).toBe(false);
  expect(await connect(f, created.device_token, 'broken').opened).toBe(false);
  await f.store.system.write((sql) => sql.run('DELETE FROM device_directory'));
  f.advance(10_000);
  const edge = connect(f, created.device_token);
  expect(await edge.opened).toBe(true);
  edge.hello();
  expect(await edge.next()).toMatchObject({ type: 'welcome', re: 'edge-hello', device_id: created.device_id, ack_seq: 0 });
  expect(f.store.tenant(f.tenantId).get('SELECT token_expires_at FROM devices')).toEqual({ token_expires_at: new Date(f.now() + 30 * 86_400_000).toISOString() });
  expect(await f.presence.get(created.device_id)).toBeTruthy();
  f.advance(30 * 86_400_000 + 1);
  expect(await connect(f, created.device_token).opened).toBe(false);
});

test('new device connection replaces old; heartbeat is correlated and closes after three misses', async () => {
  const f = await fixture(70);
  const scoped = await f.select(await f.login());
  const { device_id, device_token } = await (await f.request('/devices', f.device, scoped)).json() as DeviceReply;
  const old = connect(f, device_token);
  expect(await old.opened).toBe(true);
  old.hello();
  await old.next();
  const current = connect(f, device_token);
  expect(await current.opened).toBe(true);
  current.hello();
  expect(await current.next()).toMatchObject({ type: 'welcome', heartbeat_ms: 70 });
  expect(await current.next()).toMatchObject({ type: 'cutoff', reason: 'balance' });
  expect((await old.closed).code).toBe(4001);
  expect(await f.presence.get(device_id)).toBeTruthy();
  current.send({ type: 'ping', id: 'client-ping' });
  expect(await current.nextOf('pong')).toEqual({ type: 'pong', re: 'client-ping' });
  const ping = await current.nextOf('ping');
  expect(ping.type).toBe('ping');
  current.send({ type: 'pong', re: ping.id });
  for (let i = 0; i < 3; i++) expect((await current.nextOf('ping')).type).toBe('ping');
  expect((await current.closed).code).toBe(1008);
  await until(async () => await f.presence.get(device_id) === null);
});

test('configuration scopes model routes and encrypts provider secrets to the registered device', async () => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  await f.store.system.write((sql) => sql.run('INSERT INTO platform_admins VALUES (?)', [f.userId]));
  const providerResponse = await f.request('/platform/providers', { name: 'Fake', protocol: 'anthropic',
    base_url: 'http://127.0.0.1:3333', secret: 'test-only-provider-key', auth: 'bearer', proxy: 'none' }, global);
  expect(providerResponse.status).toBe(201);
  const provider = await providerResponse.json() as { id: string };
  const modelResponse = await f.request('/platform/models', { provider_id: provider.id, upstream_name: 'fake-upstream',
    route_model: 'managed-*', display_name: 'Fake', context_window: 1024 }, global);
  expect(modelResponse.status).toBe(201);
  const model = await modelResponse.json() as { id: string };
  expect((await f.request('/platform/rates', { model_id: model.id, effective_from: new Date(f.now()).toISOString(),
    input_milli_per_mtok: 1, output_milli_per_mtok: 2, cache_read_milli_per_mtok: 0, cache_write_milli_per_mtok: 0 }, global)).status).toBe(201);
  const update = { revision: 1, seat_limit: 2, allowed_agents: ['claude-code'], allowed_models: [model.id], lease_minutes: 10, lease_budget_milli: 2000, visibility: {} };
  expect((await f.request('/contract', update, scoped, undefined, 'PUT')).status).toBe(200);
  const keys = generateKeyPairSync('x25519');
  const raw = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const device = await (await f.request('/devices', { ...f.device, public_key: raw.toString('base64') }, scoped)).json() as DeviceReply;
  const edge = connect(f, device.device_token);
  expect(await edge.opened).toBe(true);
  edge.hello();
  expect(await edge.next()).toMatchObject({ type: 'welcome' });
  expect(await edge.next()).toMatchObject({ type: 'cutoff' });
  const config = await edge.next();
  expect(config).toMatchObject({ type: 'config', routes: [{ model: 'managed-*', model_id: model.id,
    provider_id: provider.id, protocol: 'anthropic', upstream_model: 'fake-upstream', auth: 'bearer', proxy: 'none' }],
    rates: [{ model_id: model.id, input_milli_per_mtok: 1 }] });
  const secret = await edge.next();
  expect(secret).toMatchObject({ type: 'secret', provider_id: provider.id });
  const der = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(secret.key_id, 'base64')]);
  const shared = diffieHellman({ privateKey: keys.privateKey, publicKey: createPublicKey({ key: der, format: 'der', type: 'spki' }) });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), 'onex-edge-secret-v1', 32));
  expect(Buffer.from(xchacha20poly1305(key, Buffer.from(secret.nonce, 'base64'), Buffer.from(provider.id))
    .decrypt(Buffer.from(secret.ciphertext, 'base64'))).toString()).toBe('test-only-provider-key');
  edge.send({ type: 'ack', re: secret.id, ok: true });
  edge.send({ type: 'ack', re: config.id, ok: true });
  expect((await f.request(`/platform/models/${model.id}`, { revision: 1, route_model: 'renamed' }, global, undefined, 'PATCH')).status).toBe(200);
  const changed = await edge.next();
  expect(changed).toMatchObject({ type: 'config', routes: [{ model: 'renamed' }] });
  expect(changed.revision).toBeGreaterThan(config.revision);
  expect(await edge.next()).toMatchObject({ type: 'secret' });
  const noKey = await (await f.request('/devices', { name: 'No key', os: 'darwin', arch: 'arm64' }, scoped)).json() as DeviceReply;
  const secondary = connect(f, noKey.device_token);
  expect(await secondary.opened).toBe(true);
  secondary.hello();
  expect(await secondary.next()).toMatchObject({ type: 'welcome' });
  expect(await secondary.next()).toMatchObject({ type: 'cutoff' });
  expect(await secondary.next()).toMatchObject({ type: 'config', routes: [{ model: 'renamed' }] });
  secondary.send({ type: 'ping', id: 'no-secret' });
  expect(await secondary.next()).toEqual({ type: 'pong', re: 'no-secret' });
  expect((await f.request('/contract', { ...update, revision: 2, allowed_models: [] }, scoped, undefined, 'PUT')).status).toBe(200);
  const removed = await edge.next();
  expect(removed).toMatchObject({ type: 'config', routes: [], rates: [] });
  expect(removed.revision).toBeGreaterThan(changed.revision);
  edge.send({ type: 'ping', id: 'barrier' });
  expect(await edge.next()).toEqual({ type: 'pong', re: 'barrier' });
});

test('event and usage acknowledgments share a durable cursor, and observation is scoped and audited', async () => {
  const f = await fixture(15_000, Date.parse('2027-01-31T15:55:00.000Z'));
  const scoped = await f.select(await f.login());
  const a = await linkedEdge(f, scoped);
  await a.nextOf('cutoff');
  const session_id = randomUUID();
  const at = new Date(f.now()).toISOString();
  const input = { seq: 3, session_id, kind: 'user_message', at, source_offset: 50, payload: { content: 'private test text' } };
  const stream = await f.request('/observe/stream', undefined, scoped);
  expect(stream.headers.get('content-type')).toContain('text/event-stream');
  const reader = stream.body!.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected');
    a.send({ type: 'events', id: 'out-of-order', batch: [input] });
    expect(await a.nextOf('events_ack')).toMatchObject({ ack_seq: 0 });
    const summary = new TextDecoder().decode((await reader.read()).value);
    expect(summary).toContain(session_id);
    expect(summary).not.toContain('private test text');
    expect(await (await f.request(`/observe/sessions/${session_id}/events`, undefined, scoped)).json()).toMatchObject({ items: [], total: 0 });
    a.send({ type: 'usage', id: 'usage', batch: [{ seq: 2, request_id: 'req_test', session_id,
      provider_id: 'prv_test', model: 'fake', model_id: 'mod_test', input_tokens: 5, output_tokens: 2,
      cache_read_tokens: 0, cache_write_tokens: 0, at, status: 'client_cancelled', complete: false, cost_milli: 3 }] });
    expect(await a.nextOf('events_ack')).toMatchObject({ ack_seq: 0 });
    const start = { seq: 1, session_id, kind: 'session_start', at, source_offset: 0, payload: { agent: 'claude-code', agent_version: 'test', model: 'fake' } };
    a.send({ type: 'events', id: 'complete', batch: [start, input] });
    expect(await a.nextOf('events_ack')).toMatchObject({ ack_seq: 3 });
    a.send({ type: 'events', id: 'gap', batch: [{ seq: 4, session_id, kind: 'gap', at, payload: { reason: 'bad_line', offset: 55 } }] });
    expect(await a.nextOf('events_ack')).toMatchObject({ ack_seq: 4 });
    a.send({ type: 'events', id: 'non-turns', batch: [
      { ...input, seq: 5, payload: { content: 'subagent', sidechain: true, agent_id: 'sub' } },
      { ...input, seq: 6, payload: { content: 'injection', system_injected: true } },
    ] });
    expect(await a.nextOf('events_ack')).toMatchObject({ ack_seq: 6 });
    const usageBase = { request_id: 'month-test', session_id, provider_id: 'prv_test', model: 'fake', model_id: 'mod_test',
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, complete: true, status: 'ok' };
    f.advance(Date.parse('2027-01-31T16:30:00.000Z') - f.now());
    a.send({ type: 'usage', id: 'month-boundary', batch: [
      { ...usageBase, seq: 7, at: '2027-01-31T15:59:59.999Z', cost_milli: 7 },
      { ...usageBase, seq: 8, at: '2027-01-31T16:00:00.000Z', cost_milli: 11 },
    ] });
    expect(await a.nextOf('events_ack')).toMatchObject({ ack_seq: 8 });
    expect(await (await f.request('/observe/people', undefined, scoped)).json()).toMatchObject({
      items: [{ user_id: f.userId, session_count: 1, cost_milli: 21, month_cost_milli: 11 }],
    });
    expect(await (await f.request('/observe/sessions', undefined, scoped)).json()).toMatchObject({ items: [{ id: session_id, event_count: 5,
      turn_count: 1, cost_milli: 21, pending_usage_count: 3, input_tokens: 5, output_tokens: 2, actions: ['read', 'read_content'] }] });
    expect(await (await f.request(`/observe/sessions/${session_id}/events?after_seq=1`, undefined, scoped)).json()).toMatchObject({
      items: [{ seq: 3, source_offset: 50, payload: input.payload }, { seq: 4, kind: 'gap' }, { seq: 5 }, { seq: 6 }], total: 4 });
    expect(f.store.tenant(f.tenantId).all('SELECT actor, action, target FROM audit ORDER BY rowid')).toEqual([
      { actor: f.userId, action: 'observe.events.read', target: session_id },
      { actor: f.userId, action: 'observe.events.read', target: session_id },
    ]);
  } finally { await reader.cancel(); }
  a.ws.close();
  await a.closed;
  const b = connect(f, a.device_token);
  expect(await b.opened).toBe(true);
  b.hello(undefined, 8);
  expect(await b.next()).toMatchObject({ type: 'welcome', ack_seq: 8 });
  const unrelated = await linkedEdge(f, scoped);
  await unrelated.nextOf('cutoff');
  unrelated.send({ type: 'events', id: 'cross-device', batch: [{ ...input, seq: 1 }] });
  expect(await unrelated.nextOf('ack')).toMatchObject({ ok: false, error: { code: 'conflict' } });
  const target = 'observe-admin@example.test';
  const invite = await (await f.request('/invites', { role: 'admin', max_uses: 1, expires_in_ms: 60_000 }, scoped)).json() as { invite_code: string };
  const login = await f.request('/auth/login', { target, code: await f.code(target), invite_code: invite.invite_code });
  const admin = await f.select((await login.json() as { token: string }).token);
  expect(await (await f.request('/observe/people', undefined, admin)).json()).toMatchObject({ total: 2 });
  expect(await (await f.request('/observe/sessions', undefined, admin)).json()).toMatchObject({ items: [{ id: session_id, actions: ['read'] }] });
  expect((await f.request(`/observe/sessions/${session_id}/events`, undefined, admin)).status).toBe(404);
  const contract = await (await f.request('/contract', undefined, scoped)).json() as Record<string, unknown>;
  const grants = { admin: { summary: true, content: true }, group_admin: { summary: true, content: false } };
  expect((await f.request('/contract', { ...contract, visibility: grants }, scoped, undefined, 'PUT')).status).toBe(200);
  expect(await (await f.request('/observe/sessions', undefined, admin)).json()).toMatchObject({ items: [{ id: session_id, actions: ['read', 'read_content'] }] });
  expect((await f.request(`/observe/sessions/${session_id}/events`, undefined, admin)).status).toBe(200);
  expect(f.store.tenant(f.tenantId).get("SELECT actor FROM audit WHERE action = 'contract.visibility.update'")).toEqual({ actor: f.userId });
});

test('MVP seed provisions OTP users, an OpenAI Chat route, and a prepaid lease', async () => {
  const f = await fixture();
  const seeded = await seedMvp(f.store, { owner: 'mvp-owner@example.test', employee: 'mvp-employee@example.test', masterKey: Buffer.alloc(32, 41), now: f.now() });
  const repeat = await seedMvp(f.store, { owner: 'mvp-owner@example.test', employee: 'mvp-employee@example.test', masterKey: Buffer.alloc(32, 41), now: f.now() });
  expect(repeat).toEqual(seeded);
  const owner = await f.login(seeded.owner_target);
  expect((await f.request('/platform/providers', undefined, owner)).status).toBe(200);
  const employee = await f.login(seeded.employee_target);
  const selected = await f.request('/auth/select-tenant', { tenant_id: seeded.tenant_id }, employee);
  expect(selected.status).toBe(200);
  const { token } = await selected.json() as { token: string };
  const edge = await linkedEdge(f, token);
  expect(await edge.nextOf('lease')).toMatchObject({ budget_milli: 2000 });
  expect(await edge.next()).toMatchObject({ type: 'config', routes: [{ model: '*', protocol: 'openai_chat',
    base_url: 'http://192.168.3.212:11516/v1', upstream_model: 'Qwen3.8-27B', auth: 'bearer' }],
    rates: [{ model_id: seeded.model_id, input_milli_per_mtok: 1000, output_milli_per_mtok: 4000 }] });
  expect(await edge.next()).toMatchObject({ type: 'secret', provider_id: seeded.provider_id });
  expect(f.store.tenant(seeded.tenant_id).get('SELECT sum(amount_milli) AS n FROM ledger WHERE kind = ?', ['topup'])).toEqual({ n: 1_000_000 });
});

async function fund(f: Awaited<ReturnType<typeof fixture>>, token: string, amount: number) {
  await f.store.system.write((sql) => sql.run('INSERT OR IGNORE INTO platform_admins VALUES (?)', [f.userId]));
  const body = { tenant_id: f.tenantId, amount_milli: amount };
  const res = await f.request('/platform/ledger/topup', body, token, 'fund');
  expect(res.status).toBe(201);
  const row = await res.json();
  expect(await (await f.request('/platform/ledger/topup', body, token, 'fund')).json()).toEqual(row);
}

async function linkedEdge(f: Awaited<ReturnType<typeof fixture>>, scoped: string) {
  const token = await (await f.request('/devices', f.device, scoped)).json() as DeviceReply;
  const edge = connect(f, token.device_token);
  expect(await edge.opened).toBe(true);
  edge.hello();
  expect(await edge.next()).toMatchObject({ type: 'welcome' });
  return { ...edge, ...token };
}

test('concurrent renewals stay inside tenant funds and a replay settles only once', async () => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  expect((await f.request('/platform/ledger/topup', { tenant_id: f.tenantId, amount_milli: 1 }, global)).status).toBe(403);
  await fund(f, global, 2);
  const [a, b] = await Promise.all([linkedEdge(f, scoped), linkedEdge(f, scoped)]);
  const [la, lb] = await Promise.all([a.next(), b.next()]);
  expect(la).toMatchObject({ type: 'lease', budget_milli: 1, seq: 1 });
  expect(lb).toMatchObject({ type: 'lease', budget_milli: 1, seq: 1 });
  const msg = { type: 'lease_renew', id: 'renew-a', op_id: 'once', lease_id: la.lease_id, used_milli: 1 };
  a.send(msg);
  a.send({ ...msg, id: 'renew-a-retry' });
  b.send({ ...msg, id: 'renew-b', lease_id: lb.lease_id });
  expect(await a.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'balance', re: 'renew-a' });
  expect(await a.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'balance', re: 'renew-a-retry' });
  expect(await b.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'balance' });
  const balance = await f.request('/balance', undefined, scoped);
  expect(await balance.json()).toMatchObject({ balance_milli: 0, reserved_milli: 0, month_used_milli: 2 });
  expect(f.store.tenant(f.tenantId).get("SELECT count(*) AS n FROM ledger WHERE kind = 'settle'")).toEqual({ n: 2 });
});

test('renewal reporting usage over the lease budget charges only the budget and parks the rest as overage_pending', async () => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  await fund(f, global, 100);
  const a = await linkedEdge(f, scoped);
  const lease = await a.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 5 });
  // 实际花费 6，超出这份额度 1（尾部花费在发出预留之后才计出，Edge 诚实上报）
  a.send({ type: 'lease_renew', id: 'over-budget', op_id: 'op-over', lease_id: lease.lease_id, used_milli: 6 });
  const next = await a.nextOf('lease');
  expect(next).toMatchObject({ type: 'lease', seq: 2 });
  // 租户只按额度 5 实扣；lease_operations 和 usage 之外的真实快照不在这张表里，这里只看租户记账
  expect(f.store.tenant(f.tenantId).get('SELECT status, used_milli FROM leases WHERE id = ?', [lease.lease_id]))
    .toEqual({ status: 'settled', used_milli: 5 });
  expect(f.store.tenant(f.tenantId).get("SELECT amount_milli, request_ref, note FROM ledger WHERE kind = 'settle' AND lease_id = ?", [lease.lease_id]))
    .toEqual({ amount_milli: 5, request_ref: 'op-over', note: null });
  expect(f.store.tenant(f.tenantId).get("SELECT count(*) AS n FROM ledger WHERE kind = 'release' AND lease_id = ?", [lease.lease_id]))
    .toEqual({ n: 0 });
  // 差额 1 单独一条 overage_pending，request_ref 和 settle 一致，不计余额、消费或预留
  expect(f.store.tenant(f.tenantId).get("SELECT amount_milli, request_ref, note FROM ledger WHERE kind = 'overage_pending' AND lease_id = ?", [lease.lease_id]))
    .toEqual({ amount_milli: 1, request_ref: 'op-over', note: '超租约差额待核对' });
  expect(await (await f.request('/balance', undefined, scoped)).json()).toMatchObject({ month_used_milli: 5 });
  // lease_operations 保留 Edge 实报的原始快照（6），不是裁剪后的租户实扣
  expect(f.store.tenant(f.tenantId).get('SELECT used_milli FROM lease_operations WHERE device_id = ? AND op_id = ?', [a.device_id, 'op-over']))
    .toEqual({ used_milli: 6 });
  // 新租约没有继承这笔超支：额度和占用都从零开始
  expect(f.store.tenant(f.tenantId).get('SELECT used_milli FROM leases WHERE id = ?', [next.lease_id])).toEqual({ used_milli: 0 });

  // 重复同一 op_id：原样返回第一次的结果，不重复入账
  a.send({ type: 'lease_renew', id: 'replay', op_id: 'op-over', lease_id: lease.lease_id, used_milli: 6 });
  const replay = await a.nextOf('lease');
  expect(replay).toEqual({ ...next, re: 'replay' });
  expect(f.store.tenant(f.tenantId).get("SELECT count(*) AS n FROM ledger WHERE kind = 'settle' AND lease_id = ?", [lease.lease_id])).toEqual({ n: 1 });
  expect(f.store.tenant(f.tenantId).get("SELECT count(*) AS n FROM ledger WHERE kind = 'overage_pending' AND lease_id = ?", [lease.lease_id])).toEqual({ n: 1 });

  // 换一个 op_id 想再结算同一份已 settled 的租约：拒绝，不产生第二笔账
  a.send({ type: 'lease_renew', id: 'again', op_id: 'op-again', lease_id: lease.lease_id, used_milli: 6 });
  expect(await a.nextOf('ack')).toMatchObject({ type: 'ack', re: 'again', ok: false, error: { code: 'conflict' } });
  expect(f.store.tenant(f.tenantId).get("SELECT count(*) AS n FROM ledger WHERE kind = 'settle' AND lease_id = ?", [lease.lease_id])).toEqual({ n: 1 });
  expect(f.store.tenant(f.tenantId).get("SELECT count(*) AS n FROM ledger WHERE kind = 'overage_pending' AND lease_id = ?", [lease.lease_id])).toEqual({ n: 1 });
});

test('an over-budget renewal does not drain extra balance; exhaustion still comes from the budget alone', async () => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  await fund(f, global, 1);
  const a = await linkedEdge(f, scoped);
  const lease = await a.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 1 });
  // 实报 50，远超这份额度 1；overage_pending 不计余额，不应该把余额往下多扣一分
  a.send({ type: 'lease_renew', id: 'over-budget-drained', lease_id: lease.lease_id, used_milli: 50 });
  expect(await a.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'balance', re: 'over-budget-drained' });
  // 租户只按额度 1 实扣，不是实报的 50
  expect(f.store.tenant(f.tenantId).get('SELECT status, used_milli FROM leases WHERE id = ?', [lease.lease_id]))
    .toEqual({ status: 'settled', used_milli: 1 });
  expect(f.store.tenant(f.tenantId).get("SELECT amount_milli FROM ledger WHERE kind = 'overage_pending' AND lease_id = ?", [lease.lease_id]))
    .toEqual({ amount_milli: 49 });
  // 余额耗尽只是因为额度本身用完（1/1），不是被 49 的差额打空的
  expect(await (await f.request('/balance', undefined, scoped)).json()).toMatchObject({ balance_milli: 0, reserved_milli: 0, month_used_milli: 1 });
});

test('lost renewal response replays the same lease and device-level usage can span renewals', async () => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  await fund(f, global, 100);
  const a = await linkedEdge(f, scoped);
  const original = await a.nextOf('lease');
  const op = { type: 'lease_renew', id: 'before-loss', op_id: `${original.lease_id}:2`, lease_id: original.lease_id, used_milli: 2 };
  a.send(op);
  const first = await a.nextOf('lease');
  a.ws.close();
  await a.closed;
  const b = connect(f, a.device_token);
  expect(await b.opened).toBe(true);
  b.hello(original.lease_id);
  await b.nextOf('welcome');
  b.send({ ...op, id: 'after-loss' });
  const replay = await b.nextOf('lease');
  expect(replay).toEqual({ ...first, re: 'after-loss' });
  expect(await (await f.request('/balance', undefined, scoped)).json()).toMatchObject({ month_used_milli: 2 });
  b.send({ type: 'lease_renew', id: 'next', lease_id: first.lease_id, used_milli: 3 });
  await b.nextOf('lease');
  b.send({ type: 'usage', id: 'spanning-usage', batch: [{ seq: 1, request_id: 'req_spanning', lease_id: original.lease_id,
    provider_id: 'prv_fake', model: 'fake', model_id: 'mod_fake', input_tokens: 5, output_tokens: 2,
    cache_read_tokens: 0, cache_write_tokens: 0, at: new Date(f.now()).toISOString(), status: 'ok', complete: true, cost_milli: 5 }] });
  expect(await b.nextOf('events_ack')).toMatchObject({ ack_seq: 1 });
  expect(f.store.tenant(f.tenantId).get('SELECT settlement_status FROM usage')).toEqual({ settlement_status: 'reconciled' });
  expect(await (await f.request('/balance', undefined, scoped)).json()).toMatchObject({ month_used_milli: 5 });
});

test('an offline lease is settled on return and late usage reconciles without a second debit', async () => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  await fund(f, global, 100);
  const a = await linkedEdge(f, scoped);
  const lease = await a.next();
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 5 });
  a.ws.close();
  await a.closed;
  f.advance(11 * 60_000);
  expect(await (await f.request('/balance', undefined, scoped)).json()).toMatchObject({ balance_milli: 95, reserved_milli: 5 });
  f.advance(24 * 60 * 60_000);
  expect(await (await f.request('/observe/stale-leases', undefined, scoped)).json()).toMatchObject({ total: 1, items: [{ id: lease.lease_id, status: 'active' }] });
  const b = connect(f, a.device_token);
  expect(await b.opened).toBe(true);
  b.hello(lease.lease_id);
  expect(await b.next()).toMatchObject({ type: 'welcome' });
  b.send({ type: 'lease_renew', id: 'offline-renew', lease_id: lease.lease_id, used_milli: 3 });
  expect(await b.nextOf('lease')).toMatchObject({ type: 'lease', seq: 2 });
  const usage = { request_id: 'req_1', lease_id: lease.lease_id, session_id: null, provider_id: 'prv_fake', model: 'fake', model_id: 'mod_fake',
    input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, at: new Date(f.now()).toISOString(), status: 'ok' };
  b.send({ type: 'usage', id: 'offline-batch', batch: [{ ...usage, seq: 1, complete: true, cost_milli: 3 },
    { ...usage, request_id: 'req_2', seq: 2, complete: false, cost_milli: 2 }] });
  expect(await b.nextOf('events_ack')).toMatchObject({ type: 'events_ack', ack_seq: 2 });
  const rows = f.store.tenant(f.tenantId).all('SELECT model, model_id, cost_milli, settlement_status FROM usage ORDER BY seq');
  expect(rows).toEqual([{ model: 'fake', model_id: 'mod_fake', cost_milli: 3, settlement_status: 'reconciled' },
    { model: 'fake', model_id: 'mod_fake', cost_milli: 2, settlement_status: 'pending' }]);
  expect(await (await f.request('/balance', undefined, scoped)).json()).toMatchObject({ month_used_milli: 3 });
});
