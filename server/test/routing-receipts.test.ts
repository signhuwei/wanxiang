import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../../tests/fixtures/routing/p0-ab.json';
import { MemoryPresence } from '../src/presence';
import type { RoutingProjectionInputs } from '../src/route-projection';
import { openRouteSecret, routeProjectionDigest } from '../src/route-secret';
import { createServer } from '../src/server';
import { clock } from './routing-fixture';
import { devicePrivate, fixturePlaintext, followGrant, seedProjection } from './routing-projection-fixture';

const clean: (() => unknown)[] = [];
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); });

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for WebSocket state');
    await Bun.sleep(5);
  }
}

/** Real Server with injected isolated routing inputs; restartable on the same data directory. */
async function wsSetup() {
  const at = clock;
  const dir = mkdtempSync(join(tmpdir(), 'onex-projection-ws-'));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  let inputs: RoutingProjectionInputs | undefined;
  const delegate: RoutingProjectionInputs = {
    grants: tenant => inputs?.grants(tenant) ?? [],
    credentialRef: (id, revision) => inputs!.credentialRef(id, revision),
    credentialMaterial: (id, version) => inputs!.credentialMaterial(id, version),
    selectRoutePool: (tenant, device) => inputs?.selectRoutePool(tenant, device) ?? false,
    projectionId: () => inputs!.projectionId!(),
  };
  const start = () => createServer({ dataDir: dir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 2, heartbeatMs: 15_000, commit: 'test',
    codeSecret: 'test-only-secret', now: () => at, presence: new MemoryPresence(), routingProjection: delegate });
  let service = await start();
  let closed = false;
  clean.push(() => closed ? undefined : service.close());
  const seeded = await seedProjection(service.store, dir, () => at);
  inputs = seeded.inputs;
  const sockets: WebSocket[] = [];
  function connect(device: 'dev_lin' | 'dev_fix') {
    const ws = new WebSocket(`ws://${service.server.hostname}:${service.server.port}/v1/edge/ws`, {
      headers: { Authorization: `Bearer ${seeded.tokens[device]}`, 'OneX-Edge-Version': '0.1.0', 'OneX-Protocol': '0' } });
    sockets.push(ws);
    const queue: any[] = [];
    ws.onmessage = event => queue.push(JSON.parse(String(event.data)));
    const opened = new Promise<void>(resolve => { ws.onopen = () => resolve(); });
    const send = (message: unknown) => ws.send(JSON.stringify(message));
    async function next() { await until(() => queue.length > 0); return queue.shift(); }
    async function nextOf(type: string) {
      for (;;) { const message = await next(); if (message.type === type) return message; }
    }
    async function quiet(ms = 80) { await Bun.sleep(ms); return queue.splice(0); }
    async function hello(extra: Record<string, unknown> = { capabilities: ['route_pool.v1'] }, configRevision = 0) {
      await opened;
      send({ type: 'hello', id: 'h1', edge_version: '0.1.0', os: 'darwin', arch: 'arm64', config_revision: configRevision, outbox_last_seq: 0,
        lease_id: null, capability_policy_v2: true, policy_runtime_v1: true, agent_cache: true, ...extra });
      return nextOf('welcome');
    }
    async function request(message: Record<string, unknown>) { send(message); return nextOf('ack'); }
    return { ws, send, next, nextOf, quiet, hello, request, close: () => ws.close() };
  }
  const http = (path: string, token = seeded.platform) => fetch(new URL(`/v1/platform${path}`, service.server.url), {
    headers: { authorization: `Bearer ${token}` } }).then(async response => ({ status: response.status, body: await response.json() as any }));
  async function restart() {
    for (const ws of sockets.splice(0)) ws.close();
    await service.close();
    service = await start();
  }
  return { ...seeded, connect, http, restart, service: () => service, live: () => service.store.tenant(seeded.tenantId),
    stop: async () => { closed = true; await service.close(); } };
}

const open = (f: { tenantId: string }, config: any, device = 'dev_lin') => config.route_pool.secrets.map((envelope: any) =>
  openRouteSecret(devicePrivate, { tenant_id: f.tenantId, device_id: device, projection_id: config.route_pool.projection_id, revision: config.revision },
    envelope).toString());
const applied = (id: string, revision = 91, projection = 'prj_91') => ({ type: 'config_applied', id, config_revision: revision, policy_revision: 1,
  projection_id: projection, result: 'applied' });
const rejected = (id: string, revision: number, projection: string) => ({ ...fixture.wire.config_applied_rejected, id, config_revision: revision,
  policy_revision: 1, projection_id: projection });

test('isolated session sends the persisted target, confirms only exact receipts, and resends the same identity after restart', async () => {
  const f = await wsSetup();
  expect(await f.service().projection!.runRollout('rol_v7')).toBe('done');
  let edge = f.connect('dev_lin');
  expect(await edge.hello()).toMatchObject({ device_id: 'dev_lin', tenant_id: f.tenantId, capabilities: ['route_pool.v1'] });
  const config = await edge.next();
  expect(config).toMatchObject({ type: 'config', revision: 91, policy: { abi: 2, device_id: 'dev_lin', secrets: [] },
    route_pool: { projection_id: 'prj_91', signature_id: 'sig_1' } });
  expect(config.id).toMatch(/^msg_/);
  expect(config.rates[0].input_multiplier_ppm).toBe(4000000);
  expect(open(f, config)).toEqual([fixturePlaintext['cred_a@1'], fixturePlaintext['cred_b@2']]);
  // No handshake lease, no legacy config or secret frames.
  expect((await edge.quiet()).map(frame => frame.type)).toEqual([]);
  await until(() => !!f.db.get<{ sent: number }>("SELECT sent_at IS NOT NULL AS sent FROM routing_config_deliveries WHERE config_revision = 91")!.sent);
  expect(f.db.get("SELECT sent_at IS NOT NULL AS sent, retry_count, applied_at FROM routing_config_deliveries WHERE config_revision = 91"))
    .toEqual({ sent: 1, retry_count: 0, applied_at: null });
  let ledger = await f.http('/model-pool-rollouts/rol_v7/targets');
  expect(ledger.body.items).toEqual([{ tenant_id: f.tenantId, user_id: f.userId, device_id: 'dev_lin', target_config_revision: 91,
    applied_config_revision: null, state: 'pending', reason: 'awaiting_receipt', last_seen_at: expect.any(String), last_receipt_at: null, actions: [] }]);

  for (const type of ['lease_request', 'lease_renew']) {
    expect(await edge.request({ type, id: type, lease_id: 'lse_x', used_milli: 0 }))
      .toMatchObject({ re: type, ok: false, error: { code: 'forbidden', detail: { reason: 'route_pool_lease_pending' } } });
  }
  // Incomplete or extended new-protocol receipts are refused, never degraded to a legacy confirmation.
  const { projection_id: _p, ...incomplete } = applied('bad1');
  expect(await edge.request(incomplete)).toMatchObject({ re: 'bad1', ok: false, error: { code: 'invalid' } });
  expect(await edge.request({ ...applied('bad2'), extra: true })).toMatchObject({ re: 'bad2', ok: false, error: { code: 'invalid' } });
  expect(await edge.request({ ...applied('bad3'), error: { code: 'x', detail: { reason: 'x' } } })).toMatchObject({ ok: false, error: { code: 'invalid' } });
  // Wrong projection, unknown revision, another device's identity and a wrong policy revision never advance the head.
  await f.service().projection!.runRollout('rol_v6');
  for (const [frame, reason] of [[applied('x1', 91, 'prj_92'), 'projection_mismatch'], [applied('x2', 99), 'unknown_target'],
    [applied('x3', 92, 'prj_92'), 'unknown_target'], [{ ...applied('x4'), policy_revision: 7 }, 'policy_revision_mismatch']] as const) {
    expect(await edge.request(frame)).toMatchObject({ ok: false, error: { code: 'conflict', detail: { reason } } });
  }
  expect(f.db.get("SELECT count(*) AS n FROM policy_device_applications WHERE device_id = 'dev_lin'")).toEqual({ n: 0 });

  expect(await edge.request(applied('ca91'))).toEqual({ type: 'ack', re: 'ca91', ok: true });
  expect(f.db.get("SELECT config_revision, policy_revision, projection_id FROM policy_device_applications WHERE device_id = 'dev_lin'"))
    .toEqual({ config_revision: 91, policy_revision: 1, projection_id: 'prj_91' });
  expect((await edge.quiet()).map(frame => frame.type)).toEqual([]);
  expect(await edge.request(applied('ca91'))).toEqual({ type: 'ack', re: 'ca91', ok: true });
  expect(await edge.request(rejected('ca91', 91, 'prj_91'))).toMatchObject({ ok: false, error: { code: 'conflict', detail: { reason: 'receipt_changed' } } });
  // A late rejection with its own stable id is kept in history but never overrides the confirmed success.
  expect(await edge.request(rejected('ca91_reject', 91, 'prj_91'))).toEqual({ type: 'ack', re: 'ca91_reject', ok: true });
  expect(f.db.get("SELECT applied_at IS NOT NULL AS applied, rejected_at FROM routing_config_deliveries WHERE device_id = 'dev_lin'"))
    .toEqual({ applied: 1, rejected_at: null });
  expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM routing_config_receipts WHERE device_id = 'dev_lin'")!.n).toBe(2);
  ledger = await f.http('/model-pool-rollouts/rol_v7/targets');
  expect(ledger.body.items[0]).toMatchObject({ state: 'applied', reason: null, applied_config_revision: 91, last_receipt_at: expect.any(String) });

  // Restart: the persisted target is resealed and resent with the same identity, even though it was applied.
  await f.restart();
  edge = f.connect('dev_lin');
  await edge.hello({ capabilities: ['route_pool.v1'] }, 91);
  const resent = await edge.next();
  expect([resent.revision, resent.route_pool.projection_id]).toEqual([91, 'prj_91']);
  expect(resent.id).not.toBe(config.id);
  expect(resent.route_pool.secrets.map((s: any) => s.nonce)).not.toEqual(config.route_pool.secrets.map((s: any) => s.nonce));
  expect(routeProjectionDigest(resent)).toBe(routeProjectionDigest(config));
  expect(open(f, resent)).toEqual(open(f, config));
  await until(() => f.live().get<{ retry_count: number }>("SELECT retry_count FROM routing_config_deliveries WHERE device_id = 'dev_lin'")!.retry_count === 1);
  // The persisted success receipt id replays after restart.
  expect(await edge.request(applied('ca91'))).toEqual({ type: 'ack', re: 'ca91', ok: true });
  expect(f.live().get("SELECT config_revision FROM policy_device_applications WHERE device_id = 'dev_lin'")).toEqual({ config_revision: 91 });
});

test('a device rejection is kept on the target, folds to rejected and leaves the applied head untouched', async () => {
  const f = await wsSetup();
  await f.service().projection!.runRollout('rol_v6');
  const edge = f.connect('dev_fix');
  await edge.hello();
  const config = await edge.next();
  expect([config.revision, config.routes.map((route: any) => route.deployment_id)]).toEqual([91, ['dep_a']]);
  expect(await edge.request(rejected('rj91', 91, 'prj_91'))).toEqual({ type: 'ack', re: 'rj91', ok: true });
  expect(f.db.get("SELECT count(*) AS n FROM policy_device_applications")).toEqual({ n: 0 });
  expect(f.db.get<{ error_code: string; error_reason: string }>("SELECT error_code, error_reason FROM routing_config_receipts WHERE receipt_id = 'rj91'"))
    .toEqual({ error_code: 'missing_route_credential', error_reason: 'missing_envelope' });
  const row = await f.http('/model-pool-rollouts/rol_v6/targets?state=rejected');
  expect(row.body).toMatchObject({ total: 1, items: [{ device_id: 'dev_fix', state: 'rejected', reason: 'missing_envelope', applied_config_revision: null }] });
  // A later success with another id still applies; the rejection never blocks a legal success.
  expect(await edge.request(applied('ok91', 91, 'prj_91'))).toEqual({ type: 'ack', re: 'ok91', ok: true });
  expect((await f.http('/model-pool-rollouts/rol_v6/targets?state=applied')).body.total).toBe(1);
  // Lower legal receipts are confirmed but never move the head back.
  await f.service().projection!.project(f.tenantId, 'dev_fix', clock + 11 * 60_000).catch(() => null);
  expect(f.db.get("SELECT config_revision FROM policy_device_applications WHERE device_id = 'dev_fix'")).toEqual({ config_revision: 91 });
});

test('a registered device without the capability is gated: needs_upgrade, cutoff, and no legacy lease or config', async () => {
  const f = await wsSetup();
  await f.service().projection!.runRollout('rol_v7');
  const edge = f.connect('dev_lin');
  const welcome = await edge.hello({});
  expect(welcome).not.toHaveProperty('capabilities');
  const frames = await edge.quiet(150);
  expect(frames).toEqual([{ type: 'ack', re: 'h1', ok: false, error: expect.objectContaining({ code: 'unsupported_capability' }) },
    { type: 'cutoff', id: expect.any(String), reason: 'contract' }]);
  for (const type of ['lease_request', 'lease_renew', 'config_applied']) {
    expect(await edge.request({ ...applied(type), type, lease_id: 'lse_x', used_milli: 0 }))
      .toMatchObject({ re: type, ok: false, error: { code: 'unsupported_capability' } });
  }
  expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM leases")!.n).toBe(0);
  const ledger = await f.http('/model-pool-rollouts/rol_v7');
  expect(ledger.body).toMatchObject({ total: 1, job_status: 'done', counts: { needs_upgrade: 1, pending: 0, applied: 0 } });
  expect((await f.http('/model-pool-rollouts/rol_v7/targets')).body.items[0]).toMatchObject({ state: 'needs_upgrade', reason: 'unsupported_capability' });
});

test('devices not registered for the isolated stage keep the legacy handshake even when they declare route_pool.v1', async () => {
  const f = await wsSetup();
  f.setSelection(() => false);
  const edge = f.connect('dev_lin');
  const welcome = await edge.hello();
  expect(welcome).not.toHaveProperty('capabilities');
  const frames = await edge.quiet(200);
  expect(frames.some(frame => frame.type === 'lease')).toBe(true);
  const config = frames.find(frame => frame.type === 'config');
  expect(config).toBeDefined();
  expect(config).not.toHaveProperty('route_pool');
  expect(f.db.get<{ n: number }>('SELECT count(*) AS n FROM routing_config_snapshots')!.n).toBe(0);
  // The legacy session refuses new-protocol receipt fields.
  expect(await edge.request(applied('legacy'))).toMatchObject({ ok: false, error: { code: 'unsupported_capability' } });
});

test('connect sends the current authorized projection, a newer target is pushed at once, and the ledger is platform-only and cursor-bound', async () => {
  const f = await wsSetup();
  const edge = f.connect('dev_lin');
  await edge.hello();
  // Reconnecting devices receive their current authorized projection; a later job with the same basis reuses it.
  const first = await edge.nextOf('config');
  expect([first.revision, first.route_pool.projection_id]).toEqual([91, 'prj_91']);
  await f.service().projection!.runRollout('rol_v7');
  expect((await f.http('/model-pool-rollouts/rol_v7/targets')).body.items[0]).toMatchObject({ target_config_revision: 91, state: 'pending' });
  expect(await edge.quiet()).toEqual([]);
  // A changed grant persists a higher target that the online session receives without reconnecting.
  f.setGrants([{ ...followGrant, user_ids: [f.userId], pool: { mode: 'pinned', pool_revision: 6 } }]);
  await f.service().projection!.project(f.tenantId, 'dev_lin');
  const pushed = await edge.nextOf('config');
  expect([pushed.revision, pushed.route_pool.projection_id, pushed.routes.length]).toEqual([92, 'prj_92', 1]);
  f.setGrants([{ ...followGrant, user_ids: [f.userId] }, { ...followGrant, binding_id: 'bnd_codex_m_fixed', pool: { mode: 'pinned', pool_revision: 6 }, user_ids: [f.pinnedUser] }]);
  await f.service().projection!.runRollout('rol_v6');


  const detail = await f.http('/model-pool-rollouts/rol_v6');
  expect(detail).toEqual({ status: 200, body: { rollout_id: 'rol_v6', model_id: 'mdl_m', pool_revision: 6, job_status: 'done', total: 2,
    counts: { pending: 0, applied: 0, rejected: 0, offline: 1, needs_upgrade: 0, superseded: 1 }, actions: ['read'] } });
  const page = await f.http('/model-pool-rollouts/rol_v6/targets?limit=1');
  expect(page.body).toMatchObject({ total: 2, items: [{ device_id: 'dev_fix', state: 'offline', reason: 'device_offline', target_config_revision: 93 }] });
  const second = await f.http(`/model-pool-rollouts/rol_v6/targets?limit=1&cursor=${page.body.next_cursor}`);
  expect(second.body).toMatchObject({ next_cursor: null, items: [{ device_id: 'dev_lin', state: 'superseded', reason: 'pool_superseded', target_config_revision: null }] });
  expect((await f.http(`/model-pool-rollouts/rol_v6/targets?limit=1&state=offline&cursor=${page.body.next_cursor}`)).status).toBe(422);
  expect((await f.http(`/model-pool-rollouts/rol_v7/targets?limit=1&cursor=${page.body.next_cursor}`)).status).toBe(422);
  expect((await f.http('/model-pool-rollouts/rol_v6/targets?state=offline')).body).toMatchObject({ total: 1 });
  expect((await f.http('/model-pool-rollouts/rol_v6/targets?state=sent')).status).toBe(422);
  expect((await f.http('/model-pool-rollouts/rol_missing')).status).toBe(404);
  expect((await f.http('/model-pool-rollouts/rol_v6', 'not-a-session')).status).toBe(401);
  expect(JSON.stringify((await f.http('/model-pool-rollouts/rol_v6/targets')).body)).not.toMatch(/cred_|secret|base_url/);
});
