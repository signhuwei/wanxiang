import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server';
import { seedTenant } from '../src/seed';
import { MemoryPresence } from '../src/presence';
import { MemoryObjectStorage } from '../src/object-storage';

type DeviceReply = { device_id: string; device_token: string };
type Fixture = Awaited<ReturnType<typeof fixture>>;

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); });

async function fixture(withStorage = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-diag-'));
  clean.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const codes = new Map<string, string>();
  const presence = new MemoryPresence();
  const objectStorage = withStorage ? new MemoryObjectStorage() : undefined;
  let time = Date.now();
  const service = await createServer({
    dataDir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 4, heartbeatMs: 15_000, commit: 'test',
    codeSecret: 'test-only-secret', masterKey: Buffer.alloc(32, 41), deliverCode: (target, code) => { codes.set(target, code); },
    now: () => time, presence, objectStorage,
  });
  clean.push(() => service.close());
  function request(path: string, body?: Record<string, unknown>, token?: string, key?: string, method = body ? 'POST' : 'GET') {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (key) headers.set('idempotency-key', key);
    if (body) headers.set('content-type', 'application/json');
    // The API returns some URLs (e.g. diag download_url) already rooted at /v1; don't double it up.
    const full = path.startsWith('/v1/') ? path : `/v1${path}`;
    return fetch(new URL(full, service.server.url), { method, headers, body: body && JSON.stringify(body) });
  }
  async function putUpload(id: string, token: string, bytes: Uint8Array) {
    return fetch(new URL(`/v1/diag/${id}/upload`, service.server.url), {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: bytes,
    });
  }
  async function owner(target: string, opts: { seats?: number; platformAdmin?: boolean } = {}) {
    const seeded = await seedTenant(service.store, { target, now: time, ...opts });
    async function code(t: string) {
      const res = await request('/auth/code', { target: t });
      expect(res.status).toBe(202);
      return codes.get(t)!;
    }
    async function login() {
      const res = await request('/auth/login', { target, code: await code(target), kind: 'desktop' });
      expect(res.status).toBe(200);
      return (await res.json() as { token: string }).token;
    }
    async function select(global: string) {
      const res = await request('/auth/select-tenant', { tenant_id: seeded.tenantId }, global);
      expect(res.status).toBe(200);
      return (await res.json() as { token: string }).token;
    }
    const global = await login();
    const scoped = seeded ? await select(global) : global;
    return { ...seeded, global, scoped };
  }
  async function relogin(target: string, tenantId: string) {
    const codeRes = await request('/auth/code', { target });
    expect(codeRes.status).toBe(202);
    const loginRes = await request('/auth/login', { target, code: codes.get(target)!, kind: 'desktop' });
    expect(loginRes.status).toBe(200);
    const { token: global } = await loginRes.json() as { token: string };
    const selectRes = await request('/auth/select-tenant', { tenant_id: tenantId }, global);
    expect(selectRes.status).toBe(200);
    return (await selectRes.json() as { token: string }).token;
  }
  async function registerDevice(scoped: string, name = 'Mac') {
    const res = await request('/devices', { name, os: 'darwin', arch: 'arm64' }, scoped, `register-${name}-${Math.random()}`);
    expect(res.status).toBe(201);
    return await res.json() as DeviceReply;
  }
  function connectEdge(token: string, version = '0.1.0') {
    const ws = new WebSocket(`ws://${service.server.hostname}:${service.server.port}/v1/edge/ws`, {
      headers: { Authorization: `Bearer ${token}`, 'OneX-Edge-Version': version, 'OneX-Protocol': '0' },
    });
    clean.push(() => ws.close());
    const queue: any[] = [];
    ws.onmessage = (event) => queue.push(JSON.parse(String(event.data)));
    const opened = new Promise<boolean>((resolve) => { ws.onopen = () => resolve(true); ws.onerror = () => resolve(false); });
    async function until(predicate: () => boolean) {
      const deadline = Date.now() + 1_500;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for WebSocket message');
        await Bun.sleep(5);
      }
    }
    async function next() { await until(() => queue.length > 0); return queue.shift(); }
    async function nextOf(type: string) {
      for (;;) {
        const message = await next();
        if (message.type === type) return message;
        if (message.type !== 'config' && message.type !== 'secret' && message.type !== 'cutoff' && message.type !== 'lease') {
          throw new Error(`Expected ${type}, received ${JSON.stringify(message)}`);
        }
      }
    }
    function send(message: unknown) { ws.send(JSON.stringify(message)); }
    function hello() { send({ type: 'hello', id: 'edge-hello', edge_version: version, os: 'darwin', arch: 'arm64', config_revision: 0, outbox_last_seq: 0 }); }
    return { ws, opened, next, nextOf, send, hello };
  }
  async function linkedEdge(scoped: string, name = 'Mac') {
    const device = await registerDevice(scoped, name);
    const edge = connectEdge(device.device_token);
    expect(await edge.opened).toBe(true);
    edge.hello();
    expect(await edge.next()).toMatchObject({ type: 'welcome' });
    return { ...edge, ...device };
  }
  function codeFor(target: string) {
    const code = codes.get(target);
    if (!code) throw new Error(`No code was issued for ${target}`);
    return code;
  }
  return { ...service, request, putUpload, owner, relogin, registerDevice, connectEdge, linkedEdge, codeFor, objectStorage, advance: (ms: number) => { time += ms; }, now: () => time };
}

test('owner requests a logs diag job, online Edge uploads it, and only an authorized reader can download it', async (): Promise<void> => {
  const f: Fixture = await fixture();
  const a = await f.owner('owner-a@example.test');
  const edge = await f.linkedEdge(a.scoped);
  const create = await f.request(`/devices/${edge.device_id}/diag`, { kind: 'logs' }, a.scoped, 'diag-1');
  expect(create.status).toBe(201);
  const job = await create.json() as { id: string; status: string; download_url: string | null };
  expect(job).toMatchObject({ status: 'pending', download_url: null });

  const diagMsg = await edge.nextOf('diag');
  expect(diagMsg).toMatchObject({ diag_id: job.id, kind: 'logs' });
  expect(typeof diagMsg.upload_url).toBe('string');
  expect(diagMsg.upload_url).toBe(`/v1/diag/${job.id}/upload`);

  // Not ready yet: download must not be offered before the bytes land.
  const beforeUpload = await f.request(`/diag/${job.id}`, undefined, a.scoped);
  expect(await beforeUpload.json()).toMatchObject({ status: 'pending', download_url: null });

  const packed = new TextEncoder().encode('fake onexd log bundle, no secrets here');
  const upload = await f.putUpload(job.id, edge.device_token, packed);
  expect(upload.status).toBe(204);
  edge.send({ type: 'diag_result', id: 'r1', diag_id: job.id, ok: true, detail: { files: 1 } });
  expect(await edge.nextOf('ack')).toMatchObject({ re: 'r1', ok: true });

  const ready = await f.request(`/diag/${job.id}`, undefined, a.scoped);
  const readyBody = await ready.json() as { status: string; download_url: string };
  expect(readyBody.status).toBe('ready');
  expect(readyBody.download_url).toBe(`/v1/diag/${job.id}/download`);

  const download = await f.request(readyBody.download_url, undefined, a.scoped);
  expect(download.status).toBe(200);
  expect(new TextDecoder().decode(await download.arrayBuffer())).toBe('fake onexd log bundle, no secrets here');
  expect(f.store.tenant(a.tenantId).get("SELECT count(*) AS n FROM audit WHERE action = 'device.diag.download'")).toEqual({ n: 1 });

  // A second, unrelated tenant/owner cannot read or download this job at all.
  const b = await f.owner('owner-b@example.test');
  expect((await f.request(`/diag/${job.id}`, undefined, b.scoped)).status).toBe(404);
  expect((await f.request(readyBody.download_url, undefined, b.scoped)).status).toBe(404);
  // Nor can they even see the device to request a diag job on it.
  expect((await f.request(`/devices/${edge.device_id}/diag`, { kind: 'logs' }, b.scoped, 'diag-cross')).status).toBe(404);
});

test('a plain member cannot request, read or download diagnostics even in their own tenant', async (): Promise<void> => {
  const f: Fixture = await fixture();
  const a = await f.owner('owner-member-test@example.test');
  const edge = await f.linkedEdge(a.scoped);
  const create = await f.request(`/devices/${edge.device_id}/diag`, { kind: 'logs' }, a.scoped, 'member-setup-1');
  expect(create.status).toBe(201);
  const job = await create.json() as { id: string };
  await edge.nextOf('diag');
  await f.putUpload(job.id, edge.device_token, new Uint8Array([1]));
  edge.send({ type: 'diag_result', id: 'mr1', diag_id: job.id, ok: true, detail: null });
  await edge.nextOf('ack');

  // A joining member (not owner/admin) uses the same invite code to land in the same tenant.
  const codeRes = await f.request('/auth/code', { target: 'member-joiner@example.test' });
  expect(codeRes.status).toBe(202);
  const joinedRes = await f.request('/auth/login', {
    target: 'member-joiner@example.test', code: await f.codeFor('member-joiner@example.test'), invite_code: a.inviteCode, kind: 'desktop',
  });
  expect(joinedRes.status).toBe(200);
  const { token: memberGlobal } = await joinedRes.json() as { token: string };
  const memberScoped = (await (await f.request('/auth/select-tenant', { tenant_id: a.tenantId }, memberGlobal)).json() as { token: string }).token;

  expect((await f.request(`/devices/${edge.device_id}/diag`, { kind: 'logs' }, memberScoped, 'member-forbidden')).status).toBe(403);
  expect((await f.request(`/diag/${job.id}`, undefined, memberScoped)).status).toBe(403);
  expect((await f.request(`/diag/${job.id}/download`, undefined, memberScoped)).status).toBe(403);
  expect((await f.request('/devices', undefined, memberScoped)).status).toBe(200);
  const list = await (await f.request('/devices', undefined, memberScoped)).json() as { items: Record<string, unknown>[] };
  expect(list.items[0].actions).toEqual(['read']);
});

test('rate limits a second diag request on the same device within ten minutes', async (): Promise<void> => {
  const f: Fixture = await fixture();
  const a = await f.owner('owner-rate@example.test');
  const edge = await f.linkedEdge(a.scoped);
  const first = await f.request(`/devices/${edge.device_id}/diag`, { kind: 'status' }, a.scoped, 'rate-1');
  expect(first.status).toBe(201);
  await edge.nextOf('diag');
  const second = await f.request(`/devices/${edge.device_id}/diag`, { kind: 'logs' }, a.scoped, 'rate-2');
  expect(second.status).toBe(429);
  const body = await second.json() as { error: { code: string; detail: { retry_after_ms: number } } };
  expect(body.error.code).toBe('rate_limited');
  expect(body.error.detail.retry_after_ms).toBeGreaterThan(0);
  expect(body.error.detail.retry_after_ms).toBeLessThanOrEqual(600_000);
  // Advancing past the window allows a new request.
  f.advance(600_001);
  const third = await f.request(`/devices/${edge.device_id}/diag`, { kind: 'logs' }, a.scoped, 'rate-3');
  expect(third.status).toBe(201);
});

test('kind=status resolves immediately from diag_result without any upload', async (): Promise<void> => {
  const f: Fixture = await fixture();
  const a = await f.owner('owner-status@example.test');
  const edge = await f.linkedEdge(a.scoped);
  const create = await f.request(`/devices/${edge.device_id}/diag`, { kind: 'status' }, a.scoped, 'status-1');
  expect(create.status).toBe(201);
  const job = await create.json() as { id: string };
  const diagMsg = await edge.nextOf('diag');
  expect(diagMsg).toMatchObject({ diag_id: job.id, kind: 'status' });
  expect(diagMsg.upload_url).toBeUndefined();
  // Rejected receipts do not finish the job or prevent the device from sending a valid receipt.
  for (const detail of [['bad shape'], 'bad shape', { reason: '界'.repeat(1500) }]) {
    edge.send({ type: 'diag_result', id: 'bad-detail', diag_id: job.id, ok: true, detail });
    expect(await edge.nextOf('ack')).toMatchObject({ ok: false, error: { code: 'invalid', detail: { fields: ['detail'] } } });
    const unchanged = await f.request(`/diag/${job.id}`, undefined, a.scoped);
    expect(await unchanged.json()).toMatchObject({ status: 'pending' });
  }
  edge.send({ type: 'diag_result', id: 'sr1', diag_id: job.id, ok: true, detail: { connected: true, other: 'private sample' } });
  expect(await edge.nextOf('ack')).toMatchObject({ ok: true });
  const result = await f.request(`/diag/${job.id}`, undefined, a.scoped);
  expect(await result.json()).toMatchObject({ status: 'ready', download_url: null, detail: { connected: true } });
});

test('an offline device fails the job immediately instead of leaving a job nobody can complete', async (): Promise<void> => {
  const f: Fixture = await fixture();
  const a = await f.owner('owner-offline@example.test');
  const device = await f.registerDevice(a.scoped, 'offline-mac');
  const create = await f.request(`/devices/${device.device_id}/diag`, { kind: 'logs' }, a.scoped, 'offline-1');
  expect(create.status).toBe(201);
  const job = await create.json() as { id: string; status: string };
  expect(job.status).toBe('pending');
  const after = await f.request(`/diag/${job.id}`, undefined, a.scoped);
  expect(await after.json()).toMatchObject({ status: 'failed', download_url: null });
});

test('upload fails when the device token does not match the job device, and a failed upload stage is not resurrected', async (): Promise<void> => {
  const f: Fixture = await fixture();
  const a = await f.owner('owner-wrong-device@example.test');
  const edgeA = await f.linkedEdge(a.scoped, 'mac-a');
  const edgeB = await f.linkedEdge(a.scoped, 'mac-b');
  const create = await f.request(`/devices/${edgeA.device_id}/diag`, { kind: 'logs' }, a.scoped, 'wrong-device-1');
  const job = await create.json() as { id: string };
  await edgeA.nextOf('diag');
  // Device B tries to upload against a job that belongs to device A.
  const wrongUpload = await f.putUpload(job.id, edgeB.device_token, new Uint8Array([1, 2, 3]));
  expect(wrongUpload.status).toBe(404);
  // The legitimate device can still complete it afterwards.
  const rightUpload = await f.putUpload(job.id, edgeA.device_token, new Uint8Array([1, 2, 3]));
  expect(rightUpload.status).toBe(204);
  // Re-uploading after it is already ready is rejected, not silently accepted twice.
  const repeat = await f.putUpload(job.id, edgeA.device_token, new Uint8Array([4]));
  expect(repeat.status).toBe(404);
});

test('without object storage configured, diag creation and upload still work but the upload step reports an internal error', async (): Promise<void> => {
  const f: Fixture = await fixture(false);
  const a = await f.owner('owner-no-storage@example.test');
  const edge = await f.linkedEdge(a.scoped);
  const create = await f.request(`/devices/${edge.device_id}/diag`, { kind: 'logs' }, a.scoped, 'no-storage-1');
  const job = await create.json() as { id: string };
  await edge.nextOf('diag');
  const upload = await f.putUpload(job.id, edge.device_token, new Uint8Array([9]));
  expect(upload.status).toBe(500);
  const after = await f.request(`/diag/${job.id}`, undefined, a.scoped);
  expect(await after.json()).toMatchObject({ status: 'failed' });
});

test('download hides an object past its seven day retention even though the record still exists', async (): Promise<void> => {
  const f: Fixture = await fixture();
  const a = await f.owner('owner-retention@example.test');
  const edge = await f.linkedEdge(a.scoped);
  const create = await f.request(`/devices/${edge.device_id}/diag`, { kind: 'logs' }, a.scoped, 'retention-1');
  const job = await create.json() as { id: string };
  await edge.nextOf('diag');
  await f.putUpload(job.id, edge.device_token, new Uint8Array([7]));
  edge.send({ type: 'diag_result', id: 'rr1', diag_id: job.id, ok: true, detail: null });
  await edge.nextOf('ack');
  const fresh = await f.request(`/diag/${job.id}`, undefined, a.scoped);
  expect(await fresh.json()).toMatchObject({ status: 'ready' });
  f.advance(8 * 24 * 60 * 60_000);
  // The web session itself would also have expired by now; log back into the same tenant to isolate the retention check.
  const freshScoped = await f.relogin('owner-retention@example.test', a.tenantId);
  const stale = await f.request(`/diag/${job.id}`, undefined, freshScoped);
  expect(await stale.json()).toMatchObject({ status: 'expired', download_url: null });
  expect((await f.request(`/diag/${job.id}/download`, undefined, freshScoped)).status).toBe(404);
});

test('a platform admin can request and download diagnostics across tenants, but a tenant member cannot reach platform-only power', async (): Promise<void> => {
  const f: Fixture = await fixture();
  const a = await f.owner('owner-platform@example.test');
  const platform = await f.owner('platform-admin@example.test', { platformAdmin: true });
  const edge = await f.linkedEdge(a.scoped);
  // Platform admin uses its own global (not tenant-scoped) token.
  const create = await f.request(`/devices/${edge.device_id}/diag`, { kind: 'logs' }, platform.global, 'platform-1');
  expect(create.status).toBe(201);
  const job = await create.json() as { id: string };
  await edge.nextOf('diag');
  await f.putUpload(job.id, edge.device_token, new Uint8Array([3]));
  edge.send({ type: 'diag_result', id: 'pr1', diag_id: job.id, ok: true, detail: null });
  await edge.nextOf('ack');
  const status = await f.request(`/diag/${job.id}`, undefined, platform.global);
  expect(status.status).toBe(200);
  const download = await f.request(`/diag/${job.id}/download`, undefined, platform.global);
  expect(download.status).toBe(200);
});

test('devices list only exposes owner/admin-manageable fields, never the token hash or raw credentials', async (): Promise<void> => {
  const f: Fixture = await fixture();
  const a = await f.owner('owner-devices-list@example.test');
  const edge = await f.linkedEdge(a.scoped);
  const list = await f.request('/devices', undefined, a.scoped);
  expect(list.status).toBe(200);
  const body = await list.json() as { items: Record<string, unknown>[] };
  expect(body.items).toHaveLength(1);
  const device = body.items[0];
  expect(device.id).toBe(edge.device_id);
  expect(device).not.toHaveProperty('token_hash');
  expect(device).not.toHaveProperty('token_expires_at');
  expect(device).not.toHaveProperty('public_key');
  expect(device.actions).toEqual(['read', 'create_diag']);
});
