// Temporary isolated Server for route_pool.v1 joint checks with onexd (contracts/routing-projection.md).
// Synthetic data only: A/B supply, a real 4× signature, device key 0x07 × 32 and fixture inference material.
// Never point it at production data, keys or hosts.
//
//   bun --no-env-file tests/e2e/routing/projection-server.ts [--port 18790] [--data-dir DIR] [--unregistered dev_fix] [--now ISO] [--lease-gate]
//
// Prints one JSON line with URLs, device tokens and keys, then serves until SIGINT/SIGTERM.
// Restart check: stop it and start again with the same --data-dir; persisted targets are resealed and resent.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryPresence } from '../../../server/src/presence';
import type { RouteGrant, RoutingProjectionInputs } from '../../../server/src/route-projection';
import { x25519PublicKey } from '../../../server/src/route-secret';
import { createServer } from '../../../server/src/server';
import { clock } from '../../../server/test/routing-fixture';
import { devicePrivate, fixturePlaintext, fixtureRefs, followGrant, seedProjection } from '../../../server/test/routing-projection-fixture';

const argv = Bun.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const given = arg('--data-dir');
const dir = given ?? mkdtempSync(join(tmpdir(), 'onex-projection-joint-'));
const unregistered = new Set((arg('--unregistered') ?? '').split(',').filter(Boolean));
// --now ISO moves the fixed Server clock; use it only when restarting an already seeded --data-dir
// (for example 2026-11-22T02:11:00Z shows lapsed unapplied targets as target_expired).
const nowArg = arg('--now');
const leaseGate = argv.includes('--lease-gate');
const serverNow = nowArg ? Date.parse(nowArg) : clock;
if (!Number.isFinite(serverNow)) throw new Error('--now must be an ISO timestamp');
const statePath = join(dir, 'projection-fixture.json');
type State = { tenant_id: string; user_id: string; pinned_user: string; platform: string; tokens: Record<string, string> };
let state: State | null = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;

const grants = (s: State): RouteGrant[] => [{ ...followGrant, user_ids: [s.user_id] },
  { ...followGrant, binding_id: 'bnd_codex_m_fixed', pool: { mode: 'pinned', pool_revision: 6 }, user_ids: [s.pinned_user] }];
let seededInputs: RoutingProjectionInputs | undefined;
const inputs: RoutingProjectionInputs = {
  grants: tenant => seededInputs ? seededInputs.grants(tenant) : state ? grants(state) : [],
  credentialRef: (id, revision) => fixtureRefs[`${id}@${revision}`] ?? null,
  credentialMaterial: (id, version) => {
    const value = fixturePlaintext[`${id}@${version}`];
    return value ? { purpose: 'inference', material_class: 'inference', plaintext: Buffer.from(value) } : null;
  },
  selectRoutePool: (_tenant, device) => !unregistered.has(device),
  // First run reproduces prj_91 / prj_92; restarts use generated ids so a regenerated target never collides.
  projectionId: () => seededInputs?.projectionId?.() ?? `prj_${crypto.randomUUID().replaceAll('-', '')}`,
  // --lease-gate opens the isolated lease gate (contracts/routing-lease-gate.md); without it lease frames get route_pool_lease_pending.
  leaseGate,
};

const service = await createServer({ dataDir: dir, hostname: '127.0.0.1', port: Number(arg('--port') ?? 0), tenantCacheSize: 4,
  heartbeatMs: 15_000, commit: 'projection-joint', codeSecret: 'projection-joint-only', now: () => serverNow, presence: new MemoryPresence(),
  routingProjection: inputs });
if (!state) {
  if (nowArg) throw new Error('--now is only for restarting an already seeded --data-dir');
  const seeded = await seedProjection(service.store, dir, () => clock);
  seededInputs = seeded.inputs;
  state = { tenant_id: seeded.tenantId, user_id: seeded.userId, pinned_user: seeded.pinnedUser, platform: seeded.platform, tokens: seeded.tokens };
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  // v7 first so dev_lin's follow target is 91 (shared fixture) and dev_fix's pinned v6 target is 92.
  await service.projection!.runRollout('rol_v7');
  await service.projection!.runRollout('rol_v6');
  seededInputs = undefined;
}

const http = service.server.url.toString().replace(/\/$/, '');
console.log(JSON.stringify({
  http_url: http, ws_url: http.replace(/^http/, 'ws') + '/v1/edge/ws', data_dir: dir, server_time: new Date(serverNow).toISOString(),
  lease_gate: leaseGate,
  tenant_id: state.tenant_id,
  devices: {
    dev_lin: { token: state.tokens.dev_lin, user_id: state.user_id, registered: !unregistered.has('dev_lin'), grant: 'follow v7 (dep_a, dep_b)', config_revision: 91 },
    dev_fix: { token: state.tokens.dev_fix, user_id: state.pinned_user, registered: !unregistered.has('dev_fix'), grant: 'pinned v6 (dep_a)', config_revision: 92 },
  },
  device_private_key_hex: Buffer.from(devicePrivate).toString('hex'), device_public_key: x25519PublicKey(devicePrivate),
  inference_plaintext: fixturePlaintext, platform_session: state.platform,
  ledger: [`${http}/v1/platform/model-pool-rollouts/rol_v7/targets`, `${http}/v1/platform/model-pool-rollouts/rol_v6/targets`],
  hello: { capability_policy_v2: true, policy_runtime_v1: true, agent_cache: true, capabilities: ['route_pool.v1'] },
}));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await service.close();
  if (!given) rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
