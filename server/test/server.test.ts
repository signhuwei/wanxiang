import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server';
import { seedTenant } from '../src/seed';
import { MemoryPresence } from '../src/presence';
import { hash } from '../src/credentials';

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
    codeSecret: 'test-only-secret', deliverCode: (target, code) => { codes.set(target, code); },
    now: () => time, presence,
  });
  clean.push(() => service.close());
  const owner = 'owner@example.test';
  const seeded = await seedTenant(service.store, { target: owner, seats: 2, maxUses: 3, now: time });
  function request(path: string, body?: Record<string, unknown>, token?: string, key?: string) {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (key) headers.set('idempotency-key', key);
    if (body) headers.set('content-type', 'application/json');
    return fetch(new URL(`/v1${path}`, service.server.url), {
      method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
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
  expect(Object.keys(spec.paths).sort()).toEqual(['/v1/auth/code', '/v1/auth/login', '/v1/auth/logout', '/v1/auth/select-tenant', '/v1/devices', '/v1/edge/ws', '/v1/healthz', '/v1/me', '/v1/openapi.json'].sort());
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
  for (let i = 0; i < 5; i++) expect((await f.request('/auth/login', { target: f.owner, code: wrong })).status).toBe(401);
  expect((await f.request('/auth/login', { target: f.owner, code })).status).toBe(401);
  f.advance(60_000);
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
  function hello() { send({ type: 'hello', id: 'edge-hello', edge_version: version, os: 'darwin', arch: 'arm64', config_revision: 0, outbox_last_seq: 0 }); }
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
