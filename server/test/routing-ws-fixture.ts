import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../../tests/fixtures/routing/p0-ab.json';
import { MemoryPresence } from '../src/presence';
import type { RoutingProjectionInputs } from '../src/route-projection';
import { openRouteSecret } from '../src/route-secret';
import { createServer } from '../src/server';
import { clock } from './routing-fixture';
import { devicePrivate, seedProjection } from './routing-projection-fixture';

export async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for WebSocket state');
    await Bun.sleep(5);
  }
}

/** Real Server with injected isolated routing inputs; restartable on the same data directory. */
export async function wsSetup(clean: (() => unknown)[], options: { leaseGate?: boolean } = {}) {
  let at = clock;
  let leaseGate = options.leaseGate ?? false;
  const dir = mkdtempSync(join(tmpdir(), 'onex-projection-ws-'));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  let inputs: RoutingProjectionInputs | undefined;
  const delegate: RoutingProjectionInputs = {
    grants: tenant => inputs?.grants(tenant) ?? [],
    credentialRef: (id, revision) => inputs!.credentialRef(id, revision),
    credentialMaterial: (id, version) => inputs!.credentialMaterial(id, version),
    selectRoutePool: (tenant, device) => inputs?.selectRoutePool(tenant, device) ?? false,
    revocationRevision: (tenant, device) => inputs?.revocationRevision?.(tenant, device) ?? 0,
    projectionId: () => inputs!.projectionId!(),
    get leaseGate() { return leaseGate; },
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
    const connection = connectDeviceSocket(`ws://${service.server.hostname}:${service.server.port}/v1/edge/ws`, seeded.tokens[device]);
    sockets.push(connection.ws);
    return connection;
  }
  const http = (path: string, token = seeded.platform) => fetch(new URL(`/v1/platform${path}`, service.server.url), {
    headers: { authorization: `Bearer ${token}` } }).then(async response => ({ status: response.status, body: await response.json() as any }));
  async function restart() {
    for (const ws of sockets.splice(0)) ws.close();
    await service.close();
    service = await start();
  }
  return { ...seeded, connect, http, restart, service: () => service, live: () => service.store.tenant(seeded.tenantId),
    setClock: (value: number) => { at = value; }, setLeaseGate: (value: boolean) => { leaseGate = value; },
    stop: async () => { closed = true; await service.close(); } };
}

export function connectDeviceSocket(url: string, token: string) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, 'OneX-Edge-Version': '0.1.0', 'OneX-Protocol': '0' } });
  const queue: any[] = [];
  ws.onmessage = event => queue.push(JSON.parse(String(event.data)));
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket handshake failed'));
  });
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  async function next() { await until(() => queue.length > 0); return queue.shift(); }
  async function nextOf(type: string) {
    for (;;) { const message = await next(); if (message.type === type) return message; }
  }
  async function reply(re: string) {
    for (;;) { const message = await next(); if (message.re === re) return message; }
  }
  async function quiet(ms = 80) { await Bun.sleep(ms); return queue.splice(0); }
  async function hello(extra: Record<string, unknown> = { capabilities: ['route_pool.v1'] }, configRevision = 0) {
    await opened;
    send({ type: 'hello', id: 'h1', edge_version: '0.1.0', os: 'darwin', arch: 'arm64', config_revision: configRevision, outbox_last_seq: 0,
      lease_id: null, capability_policy_v2: true, policy_runtime_v1: true, agent_cache: true, ...extra });
    return nextOf('welcome');
  }
  async function request(message: Record<string, unknown>) { send(message); return nextOf('ack'); }
  async function call(message: Record<string, unknown> & { id: string }) { send(message); return reply(message.id); }
  return { ws, send, next, nextOf, reply, quiet, hello, request, call, close: () => ws.close() };
}

export const open = (f: { tenantId: string }, config: any, device = 'dev_lin') => config.route_pool.secrets.map((envelope: any) =>
  openRouteSecret(devicePrivate, { tenant_id: f.tenantId, device_id: device, projection_id: config.route_pool.projection_id, revision: config.revision },
    envelope).toString());
export const applied = (id: string, revision = 91, projection = 'prj_91') => ({ type: 'config_applied', id, config_revision: revision, policy_revision: 1,
  projection_id: projection, result: 'applied' });
export const rejected = (id: string, revision: number, projection: string) => ({ ...fixture.wire.config_applied_rejected, id, config_revision: revision,
  policy_revision: 1, projection_id: projection });
