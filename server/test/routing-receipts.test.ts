import { afterEach, expect, test } from 'bun:test';
import { routeProjectionDigest } from '../src/route-secret';
import { clock } from './routing-fixture';
import { fixturePlaintext, followGrant } from './routing-projection-fixture';
import { applied, open, rejected, until, wsSetup as setup } from './routing-ws-fixture';

const clean: (() => unknown)[] = [];
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); });
const wsSetup = () => setup(clean);

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

test('reconnect resends only a still-authorized target: revocation, grant change and expiry withhold it until a job regenerates', async () => {
  const f = await wsSetup();
  await f.service().projection!.runRollout('rol_v7');
  await f.service().projection!.runRollout('rol_v6');
  const delivery = (device: string, revision: number) => f.db.get<{ last_failure_json: string | null }>(
    'SELECT last_failure_json FROM routing_config_deliveries WHERE device_id = ? AND config_revision = ?', [device, revision])!;
  const reconnect = async (device: 'dev_lin' | 'dev_fix', configRevision: number) => {
    const edge = f.connect(device);
    await edge.hello({ capabilities: ['route_pool.v1'] }, configRevision);
    return edge;
  };
  // Pinned v6 (A only) and follow v7 (A/B) each come back with their own persisted identity, applied or not.
  let fix = await reconnect('dev_fix', 0);
  expect((await fix.nextOf('config')).routes.map((route: any) => route.deployment_id)).toEqual(['dep_a']);
  let lin = await reconnect('dev_lin', 0);
  const followed = await lin.nextOf('config');
  expect([followed.revision, followed.route_pool.pools[0].pool_revision]).toEqual([91, 7]);
  expect(await lin.request(applied('ca91'))).toMatchObject({ ok: true });
  lin.close(); fix.close();
  lin = await reconnect('dev_lin', 91);
  expect((await lin.nextOf('config')).revision).toBe(91);
  lin.close();

  // A newer revocation revision withholds the old target on reconnect; nothing is regenerated by connecting.
  f.setRevocation(4);
  fix = await reconnect('dev_fix', 92);
  expect(await fix.quiet(150)).toEqual([]);
  expect(JSON.parse(delivery('dev_fix', 92).last_failure_json!)).toMatchObject({ code: 'revocation_changed', reason: 'revocation_changed' });
  expect((await f.http('/model-pool-rollouts/rol_v6/targets')).body.items.find((row: any) => row.device_id === 'dev_fix'))
    .toMatchObject({ state: 'pending', reason: 'revocation_changed', target_config_revision: 92 });
  expect(f.db.get<{ n: number }>('SELECT count(*) AS n FROM routing_config_snapshots')!.n).toBe(2);
  // An explicit regeneration takes a higher revision and reaches the online session.
  await f.service().projection!.project(f.tenantId, 'dev_fix');
  const regenerated = await fix.nextOf('config');
  expect([regenerated.revision, regenerated.route_pool.revocation_revision]).toEqual([93, 4]);
  fix.close();

  // A changed grant withholds the applied follow target as well, without moving the applied head.
  f.setGrants([{ ...followGrant, user_ids: [f.userId], pool: { mode: 'pinned', pool_revision: 6 } },
    { ...followGrant, binding_id: 'bnd_codex_m_fixed', pool: { mode: 'pinned', pool_revision: 6 }, user_ids: [f.pinnedUser] }]);
  lin = await reconnect('dev_lin', 91);
  expect(await lin.quiet(150)).toEqual([]);
  expect(JSON.parse(delivery('dev_lin', 91).last_failure_json!)).toMatchObject({ code: 'revocation_changed' });
  expect(f.db.get("SELECT config_revision FROM policy_device_applications WHERE device_id = 'dev_lin'")).toEqual({ config_revision: 91 });
  lin.close();
  f.setRevocation(0);
  lin = await reconnect('dev_lin', 91);
  expect(await lin.quiet(150)).toEqual([]);
  expect(JSON.parse(delivery('dev_lin', 91).last_failure_json!)).toMatchObject({ code: 'authorization_changed' });
  lin.close();

  // Expiry: the fixed target lapses at its valid_until and is not resent.
  f.setGrants([{ ...followGrant, user_ids: [f.userId] }, { ...followGrant, binding_id: 'bnd_codex_m_fixed', pool: { mode: 'pinned', pool_revision: 6 }, user_ids: [f.pinnedUser] }]);
  f.setClock(clock + 10 * 60_000);
  lin = await reconnect('dev_lin', 91);
  expect(await lin.quiet(150)).toEqual([]);
  expect(JSON.parse(delivery('dev_lin', 91).last_failure_json!)).toMatchObject({ code: 'target_expired' });
});

test('a disconnect before the receipt resends the same identity; an expired target is withheld and an expiry rejection never moves the head', async () => {
  const f = await wsSetup();
  await f.service().projection!.runRollout('rol_v7');
  await f.service().projection!.runRollout('rol_v6');
  const targetRow = async (rollout: string, device: string) =>
    (await f.http(`/model-pool-rollouts/${rollout}/targets`)).body.items.find((row: any) => row.device_id === device);
  // Disconnect after the config arrived but before any receipt: offline, then the same identity on reconnect.
  let lin = f.connect('dev_lin');
  await lin.hello();
  const first = await lin.nextOf('config');
  lin.close();
  for (let i = 0; i < 100 && (await targetRow('rol_v7', 'dev_lin')).state !== 'offline'; i++) await Bun.sleep(10);
  expect(await targetRow('rol_v7', 'dev_lin')).toMatchObject({ state: 'offline', reason: 'device_offline', applied_config_revision: null });
  lin = f.connect('dev_lin');
  await lin.hello({ capabilities: ['route_pool.v1'] }, 90);
  const again = await lin.nextOf('config');
  expect([again.revision, again.route_pool.projection_id, routeProjectionDigest(again)]).toEqual([91, 'prj_91', routeProjectionDigest(first)]);
  await until(() => f.db.get<{ retry_count: number }>("SELECT retry_count FROM routing_config_deliveries WHERE device_id = 'dev_lin'")!.retry_count === 1);
  expect(await lin.request(applied('ca91'))).toEqual({ type: 'ack', re: 'ca91', ok: true });
  lin.close();

  // dev_fix never connected; once its target lapses the ledger says so, and reconnecting does not resend it.
  f.setClock(clock + 10 * 60_000);
  expect(await targetRow('rol_v6', 'dev_fix')).toMatchObject({ state: 'offline', reason: 'target_expired', target_config_revision: 92 });
  const fix = f.connect('dev_fix');
  await fix.hello();
  expect(await fix.quiet(150)).toEqual([]);
  expect(await targetRow('rol_v6', 'dev_fix')).toMatchObject({ state: 'pending', reason: 'target_expired' });
  expect(f.service().store.system.get('SELECT revision FROM edge_config_counter')).toEqual({ revision: 92 });
  // The device's own expiry rejection is kept on the target: rejected, head untouched.
  expect(await fix.request({ type: 'config_applied', id: 'exp92', config_revision: 92, policy_revision: 1, projection_id: 'prj_92', result: 'rejected',
    error: { code: 'invalid_config', message: '配置已过期', detail: { reason: 'config_expired' } } })).toEqual({ type: 'ack', re: 'exp92', ok: true });
  expect(await targetRow('rol_v6', 'dev_fix')).toMatchObject({ state: 'rejected', reason: 'config_expired', applied_config_revision: null });
  expect(f.db.get("SELECT count(*) AS n FROM policy_device_applications WHERE device_id = 'dev_fix'")).toEqual({ n: 0 });
  // The applied follow target stays applied after expiry; it is history, not a regression.
  expect(await targetRow('rol_v7', 'dev_lin')).toMatchObject({ state: 'applied', applied_config_revision: 91 });
});

test('connect without a persisted target sends nothing; release jobs create targets and online sessions get them at once', async () => {
  const f = await wsSetup();
  const edge = f.connect('dev_lin');
  await edge.hello();
  // Connecting never creates a target or picks the newest pool.
  expect(await edge.quiet(150)).toEqual([]);
  expect(f.db.get<{ n: number }>('SELECT count(*) AS n FROM routing_config_snapshots')!.n).toBe(0);
  expect(f.service().store.system.get('SELECT revision FROM edge_config_counter')).toEqual({ revision: 90 });
  expect(f.db.get<{ n: number }>('SELECT count(*) AS n FROM leases')!.n).toBe(0);
  // The explicit job persists 91 and the online session receives it without reconnecting.
  await f.service().projection!.runRollout('rol_v7');
  const first = await edge.nextOf('config');
  expect([first.revision, first.route_pool.projection_id, first.routes.map((route: any) => route.deployment_id)]).toEqual([91, 'prj_91', ['dep_a', 'dep_b']]);
  expect((await f.http('/model-pool-rollouts/rol_v7/targets')).body.items[0]).toMatchObject({ target_config_revision: 91, state: 'pending', reason: 'awaiting_receipt' });
  // An explicitly generated higher target (changed grant) is pushed as well.
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
