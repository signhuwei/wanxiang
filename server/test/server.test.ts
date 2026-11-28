import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_AGENT_PART_BYTES } from '../src/agent-catalog';
import { createServer } from '../src/server';
import { seedTenant } from '../src/seed';
import { hashLoginPassword, normalizeLoginName } from '../src/tenant-passwords';
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
  return { ...service, ...seeded, dataDir, owner, device, presence, request, code, login, select, advance: (ms: number) => { time += ms; }, now: () => time };
}

const templatePath = '/platform/contract-templates';
const configurationPath = '/contract/configuration';
const standardEntitlements = {
  seat_limit: 2, allowed_agents: ['claude-code'], allowed_models: [] as string[], lease_minutes: 10, lease_budget_milli: 2000,
  visibility: { admin: { summary: true, content: false }, group_admin: { summary: true, content: false } },
  quota_distribution: true,
};

test('Master password uses the existing platform identity and rotation expires old password sessions', async () => {
  const f = await fixture();
  const master = await f.login(f.owner, 'web');
  const settings = '/auth/master-password';
  const login = '/auth/master-password-login';
  const password = randomUUID();
  const updated = randomUUID();
  const username = 'Dedicated.Master';
  const credentials = { username, password };

  expect((await f.request(settings, undefined, master)).status).toBe(403);
  await f.store.system.write(sql => sql.run('INSERT INTO platform_admins VALUES (?)', [f.userId]));
  const tenant = await f.select(master);
  expect((await f.request(settings, undefined, tenant)).status).toBe(403);
  expect(await (await f.request(settings, undefined, master)).json()).toEqual({ username: null, revision: 0, actions: ['set_master_password'] });
  expect((await f.request(settings, { ...credentials, revision: 0 }, master, undefined, 'PUT')).status).toBe(422);
  const set = await f.request(settings, { ...credentials, revision: 0 }, master, 'master-setup', 'PUT');
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject({ username, revision: 1 });
  const protectedRow = f.store.system.get<{ password_hash: string }>('SELECT password_hash FROM master_login_accounts WHERE user_id=?', [f.userId])!;
  expect(protectedRow.password_hash).toStartWith('$argon2id$');
  expect(protectedRow.password_hash).not.toContain(password);
  expect((await f.request(login, { username, password: updated })).status).toBe(401);
  const signedIn = await f.request(login, { username: username.toLowerCase(), password });
  expect(signedIn.status).toBe(200);
  const { token } = await signedIn.json() as { token: string };
  expect(await (await f.request('/me', undefined, token)).json()).toMatchObject({ tenant: null, is_platform_admin: true });
  expect((await f.request('/auth/select-tenant', { tenant_id: f.tenantId, kind: 'desktop' }, token)).status).toBe(403);
  const derivedTenant = await f.select(token);
  expect((await f.request(settings, { username, password: updated, revision: 1 }, master, 'master-rotate', 'PUT')).status).toBe(200);
  expect((await f.request('/me', undefined, token)).status).toBe(401);
  expect((await f.request('/me', undefined, derivedTenant)).status).toBe(401);
  expect((await f.request('/me', undefined, master)).status).toBe(200);
  expect((await f.request(login, credentials)).status).toBe(401);
  const reauthenticated = await f.request(login, { username, password: updated });
  expect(reauthenticated.status).toBe(200);
  const replacement = (await reauthenticated.json() as { token: string }).token;
  expect(f.store.system.get<{ n: number }>("SELECT count(*) n FROM platform_audit WHERE action='auth.master_password.set' AND actor=?", [f.userId])?.n).toBe(2);
  await f.store.system.write(sql => {
    sql.run('DELETE FROM platform_admins WHERE user_id=?', [f.userId]);
    sql.run('INSERT INTO platform_admins VALUES (?)', [f.userId]);
  });
  expect((await f.request('/me', undefined, replacement)).status).toBe(401);
  expect((await f.request(login, { username, password: updated })).status).toBe(401);
});

async function issueFixtureContract(f: Awaited<ReturnType<typeof fixture>>, global: string, scoped: string, entitlements = standardEntitlements) {
  await f.store.system.write(sql => sql.run('INSERT OR IGNORE INTO platform_admins VALUES (?)', [f.userId]));
  const template = { id: 'fixture', name: 'Fixture', revision: 0, entitlements };
  expect((await f.request(templatePath, template, global, 'template-fixture')).status).toBe(201);
  const path = `/platform/capability-contracts/${f.tenantId}`;
  const body = { revision: 0, tenant_revision: 0, template_id: template.id, template_version: 1, reason: 'First contract' };
  expect((await f.request(path, body, global, 'issue-fixture', 'PUT')).status).toBe(200);
  const assigned = await (await f.request(configurationPath, undefined, scoped)).json() as { platform_revision: number; revision: number };
  return { platform_revision: assigned.platform_revision, revision: assigned.revision };
}

test('platform contract revisions enforce tenant boundaries through republishing and restoration', async () => {
  const f = await fixture();
  const global = await f.login();
  const owner = await f.select(global);
  const path = `/platform/capability-contracts/${f.tenantId}`;
  expect((await f.request(path, undefined, owner)).status).toBe(403);
  expect((await f.request(configurationPath, undefined, global)).status).toBe(403);
  expect(await (await f.request(configurationPath, undefined, owner)).json()).toMatchObject({ platform_revision: 0, entitlements: null });
  const entitlements = { ...standardEntitlements, allowed_agents: ['claude-code', 'codex'] };
  const first = await issueFixtureContract(f, global, owner, entitlements);
  expect(first).toEqual({ platform_revision: 1, revision: 1 });
  const oldContract = await (await f.request('/contract', undefined, owner)).json() as Record<string, unknown>;
  const oldWrite = await f.request('/contract', { ...oldContract, seat_limit: 3 }, owner, undefined, 'PUT');
  expect(oldWrite.status).toBe(409);
  expect(await oldWrite.json()).toMatchObject({ error: { detail: { reason: 'use_tenant_configuration' } } });
  expect((await f.request(configurationPath, { ...first, configuration: { seat_limit: 3 } }, owner, 'extra-seat', 'PUT')).status).toBe(422);
  expect((await f.request(configurationPath, { ...first, configuration: { allowed_agents: ['kimi-code'] } }, owner, 'extra-agent', 'PUT')).status).toBe(422);
  const explicit = { ...first, configuration: { allowed_agents: ['claude-code', 'codex'], lease_budget_milli: 1500 } };
  const preview = await f.request(configurationPath + '/preview', explicit, owner);
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ effective: { seat_limit: 2, lease_budget_milli: 1500 } });
  expect(await (await f.request(configurationPath, undefined, owner)).json()).toMatchObject(first);
  expect((await f.request(configurationPath, explicit, owner, undefined, 'PUT')).status).toBe(422);
  const publish = await f.request(configurationPath, explicit, owner, 'explicit', 'PUT');
  expect(publish.status).toBe(200);
  const published = await publish.json();
  expect(await (await f.request(configurationPath, explicit, owner, 'explicit', 'PUT')).json()).toEqual(published);

  expect((await f.request(templatePath, { id: 'fixture', name: 'Fixture v2', revision: 1,
    entitlements: { ...entitlements, seat_limit: 1 } }, global, 'new-template')).status).toBe(201);
  expect(await (await f.request(path, undefined, global)).json()).toMatchObject({ platform_contract: { template_version: 1 }, seats: { limit: 2 } });
  const cut = { revision: 1, tenant_revision: 2, template_id: 'fixture', template_version: 2,
    entitlements: { allowed_agents: ['claude-code'] }, reason: 'Scope reduction' };
  expect((await f.request(path + '/preview', cut, global)).status).toBe(200);
  expect((await f.request(path, cut, global, 'reduce', 'PUT')).status).toBe(200);
  expect((await f.request(configurationPath, { ...explicit, revision: 2 }, owner, 'stale', 'PUT')).status).toBe(409);
  const reduced = await (await f.request(configurationPath, undefined, owner)).json();
  expect(reduced).toMatchObject({ platform_revision: 2, revision: 3, effective: { allowed_agents: ['claude-code'], seat_limit: 1 } });
  expect(reduced).toMatchObject({ seats: { limit: 1, active: 1, available: 0, over_limit: 0 } });
  const restore = { ...cut, revision: 2, tenant_revision: 3, template_version: 1, entitlements: {}, reason: 'Restore purchased rights' };
  expect((await f.request(path, restore, global, 'restore', 'PUT')).status).toBe(200);
  expect(await (await f.request(configurationPath, undefined, owner)).json()).toMatchObject({
    platform_revision: 3, revision: 3, entitlements: { allowed_agents: entitlements.allowed_agents },
    effective: { allowed_agents: ['claude-code'], seat_limit: 2, lease_budget_milli: 1500 },
  });
});

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

test('observation uses the quota ledger and filters whole session pages by agent', async () => {
  const f = await fixture();
  const scoped = await f.select(await f.login());
  const device = await (await f.request('/devices', f.device, scoped)).json() as DeviceReply;
  const db = f.store.tenant(f.tenantId);
  const at = iso(f.now());
  await db.write(sql => {
    sql.run('UPDATE members SET quota_milli = 96 WHERE user_id = ?', [f.userId]);
    sql.run("INSERT INTO ledger (id, kind, amount_milli, user_id, at) VALUES (?, 'settle', ?, ?, ?)", ['led-observe-test', 42, f.userId, at]);
    for (const [index, agent] of ['kimi-code', 'codex', 'kimi-code'].entries()) {
      sql.run(`INSERT INTO agent_sessions (id, device_id, user_id, agent, agent_version, started_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [`s-observe-${index}`, device.device_id, f.userId, agent, 'test', iso(f.now() + index)]);
    }
  });
  const people = await f.request('/observe/people', undefined, scoped);
  expect(await people.json()).toMatchObject({
    items: [{ user_id: f.userId, last_agent: 'kimi-code', quota_milli: 96, month_used_milli: 42, month_cost_milli: 0 }],
  });
  const path = '/observe/sessions?agent=kimi-code&limit=1';
  const first = await (await f.request(path, undefined, scoped)).json() as { next_cursor: string };
  expect(first).toMatchObject({ items: [{ id: 's-observe-2', agent: 'kimi-code' }], total: 2 });
  expect(await (await f.request(`${path}&cursor=${first.next_cursor}`, undefined, scoped)).json()).toMatchObject({
    items: [{ id: 's-observe-0' }], total: 2, next_cursor: null,
  });
  expect((await f.request('/observe/sessions?agent=unknown', undefined, scoped)).status).toBe(422);
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
    '/v1/platform/contract-templates', '/v1/platform/capability-contracts/{tenant_id}', '/v1/contract/configuration/preview',
  ]));
  expect(spec.paths).toMatchObject({ '/v1/audit': { get: { security: [{ SessionToken: [] }],
    parameters: expect.arrayContaining([expect.objectContaining({ name: 'action', in: 'query' })]),
  } } });
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
const passwordLogin = '/auth/password-login';
type PersonalTokenReply = { id: string; token: string; name: string; created_at: string; expires_at: string;
  last_used_at: string | null; revoked_at: string | null; revision: number; actions: string[] };

type ServerFixture = Awaited<ReturnType<typeof fixture>>;
async function setPassword(f: ServerFixture, tenantId: string, userId: string, shortName: string, username: string, password: string) {
  const alias = normalizeLoginName(shortName)!;
  const login = normalizeLoginName(username)!;
  const passwordHash = await hashLoginPassword(password);
  await f.store.system.write((sql) => {
    sql.run('UPDATE tenants SET short_name = ?, short_name_key = ? WHERE id = ?', [alias.display, alias.key, tenantId]);
    sql.run(`INSERT INTO tenant_login_accounts (tenant_id, username, username_key, user_id, password_hash) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id,username_key) DO UPDATE SET password_hash=excluded.password_hash`,
    [tenantId, login.display, login.key, userId, passwordHash]);
  });
}

test('password login binds duplicate aliases to the one matching tenant and cannot create global credentials', async () => {
  const f = await fixture();
  const other = await seedTenant(f.store, { target: f.owner, name: 'Other test tenant', platformAdmin: true });
  const password = 'Test password exact! ';
  await setPassword(f, f.tenantId, f.userId, 'Provisioning', 'Owner', password);
  await setPassword(f, other.tenantId, other.userId, 'PROVISIONING', 'owner', 'Other password!');

  const login = await f.request(passwordLogin, { tenant: ' ｐｒｏｖｉｓｉｏｎｉｎｇ ', username: 'Ｏｗｎｅｒ', password, kind: 'desktop' });
  expect(login.status).toBe(200);
  expect(login.headers.get('cache-control')).toBe('no-store');
  const reply = await login.json() as { token: string; tenants: { id: string; role: string }[] };
  expect(reply.tenants).toMatchObject([{ id: f.tenantId, role: 'owner' }]);
  expect(await (await f.request('/me', undefined, reply.token)).json()).toMatchObject({
    tenant: { id: f.tenantId }, role: 'owner', is_platform_admin: false, tenant_password_login: true,
  });
  expect((await f.request('/devices', f.device, reply.token)).status).toBe(201);
  expect((await f.request('/auth/select-tenant', { tenant_id: other.tenantId }, reply.token)).status).toBe(403);
  expect((await f.request('/platform/tenants', undefined, reply.token)).status).toBe(403);
  expect((await f.request(personalTokens, { name: 'Escape attempt' }, reply.token)).status).toBe(403);
  expect((await f.request(personalTokens, undefined, reply.token)).status).toBe(403);
  expect((await f.request(passwordLogin, { tenant: f.tenantId, username: 'owner', password: password.trim() })).status).toBe(401);
  expect((await f.request(passwordLogin, { tenant: other.tenantId, username: 'owner', password })).status).toBe(401);

  await setPassword(f, other.tenantId, other.userId, 'PROVISIONING', 'owner', password);
  const ambiguous = await f.request(passwordLogin, { tenant: 'Provisioning', username: 'owner', password });
  expect(ambiguous.status).toBe(401);
  expect(await ambiguous.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  expect((await f.request(passwordLogin, { tenant: other.tenantId, username: 'owner', password })).status).toBe(200);
  await f.store.system.write((sql) => sql.run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [other.tenantId]));
  expect((await f.request(passwordLogin, { tenant: other.tenantId, username: 'owner', password })).status).toBe(401);
  await f.store.tenant(f.tenantId).write((sql) => sql.run("UPDATE members SET status = 'disabled' WHERE user_id = ?", [f.userId]));
  expect((await f.request(passwordLogin, { tenant: f.tenantId, username: 'owner', password })).status).toBe(401);
});

test('password login throttles repeated attempts and uses the exact password after the window', async () => {
  const f = await fixture(15_000, Date.UTC(2026, 11, 22));
  await setPassword(f, f.tenantId, f.userId, 'OneC', 'owner', 'Fictional strong password');
  const body = { tenant: 'onec', username: 'OWNER', password: 'wrong' };
  for (let i = 0; i < 8; i++) expect((await f.request(passwordLogin, body)).status).toBe(401);
  const correct = { ...body, password: 'Fictional strong password' };
  const throttled = await f.request(passwordLogin, correct);
  expect(throttled.status).toBe(429);
  expect(await throttled.json()).toMatchObject({ error: { code: 'rate_limited', detail: { retry_after_ms: 60_000 } } });
  f.advance(60_000);
  expect((await f.request(passwordLogin, correct)).status).toBe(200);
});

test('platform tenant list and details support shared short names and clearing a short name', async () => {
  const f = await fixture();
  await f.store.system.write((sql) => sql.run('INSERT INTO platform_admins VALUES (?)', [f.userId]));
  const master = await f.login(f.owner, 'web');
  const path = '/platform/tenants';
  const first = await f.request(`${path}/${f.tenantId}`, { short_name: 'Demo', revision: 1 }, master, undefined, 'PATCH');
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ id: f.tenantId, short_name: 'Demo', revision: 2 });
  const duplicate = await f.request(path, { name: 'Other test tenant', short_name: 'DEMO', owner_user_id: f.userId }, master);
  expect(duplicate.status).toBe(201);
  const row = await duplicate.json() as { id: string };
  expect(await (await f.request(`${path}/${row.id}`, undefined, master)).json()).toMatchObject({ id: row.id, short_name: 'DEMO', actions: ['read', 'update'] });
  expect(await (await f.request(`${path}?q=demo`, undefined, master)).json()).toMatchObject({ total: 2 });
  expect(await (await f.request('/platform/policy/contracts?q=demo', undefined, master)).json()).toMatchObject({ total: 2 });
  const cleared = await f.request(`${path}/${f.tenantId}`, { short_name: null, revision: 2 }, master);
  expect(await cleared.json()).toMatchObject({ short_name: null, revision: 3 });
  expect(await (await f.request(`${path}?q=demo`, undefined, master)).json()).toMatchObject({ total: 1 });
});

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

test('tenant-password Web accounts can only issue and exchange personal tokens within their own tenant', async () => {
  const f = await fixture();
  const other = await seedTenant(f.store, { target: f.owner, name: 'Other test tenant', platformAdmin: true });
  const password = 'Tenant account fixture password';
  await setPassword(f, f.tenantId, f.userId, 'First', 'Owner', password);
  await setPassword(f, other.tenantId, f.userId, 'Second', 'Owner', password);
  const webLogin = async (tenant: string) => {
    const response = await f.request(passwordLogin, { tenant, username: 'owner', password, kind: 'web' });
    expect(response.status).toBe(200);
    return (await response.json() as { token: string }).token;
  };
  const firstWeb = await webLogin(f.tenantId);
  const secondWeb = await webLogin(other.tenantId);
  const masterWeb = await f.login(f.owner, 'web');
  const name = { name: 'Automation login' };
  const legacy = await (await f.request(personalTokens, name, masterWeb, 'once')).json() as PersonalTokenReply;
  const issued = await f.request(personalTokens, name, firstWeb, 'once');
  expect(issued.status).toBe(201);
  const personal = await issued.json() as PersonalTokenReply & { tenant_id: string };
  expect(personal.tenant_id).toBe(f.tenantId);
  expect(personal.id).not.toBe(legacy.id);
  const replay = await (await f.request(personalTokens, name, firstWeb, 'once')).json();
  const { token: rawPersonal, ...metadata } = personal;
  expect(replay).toEqual(metadata);
  expect(await (await f.request(personalTokens, undefined, firstWeb)).json()).toMatchObject({ items: [metadata], total: 1 });
  expect(await (await f.request(personalTokens, undefined, secondWeb)).json()).toMatchObject({ items: [], total: 0 });
  for (const [id, session] of [[legacy.id, firstWeb], [personal.id, secondWeb]]) {
    expect((await f.request(`${personalTokens}/${id}/revoke`, { revision: 1 }, session)).status).toBe(404);
  }

  const lookup = await f.request(tokenLogin, { token: rawPersonal });
  expect(lookup.status).toBe(200);
  const parent = await lookup.json() as { token: string; tenants: { id: string; role: string }[] };
  expect(parent.tenants).toHaveLength(1);
  expect(parent.tenants[0]).toMatchObject({ id: f.tenantId, role: 'owner' });
  expect(await (await f.request('/me', undefined, parent.token)).json()).toMatchObject({
    tenant: { id: f.tenantId }, role: 'owner', is_platform_admin: false, tenant_password_login: true,
  });
  expect((await f.request('/me', undefined, rawPersonal)).status).toBe(401);
  expect((await f.request('/platform/tenants', undefined, parent.token)).status).toBe(403);
  expect((await f.request('/auth/select-tenant', { tenant_id: other.tenantId }, parent.token)).status).toBe(403);
  expect((await f.request('/devices', f.device, parent.token)).status).toBe(403);

  // A copied automation token cannot outlive the credential that authorized it.
  f.advance(10 * 60_000);
  const childIssue = await f.request(personalTokens, { name: 'Child automation login' }, parent.token);
  expect(childIssue.status).toBe(201);
  const child = await childIssue.json() as PersonalTokenReply & { tenant_id: string };
  expect(child).toMatchObject({ tenant_id: f.tenantId, expires_at: personal.expires_at });
  const childLogin = await f.request(tokenLogin, { token: child.token });
  expect(childLogin.status).toBe(200);
  const childSession = (await childLogin.json() as { token: string }).token;
  await f.store.tenant(f.tenantId).write(sql => sql.run("UPDATE members SET role = 'member' WHERE user_id = ?", [f.userId]));
  expect(await (await f.request('/me', undefined, childSession)).json()).toMatchObject({ role: 'member', is_platform_admin: false });
  expect((await f.request('/groups', { name: 'Forbidden group' }, childSession)).status).toBe(403);
  await f.store.tenant(f.tenantId).write(sql => sql.run("UPDATE members SET status = 'disabled' WHERE user_id = ?", [f.userId]));
  expect((await f.request(tokenLogin, { token: rawPersonal })).status).toBe(401);
  await f.store.tenant(f.tenantId).write(sql => sql.run("UPDATE members SET status = 'active' WHERE user_id = ?", [f.userId]));
  expect((await f.request(`${personalTokens}/${personal.id}/revoke`, { revision: 1 }, firstWeb, 'revoke')).status).toBe(204);
  for (const raw of [rawPersonal, child.token]) expect((await f.request(tokenLogin, { token: raw })).status).toBe(401);
  for (const stale of [parent.token, childSession]) expect((await f.request('/me', undefined, stale)).status).toBe(401);
  expect((await f.request(tokenLogin, { token: legacy.token })).status).toBe(200);
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

test('tenant audit requires an active scoped owner and isolates rows and counts', async () => {
  const f = await fixture();
  const second = await seedTenant(f.store, { target: f.owner, name: 'Other', platformAdmin: true });
  const global = await f.login();
  const owner = await f.select(global);
  const otherSelection = await f.request('/auth/select-tenant', { tenant_id: second.tenantId }, global);
  expect(otherSelection.status).toBe(200);
  const other = (await otherSelection.json() as { token: string }).token;
  const at = new Date(f.now()).toISOString();
  const db = f.store.tenant(f.tenantId);
  await db.write((sql) => sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
    ['aud-own', f.userId, 'test.action', 'own', '{}', at]));
  await f.store.tenant(second.tenantId).write((sql) => {
    for (const id of ['aud-other-1', 'aud-other-2']) {
      sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, f.userId, 'test.action', 'other', '{}', at]);
    }
  });

  expect((await f.request('/audit')).status).toBe(401);
  expect((await f.request('/audit', undefined, global)).status).toBe(403);
  const ownRows = await f.request(`/audit?action=test.action&tenant_id=${second.tenantId}`, undefined, owner);
  expect(ownRows.status).toBe(200);
  expect(await ownRows.json()).toEqual({ items: [{ id: 'aud-own', actor: f.userId, action: 'test.action', target: 'own', at, revision: 1, actions: ['read'] }],
    total: 1, next_cursor: null, actions: ['read_audit'] });
  expect(await (await f.request('/audit?action=test.action', undefined, other)).json()).toMatchObject({
    items: [{ id: 'aud-other-2' }, { id: 'aud-other-1' }], total: 2,
  });

  const target = 'audit-reader@example.test';
  const joined = await f.request('/auth/login', { target, code: await f.code(target), invite_code: f.inviteCode });
  expect(joined.status).toBe(200);
  const member = await joined.json() as { token: string; user: { id: string } };
  const scopedMember = await f.select(member.token);
  expect((await f.request('/audit', undefined, scopedMember)).status).toBe(403);
  const group = await f.request('/groups', { name: 'Audit test group' }, owner);
  expect(group.status).toBe(201);
  const { id: group_id } = await group.json() as { id: string };
  for (const [role, revision] of [['admin', 1], ['group_admin', 2]] as const) {
    const updated = await f.request(`/members/${member.user.id}`, { role, revision, group_id }, owner);
    expect(updated.status).toBe(200);
    expect((await f.request('/audit', undefined, scopedMember)).status).toBe(403);
    expect(await (await f.request('/me', undefined, scopedMember)).json()).toMatchObject({
      role, actions: expect.not.arrayContaining(['read_audit']),
    });
  }

  await db.write((sql) => sql.run("UPDATE members SET status = 'disabled' WHERE user_id = ?", [f.userId]));
  expect((await f.request('/audit', undefined, owner)).status).toBe(403);
  await f.store.system.write((sql) => sql.run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [second.tenantId]));
  expect((await f.request('/audit', undefined, other)).status).toBe(403);
  f.advance(8 * 86_400_000);
  expect((await f.request('/audit', undefined, owner)).status).toBe(401);
});

test('tenant audit paginates stable literal matches and omits private audit data', async () => {
  const f = await fixture();
  const owner = await f.select(await f.login());
  const db = f.store.tenant(f.tenantId);
  const action = 'observe.events.read';
  const older = '2026-11-19T00:00:00.000Z';
  const newer = '2026-11-20T00:00:00.000Z';
  const detail = JSON.stringify({ note: 'private-note', content: 'private-transcript' });
  await db.write((sql) => {
    for (const row of [
      ['aud-a', 'Actor-Find', action, 'sess-old', older],
      ['aud-b', f.userId, action, 'sess-%_Mixed', newer],
      ['aud-c', f.userId, action, 'sess-XZMixed', newer],
      ['aud-d', f.userId, `${action}.extra`, 'sess-extra', newer],
    ]) {
      sql.run('INSERT INTO audit (id, actor, action, target, at, detail_json) VALUES (?, ?, ?, ?, ?, ?)', [...row, detail]);
    }
  });
  async function list(query: Record<string, string>) {
    const response = await f.request(`/audit?${new URLSearchParams(query)}`, undefined, owner);
    expect(response.status).toBe(200);
    return await response.json() as {
      items: { id: string; actor: string; action: string; target: string; at: string; revision: number; actions: string[] }[];
      total: number; next_cursor: string | null; actions: string[];
    };
  }

  const first = await list({ action, limit: '2' });
  expect(first.items.map(({ id }) => id)).toEqual(['aud-c', 'aud-b']);
  expect(first.total).toBe(3);
  expect(first.next_cursor).toBeString();
  const second = await list({ action, limit: '2', cursor: first.next_cursor! });
  expect(second).toMatchObject({ items: [{ id: 'aud-a' }], total: 3, next_cursor: null });
  expect((await list({ q: 'EVENTS.READ' })).items.map(({ id }) => id)).toEqual(['aud-d', 'aud-c', 'aud-b', 'aud-a']);
  expect((await list({ action, q: 'actor-FIND' })).items.map(({ id }) => id)).toEqual(['aud-a']);
  expect(await list({ action, q: '%_mixed' })).toEqual({
    items: [{ id: 'aud-b', actor: f.userId, action, target: 'sess-%_Mixed', at: newer, revision: 1, actions: ['read'] }],
    total: 1, next_cursor: null, actions: ['read_audit'],
  });
  for (const q of ['private-note', 'private-transcript', 'aud-a', older]) {
    expect(await list({ q })).toEqual({ items: [], total: 0, next_cursor: null, actions: ['read_audit'] });
  }
  for (const query of ['limit=201', 'cursor=!', `q=${'A'.repeat(201)}`]) {
    expect((await f.request(`/audit?${query}`, undefined, owner)).status).toBe(422);
  }
  expect(db.get('SELECT count(*) AS n FROM audit')).toEqual({ n: 4 });
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
    actions: ['create_member', 'create_group', 'create_invite', 'update_contract', 'assign_role:admin', 'assign_role:group_admin', 'assign_role:member', 'read_audit'],
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
  expect(await (await f.request(`/members/${user.id}`, update, scoped, undefined, 'PATCH')).json()).toMatchObject({
    revision: 2, group_id: group.id, quota_milli: 100, actions: ['read', 'update', 'disable'],
  });
  expect((await f.request(`/members/${user.id}`, update, scoped)).status).toBe(409);
  const set = { revision: 1, seat_limit: 2, allowed_agents: ['claude-code'], allowed_models: [], lease_minutes: 10, lease_budget_milli: 2000, visibility: {} };
  expect((await f.request('/contract', set, employee, undefined, 'PUT')).status).toBe(403);
  expect((await f.request('/contract', { ...set, seat_limit: 3 }, scoped, undefined, 'PUT')).status).toBe(422);
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
  const { id: model_id, max_output_tokens } = await model.json() as { id: string; max_output_tokens: number | null };
  expect(max_output_tokens).toBeNull();
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
  expect((await f.request('/platform/tenants', { ...tenant, seat_limit: 10 }, global, 'unsigned-seats')).status).toBe(422);
  const created = await f.request('/platform/tenants', tenant, global, 'tenant');
  expect(created.status).toBe(201);
  const second = await created.json() as { id: string };
  expect(await (await f.request('/platform/tenants', tenant, global, 'tenant')).json()).toEqual(second);
  expect(f.store.tenant(second.id).get('SELECT revision FROM contract')).toBeNull();
  expect(await (await f.request('/platform/policy/contracts/' + second.id, undefined, global)).json())
    .toMatchObject({ platform_revision: 0, policy_revision: 0, actions: ['read', 'sign'] });
});

test('signed model output limit persists across partial edits and can be explicitly cleared', async () => {
  const f = await fixture();
  const admin = await f.login();
  await f.store.system.write((sql) => sql.run('INSERT INTO platform_admins (user_id) VALUES (?)', [f.userId]));
  const provider = await f.request('/platform/providers', {
    name: 'Upstream', protocol: 'anthropic', base_url: 'http://127.0.0.1:3333', secret: 'secret',
  }, admin);
  const { id: provider_id } = await provider.json() as { id: string };
  const create = await f.request('/platform/models', { provider_id, upstream_name: 'test-model', display_name: 'Test model',
    context_window: 128000, max_output_tokens: 8192 }, admin);
  expect(create.status).toBe(201);
  const model = await create.json() as { id: string; revision: number; max_output_tokens: number };
  expect(model.max_output_tokens).toBe(8192);
  const pathname = `/platform/models/${model.id}`;
  const updated = await f.request(pathname, { revision: model.revision, display_name: 'Updated' }, admin, undefined, 'PATCH');
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ revision: 2, max_output_tokens: 8192 });
  for (const changes of [{ context_window: 4096 }, ...[0, 3.5, 128001, '8192'].map(max_output_tokens => ({ max_output_tokens }))]) {
    expect((await f.request(pathname, { revision: 2, ...changes }, admin)).status).toBe(422);
  }
  const cleared = await f.request(pathname, { revision: 2, max_output_tokens: null, context_window: 4096 }, admin);
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ revision: 3, context_window: 4096, max_output_tokens: null });
  expect(await (await f.request(`/platform/models?provider_id=${provider_id}`, undefined, admin)).json())
    .toMatchObject({ items: [{ id: model.id, context_window: 4096, max_output_tokens: null }] });
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
  function hello(leaseId?: string, outboxLastSeq = 0, configRevision = 0, capabilityContract = false, capabilityPolicy = false) {
    send({ type: 'hello', id: 'edge-hello', edge_version: version, os: 'darwin', arch: 'arm64', config_revision: configRevision,
      outbox_last_seq: outboxLastSeq, lease_id: leaseId, ...(capabilityContract && { agent_cache: true, capability_contract_v1: true }),
      ...(capabilityPolicy && { agent_cache: true, capability_policy_v2: true }) });
  }
  async function nextOf(type: string) {
    for (;;) {
      const message = await next();
      if (message.type === type) return message;
      if (message.type !== 'config' && message.type !== 'secret') throw new Error(`Expected ${type}, received ${message.type}`);
    }
  }
  return { ws, opened, closed, next, nextOf, send, hello };
}

test('records a config rejection once with server-owned metadata', async () => {
  const f = await fixture();
  const scoped = await f.select(await f.login());
  const device = await (await f.request('/devices', f.device, scoped)).json() as DeviceReply;
  const edge = connect(f, device.device_token);
  expect(await edge.opened).toBe(true);
  edge.hello('fixture-lease');
  expect(await edge.next()).toMatchObject({ type: 'welcome' });
  const config = await edge.nextOf('config');
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    function reject(re: string) {
      edge.send({ type: 'ack', re, ok: false, error: { code: 'untrusted-code', message: 'untrusted-message' } });
    }
    reject('unsent-config');
    reject(config.id);
    reject(config.id);
    edge.send({ type: 'ping', id: 'after-acks' });
    expect(await edge.nextOf('pong')).toEqual({ type: 'pong', re: 'after-acks' });
    expect(warn.mock.calls).toEqual([['OneX Edge rejected configuration', {
      device_id: device.device_id, config_revision: config.revision,
    }]]);
  } finally {
    warn.mockRestore();
  }
});

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

test('device resume rotates the bearer without resetting the account history or ingest cursor', async () => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  const otherSession = await f.select(global);
  const pair = generateKeyPairSync('x25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const created = await (await f.request('/devices', { ...f.device, public_key: publicKey }, scoped)).json() as DeviceReply;
  const deviceId = created.device_id;
  const tenant = f.store.tenant(f.tenantId);
  await tenant.write((sql) => {
    sql.run('INSERT INTO ingest_cursors (device_id, ack_seq) VALUES (?, 7)', [deviceId]);
    sql.run(`INSERT INTO agent_sessions (id, device_id, user_id, agent, agent_version, started_at)
      VALUES (?, ?, ?, ?, ?, ?)`, ['historical-session', deviceId, f.userId, 'codex', '0.1.0', iso(f.now())]);
  });
  const old = connect(f, created.device_token);
  expect(await old.opened).toBe(true);
  old.hello(undefined, 7);
  expect(await old.next()).toMatchObject({ type: 'welcome', device_id: deviceId, ack_seq: 7 });

  const path = `/devices/${deviceId}/resume`;
  const challenge = `${path}-challenge`;
  const webSelection = await f.request('/auth/select-tenant', { tenant_id: f.tenantId, kind: 'web' }, global);
  expect(webSelection.status).toBe(200);
  const { token: web } = await webSelection.json() as { token: string };
  const target = 'another-device-owner@example.test';
  const joined = await f.request('/auth/login', { target, code: await f.code(target), invite_code: f.inviteCode, kind: 'desktop' });
  expect(joined.status).toBe(200);
  const foreign = await f.select((await joined.json() as { token: string }).token);
  expect((await f.request(challenge, {}, global)).status).toBe(403);
  expect((await f.request(challenge, {}, web)).status).toBe(403);
  expect((await f.request(challenge, {}, foreign)).status).toBe(404);

  async function receiveProof() {
    const response = await f.request(challenge, {}, scoped);
    expect(response.status).toBe(200);
    const sealed = await response.json() as { key_id: string; nonce: string; ciphertext: string };
    const der = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(sealed.key_id, 'base64')]);
    const sender = createPublicKey({ key: der, format: 'der', type: 'spki' });
    function decrypt(recipient: typeof pair.privateKey) {
      const shared = diffieHellman({ privateKey: recipient, publicKey: sender });
      const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), 'onex-edge-secret-v1', 32));
      return Buffer.from(xchacha20poly1305(key, Buffer.from(sealed.nonce, 'base64'), Buffer.from('onex-device-resume-v1'))
        .decrypt(Buffer.from(sealed.ciphertext, 'base64'))).toString('utf8');
    }
    expect(() => decrypt(generateKeyPairSync('x25519').privateKey)).toThrow();
    return decrypt(pair.privateKey);
  }

  const stale = await receiveProof();
  f.advance(120_001);
  expect((await f.request(path, { proof: stale }, scoped, 'expired-proof')).status).toBe(401);
  const proof = await receiveProof();
  expect((await f.request(path, { proof }, foreign, 'foreign-proof')).status).toBe(404);
  expect((await f.request(path, { proof }, otherSession, 'other-session')).status).toBe(401);
  expect((await f.request(path, { proof }, scoped)).status).toBe(422);
  expect((await f.request(path, { proof: `${proof}\n` }, scoped, 'malformed')).status).toBe(422);
  await tenant.write((sql) => sql.run('UPDATE devices SET token_expires_at = ? WHERE id = ?', [iso(f.now() - 1), deviceId]));
  const rotationKeys = ['execute-first', 'execute-second'];
  const attempts = await Promise.all(rotationKeys.map((key) => f.request(path, { proof }, scoped, key)));
  expect(attempts.map((res) => res.status).sort()).toEqual([200, 401]);
  const winner = attempts.findIndex((res) => res.status === 200);
  const resumed = attempts[winner]!;
  const retryKey = rotationKeys[winner]!;
  const result = await resumed.json() as DeviceReply;
  expect(result.device_id).toBe(deviceId);
  expect(result.device_token).not.toBe(created.device_token);
  expect((await old.closed).code).toBe(1008);
  expect(await connect(f, created.device_token).opened).toBe(false);
  expect(tenant.all('SELECT id, public_key, token_hash, token_expires_at FROM devices')).toEqual([{
    id: deviceId, public_key: publicKey, token_hash: hash(result.device_token), token_expires_at: iso(f.now() + 30 * day),
  }]);
  expect(tenant.all('SELECT id, device_id, user_id FROM agent_sessions')).toEqual([{
    id: 'historical-session', device_id: deviceId, user_id: f.userId,
  }]);
  await f.store.system.write((sql) => sql.run('DELETE FROM device_directory'));
  const replay = await f.request(path, { proof }, scoped, retryKey);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
  expect(f.store.system.get('SELECT token_hash FROM device_directory')).toEqual({ token_hash: hash(result.device_token) });
  expect((await f.request(path, { proof }, scoped, 'different-key')).status).toBe(401);
  expect((await f.request(path, { proof: stale }, scoped, retryKey)).status).toBe(409);

  const current = connect(f, result.device_token);
  expect(await current.opened).toBe(true);
  current.hello(undefined, 7);
  expect(await current.next()).toMatchObject({ type: 'welcome', device_id: deviceId, ack_seq: 7 });
  const nextProof = await receiveProof();
  await tenant.write((sql) => sql.run("UPDATE devices SET status = 'revoked' WHERE id = ?", [deviceId]));
  expect((await f.request(challenge, {}, scoped)).status).toBe(404);
  expect((await f.request(path, { proof: nextProof }, scoped, 'revoked-device')).status).toBe(404);
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

test('capability pins select an exact verified artifact and recheck it on each device download', async () => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  await f.store.system.write(sql => sql.run('INSERT INTO platform_admins VALUES (?)', [f.userId]));
  const platform = '/platform/agent-releases';
  const register = async (version: string, os = 'darwin', arch = 'arm64') => {
    const response = await f.request(platform, { agent: 'claude-code', version, os, arch, status: 'disabled',
      url: 'https://downloads.claude.ai/fixture', sha256: createHash('sha256').update(version).digest('hex'), size: version.length }, global);
    expect(response.status).toBe(201);
    return await response.json() as { id: string };
  };
  const first = await register('2.1.30');
  const other = await register('2.1.31');
  const getConfig = () => f.request('/contract', undefined, scoped).then(r => r.json()) as Promise<Record<string, unknown>>;
  const update = (body: Record<string, unknown>) => f.request('/contract', body, scoped, undefined, 'PUT');
  const contract = await getConfig();
  expect((await update({ ...contract, agent_release_ids: [first.id] })).status).toBe(422);
  expect((await f.request(platform + '/' + first.id, { revision: 1, status: 'active' }, global, undefined, 'PATCH')).status).toBe(409);
  for (const [version, release] of [['2.1.30', first], ['2.1.31', other]] as const) {
    const uploaded = await fetch(new URL('/v1' + platform + '/' + release.id + '/artifact', f.server.url), {
      method: 'PUT', headers: { authorization: `Bearer ${global}` }, body: version
    });
    expect(uploaded.status).toBe(200);
    expect((await f.request(platform + '/' + release.id, { revision: 1, status: 'active' }, global, undefined, 'PATCH')).status).toBe(200);
  }
  expect((await update({ ...contract, agent_release_ids: [first.id, other.id] })).status).toBe(422);
  const fixed = await update({ ...contract, agent_release_ids: [first.id] });
  expect(fixed.status).toBe(200);
  expect(await fixed.json()).toMatchObject({ agent_releases: [{ id: first.id, version: '2.1.30', available: true }] });
  const device = await (await f.request('/devices', f.device, scoped)).json() as DeviceReply;
  const path = '/edge/agent-artifacts/';
  expect((await f.request(path + first.id)).status).toBe(401);
  expect((await f.request(path + first.id, undefined, scoped)).status).toBe(401);
  const full = await f.request(path + first.id, undefined, device.device_token);
  const etag = '"' + createHash('sha256').update('2.1.30').digest('hex') + '"';
  expect(full.status).toBe(200);
  expect(full.headers.get('accept-ranges')).toBe('bytes');
  expect(full.headers.get('etag')).toBe(etag);
  expect(await full.text()).toBe('2.1.30');
  const ranged = (range: string, token?: string, ifRange?: string, id = first.id) =>
    fetch(new URL('/v1' + path + id, f.server.url), { headers: {
      range, ...(token && { authorization: `Bearer ${token}` }), ...(ifRange && { 'if-range': ifRange }),
    } });
  for (const [request, contentRange, body] of [
    ['bytes=2-', 'bytes 2-5/6', '1.30'],
    ['bytes=0-2', 'bytes 0-2/6', '2.1'],
    ['bytes=4-99', 'bytes 4-5/6', '30'],
    ['bytes=-2', 'bytes 4-5/6', '30'],
  ] as const) {
    const part = await ranged(request, device.device_token, etag);
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(contentRange);
    expect(part.headers.get('content-length')).toBe(String(body.length));
    expect(await part.text()).toBe(body);
  }
  const tooFar = await ranged('bytes=6-', device.device_token);
  expect(tooFar.status).toBe(416);
  expect(tooFar.headers.get('content-range')).toBe('bytes */6');
  for (const whole of [
    await ranged('bytes=2-', device.device_token, '"different"'),
    await ranged('bytes=0-1,3-4', device.device_token),
  ]) {
    expect(whole.status).toBe(200);
    expect(whole.headers.has('content-range')).toBe(false);
    expect(await whole.text()).toBe('2.1.30');
  }
  expect((await ranged('bytes=0-1')).status).toBe(401);
  expect((await ranged('bytes=0-1', scoped)).status).toBe(401);
  expect((await ranged('bytes=0-1', device.device_token, undefined, other.id)).status).toBe(404);
  expect((await f.request(path + other.id, undefined, device.device_token)).status).toBe(404);

  const windows = await (await f.request('/devices', { ...f.device, name: 'Windows', os: 'win32', arch: 'x64',
    public_key: Buffer.alloc(32, 6).toString('base64') }, scoped)).json() as DeviceReply;
  expect((await f.request(path + first.id, undefined, windows.device_token)).status).toBe(404);

  const legacy = connect(f, device.device_token);
  expect(await legacy.opened).toBe(true);
  legacy.hello();
  expect((await legacy.next()).type).toBe('welcome');
  await legacy.next();
  expect(await legacy.next()).toMatchObject({ type: 'config', agents: [], routes: [] });
  expect(await legacy.next()).toMatchObject({ type: 'cutoff', reason: 'contract' });
  legacy.ws.close();
  await legacy.closed;

  const modern = connect(f, device.device_token);
  expect(await modern.opened).toBe(true);
  modern.send({ type: 'hello', id: 'edge-modern', edge_version: '0.1.0', os: 'darwin', arch: 'arm64',
    config_revision: 0, outbox_last_seq: 0, agent_cache: true });
  expect((await modern.next()).type).toBe('welcome');
  await modern.next();
  expect(await modern.next()).toMatchObject({ type: 'config', agent_cache: true, agents: [{ id: first.id, url: '/v1' + path + first.id }] });

  expect((await f.request(platform + '/' + first.id, { revision: 2, sha256: 'a'.repeat(64) }, global, undefined, 'PATCH')).status).toBe(409);
  expect((await f.request(platform + '/' + first.id, { revision: 2, status: 'disabled' }, global, undefined, 'PATCH')).status).toBe(200);
  expect(await modern.next()).toMatchObject({ type: 'config', agent_cache: true, agents: [] });
  expect((await f.request(path + first.id, undefined, device.device_token)).status).toBe(404);
  expect((await f.request(path + other.id, undefined, device.device_token)).status).toBe(404);
  expect(await getConfig()).toMatchObject({ agent_releases: [{ id: first.id, available: false }] });
});

test.each(['anthropic', 'openai_chat', 'openai_responses'])('configuration scopes %s model routes and encrypts provider secrets to the registered device', async (protocol) => {
  const f = await fixture();
  const global = await f.login();
  const scoped = await f.select(global);
  await f.store.system.write((sql) => sql.run('INSERT INTO platform_admins VALUES (?)', [f.userId]));
  const providerResponse = await f.request('/platform/providers', { name: 'Fake', protocol,
    base_url: 'http://127.0.0.1:3333', secret: 'test-only-provider-key', proxy: 'none',
    ...(protocol === 'anthropic' && { auth: 'bearer' }) }, global);
  expect(providerResponse.status).toBe(201);
  const provider = await providerResponse.json() as { id: string };
  const modelResponse = await f.request('/platform/models', { provider_id: provider.id, upstream_name: 'fake-upstream',
    route_model: 'managed-*', display_name: 'Fake', context_window: 1024 }, global);
  expect(modelResponse.status).toBe(201);
  const model = await modelResponse.json() as { id: string };
  expect((await f.request('/platform/rates', { model_id: model.id, effective_from: new Date(f.now()).toISOString(),
    input_milli_per_mtok: 1, output_milli_per_mtok: 2, cache_read_milli_per_mtok: 0, cache_write_milli_per_mtok: 0 }, global)).status).toBe(201);
  const state = await issueFixtureContract(f, global, scoped, {
    ...standardEntitlements, allowed_agents: ['claude-code', 'codex'], allowed_models: [model.id],
  });
  const enabled = await f.request(configurationPath, { ...state, configuration: {} }, scoped, 'enable-model', 'PUT');
  expect(enabled.status).toBe(200);
  const enabledConfig = await enabled.json() as { revision: number; platform_revision: number };
  const effective = '/contract/effective?os=darwin&arch=arm64';
  expect((await f.request(effective, undefined, global)).status).toBe(403);
  const effectiveReply = await f.request(effective, undefined, scoped);
  expect(effectiveReply.status).toBe(200);
  const view = await effectiveReply.json();
  expect(view).toMatchObject({ models: [{ model_id: model.id, provider_id: provider.id, model: 'managed-*',
    protocol, rate: { input_milli_per_mtok: 1 } }] });
  expect(JSON.stringify(view)).not.toContain('test-only-provider-key');
  expect(JSON.stringify(view)).not.toContain('127.0.0.1');
  const keys = generateKeyPairSync('x25519');
  const raw = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const device = await (await f.request('/devices', { ...f.device, public_key: raw.toString('base64') }, scoped)).json() as DeviceReply;
  const legacy = connect(f, device.device_token);
  expect(await legacy.opened).toBe(true);
  legacy.hello();
  expect(await legacy.next()).toMatchObject({ type: 'welcome' });
  expect(await legacy.next()).toMatchObject({ type: 'cutoff', reason: 'contract' });
  expect(await legacy.next()).toMatchObject({ type: 'config', routes: [], rates: [], agents: [] });
  expect(await legacy.next()).toMatchObject({ type: 'cutoff', reason: 'contract' });
  legacy.send({ type: 'lease_request', id: 'legacy-try-again' });
  expect(await legacy.next()).toMatchObject({ type: 'cutoff', reason: 'contract', re: 'legacy-try-again' });
  legacy.ws.close();
  await legacy.closed;
  const edge = connect(f, device.device_token);
  expect(await edge.opened).toBe(true);
  edge.hello(undefined, 0, 0, true);
  expect(await edge.next()).toMatchObject({ type: 'welcome' });
  expect(await edge.next()).toMatchObject({ type: 'cutoff' });
  const config = await edge.next();
  expect(config).toMatchObject({ type: 'config', routes: [{ model: 'managed-*', model_id: model.id,
    provider_id: provider.id, protocol, upstream_model: 'fake-upstream', auth: 'bearer', proxy: 'none' }],
    rates: [{ model_id: model.id, input_milli_per_mtok: 1 }],
    capability_contract: { platform_revision: enabledConfig.platform_revision, tenant_revision: enabledConfig.revision } });
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
  secondary.hello(undefined, 0, 0, true);
  expect(await secondary.next()).toMatchObject({ type: 'welcome' });
  expect(await secondary.next()).toMatchObject({ type: 'cutoff' });
  expect(await secondary.next()).toMatchObject({ type: 'config', routes: [{ model: 'renamed' }] });
  secondary.send({ type: 'ping', id: 'no-secret' });
  expect(await secondary.next()).toEqual({ type: 'pong', re: 'no-secret' });
  const disabled = await f.request(configurationPath, { platform_revision: enabledConfig.platform_revision, revision: enabledConfig.revision,
    configuration: { allowed_models: [] } }, scoped, 'disable-model', 'PUT');
  expect(disabled.status).toBe(200);
  const removed = await edge.next();
  expect(removed).toMatchObject({ type: 'config', routes: [], rates: [],
    capability_contract: { platform_revision: enabledConfig.platform_revision, tenant_revision: enabledConfig.revision + 1 } });
  expect(removed.revision).toBeGreaterThan(changed.revision);
  edge.send({ type: 'ping', id: 'barrier' });
  expect(await edge.next()).toEqual({ type: 'pong', re: 'barrier' });
});

test('event and usage acknowledgments share a durable cursor, and observation is scoped and audited', async () => {
  const f = await fixture(15_000, Date.parse('2027-01-31T15:55:00.000Z'));
  const global = await f.login();
  const scoped = await f.select(global);
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
  const grants = { admin: { summary: true, content: true }, group_admin: { summary: true, content: false } };
  const state = await issueFixtureContract(f, global, scoped, { ...standardEntitlements, visibility: grants });
  expect((await f.request(configurationPath, { ...state, configuration: { visibility: grants } }, scoped, 'visibility', 'PUT')).status).toBe(200);
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

test('first signature settles legacy Edge leases and enforces the quota distribution switch', async () => {
  const f = await fixture();
  const global = await f.login();
  const owner = await f.select(global);
  await fund(f, global, 20_000);
  const created = await f.request('/groups', { name: 'Research', quota_milli: 250 }, owner);
  expect(created.status).toBe(201);
  const group = await created.json() as { id: string };
  const db = f.store.tenant(f.tenantId);
  await db.write(sql => sql.run('UPDATE members SET group_id = ? WHERE user_id = ?', [group.id, f.userId]));
  const oldEdge = await linkedEdge(f, owner);
  const lease = await oldEdge.nextOf('lease');
  expect(lease.budget_milli).toBe(250);
  await issueFixtureContract(f, global, owner, { ...standardEntitlements, quota_distribution: false });
  expect(await oldEdge.nextOf('cutoff')).toMatchObject({ reason: 'contract' });
  const settle = { type: 'lease_renew', id: 'settle-legacy', op_id: 'pre-signature', lease_id: lease.lease_id, used_milli: 100 };
  oldEdge.send(settle);
  expect(await oldEdge.next()).toMatchObject({ type: 'cutoff', reason: 'contract', settled_lease_id: lease.lease_id, re: settle.id });
  expect(db.get('SELECT status, used_milli FROM leases WHERE id = ?', [lease.lease_id])).toEqual({ status: 'settled', used_milli: 100 });
  expect((await f.request(`/groups/${group.id}`, { revision: 1, quota_milli: 500 }, owner, undefined, 'PATCH')).status).toBe(403);
  const usage = `/quota/usage?scope=group&id=${group.id}`;
  expect(await (await f.request(usage, undefined, owner)).json()).toMatchObject({
    quota_distribution: false, quota_milli: null, used_milli: 100, remaining_milli: null,
  });
  const path = `/platform/capability-contracts/${f.tenantId}`;
  const reopen = { revision: 1, tenant_revision: 1, template_id: 'fixture', template_version: 1,
    entitlements: { quota_distribution: true }, reason: 'Restore quota distribution' };
  expect((await f.request(path, reopen, global, 'restore-quota', 'PUT')).status).toBe(200);
  expect(await (await f.request(usage, undefined, owner)).json()).toMatchObject({
    quota_distribution: true, quota_milli: 250, used_milli: 100, remaining_milli: 150,
  });
});

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

// The snapshot and each statistics query start a separate DuckDB worker.
test('statistics exports scoped daily aggregates without conversation bodies', async () => {
  const f = await fixture(15_000, Date.parse('2027-01-31T16:30:00.000Z'));
  const owner = await f.select(await f.login());
  const invited = await f.request('/invites', { role: 'member', max_uses: 1, expires_in_ms: 60_000 }, owner);
  const { invite_code } = await invited.json() as { invite_code: string };
  const target = 'statistics-employee@example.test';
  const logged = await f.request('/auth/login', { target, code: await f.code(target), invite_code });
  const employeeAuth = await logged.json() as { token: string; user: { id: string } };
  const employee = await f.select(employeeAuth.token);
  const ownDevice = await (await f.request('/devices', f.device, owner)).json() as DeviceReply;
  const memberDevice = await (await f.request('/devices', f.device, employee)).json() as DeviceReply;
  await f.store.tenant(f.tenantId).write(sql => {
    const initial = '2027-01-31T15:59:59.999Z';
    const later = '2027-01-31T16:00:00.000Z';
    for (const [id, device, user, agent, at, cost] of [
      ['test-owned', ownDevice.device_id, f.userId, 'claude-code', initial, 7],
      ['test-employee', memberDevice.device_id, employeeAuth.user.id, 'kimi-code', later, 11],
    ] as const) {
      sql.run('INSERT INTO agent_sessions (id, device_id, user_id, agent, agent_version, started_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, device, user, agent, 'fixture', at]);
      sql.run(`INSERT INTO session_events (session_id, device_id, seq, kind, at, payload_json)
        VALUES (?, ?, 1, 'user_message', ?, ?), (?, ?, 3, 'user_message', ?, ?)`,
      [id, device, at, '{"content":"private message"}', id, device, at, '{"content":"unacknowledged"}']);
      sql.run('INSERT INTO ingest_cursors (device_id, ack_seq) VALUES (?, 2)', [device]);
      sql.run(`INSERT INTO usage (device_id, seq, request_id, session_id, model_id, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, cost_milli, status, at, complete, settlement_status)
        VALUES (?, 2, ?, ?, 'fake-model', 5, 3, 1, 0, ?, 'ok', ?, 1, 'reconciled')`, [device, id, id, cost, at]);
    }
  });
  const path = '/observe/statistics?from=2027-01-31&to=2027-02-01';
  expect(await (await f.request(path, undefined, owner)).json()).toMatchObject({
    totals: { active_people: 2, sessions: 2, events: 2, turns: 2, cost_milli: 18 },
    daily: [{ day: '2027-01-31', cost_milli: 7 }, { day: '2027-02-01', cost_milli: 11 }],
  });
  expect(await (await f.request(path, undefined, employee)).json()).toMatchObject({
    totals: { active_people: 1, sessions: 1, cost_milli: 11 },
    daily: [{ day: '2027-02-01', cost_milli: 11 }],
  });
  expect(await (await f.request(path + '&agent=claude-code', undefined, employee)).json()).toMatchObject({ totals: { cost_milli: 0 }, daily: [] });
  expect((await f.request('/observe/statistics?from=2027-02-30', undefined, owner)).status).toBe(422);
  const exportFile = await f.request('/observe/statistics/parquet?from=2027-01-31&to=2027-02-01', undefined, employee);
  expect(exportFile.status).toBe(200);
  const parquet = Buffer.from(await exportFile.arrayBuffer());
  expect(parquet.subarray(0, 4).toString()).toBe('PAR1');
  expect(parquet.toString().includes('private message')).toBe(false);
  expect(readdirSync(join(f.dataDir, 'statistics'))).toEqual([`${f.tenantId}.parquet`]);
  expect(f.store.tenant(f.tenantId).get("SELECT actor FROM audit WHERE action = 'observe.statistics.export'")).toEqual({ actor: employeeAuth.user.id });
}, 15_000);

test('complete desktop installers can be staged and verified without enabling an unqualified runtime', async () => {
  const f = await fixture();
  const global = await f.login();
  const tenant = await f.select(global);
  await f.store.system.write(sql => sql.run('INSERT INTO platform_admins VALUES (?)', [f.userId]));
  const diskImage = new Uint8Array(DESKTOP_AGENT_PART_BYTES + 512);
  diskImage.set(new TextEncoder().encode('koly'), DESKTOP_AGENT_PART_BYTES);
  const definition = { agent: 'workbuddy', version: 'fixture', os: 'darwin', arch: 'arm64',
    url: 'https://download.codebuddy.cn/workbuddy/saas/fixture.dmg',
    sha256: createHash('sha256').update(diskImage).digest('hex'), size: diskImage.length };
  const route = '/platform/agent-releases';
  const denied = await f.request(route, { ...definition, status: 'active' }, global);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toMatchObject({ error: { detail: { reason: 'desktop_qualification_required' } } });
  const stage = await f.request(route, { ...definition, status: 'disabled' }, global);
  expect(stage.status).toBe(201);
  const release = await stage.json() as { id: string; revision: number };
  expect(release).toMatchObject({ format: 'dmg', qualification_required: true, artifact_cached: false });
  const putPart = (part: number, body: Uint8Array<ArrayBuffer>, revision = release.revision) =>
    fetch(new URL(`/v1${route}/${release.id}/artifact?part=${part}&revision=${revision}`, f.server.url),
      { method: 'PUT', headers: { authorization: 'Bearer ' + global, 'content-type': 'application/octet-stream' }, body });
  const tail = diskImage.subarray(DESKTOP_AGENT_PART_BYTES);
  expect((await putPart(1, tail, release.revision + 1)).status).toBe(409);
  expect((await putPart(1, tail)).status).toBe(202);
  expect((await f.request('/agent-artifacts/' + definition.sha256, undefined, global)).status).toBe(404);
  expect((await putPart(0, diskImage.subarray(0, DESKTOP_AGENT_PART_BYTES))).status).toBe(200);
  expect(await (await putPart(1, tail)).json()).toMatchObject({ artifact_cached: true, sha256: definition.sha256 });
  const artifact = '/agent-artifacts/' + definition.sha256;
  const downloaded = await f.request(artifact, undefined, global);
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get('content-length')).toBe(String(diskImage.length));
  expect(createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex')).toBe(definition.sha256);
  expect((await f.request(artifact, undefined, tenant)).status).toBe(403);
  const state = await issueFixtureContract(f, global, tenant, { ...standardEntitlements, allowed_agents: ['claude-code', 'workbuddy'] });
  expect((await f.request(configurationPath, { ...state, configuration: { agent_release_ids: [release.id] } }, tenant, 'unqualified', 'PUT')).status).toBe(422);
  expect((await f.request(configurationPath, { ...state, configuration: {} }, tenant, 'enable-agent', 'PUT')).status).toBe(200);
  const view = await f.request('/contract/effective?os=darwin&arch=arm64', undefined, tenant);
  expect(await view.json()).toMatchObject({ agents: [
    { agent: 'claude-code', status: 'unavailable', releases: [] },
    { agent: 'workbuddy', status: 'unavailable', releases: [] },
  ] });
  const windows = await f.request('/contract/effective?os=win32&arch=x64', undefined, tenant);
  expect(await windows.json()).toMatchObject({ agents: [
    { agent: 'claude-code', status: 'unavailable', releases: [] },
    { agent: 'workbuddy', status: 'qualification_required', releases: [] },
  ] });
  expect((await f.request(route + '/' + release.id, { status: 'active', revision: release.revision }, global)).status).toBe(409);
});

test('policy v2 ties generic signing, exact recharge, profile revisions and device application together', async () => {
  const f = await fixture();
  const global = await f.login();
  const owner = await f.select(global);
  const platform = '/platform/policy';
  const contract = `${platform}/contracts/${f.tenantId}`;
  await f.store.system.write(sql => sql.run('INSERT INTO platform_admins (user_id) VALUES (?)', [f.userId]));
  const group = 'grp_00000000000000000000000001';
  const db = f.store.tenant(f.tenantId);
  await db.write(sql => {
    sql.run('INSERT INTO groups (id, name) VALUES (?, ?)', [group, 'Research']);
    sql.run('UPDATE members SET group_id = ? WHERE user_id = ?', [group, f.userId]);
  });
  // The issuer chooses a definition ID that no Web UI or Edge code knows.
  const entries = [
    { id: 'customer.signature-note', title: '签约备注', schema: { kind: 'text' }, merge: 'fixed',
      default_value: '基础服务', binding: null },
    { id: 'customer.seats', title: '签约席位', schema: { kind: 'integer', min: 0 }, merge: 'fixed',
      default_value: 20, binding: { adapter: 'seats.limit', abi: 1 } },
    { id: 'customer.device-balance', title: '单设备租约额度', schema: { kind: 'money_milli', min: 0 }, merge: 'min',
      default_value: 2125, binding: { adapter: 'lease.budget', abi: 1 } },
    { id: 'customer.route-set', title: '可用模型', schema: { kind: 'resource_set', catalog: 'models' }, merge: 'intersection',
      default_value: [], binding: { adapter: 'access.models', abi: 1 } },
  ];
  const modelId = 'model_fixture_a';
  const providerId = 'provider_fixture_a';
  const providerSecret = 'fixture-only-provider-key';
  const { encryptProviderSecret } = await import('../src/provider-secret');
  await f.store.system.write(sql => {
    sql.run(`INSERT INTO providers (id,name,protocol,base_url,secret_ciphertext,status)
      VALUES (?,?,'openai_chat','https://one.invalid/v1',?,'active')`,
    [providerId,'Fixture Provider',encryptProviderSecret(Buffer.alloc(32, 41), providerId, providerSecret)]);
    sql.run(`INSERT INTO models (id,provider_id,upstream_name,display_name,context_window,max_output_tokens,status)
      VALUES (?,?,'example-a','Fixture Model',262144,16384,'active')`, [modelId,providerId]);
    sql.run(`INSERT INTO rates (model_id,input_milli_per_mtok,output_milli_per_mtok,cache_read_milli_per_mtok,cache_write_milli_per_mtok,effective_from)
      VALUES (?,1,1,1,1,?)`, [modelId,iso(f.now())]);
  });
  function reference(id: string) { return { id, version: 1 }; }
  for (const entry of entries) {
    const definition = { ...entry, expected_version: 0, category: 'fixture',
      scopes: entry.merge === 'fixed' ? ['tenant'] : ['tenant','group','member'] };
    const response = await f.request(`${platform}/definitions`, definition, global, 'definition-' + entry.id);
    expect(await response.json()).toMatchObject({ id: entry.id, version: 1 });
    expect(response.status).toBe(201);
  }
  const template = reference('fixture-template');
  expect((await f.request(`${platform}/templates`, {
    id: template.id, expected_version: 0, scope: 'platform', name: 'Fixture template', description: '',
    entries: entries.map(definition => ({ clause_ref: reference(definition.id),
      value: definition.schema.kind === 'resource_set' ? [modelId] : definition.default_value })),
  }, global, 'template')).status).toBe(201);
  expect((await f.request(contract, undefined, owner)).status).toBe(403);
  expect(await (await f.request(contract, undefined, global)).json()).toMatchObject({ platform_revision: 0, policy_revision: 0 });
  const draft = { expected_policy_revision: 0, expected_platform_revision: 0, base_revision: null,
    reason: 'First signed fixture', entries: entries.map(definition => ({ clause_ref: reference(definition.id), template_ref: template })) };
  const preview = await f.request(contract + '/preview', draft, global);
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ platform_revision: 0, policy_revision: 0 });
  expect(db.all('SELECT revision FROM policy_signatures')).toEqual([]);
  const sign = await f.request(contract + '/signatures', draft, global, 'first-signature');
  const signed = await sign.json();
  expect(sign.status).toBe(201);
  expect(signed).toMatchObject({ revision: 1, current: true, platform_revision: 1, policy_revision: 1 });
  expect(await (await f.request(contract + '/signatures', draft, global, 'first-signature')).json()).toEqual(signed);

  const recharge = await f.request(contract + '/recharges', { amount_milli: 25_125, note: '内测登记' }, global, 'recharge');
  const receipt = await recharge.json() as { ledger_id: string };
  expect(recharge.status).toBe(201);
  expect(receipt).toMatchObject({ amount_milli: 25_125, platform_revision: 1, balance_before_milli: 0, balance_after_milli: 25_125 });
  expect(await (await f.request(contract + '/recharges', { amount_milli: 25_125, note: '内测登记' }, global, 'recharge')).json()).toEqual(receipt);
  expect(await (await f.request('/policy/recharges/' + receipt.ledger_id, undefined, owner)).json()).toEqual(receipt);
  expect((await f.request('/platform/ledger/topup', { tenant_id: f.tenantId, amount_milli: 1_000 }, global, 'obsolete-topup')).status).toBe(409);

  const token = await (await f.request('/devices', f.device, owner)).json() as DeviceReply;
  const edge = connect(f, token.device_token);
  expect(await edge.opened).toBe(true);
  edge.hello(undefined, 0, 0, true, true);
  expect(await edge.next()).toMatchObject({ type: 'welcome' });
  expect(await edge.nextOf('lease')).toMatchObject({ budget_milli: 2125 });
  const configuration = await edge.nextOf('config');
  expect(configuration).toMatchObject({ routes: [{ model_id: modelId }], rates: [{ model_id: modelId }],
    model_limits: { [modelId]: { context_window: 262_144, max_output_tokens: 16_384 } },
    policy: { abi: 1, tenant_id: f.tenantId, user_id: f.userId, device_id: token.device_id, policy_revision: 1,
      platform_revision: 1, tenant_revision: null, groups: [], member: null, secrets: [{ provider_id: providerId }],
      display: expect.arrayContaining([expect.objectContaining({ id: 'customer.device-balance', value: 2125 })]) } });
  expect(JSON.stringify(configuration)).not.toContain(providerSecret);
  expect(db.all('SELECT * FROM policy_device_applications')).toEqual([]);
  edge.send({ type: 'config_applied', id: 'unsent', config_revision: configuration.revision + 1, policy_revision: 1 });
  expect(await edge.next()).toMatchObject({ type: 'ack', re: 'unsent', ok: false });
  for (const fields of [{ projection_id: 'prj_fixture', result: 'rejected' }, { result: null }, { error: null }]) {
    edge.send({ type: 'config_applied', id: 'unnegotiated', config_revision: configuration.revision, policy_revision: 1, ...fields });
    expect(await edge.next()).toMatchObject({ type: 'ack', re: 'unnegotiated', ok: false, error: { code: 'unsupported_capability' } });
    expect(db.all('SELECT * FROM policy_device_applications')).toEqual([]);
  }
  edge.send({ type: 'config_applied', id: 'actual', config_revision: configuration.revision, policy_revision: 1 });
  expect(await edge.next()).toMatchObject({ type: 'ack', re: 'actual', ok: true });
  expect(await (await f.request('/devices/' + token.device_id, undefined, owner)).json()).toMatchObject({
    policy: { policy_revision: 1, applied: { config_revision: configuration.revision, policy_revision: 1 } },
  });

  const groupConfig = '/policy/configurations/group/' + group;
  const narrow = { expected_policy_revision: 1, expected_platform_revision: 1, template_ref: null,
    selections: [{ clause_ref: reference('customer.route-set'), value: [] }] };
  const updated = await f.request(groupConfig, narrow, owner, 'narrow', 'PUT');
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ scope: 'group', subject_id: group, policy_revision: 2 });
  expect((await f.request(groupConfig, narrow, owner, 'stale-narrow', 'PUT')).status).toBe(409);
  expect(await edge.nextOf('config')).toMatchObject({ routes: [], rates: [], model_limits: {}, policy: {
    policy_revision: 2, platform_revision: 1, groups: [{ id: group, revision: 1 }], secrets: [],
    notices: expect.arrayContaining([expect.objectContaining({ kind: 'policy_changed', policy_revision: 2 })]),
  } });
  expect(await (await f.request(contract + '/signatures/1', undefined, global)).json()).toMatchObject({
    revision: 1, entries: expect.arrayContaining([expect.objectContaining({
      clause_ref: reference('customer.route-set'), signed_value: [modelId],
    })]),
  });
  const descendants = Array.from({ length: 64 }, (_, i) => 'grp_' + String(i + 2).padStart(26, '0'));
  await db.write(sql => {
    let parent = group;
    for (const descendant of descendants) {
      sql.run('INSERT INTO groups (id, name, parent_id) VALUES (?, ?, ?)', [descendant, 'Nested group', parent]);
      sql.run(`INSERT INTO policy_configurations (scope, subject_id, revision, platform_revision, selections_json, revoked_json, retained_json, updated_by, updated_at)
        VALUES ('group', ?, 1, 1, '[]', '[]', '{}', ?, ?)`, [descendant, f.userId, iso(f.now())]);
      parent = descendant;
    }
    sql.run('UPDATE members SET group_id = ? WHERE user_id = ?', [parent, f.userId]);
  });
  expect((await f.request(groupConfig, { ...narrow, expected_policy_revision: 2 }, owner, 'nested-publish', 'PUT')).status).toBe(200);
  expect(await edge.nextOf('config')).toMatchObject({ routes: [], policy: {
    policy_revision: 3, groups: descendants.map(id => ({ id, revision: 1 })),
  } });
  const old = await linkedEdge(f, owner);
  expect(await old.nextOf('cutoff')).toMatchObject({ reason: 'contract' });
});

test('signed policy leases use the agreed cap and share wallet and quota remainders across devices', async () => {
  const f = await fixture();
  const global = await f.login();
  const owner = await f.select(global);
  const { encryptProviderSecret } = await import('../src/provider-secret');
  await f.store.system.write(sql => {
    sql.run('INSERT OR IGNORE INTO platform_admins VALUES (?)', [f.userId]);
    sql.run(`INSERT INTO providers (id,name,protocol,base_url,secret_ciphertext,status)
      VALUES ('provider_lease','Lease fixture','openai_chat','https://lease.invalid/v1',?,'active')`,
      [encryptProviderSecret(Buffer.alloc(32, 41), 'provider_lease', 'fixture-only-key')]);
    sql.run(`INSERT INTO models (id,provider_id,upstream_name,display_name,context_window,status)
      VALUES ('model_lease','provider_lease','model','Lease fixture',2048,'active')`);
  });
  const contract = `/platform/policy/contracts/${f.tenantId}`;
  const entry = (id: string, adjustment: number | string[]) => ({ clause_ref: { id, version: 1 }, template_ref: null, adjustment });
  async function sign(revision: number, budget: number, quota?: number) {
    const response = await f.request(contract + '/signatures', {
      expected_platform_revision: revision, expected_policy_revision: revision, base_revision: revision || null,
      reason: 'Fixture lease limits',
      entries: [entry('access.models', ['model_lease']), entry('lease.budget', budget),
        ...(quota === undefined ? [] : [entry('quota.monthly', quota)])],
    }, global, 'lease-sign-' + revision);
    expect(response.status).toBe(201);
  }
  async function open() {
    const registered = await f.request('/devices', f.device, owner);
    expect(registered.status).toBe(201);
    const { device_token } = await registered.json() as DeviceReply;
    const edge = connect(f, device_token);
    expect(await edge.opened).toBe(true);
    edge.hello(undefined, 0, 0, true, true);
    expect(await edge.next()).toMatchObject({ type: 'welcome' });
    return edge;
  }
  async function nextBalanceReply(edge: Awaited<ReturnType<typeof open>>) {
    let reply = await edge.next();
    while (reply.type === 'config' || reply.type === 'secret') reply = await edge.next();
    return reply;
  }
  const wallet = async () => (await f.request('/balance', undefined, owner)).json();

  await sign(0, 1000);
  expect((await f.request(contract + '/recharges', { amount_milli: 7533 }, global, 'lease-funds')).status).toBe(201);
  const first = await open();
  expect(await first.nextOf('lease')).toMatchObject({ budget_milli: 1000 });
  expect(await wallet()).toMatchObject({ balance_milli: 6533, reserved_milli: 1000 });

  await sign(1, 1000, 1500);
  const edges = await Promise.all([open(), open()]);
  const replies = await Promise.all(edges.map(nextBalanceReply));
  expect(replies).toContainEqual(expect.objectContaining({ type: 'lease', budget_milli: 500 }));
  expect(replies).toContainEqual(expect.objectContaining({ type: 'cutoff', reason: 'quota' }));
  expect(await wallet()).toMatchObject({ balance_milli: 6033, reserved_milli: 1500 });

  await sign(2, 8000);
  const blocked = edges[replies.findIndex(reply => reply.type === 'cutoff')]!;
  blocked.send({ type: 'lease_request', id: 'now-allowed', op_id: 'now-allowed' });
  expect(await nextBalanceReply(blocked)).toMatchObject({ type: 'lease', budget_milli: 6033 });
  expect(await wallet()).toMatchObject({ balance_milli: 0, reserved_milli: 7533 });
  expect(await nextBalanceReply(await open())).toMatchObject({ type: 'cutoff', reason: 'balance' });
});

test('platform stages Claude Desktop and Codex Desktop as separate unqualified Mac releases', async () => {
  const f = await fixture();
  const global = await f.login();
  const tenant = await f.select(global);
  await f.store.system.write(sql => sql.run('INSERT INTO platform_admins VALUES (?)', [f.userId]));
  const path = '/platform/agent-releases';
  const base = { version: 'fixture', os: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64), size: 582_617_625 };
  const entries = [
    { agent: 'claude-desktop', url: 'https://downloads.claude.ai/releases/darwin/universal/6.0.1/Claude-aabbcc.dmg' },
    { agent: 'codex-desktop', url: 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg' },
  ];
  for (const entry of entries) {
    const payload = { ...base, ...entry };
    const denied = await f.request(path, { ...payload, status: 'active' }, global);
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { detail: { reason: 'desktop_qualification_required' } } });
    const stage = await f.request(path, { ...payload, status: 'disabled' }, global);
    expect(stage.status).toBe(201);
    const release = await stage.json() as { id: string; revision: number; actions: string[] };
    expect(release).toMatchObject({ agent: entry.agent, format: 'dmg', status: 'disabled', qualification_required: true,
      artifact_cached: false, part_bytes: DESKTOP_AGENT_PART_BYTES });
    expect(release.actions).toContain('pull_artifact');
    expect(release.actions).not.toContain('activate');
    const pull = await f.request(path + '/' + release.id + '/pull', {}, tenant);
    expect(pull.status).toBe(403);
  }
  const cli = await f.request(path, { ...base, agent: 'codex', url: 'https://releases.openai.com/fixture', status: 'disabled' }, global);
  expect(cli.status).toBe(422);
  const tooLarge = await f.request(path, { ...base, ...entries[0], version: 'oversize', size: 768 * 1024 * 1024 + 1, status: 'disabled' }, global);
  expect(tooLarge.status).toBe(422);
});

test('signed release selections reach only compatible Apple Silicon Edges', async () => {
  const f = await fixture();
  const admin = await f.login();
  const tenant = await f.select(admin);
  await f.store.system.write(sql => sql.run('INSERT INTO platform_admins VALUES (?)', [f.userId]));
  const path = '/platform/agent-releases';
  const mac = { os: 'darwin', arch: 'arm64' };
  const candidate = { ...mac, agent: 'codex-desktop', version: '26.1117.41037', size: 582_617_625,
    sha256: '67d362df03de37ebd794a64608abf98a2b0b1be2783d33a950abdd83ed89b279',
    url: 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg' };
  const existing = { ...mac, agent: 'deepseek-desktop', version: '0.2.1-rc.3', size: 264_791_658,
    sha256: '0c2217c2c9110d0b5104af8eb4df55f214239405d079d0a83e30080ce1cbd1e1',
    url: 'https://download.deepseek.com/dsh-desk/fixture.dmg' };
  const claude = { ...mac, agent: 'claude-desktop', version: '6.28899.6', size: 402_202_476,
    sha256: 'a1226d5e7072a713f7eab74d06d1745fc47aa57eae3ba202a103032d1329530f',
    url: 'https://downloads.claude.ai/releases/darwin/universal/6.28899.6/Claude-2f5fc59b2d1c672dd9dced86720c50f48cca0cf9.dmg' };
  const runtime = { size: 124_237_798, sha256: '4262a1273231dc7d7ada7914750fa9b5c724548cff6b2ae4a8d49ce55ac2456f' };
  const registerClaude = await f.request(path, { ...claude, status: 'disabled' }, admin);
  expect(registerClaude.status).toBe(201);
  const claudeStage = await registerClaude.json() as { id: string; revision: number };
  expect(claudeStage).toMatchObject({ runtime: { ...runtime, artifact_cached: false }, qualification_required: false,
    actions: expect.arrayContaining(['upload_runtime']) });
  const claudePath = path + '/' + claudeStage.id;
  const runtimePath = claudePath + '/runtime';
  const edgeRuntimePath = '/edge/agent-artifacts/' + claudeStage.id + '/runtime';
  const activateClaude = () => f.request(claudePath, { revision: claudeStage.revision, status: 'active' }, admin);
  expect((await f.request(runtimePath, undefined, admin)).status).toBe(404);
  expect((await f.request(runtimePath, undefined, tenant)).status).toBe(403);
  const putRuntime = (token: string, revision: number) => fetch(new URL('/v1' + runtimePath + '?revision=' + revision, f.server.url),
    { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream' }, body: 'truncated' });
  expect((await putRuntime(tenant, claudeStage.revision)).status).toBe(403);
  expect((await putRuntime(admin, claudeStage.revision + 1)).status).toBe(409);
  expect((await putRuntime(admin, claudeStage.revision)).status).toBe(422);
  const wrongDigest = await f.request(path, { ...candidate, sha256: 'a'.repeat(64), status: 'active' }, admin);
  expect(wrongDigest.status).toBe(409);
  expect(await wrongDigest.json()).toMatchObject({ error: { detail: { reason: 'desktop_qualification_required' } } });
  const registration = await f.request(path, { ...candidate, status: 'disabled' }, admin);
  expect(registration.status).toBe(201);
  const staged = await registration.json() as { id: string; revision: number };
  expect(staged).toMatchObject({ artifact_cached: false, qualification_required: false });
  const activate = () => f.request(path + '/' + staged.id, { revision: staged.revision, status: 'active' }, admin);
  const uncached = await activate();
  expect(uncached.status).toBe(409);
  expect(await uncached.json()).toMatchObject({ error: { detail: { reason: 'artifact_unavailable' } } });
  // Represent completed cache entries without allocating or uploading a vendor installer in the test.
  const cache = join(f.dataDir, 'agent-artifacts');
  mkdirSync(cache, { recursive: true });
  for (const release of [candidate, existing, claude]) {
    const file = join(cache, release.sha256);
    writeFileSync(file, '');
    truncateSync(file, release.size);
  }
  expect((await activate()).status).toBe(200);
  const missingRuntime = await activateClaude();
  expect(missingRuntime.status).toBe(409);
  expect(await missingRuntime.json()).toMatchObject({ error: { detail: { reason: 'artifact_unavailable' } } });
  const engine = join(cache, runtime.sha256);
  writeFileSync(engine, '');
  truncateSync(engine, runtime.size);
  expect((await activateClaude()).status).toBe(200);
  const adminRuntime = await f.request(runtimePath, undefined, admin);
  expect(adminRuntime.status).toBe(200);
  expect(adminRuntime.headers.get('content-length')).toBe(String(runtime.size));
  await adminRuntime.body!.cancel();
  const baseRelease = await f.request(path, { ...existing, status: 'active' }, admin);
  expect(baseRelease.status).toBe(201);
  const baseId = (await baseRelease.json() as {id:string}).id;
  const toolPath = '/platform/tool-releases';
  const toolDraft = await f.request(toolPath, { name: 'desktop-skill', version: '1.0.0', kind: 'skill',
    agents: ['claude-code', 'deepseek-desktop', 'codex-desktop', 'claude-desktop'], delivery: 'system' }, admin);
  expect(toolDraft.status).toBe(201);
  const toolId = (await toolDraft.json() as { id: string }).id;
  const toolUpload = await fetch(new URL(`/v1${toolPath}/${toolId}/artifact?revision=1`, f.server.url), {
    method: 'PUT', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ path: 'SKILL.md', data: Buffer.from('---\nname: desktop-skill\ndescription: Test\n---\n').toString('base64') }] }),
  });
  expect(toolUpload.status).toBe(200);
  expect((await f.request(`${toolPath}/${toolId}/publish`, { revision: 2 }, admin)).status).toBe(200);
  const device = await (await f.request('/devices', f.device, tenant)).json() as DeviceReply;
  expect((await f.request(edgeRuntimePath, undefined, device.device_token)).status).toBe(404);
  expect((await f.request(edgeRuntimePath)).status).toBe(401);
  const signaturePath = '/platform/policy/contracts/' + f.tenantId + '/signatures';
  function signReleases(revision: number, releases: string[]) {
    const values = { 'seats.limit': 2, 'lease.budget': 2000,
      'access.agents': ['claude-code', 'deepseek-desktop', 'codex-desktop', 'claude-desktop'], 'access.releases': releases,
      'access.tools': [toolId] };
    return f.request(signaturePath, {expected_policy_revision: revision, expected_platform_revision: revision,
      base_revision: revision || null, reason: 'Signed desktop eligibility',
      entries: Object.entries(values).map(([id, adjustment]) => ({clause_ref: {id, version: 1}, template_ref: null, adjustment}))},
    admin, 'desktop-grant-' + revision);
  }
  expect((await signReleases(0, [baseId, staged.id, claudeStage.id])).status).toBe(201);
  const authorized = await f.request(edgeRuntimePath, undefined, device.device_token);
  expect(authorized.status).toBe(200);
  expect(authorized.headers.get('content-length')).toBe(String(runtime.size));
  await authorized.body!.cancel();
  const runtimeTail = await fetch(new URL('/v1' + edgeRuntimePath, f.server.url), {
    headers: { authorization: 'Bearer ' + device.device_token, range: 'bytes=-7', 'if-range': '"' + runtime.sha256 + '"' },
  });
  expect(runtimeTail.status).toBe(206);
  expect(runtimeTail.headers.get('content-range')).toBe(`bytes ${runtime.size - 7}-${runtime.size - 1}/${runtime.size}`);
  expect((await runtimeTail.arrayBuffer()).byteLength).toBe(7);
  const effective = await f.request('/policy/targets/' + f.userId + '?os=darwin&arch=arm64', undefined, tenant);
  expect(effective.status).toBe(200);
  expect((await effective.json() as {releases: {id: string}[]}).releases.map(row => row.id).sort())
    .toEqual([baseId, staged.id, claudeStage.id].sort());
  for (const { features, expected, toolAgents } of [
    { features: { agent_cache: true, mac_desktop_v1: true }, expected: ['deepseek-desktop'] },
    { features: { agent_cache: true, windows_deepseek_desktop_v1: true }, expected: [] },
    { features: { agent_cache: true, codex_desktop_v1: true }, expected: [] },
    { features: { agent_cache: true, mac_desktop_v1: true, codex_desktop_v1: true }, expected: ['codex-desktop', 'deepseek-desktop'] },
    { features: { agent_cache: true, mac_desktop_v1: true, claude_desktop_v1: true }, expected: ['claude-desktop', 'deepseek-desktop'] },
    { features: { agent_cache: true, mac_desktop_v1: true, codex_desktop_v1: true, claude_desktop_v1: true },
      expected: ['claude-desktop', 'codex-desktop', 'deepseek-desktop'] },
    { features: { agent_cache: true, mac_desktop_v1: true, tooth_v1: true,
      desktop_tool_targets: { 'deepseek-desktop': ['skill'], 'codex-desktop': ['skill'], 'claude-desktop': ['skill'] } },
      expected: ['deepseek-desktop'], toolAgents: ['claude-code', 'deepseek-desktop'] },
    { features: { agent_cache: true, mac_desktop_v1: true, codex_desktop_v1: true, claude_desktop_v1: true, tooth_v1: true,
      desktop_tool_targets: { 'deepseek-desktop': ['skill'], 'codex-desktop': ['mcp'], 'claude-desktop': ['skill'] } },
      expected: ['claude-desktop', 'codex-desktop', 'deepseek-desktop'], toolAgents: ['claude-code', 'deepseek-desktop', 'claude-desktop'] },
  ]) {
    const edge = connect(f, device.device_token);
    expect(await edge.opened).toBe(true);
    edge.send({ type: 'hello', id: 'desktop-hello', edge_version: '0.1.0', ...mac,
      config_revision: 0, outbox_last_seq: 0, capability_policy_v2: true, policy_runtime_v1: true, ...features });
    await edge.nextOf('welcome');
    await edge.nextOf('cutoff');
    const config = await edge.nextOf('config');
    expect(config.agents.map((row: { agent: string }) => row.agent).sort()).toEqual(expected);
    expect(config.tools).toMatchObject([{ id: toolId, delivery: 'system', agents: toolAgents ?? ['claude-code'] }]);
    edge.ws.close();
    await edge.closed;
  }
  expect((await signReleases(1, [baseId, staged.id])).status).toBe(201);
  expect((await f.request(edgeRuntimePath, undefined, device.device_token)).status).toBe(404);
});

test('the qualified DeepSeek NSIS release reaches only authorized Windows x64 Edges', async () => {
  const f = await fixture();
  const admin = await f.login();
  const tenant = await f.select(admin);
  await f.store.system.write(sql => sql.run('INSERT INTO platform_admins VALUES (?)', [f.userId]));
  const windows = { os: 'win32', arch: 'x64' };
  const candidate = { ...windows, agent: 'deepseek-desktop', version: '0.2.1-rc.3', size: 289_415_960,
    sha256: '1e3876baaa20c3f26371dba7b6873bb70c3ef9b91403f6d3f87d2b27d4fd1e3a',
    url: 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.1-rc.3-win-x64.exe' };
  const releasePath = '/platform/agent-releases';
  const wrongDigest = await f.request(releasePath, { ...candidate, sha256: 'a'.repeat(64), status: 'active' }, admin);
  expect(wrongDigest.status).toBe(409);
  expect(await wrongDigest.json()).toMatchObject({ error: { detail: { reason: 'desktop_qualification_required' } } });

  const registration = await f.request(releasePath, { ...candidate, status: 'disabled' }, admin);
  expect(registration.status).toBe(201);
  const staged = await registration.json() as { id: string; revision: number };
  expect(staged).toMatchObject({ format: 'nsis', artifact_cached: false, qualification_required: false });
  const activate = () => f.request(releasePath + '/' + staged.id, { revision: staged.revision, status: 'active' }, admin);
  const uncached = await activate();
  expect(uncached.status).toBe(409);
  expect(await uncached.json()).toMatchObject({ error: { detail: { reason: 'artifact_unavailable' } } });
  const cache = join(f.dataDir, 'agent-artifacts');
  mkdirSync(cache, { recursive: true });
  // Model a completed cache entry. The vendor installer is not needed to verify download authorization.
  const file = join(cache, candidate.sha256);
  writeFileSync(file, '');
  truncateSync(file, candidate.size);
  expect((await activate()).status).toBe(200);

  const winRegistration = await f.request('/devices', { ...f.device, ...windows, name: 'Windows' }, tenant);
  expect(winRegistration.status).toBe(201);
  const winDevice = await winRegistration.json() as DeviceReply;
  const macRegistration = await f.request('/devices', f.device, tenant);
  expect(macRegistration.status).toBe(201);
  const macDevice = await macRegistration.json() as DeviceReply;
  const downloadPath = '/edge/agent-artifacts/' + staged.id;
  expect((await f.request(downloadPath)).status).toBe(401);
  expect((await f.request(downloadPath, undefined, winDevice.device_token)).status).toBe(404);

  const signaturePath = '/platform/policy/contracts/' + f.tenantId + '/signatures';
  function signGrant(revision: number, releases?: string[]) {
    const values = { 'seats.limit': 2, 'lease.budget': 2000, 'access.agents': ['deepseek-desktop'],
      ...(releases && { 'access.releases': releases }) };
    return f.request(signaturePath, { expected_policy_revision: revision, expected_platform_revision: revision,
      base_revision: revision || null, reason: 'Windows DeepSeek eligibility',
      entries: Object.entries(values).map(([id, adjustment]) => ({ clause_ref: { id, version: 1 }, template_ref: null, adjustment })) },
    admin, 'windows-deepseek-grant-' + revision);
  }
  expect((await signGrant(0)).status).toBe(201);
  expect((await f.request(downloadPath, undefined, macDevice.device_token)).status).toBe(404);
  for (const { features, allowed } of [
    { features: { agent_cache: true }, allowed: false },
    { features: { mac_desktop_v1: true, agent_cache: true }, allowed: false },
    { features: { windows_deepseek_desktop_v1: true }, allowed: false },
    { features: { windows_deepseek_desktop_v1: true, agent_cache: true }, allowed: true },
  ]) {
    const edge = connect(f, winDevice.device_token);
    expect(await edge.opened).toBe(true);
    edge.send({ type: 'hello', id: 'windows-hello', edge_version: '0.1.0', ...windows,
      config_revision: 0, outbox_last_seq: 0, capability_policy_v2: true, policy_runtime_v1: true, ...features });
    await edge.nextOf('welcome');
    await edge.nextOf('cutoff');
    const config = await edge.nextOf('config');
    expect(config.agents).toEqual(allowed ? [{ ...candidate, id: staged.id, url: '/v1' + downloadPath }] : []);
    edge.ws.close();
    await edge.closed;
  }

  const etag = '"' + candidate.sha256 + '"';
  const resume = () => fetch(new URL('/v1' + downloadPath, f.server.url), {
    headers: { authorization: 'Bearer ' + winDevice.device_token, range: 'bytes=5-11', 'if-range': etag },
  });
  const authorized = await resume();
  expect(authorized.status).toBe(206);
  expect(authorized.headers.get('content-range')).toBe(`bytes 5-11/${candidate.size}`);
  expect(authorized.headers.get('content-disposition')).toBe('attachment; filename="onex-agent.exe"');
  expect(authorized.headers.get('etag')).toBe(etag);
  expect((await authorized.arrayBuffer()).byteLength).toBe(7);
  expect((await signGrant(1, [])).status).toBe(201);
  expect((await resume()).status).toBe(404);
});
