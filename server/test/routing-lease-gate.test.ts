import { afterEach, expect, test } from 'bun:test';
import { clock, minutes } from './routing-fixture';
import { followGrant } from './routing-projection-fixture';
import { applied, rejected, wsSetup } from './routing-ws-fixture';

const clean: (() => unknown)[] = [];
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); });

type Setup = Awaited<ReturnType<typeof wsSetup>>;
const reserves = (f: Setup) => f.live().get<{ n: number }>("SELECT count(*) AS n FROM ledger WHERE kind = 'reserve'")!.n;
const links = (f: Setup) => f.live().all('SELECT lease_id, device_id, config_revision, projection_id FROM routing_lease_projections ORDER BY lease_id');
const refused = (reason: string, detail: Record<string, unknown> = {}) =>
  ({ type: 'ack', ok: false, error: expect.objectContaining({ code: 'forbidden', detail: { reason, ...detail } }) });
let seq = 0;
const leaseRequest = () => { const id = `lr_${++seq}`; return { type: 'lease_request', id, op_id: `op_${id}` }; };
/** Per-model snapshot for a lease: everything on the first allocated model, zero on the rest. */
const modelUsed = (lease: any, used: number) => lease.model_budgets
  ? Object.fromEntries(Object.keys(lease.model_budgets).map((model, i) => [model, i === 0 ? used : 0])) : undefined;
const renew = (lease: any, used: number, extra: Record<string, unknown> = {}) => {
  const id = `rn_${++seq}`;
  return { type: 'lease_renew', id, op_id: `op_${id}`, lease_id: lease.lease_id, used_milli: used, model_used_milli: modelUsed(lease, used), ...extra };
};
const ledger = (f: Setup, leaseId: string) => Object.fromEntries(f.live().all<{ kind: string; amount: number }>(
  "SELECT kind, sum(amount_milli) AS amount FROM ledger WHERE lease_id = ? AND kind IN ('settle', 'release', 'overage_pending') GROUP BY kind", [leaseId])
  .map(row => [row.kind, row.amount]));
const poolHead8 = (f: Setup) => f.service().store.system.write(sql => {
  sql.run(`INSERT INTO model_pool_revisions (model_id, pool_revision, based_on_revision, identity_revision, strategy, max_attempts, attempt_timeout_ms,
    total_timeout_ms, reason, digest, released_by, released_at) VALUES ('mdl_m', 8, 7, 1, 'ordered', 2, 5000, 12000, 'reorder', 'seed8', 'seed', ?)`, [minutes(0)]);
  sql.run(`INSERT INTO model_pool_deployments (model_id, pool_revision, deployment_id, deployment_revision, approved_match_id, priority, evidence_ids_json)
    VALUES ('mdl_m', 8, 'dep_a', 3, 'mt_a', 20, '["ev_a"]')`);
  sql.run("UPDATE model_pool_heads SET pool_revision = 8 WHERE model_id = 'mdl_m'");
});

/** dev_lin follows v7 and has applied 91 (no lease yet). */
async function appliedSetup() {
  const f = await wsSetup(clean, { leaseGate: true });
  await f.service().projection!.runRollout('rol_v7');
  const edge = f.connect('dev_lin');
  await edge.hello();
  await edge.nextOf('config');
  expect(await edge.request(applied('ca91'))).toEqual({ type: 'ack', re: 'ca91', ok: true });
  return { f, edge };
}

test('the gate stays off by default: route_pool_lease_pending and no reserve', async () => {
  const f = await wsSetup(clean);
  await f.service().projection!.runRollout('rol_v7');
  const edge = f.connect('dev_lin');
  await edge.hello();
  await edge.nextOf('config');
  expect(await edge.request(applied('ca91'))).toMatchObject({ ok: true });
  expect(await edge.call(leaseRequest())).toMatchObject(refused('route_pool_lease_pending'));
  expect(reserves(f)).toBe(0);
});

test('no head, a rejected receipt or another device head never reserve; a lease binds exactly the applied head and is never pushed', async () => {
  const f = await wsSetup(clean, { leaseGate: true });
  await f.service().projection!.runRollout('rol_v7');
  const lin = f.connect('dev_lin');
  await lin.hello();
  await lin.nextOf('config');
  expect(await lin.call(leaseRequest())).toMatchObject(refused('projection_not_applied'));
  expect(await lin.call({ type: 'lease_request', id: 'no_op' })).toMatchObject({ ok: false, error: { code: 'invalid', detail: { fields: ['op_id'] } } });
  // A rejection is only acknowledged; it opens no lease.
  expect(await lin.request(rejected('rj91', 91, 'prj_91'))).toMatchObject({ ok: true });
  expect(await lin.call(leaseRequest())).toMatchObject(refused('projection_not_applied'));
  expect(reserves(f)).toBe(0);

  // The applied receipt itself pushes nothing.
  expect(await lin.request(applied('ca91'))).toMatchObject({ ok: true });
  expect(await lin.quiet()).toEqual([]);
  const request = leaseRequest();
  const lease = await lin.call(request);
  const snapshot = f.live().get<{ valid_until: string }>("SELECT valid_until FROM routing_config_snapshots WHERE device_id = 'dev_lin' AND config_revision = 91")!;
  expect(lease).toMatchObject({ type: 'lease', re: request.id, lease_id: expect.stringMatching(/^lse_/), signature_id: 'sig_1',
    config_revision: 91, projection_id: 'prj_91', commerce_plan_id: f.planId, seq: 1 });
  expect(lease).not.toHaveProperty('settled_lease_id');
  expect(lease.expires_at <= snapshot.valid_until).toBe(true);
  expect(links(f)).toEqual([{ lease_id: lease.lease_id, device_id: 'dev_lin', config_revision: 91, projection_id: 'prj_91' }]);
  expect(reserves(f)).toBe(1);
  // Repeating reaffirms the same lease and link without a second reserve.
  const again = await lin.call(leaseRequest());
  expect([again.lease_id, again.config_revision, again.projection_id]).toEqual([lease.lease_id, 91, 'prj_91']);
  expect(reserves(f)).toBe(1);

  // dev_fix has its own target but no applied head; dev_lin's head never opens a lease for it.
  await f.service().projection!.runRollout('rol_v6');
  const fix = f.connect('dev_fix');
  await fix.hello();
  await fix.nextOf('config');
  expect(await fix.call(leaseRequest())).toMatchObject(refused('projection_not_applied'));
  expect(reserves(f)).toBe(1);
});

test('signature, plan, revocation, expiry and authorization each refuse a new lease in contract order without reserving', async () => {
  const { f, edge } = await appliedSetup();
  const expectRefused = async (reason: string) => {
    expect(await edge.call(leaseRequest())).toMatchObject(refused(reason));
    expect(reserves(f)).toBe(0);
  };
  await f.patchHot(f.userId, { commerce_plan_id: 'pln_other' });
  f.setRevocation(1);
  await expectRefused('projection_plan_changed');
  await f.patchHot(f.userId, { commerce_plan_id: f.planId });
  await expectRefused('projection_revoked');
  f.setRevocation(0);
  const snapshot = f.live().get<{ valid_until: string }>("SELECT valid_until FROM routing_config_snapshots WHERE config_revision = 91")!;
  f.setClock(Date.parse(snapshot.valid_until));
  await expectRefused('projection_expired');
  f.setClock(clock);

  // Group or member narrowing: provider and model.
  await f.patchHot(f.userId, { provider_ids_json: JSON.stringify(['prv_elsewhere']) });
  await expectRefused('projection_authorization_changed');
  await f.patchHot(f.userId, { provider_ids_json: null, allowed_models_json: '[]' });
  await expectRefused('projection_authorization_changed');
  await f.patchHot(f.userId, { allowed_models_json: JSON.stringify(['mdl_m']) });
  // A grant withdrawn from the member.
  f.setGrants([{ ...followGrant, user_ids: [f.pinnedUser] }]);
  await expectRefused('projection_authorization_changed');
  f.setGrants([{ ...followGrant, user_ids: [f.userId] }]);
  // A really disabled deployment of the exact projected pool revision.
  await f.service().store.system.write(sql => sql.run("UPDATE model_deployments SET status = 'disabled' WHERE deployment_id = 'dep_b'"));
  await expectRefused('projection_authorization_changed');
  await f.service().store.system.write(sql => sql.run("UPDATE model_deployments SET status = 'active' WHERE deployment_id = 'dep_b'"));
  // The exact Agent release withdrawn.
  await f.service().store.system.write(sql => sql.run("UPDATE agent_releases SET status = 'disabled' WHERE id = 'rel_codex'"));
  await expectRefused('projection_authorization_changed');
  await f.service().store.system.write(sql => sql.run("UPDATE agent_releases SET status = 'active' WHERE id = 'rel_codex'"));

  // A pure pool-head update of the follow grant keeps the applied snapshot usable: the lease binds 91 on v7.
  await poolHead8(f);
  const lease = await edge.call(leaseRequest());
  expect(lease).toMatchObject({ type: 'lease', config_revision: 91, projection_id: 'prj_91', signature_id: 'sig_1' });
  expect(reserves(f)).toBe(1);

  // An active lease whose projection lost authorization must be settled first; a pure pool change reaffirms it.
  expect((await edge.call(leaseRequest())).lease_id).toBe(lease.lease_id);
  await f.service().store.system.write(sql => sql.run("UPDATE model_deployments SET status = 'disabled' WHERE deployment_id = 'dep_b'"));
  expect(await edge.call(leaseRequest())).toMatchObject(refused('lease_settlement_required', { lease_id: lease.lease_id }));
  expect(reserves(f)).toBe(1);
});

test('a new signature refuses the old head and an old active lease; a re-signed applied target leases on the new signature', async () => {
  const { f, edge } = await appliedSetup();
  const lease = await edge.call(leaseRequest());
  expect(lease).toMatchObject({ type: 'lease', signature_id: 'sig_1' });
  const revision = await f.resign();
  expect(revision).toBe(2);
  expect(await edge.call(leaseRequest())).toMatchObject(refused('lease_settlement_required', { lease_id: lease.lease_id }));
  // Settling first: the old lease is charged once and no successor is issued under the stale signature.
  const settled = await edge.call(renew(lease, 7));
  expect(settled).toMatchObject({ type: 'cutoff', reason: 'contract', settled_lease_id: lease.lease_id, detail: { reason: 'projection_signature_stale' } });
  expect(ledger(f, lease.lease_id)).toEqual({ settle: 7, release: lease.budget_milli - 7 });
  expect(await edge.call(leaseRequest())).toMatchObject(refused('projection_signature_stale'));
  expect(reserves(f)).toBe(1);
  f.setGrants([{ ...followGrant, platform_revision: 2, user_ids: [f.userId] }]);
  await f.service().projection!.project(f.tenantId, 'dev_lin');
  const next = await edge.nextOf('config');
  expect(next.route_pool.signature_id).toBe('sig_2');
  // An unapplied target has no lease effect.
  expect(await edge.call(leaseRequest())).toMatchObject(refused('projection_signature_stale'));
  expect(await edge.request({ ...applied('ca_next', next.revision, next.route_pool.projection_id), policy_revision: next.policy.policy_revision }))
    .toMatchObject({ ok: true });
  expect(await edge.call(leaseRequest())).toMatchObject({ type: 'lease', signature_id: 'sig_2', config_revision: next.revision,
    projection_id: next.route_pool.projection_id, seq: 2 });
});

test('renewal settles once by the original terms; the successor binds the applied head before and after a pure pool change; replay never charges twice', async () => {
  const { f, edge } = await appliedSetup();
  const first = await edge.call(leaseRequest());
  // Pool head moves to v8 and a new target 92 is generated but not yet applied: the successor still binds 91.
  await poolHead8(f);
  await f.service().projection!.project(f.tenantId, 'dev_lin');
  const target = await edge.nextOf('config');
  expect([target.revision, target.route_pool.pools[0].pool_revision]).toEqual([92, 8]);
  const request = renew(first, 10);
  const second = await edge.call(request);
  expect(second).toMatchObject({ type: 'lease', re: request.id, settled_lease_id: first.lease_id, config_revision: 91, projection_id: 'prj_91',
    signature_id: 'sig_1', seq: 2 });
  expect(ledger(f, first.lease_id)).toEqual({ settle: 10, release: first.budget_milli - 10 });
  expect(f.live().get('SELECT mode FROM lease_operations WHERE op_id = ?', [request.op_id])).toEqual({ mode: 'route_pool' });
  // Same op_id, same values: the cached successor is reaffirmed, nothing charged or reserved again.
  const replay = await edge.call({ ...request, id: 'rn_replay1' });
  expect(replay).toMatchObject({ type: 'lease', re: 'rn_replay1', lease_id: second.lease_id, settled_lease_id: first.lease_id, config_revision: 91 });
  expect(ledger(f, first.lease_id)).toEqual({ settle: 10, release: first.budget_milli - 10 });
  expect(reserves(f)).toBe(2);
  // Same op_id with another amount, lease or mode conflicts.
  for (const changed of [{ used_milli: 11, model_used_milli: modelUsed(first, 11) }, { lease_id: second.lease_id }, { release_only: true }]) {
    expect(await edge.call({ ...request, id: `rn_c_${++seq}`, ...changed })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  }
  // After 92 is applied, the next renewal binds 92.
  expect(await edge.request(applied('ca92', 92, 'prj_92'))).toMatchObject({ ok: true });
  const third = await edge.call(renew(second, 3));
  expect(third).toMatchObject({ type: 'lease', settled_lease_id: second.lease_id, config_revision: 92, projection_id: 'prj_92', seq: 3 });
  expect(links(f)).toHaveLength(3);
  // The first operation's successor is settled now: replay still confirms the settlement, never re-charges.
  expect(await edge.call({ ...request, id: 'rn_replay2' })).toMatchObject({ type: 'cutoff', re: 'rn_replay2', reason: 'contract',
    settled_lease_id: first.lease_id, detail: { reason: 'successor_lease_unavailable' } });
  expect((await edge.call({ ...request, id: 'rn_replay3' })).detail).not.toHaveProperty('lease_id');
  expect(ledger(f, first.lease_id)).toEqual({ settle: 10, release: first.budget_milli - 10 });
  expect(reserves(f)).toBe(3);
  // Settling twice through a new op_id is refused; an unknown lease is not found.
  expect(await edge.call(renew(first, 10))).toMatchObject({ ok: false, error: { code: 'conflict' } });
  expect(await edge.call(renew({ lease_id: 'lse_missing' }, 0))).toMatchObject({ ok: false, error: { code: 'not_found' } });
});

test('a lost successor reply replays as successor_lease_unavailable with the still-pending successor', async () => {
  const { f, edge } = await appliedSetup();
  const first = await edge.call(leaseRequest());
  const request = renew(first, 4);
  const second = await edge.call(request);
  expect(second).toMatchObject({ type: 'lease', settled_lease_id: first.lease_id });
  // The successor's projection loses a deployment before the device saw the reply.
  await f.service().store.system.write(sql => sql.run("UPDATE model_deployments SET status = 'disabled' WHERE deployment_id = 'dep_b'"));
  expect(await edge.call({ ...request, id: 'rn_lost' })).toMatchObject({ type: 'cutoff', reason: 'contract', settled_lease_id: first.lease_id,
    detail: { reason: 'successor_lease_unavailable', lease_id: second.lease_id } });
  expect(ledger(f, first.lease_id)).toEqual({ settle: 4, release: first.budget_milli - 4 });
  expect(await edge.call(leaseRequest())).toMatchObject(refused('lease_settlement_required', { lease_id: second.lease_id }));
  // Settling the pending successor reports the gate reason; nothing new is reserved.
  expect(await edge.call(renew(second, 0))).toMatchObject({ type: 'cutoff', settled_lease_id: second.lease_id,
    detail: { reason: 'projection_authorization_changed' } });
  expect(reserves(f)).toBe(2);
});

test('release_only settles a bound, never-used lease to zero and issues nothing; legacy entries refuse it', async () => {
  const { f, edge } = await appliedSetup();
  const lease = await edge.call(leaseRequest());
  const zero = modelUsed(lease, 0);
  expect(await edge.call(renew(lease, 5, { release_only: true, model_used_milli: modelUsed(lease, 5) })))
    .toMatchObject({ ok: false, error: { code: 'invalid', detail: { fields: ['used_milli'] } } });
  expect(await edge.call(renew(lease, 0, { release_only: 'yes' }))).toMatchObject({ ok: false, error: { code: 'invalid', detail: { fields: ['release_only'] } } });
  if (zero) {
    expect(await edge.call(renew(lease, 0, { release_only: true, model_used_milli: {} })))
      .toMatchObject({ ok: false, error: { code: 'invalid', detail: { fields: ['model_used_milli'] } } });
  }
  const request = renew(lease, 0, { release_only: true });
  expect(await edge.call(request)).toEqual({ type: 'cutoff', id: expect.any(String), re: request.id, reason: 'contract',
    settled_lease_id: lease.lease_id, detail: { reason: 'lease_released' } });
  expect(ledger(f, lease.lease_id)).toEqual({ release: lease.budget_milli });
  expect(f.live().get('SELECT status, used_milli FROM leases WHERE id = ?', [lease.lease_id])).toEqual({ status: 'settled', used_milli: 0 });
  expect(f.live().get('SELECT mode FROM lease_operations WHERE op_id = ?', [request.op_id])).toEqual({ mode: 'route_pool_release_only' });
  expect(reserves(f)).toBe(1);
  expect(await edge.call({ ...request, id: 'rel_replay' })).toMatchObject({ type: 'cutoff', settled_lease_id: lease.lease_id, detail: { reason: 'lease_released' } });
  expect(await edge.call({ ...request, id: 'rel_mode', release_only: false })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  expect(ledger(f, lease.lease_id)).toEqual({ release: lease.budget_milli });

  // A lease without a projection link is never releasable through release_only.
  await f.live().write(sql => sql.run(`INSERT INTO leases (id, device_id, user_id, budget_milli, expires_at, status, seq)
    VALUES ('lse_unbound', 'dev_lin', ?, 20, ?, 'active', 9)`, [f.userId, minutes(5)]));
  expect(await edge.call(renew({ lease_id: 'lse_unbound' }, 0, { release_only: true })))
    .toMatchObject({ ok: false, error: { code: 'invalid', detail: { fields: ['release_only'] } } });
  expect(ledger(f, 'lse_unbound')).toEqual({});
});

test('legacy sessions refuse release_only and keep their renew frames', async () => {
  const f = await wsSetup(clean, { leaseGate: true });
  f.setSelection(() => false);
  const edge = f.connect('dev_lin');
  await edge.hello();
  const lease = await edge.nextOf('lease');
  expect(lease).not.toHaveProperty('signature_id');
  expect(await edge.call({ type: 'lease_renew', id: 'leg1', op_id: 'leg1', lease_id: lease.lease_id, used_milli: 0, release_only: true }))
    .toMatchObject({ ok: false, error: { code: 'invalid', detail: { fields: ['release_only'] } } });
  expect(ledger(f, lease.lease_id)).toEqual({});
  const next = await edge.call({ type: 'lease_renew', id: 'leg2', op_id: 'leg2', lease_id: lease.lease_id, used_milli: 2 });
  expect(next).toMatchObject({ type: 'lease', re: 'leg2' });
  expect(next).not.toHaveProperty('config_revision');
  expect(f.live().get("SELECT mode FROM lease_operations WHERE op_id = 'leg2'")).toEqual({ mode: 'legacy' });
  expect(f.live().get<{ n: number }>('SELECT count(*) AS n FROM routing_lease_projections')!.n).toBe(0);
});
