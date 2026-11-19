import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server';
import { seedTenant } from '../src/seed';
import { MemoryPresence } from '../src/presence';
import { hash } from '../src/credentials';
import { decryptProviderSecret } from '../src/provider-secret';

type DeviceReply = { device_id: string; device_token: string };

const clean: (() => void)[] = [];
afterEach(() => { for (const dispose of clean.splice(0).reverse()) dispose(); });

async function fixture(heartbeatMs = 15_000) {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-server-'));
  clean.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const codes = new Map<string, string>();
  const presence = new MemoryPresence();
  let time = Date.now();
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
    expect((await request('/auth/code', { target })).status).toBe(202);
    return codes.get(target)!;
  }
  async function login(target = owner) {
    const response = await request('/auth/login', { target, code: await code(target), kind: 'desktop' });
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

test('health, OpenAPI, one-use codes, tenant selection and logout', async () => {
  const f = await fixture();
  expect(await (await f.request('/healthz')).json()).toMatchObject({ status: 'ok', commit: 'test' });
  const spec = await (await f.request('/openapi.json')).json() as { paths: object };
  expect(Object.keys(spec.paths)).toContain('/v1/auth/login');
  expect(Object.keys(spec.paths)).toContain('/v1/platform/providers');
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
    actions: ['create_member', 'create_group', 'create_invite', 'update_contract'],
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
  expect(await (await f.request('/contract', set, scoped, undefined, 'PUT')).json()).toMatchObject({ ...set, revision: 2 });
  expect((await f.request('/contract', set, scoped, undefined, 'PUT')).status).toBe(409);
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
  function hello(leaseId?: string, outboxLastSeq = 0) { send({ type: 'hello', id: 'edge-hello', edge_version: version, os: 'darwin', arch: 'arm64', config_revision: 0, outbox_last_seq: outboxLastSeq, lease_id: leaseId }); }
  return { ws, opened, closed, next, send, hello };
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
  expect(await current.next()).toEqual({ type: 'pong', re: 'client-ping' });
  const ping = await current.next();
  expect(ping.type).toBe('ping');
  current.send({ type: 'pong', re: ping.id });
  for (let i = 0; i < 3; i++) expect((await current.next()).type).toBe('ping');
  expect((await current.closed).code).toBe(1008);
  await until(async () => await f.presence.get(device_id) === null);
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
  expect(await a.next()).toMatchObject({ type: 'cutoff', reason: 'balance', re: 'renew-a' });
  expect(await a.next()).toMatchObject({ type: 'cutoff', reason: 'balance', re: 'renew-a-retry' });
  expect(await b.next()).toMatchObject({ type: 'cutoff', reason: 'balance' });
  const balance = await f.request('/balance', undefined, scoped);
  expect(await balance.json()).toMatchObject({ balance_milli: 0, reserved_milli: 0, month_used_milli: 2 });
  expect(f.store.tenant(f.tenantId).get("SELECT count(*) AS n FROM ledger WHERE kind = 'settle'")).toEqual({ n: 2 });
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
  expect(await b.next()).toMatchObject({ type: 'lease', seq: 2 });
  const usage = { request_id: 'req_1', lease_id: lease.lease_id, session_id: null, provider_id: 'prv_fake', model: 'fake',
    input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, at: new Date(f.now()).toISOString(), status: 'ok' };
  b.send({ type: 'usage', id: 'offline-batch', batch: [{ ...usage, seq: 1, complete: true, cost_milli: 3 },
    { ...usage, request_id: 'req_2', seq: 2, complete: false, cost_milli: 2 }] });
  expect(await b.next()).toMatchObject({ type: 'events_ack', ack_seq: 2 });
  const rows = f.store.tenant(f.tenantId).all('SELECT cost_milli, settlement_status FROM usage ORDER BY seq');
  expect(rows).toEqual([{ cost_milli: 3, settlement_status: 'reconciled' }, { cost_milli: 2, settlement_status: 'pending' }]);
  expect(await (await f.request('/balance', undefined, scoped)).json()).toMatchObject({ month_used_milli: 3 });
});
