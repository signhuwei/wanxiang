import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../../tests/fixtures/routing/p0-ab.json';
import { iso } from '../src/credentials';
import { routingProjector } from '../src/route-projection';
import { openRouteSecret, routeProjectionDigest, sealRoutePoolConfig } from '../src/route-secret';
import { QueuedDatabase, Store } from '../src/store';
import { clock, minutes } from './routing-fixture';
import { devicePrivate, fixturePlaintext as plaintext, fixtureRefs as refs, followGrant as follow, seedProjection } from './routing-projection-fixture';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function projectionSetup(options: { credentials?: Record<string, string> } = {}) {
  let at = clock;
  const dir = mkdtempSync(join(tmpdir(), 'onex-projection-'));
  const store = new Store(dir, 4);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const seeded = await seedProjection(store, dir, () => at, options);
  const projector = routingProjector(store, seeded.inputs, () => at);
  return { ...seeded, store, projector, setClock: (value: number) => { at = value; }, now: () => at };
}

const roster = (store: Store, rollout: string) => store.system.all<Record<string, unknown>>(`SELECT tenant_id, device_id, user_id, target_config_revision,
  projection_id, outcome, outcome_reason FROM route_rollout_targets WHERE rollout_id = ? ORDER BY device_id`, [rollout]);
const rosterRow = (store: Store, rollout: string, device: string) => roster(store, rollout).find(row => row.device_id === device);
const counter = (store: Store) => store.system.get<{ revision: number }>('SELECT revision FROM edge_config_counter')!.revision;
const payload = (f: { db: Store['system'] }, device: string, revision?: number) => JSON.parse(f.db.get<{ payload_json: string }>(
  `SELECT payload_json FROM routing_config_snapshots WHERE device_id = ? ${revision ? 'AND config_revision = ?' : ''} ORDER BY config_revision DESC LIMIT 1`,
  revision ? [device, revision] : [device])!.payload_json);
const narrow = (f: { db: Store['system'] }, user: string, hot: Record<string, string | null>) => f.db.write(sql => {
  for (const [key, value] of Object.entries(hot)) {
    sql.run(`UPDATE policy_effective SET document_json = json_set(document_json, '$.hot.' || ?, ?) WHERE scope = 'member' AND subject_id = ?`, [key, value, user]);
  }
});

test('pinned v6 projects only A, follow v7 projects A/B with the signed 4× rate and the exact binding', async () => {
  const f = await projectionSetup();
  expect(await f.projector.runRollout('rol_v7')).toBe('done');
  expect(roster(f.store, 'rol_v7')).toEqual([{ tenant_id: f.tenantId, device_id: 'dev_lin', user_id: f.userId, target_config_revision: 91,
    projection_id: 'prj_91', outcome: null, outcome_reason: null }]);
  expect(await f.projector.runRollout('rol_v6')).toBe('done');
  expect(rosterRow(f.store, 'rol_v6', 'dev_fix')).toMatchObject({ target_config_revision: 92, projection_id: 'prj_92', outcome: null });
  // The follow device was a v6 recipient too; the active v7 head supersedes that row instead of attributing v7 to the old job.
  expect(rosterRow(f.store, 'rol_v6', 'dev_lin')).toMatchObject({ target_config_revision: null, outcome: 'superseded', outcome_reason: 'pool_superseded' });
  expect(f.store.system.get('SELECT status FROM route_release_jobs WHERE job_id = ?', ['rol_v7'])).toEqual({ status: 'done' });

  const row = f.db.get<Record<string, any>>("SELECT * FROM routing_config_snapshots WHERE device_id = 'dev_lin'")!;
  const config = JSON.parse(row.payload_json);
  expect(row).toMatchObject({ config_revision: 91, projection_id: 'prj_91', user_id: f.userId, platform_revision: 1, revocation_revision: 0,
    valid_until: minutes(10) });
  expect(row.digest).toBe(routeProjectionDigest(config));
  expect(config).not.toHaveProperty('id');
  expect(config.route_pool.secrets).toEqual([]);
  expect(config.routes.map((route: any) => [route.deployment_id, route.deployment_revision, route.pool_revision, route.credential_ref]))
    .toEqual([['dep_a', 3, 7, refs['dep_a@3']], ['dep_b', 2, 7, refs['dep_b@2']]]);
  const [rate] = f.signature.sales_rate_snapshots;
  expect(config.rates).toEqual([{ ...fixture.wire.config.rates[0], rate_version_id: rate.rate_version_id, effective_from: rate.valid_from, effective_until: null }]);
  expect(config.route_pool).toMatchObject({ abi: 1, projection_id: 'prj_91', signature_id: 'sig_1', expires_at: minutes(10),
    pools: fixture.wire.config.route_pool.pools, bindings: fixture.wire.config.route_pool.bindings });
  expect(config.policy).toMatchObject({ abi: 2, tenant_id: f.tenantId, device_id: 'dev_lin', user_id: f.userId, platform_revision: 1, secrets: [] });
  expect(config.agents).toEqual([{ ...fixture.wire.config.agents[0], sha256: '0'.repeat(64) }]);
  const routeFields = ({ base_url: _b, valid_until: _v, availability: _a, ...rest }: any) => rest;
  expect(config.routes.map(routeFields)).toEqual(fixture.wire.config.routes.map(routeFields));
  // The generation basis never strips fields from the persisted frame.
  expect(config.routes.map((route: any) => [route.valid_until, route.availability])).toEqual([
    [minutes(10), { state: 'eligible', observed_at: minutes(-60), valid_until: minutes(10) }],
    [minutes(10), { state: 'eligible', observed_at: minutes(-60), valid_until: minutes(10) }]]);
  expect(f.db.get("SELECT device_id, config_revision, projection_id, sent_at, applied_at, rejected_at, last_failure_json, retry_count FROM routing_config_deliveries WHERE device_id = 'dev_lin'"))
    .toEqual({ device_id: 'dev_lin', config_revision: 91, projection_id: 'prj_91', sent_at: null, applied_at: null, rejected_at: null, last_failure_json: null, retry_count: 0 });

  const pinned = JSON.parse(f.db.get<{ payload_json: string }>("SELECT payload_json FROM routing_config_snapshots WHERE device_id = 'dev_fix'")!.payload_json);
  expect(pinned.routes.map((route: any) => route.deployment_id)).toEqual(['dep_a']);
  expect(pinned.route_pool.pools[0].pool_revision).toBe(6);
  expect(pinned.route_pool.bindings[0]).toMatchObject({ binding_id: 'bnd_codex_m_fixed', deployment_ids: ['dep_a'] });
  expect(pinned.rates[0].input_multiplier_ppm).toBe(4000000);

  // The persisted target reseals with the frozen credential versions and opens with the synthetic device key.
  const sealed = sealRoutePoolConfig(config, { tenant_id: f.tenantId, device_id: 'dev_lin', recipient_public_key: f.publicKey },
    (id, version) => f.inputs.credentialMaterial(id, version));
  expect(routeProjectionDigest(sealed)).toBe(row.digest);
  for (const envelope of sealed.route_pool.secrets) {
    expect(openRouteSecret(devicePrivate, { tenant_id: f.tenantId, device_id: 'dev_lin', projection_id: 'prj_91', revision: 91 }, envelope).toString())
      .toBe(plaintext[`${envelope.credential_id}@${envelope.credential_version}`]);
  }
});

test('the same generation basis reuses the target, and a crash between target and roster write recovers it', async () => {
  const f = await projectionSetup();
  await f.projector.runRollout('rol_v7');
  expect(counter(f.store)).toBe(91);
  // A direct re-projection with the same inputs reuses the target without advancing the counter.
  expect(await f.projector.project(f.tenantId, 'dev_lin')).toEqual({ config_revision: 91, projection_id: 'prj_91', reused: true });
  expect(counter(f.store)).toBe(91);
  // Simulate a failure after the tenant transaction and before the roster reference was written.
  await f.store.system.write(sql => {
    sql.run("UPDATE route_rollout_targets SET target_config_revision = NULL, projection_id = NULL WHERE rollout_id = 'rol_v7'");
    sql.run("UPDATE route_release_jobs SET status = 'running' WHERE job_id = 'rol_v7'");
  });
  expect(await f.projector.runRollout('rol_v7')).toBe('done');
  expect(roster(f.store, 'rol_v7')).toMatchObject([{ device_id: 'dev_lin', target_config_revision: 91, projection_id: 'prj_91' }]);
  expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM routing_config_snapshots WHERE device_id = 'dev_lin'")!.n).toBe(1);
  expect(counter(f.store)).toBe(91);
  // A finished job is not re-executed.
  expect(await f.projector.runRollout('rol_v7')).toBe('done');

  // Once the target expires the same basis is not reused: B's evidence lapses and a higher revision projects only A.
  f.setClock(clock + 10 * 60_000);
  const renewed = await f.projector.project(f.tenantId, 'dev_lin');
  expect(renewed).toMatchObject({ reused: false, config_revision: 92 });
  expect(payload(f, 'dev_lin', 92).routes.map((route: any) => route.deployment_id)).toEqual(['dep_a']);
});

test('only the latest target is reused: A → B → A allocates a new revision instead of falling back before B', async () => {
  const f = await projectionSetup();
  const a = await f.projector.project(f.tenantId, 'dev_lin');
  f.setGrants([{ ...follow, user_ids: [f.userId], pool: { mode: 'pinned', pool_revision: 6 } }]);
  const b = await f.projector.project(f.tenantId, 'dev_lin');
  f.setGrants([{ ...follow, user_ids: [f.userId] }]);
  const back = await f.projector.project(f.tenantId, 'dev_lin');
  expect([a.config_revision, b.config_revision, back.config_revision]).toEqual([91, 92, 93]);
  expect(back.reused).toBe(false);
  expect(f.db.get<{ source_token: string }>("SELECT source_token FROM routing_config_snapshots WHERE config_revision = 93")!.source_token)
    .toBe(f.db.get<{ source_token: string }>("SELECT source_token FROM routing_config_snapshots WHERE config_revision = 91")!.source_token);
  expect(await f.projector.project(f.tenantId, 'dev_lin')).toEqual({ config_revision: 93, projection_id: 'prj_93', reused: true });
});

test('group or member narrowing never projects a disabled release, Agent or provider credential', async () => {
  // Only cred_a exists: narrowing to prv_a must not even ask for cred_b.
  const f = await projectionSetup({ credentials: { 'cred_a@1': 'fixture-inference-key' } });
  await narrow(f, f.userId, { provider_ids_json: '["prv_a"]' });
  await f.projector.project(f.tenantId, 'dev_lin');
  const config = payload(f, 'dev_lin');
  expect(config.routes.map((route: any) => [route.deployment_id, route.credential_ref.credential_id])).toEqual([['dep_a', 'cred_a']]);
  expect(config.route_pool.bindings[0].deployment_ids).toEqual(['dep_a']);
  expect(JSON.stringify(config)).not.toContain('cred_b');
  // No permitted provider at all: the binding is withheld, not failed.
  await narrow(f, f.userId, { provider_ids_json: '["prv_c"]' });
  await f.projector.project(f.tenantId, 'dev_lin');
  expect(payload(f, 'dev_lin')).toMatchObject({ routes: [], rates: [], agents: [], route_pool: { bindings: [], pools: [] } });
  // Exact release narrowing and Agent narrowing each withhold the binding and keep the device out of the roster.
  for (const hot of [{ provider_ids_json: null, release_ids_json: '["rel_other"]' }, { release_ids_json: null, allowed_agents_json: '["claude-code"]' }] as Record<string, string | null>[]) {
    await narrow(f, f.userId, hot);
    await f.projector.project(f.tenantId, 'dev_lin');
    expect(payload(f, 'dev_lin')).toMatchObject({ agents: [], routes: [], route_pool: { bindings: [] } });
  }
  await f.projector.runRollout('rol_v7');
  expect(rosterRow(f.store, 'rol_v7', 'dev_lin')).toBeUndefined();
});

test('missing credential versions keep the roster row with a failure and persist nothing', async () => {
  const f = await projectionSetup({ credentials: { 'cred_a@1': 'fixture-inference-key' } });
  expect(await f.projector.runRollout('rol_v7')).toBe('done');
  expect(roster(f.store, 'rol_v7')).toMatchObject([{ device_id: 'dev_lin', target_config_revision: null, projection_id: null,
    outcome: 'failed', outcome_reason: 'missing_route_credential' }]);
  expect(f.db.get<{ n: number }>('SELECT count(*) AS n FROM routing_config_snapshots')!.n).toBe(0);
  // The pinned v6 target needs only cred_a and still projects.
  await f.projector.runRollout('rol_v6');
  expect(rosterRow(f.store, 'rol_v6', 'dev_fix')).toMatchObject({ outcome: null, target_config_revision: 91 });
});

test('a follow target replaced by a newer pool is superseded and not attributed to the old job', async () => {
  const f = await projectionSetup();
  await f.store.system.write(sql => {
    sql.run(`INSERT INTO model_pool_revisions (model_id, pool_revision, based_on_revision, identity_revision, strategy, max_attempts, attempt_timeout_ms,
      total_timeout_ms, reason, digest, released_by, released_at) VALUES ('mdl_m', 8, 7, 1, 'ordered', 1, 5000, 12000, 'only B', 'seed8', 'seed', ?)`, [minutes(0)]);
    sql.run(`INSERT INTO model_pool_deployments (model_id, pool_revision, deployment_id, deployment_revision, approved_match_id, priority, evidence_ids_json)
      VALUES ('mdl_m', 8, 'dep_b', 2, 'mt_b', 10, '["ev_b"]')`);
    sql.run("UPDATE model_pool_heads SET pool_revision = 8 WHERE model_id = 'mdl_m'");
  });
  await f.projector.runRollout('rol_v7');
  expect(roster(f.store, 'rol_v7')).toMatchObject([{ device_id: 'dev_lin', target_config_revision: null, outcome: 'superseded', outcome_reason: 'pool_superseded' }]);
  expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM routing_config_snapshots WHERE device_id = 'dev_lin'")!.n).toBe(0);
  // The pinned v6 grant is unaffected by the newer head.
  await f.projector.runRollout('rol_v6');
  expect(rosterRow(f.store, 'rol_v6', 'dev_fix')).toMatchObject({ target_config_revision: 91, outcome: null });
});

test('tenants without grants keep their current configuration and the roster ignores devices outside the grant', async () => {
  const f = await projectionSetup();
  f.setGrants([]);
  await f.projector.runPending();
  expect(f.store.system.get<{ n: number }>('SELECT count(*) AS n FROM route_rollout_targets')!.n).toBe(0);
  expect(f.db.get<{ n: number }>('SELECT count(*) AS n FROM routing_config_snapshots')!.n).toBe(0);
  expect(counter(f.store)).toBe(90);
  // A disabled device is not a recipient.
  f.setGrants([{ ...follow }]);
  await f.db.write(sql => sql.run("UPDATE devices SET status = 'disabled' WHERE id = 'dev_fix'"));
  await f.store.system.write(sql => sql.run("UPDATE route_release_jobs SET status = 'pending' WHERE job_id = 'rol_v7'"));
  await f.projector.runRollout('rol_v7');
  expect(roster(f.store, 'rol_v7').map(row => row.device_id)).toEqual(['dev_lin']);
  // A grant from an older signature is not projected.
  f.setGrants([{ ...follow, platform_revision: 9 }]);
  await expect(f.projector.project(f.tenantId, 'dev_lin', clock)).rejects.toMatchObject({ reason: 'signature_changed' });
});

test('existing tenant 20 and system 17 databases upgrade to 21 and 20 with the legacy application head intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onex-projection-upgrade-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const tenantId = 'ten_00000000000000000000000001';
  for (const [kind, file, version] of [['tenant', `tenant-${tenantId}.sqlite`, 20], ['system', 'system.sqlite', 17]] as const) {
    const legacy = new Database(join(dir, file));
    try {
      const migrations = join(import.meta.dir, '../migrations', kind);
      for (const name of readdirSync(migrations).filter(name => /^\d+_.+\.sql$/.test(name) && Number(name.split('_')[0]) <= version).sort()) {
        legacy.exec(readFileSync(join(migrations, name), 'utf8'));
      }
      legacy.exec(`PRAGMA user_version = ${version}`);
      if (kind === 'tenant') legacy.exec(`PRAGMA foreign_keys = ON;
        INSERT INTO members (user_id, role, status) VALUES ('usr_old', 'owner', 'active');
        INSERT INTO devices (id, user_id, name, os, arch, public_key, token_hash, token_expires_at, status)
          VALUES ('dev_old', 'usr_old', 'Old', 'darwin', 'arm64', 'k', 'h', '2030-01-01T00:00:00Z', 'active');
        INSERT INTO policy_device_applications (device_id, config_revision, policy_revision, applied_at) VALUES ('dev_old', 40, 3, '2026-11-01T00:00:00Z');`);
    } finally { legacy.close(); }
  }
  const tenant = new QueuedDatabase(join(dir, `tenant-${tenantId}.sqlite`), 'tenant');
  const system = new QueuedDatabase(join(dir, 'system.sqlite'), 'system');
  try {
    expect(tenant.get('PRAGMA user_version')).toEqual({ user_version: 21 });
    expect(system.get('PRAGMA user_version')).toEqual({ user_version: 20 });
    expect(tenant.get('SELECT device_id, config_revision, policy_revision, projection_id FROM policy_device_applications'))
      .toEqual({ device_id: 'dev_old', config_revision: 40, policy_revision: 3, projection_id: null });
    for (const db of [tenant, system]) {
      expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
      expect(db.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' });
    }
  } finally { tenant.close(); system.close(); }
});

test('deliveries and receipts must name the exact persisted (device, revision, projection) and targets are immutable', async () => {
  const f = await projectionSetup();
  await f.projector.runRollout('rol_v7');
  await f.projector.runRollout('rol_v6');
  const at = iso(f.now());
  await expect(f.db.write(sql => sql.run(`INSERT INTO routing_config_deliveries (device_id, config_revision, projection_id, targeted_at)
    VALUES ('dev_lin', 91, 'prj_92', ?)`, [at]))).rejects.toThrow();
  await expect(f.db.write(sql => sql.run("UPDATE routing_config_deliveries SET projection_id = 'prj_92' WHERE device_id = 'dev_lin'"))).rejects.toThrow();
  for (const [device, revision, projection] of [['dev_lin', 91, 'prj_92'], ['dev_fix', 91, 'prj_91'], ['dev_lin', 99, 'prj_91']] as const) {
    await expect(f.db.write(sql => sql.run(`INSERT INTO routing_config_receipts (device_id, receipt_id, config_revision, projection_id, policy_revision,
      result, content_digest, received_at) VALUES (?, 'ca', ?, ?, 1, 'applied', ?, ?)`, [device, revision, projection, '0'.repeat(64), at]))).rejects.toThrow();
  }
  await f.db.write(sql => sql.run(`INSERT INTO routing_config_receipts (device_id, receipt_id, config_revision, projection_id, policy_revision,
    result, content_digest, received_at) VALUES ('dev_lin', 'ca', 91, 'prj_91', 1, 'applied', ?, ?)`, ['0'.repeat(64), at]));
  await expect(f.db.write(sql => sql.run("UPDATE routing_config_snapshots SET valid_until = valid_until WHERE device_id = 'dev_lin'"))).rejects.toThrow('immutable');
  await expect(f.db.write(sql => sql.run("DELETE FROM routing_config_snapshots WHERE device_id = 'dev_lin'"))).rejects.toThrow('immutable');
  expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
});
