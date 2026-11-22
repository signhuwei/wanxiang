import { expect, test } from 'bun:test';
import fixture from '../../tests/fixtures/routing/p0-ab.json';
import { orderMembers } from '../src/model-pool';
import type { Transaction } from '../src/store';
import { body, clock, minutes, setup, type Json } from './routing-fixture';

test('routing migrations keep legacy tables readable and foreign keys consistent', async () => {
  const f = await setup();
  try {
    expect(f.store.system.get<{ user_version: number }>('PRAGMA user_version')!.user_version).toBe(19);
    expect(f.store.system.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(f.store.system.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' });
    const models = await body(await f.call(f.platform, '/models'));
    const byId = Object.fromEntries(models.items.map((row: Json) => [row.id, row]));
    expect(byId.mdl_m).toMatchObject({ provider_id: 'prv_a', upstream_name: 'vendor-a/m-20261121', revision: 1,
      actions: ['read', 'update', 'preview_input_multiplier'], current_pool_revision: 6, channel_count: 1 });
    expect(byId.mdl_legacy).toMatchObject({ current_pool_revision: 0, channel_count: 0 });
    expect(models.actions).toEqual(['create_model']);
    expect((await f.call(f.platform, '/models?provider_id=prv_b')).status).toBe(200);
  } finally { f.close(); }
});

test('platform routing reads and writes reject tenant and non-platform sessions', async () => {
  const f = await setup();
  try {
    const draft = fixture.http.draft;
    for (const token of [f.tenant, f.outsider]) {
      for (const path of ['/providers/prv_a/deployments', '/deployments?target_model_id=mdl_m', '/models/mdl_m/pool/revisions', '/models/mdl_m/pool/revisions/6']) {
        expect((await f.call(token, path)).status).toBe(403);
      }
      expect((await f.call(token, '/models/mdl_m/pool/preview', draft)).status).toBe(403);
      expect((await f.call(token, '/models/mdl_m/pool/revisions', { ...draft, preview_basis: 'pv_x' }, 'k-' + token)).status).toBe(403);
    }
    expect(f.store.system.get('SELECT count(*) AS n FROM model_pool_revisions')).toEqual({ n: 1 });
    expect((await f.call(f.platform, '/providers/prv_none/deployments')).status).toBe(404);
    expect((await f.call(f.platform, '/deployments?target_model_id=mdl_none')).status).toBe(404);
    expect((await f.call(f.platform, '/deployments')).status).toBe(422);
    expect((await f.call(f.platform, '/models/mdl_m/pool/revisions/99')).status).toBe(404);
  } finally { f.close(); }
});

test('channel cards and candidates explain eligibility and assemble the shared draft', async () => {
  const f = await setup();
  try {
    const cards = await body(await f.call(f.platform, '/providers/prv_b/deployments'));
    expect(cards).toMatchObject({ total: 2, next_cursor: null, actions: [] });
    expect(cards.items.map((row: Json) => [row.id, row.raw_model, row.archive_blockers])).toEqual([
      ['dep_b', 'vendor-b/m', []], ['dep_quant', 'vendor-b/m-int4', []]]);
    const a = await body(await f.call(f.platform, '/providers/prv_a/deployments?q=vendor-a'));
    expect(a.items).toMatchObject([{ id: 'dep_a', revision: 1, deployment_revision: 3, account_id: 'acct_a', endpoint_id: 'ep_a', status: 'active',
      capabilities: ['text', 'stream', 'function_tools'], archive_blockers: [{ kind: 'active_pool', model_id: 'mdl_m', pool_revision: 6 }], actions: ['read', 'read_quotes'] }]);

    const first = await body(await f.call(f.platform, '/deployments?target_model_id=mdl_m&limit=2'));
    expect(first.total).toBe(3);
    expect(first.next_cursor).toBeString();
    expect((await f.call(f.platform, `/deployments?target_model_id=mdl_m&limit=2&provider_id=prv_b&cursor=${first.next_cursor}`)).status).toBe(422);
    const rest = await body(await f.call(f.platform, `/deployments?target_model_id=mdl_m&limit=2&cursor=${first.next_cursor}`));
    const rows: Json[] = [...first.items, ...rest.items];
    const quant = rows.find((row) => row.deployment_id === fixture.http.ineligible_candidate.deployment_id)!;
    expect(quant).toMatchObject({ eligible: false, reason: fixture.http.ineligible_candidate.reason, actions: ['read'],
      match: { review_status: 'needs_review', reason: 'quantization_variant' } });
    expect(quant.approved_match_id).toBeUndefined();
    const eligible = rows.filter((row) => row.eligible);
    expect(eligible.map((row) => row.actions)).toEqual([['read', 'select'], ['read', 'select']]);
    const priorities: Record<string, number> = { dep_a: 10, dep_b: 20 };
    const members = orderMembers(eligible.map((row) => ({ deployment_id: row.deployment_id, deployment_revision: row.deployment_revision,
      priority: priorities[row.deployment_id]!, approved_match_id: row.approved_match_id, evidence_ids: row.evidence_ids })));
    expect(members).toEqual(fixture.http.draft.members);
    const b = await body(await f.call(f.platform, '/deployments?target_model_id=mdl_m&provider_id=prv_b&match=accepted'));
    expect(b.items.map((row: Json) => row.deployment_id)).toEqual(['dep_b']);
  } finally { f.close(); }
});

test('shared sample publishes v6 to v7 once, replays idempotently and rejects stale previews', async () => {
  const f = await setup();
  try {
    const draft = fixture.http.draft;
    const preview = await f.call(f.platform, '/models/mdl_m/pool/preview', draft);
    expect(preview.status).toBe(200);
    const view = await body(preview);
    expect(view).toMatchObject({ ...fixture.http.expected_preview, impact: { tenant_count: 1, device_count: 1 } });
    expect(view.preview_basis).toMatch(/^pv_/);
    expect((await body(await f.call(f.platform, '/models/mdl_m/pool/preview', draft))).preview_basis).toBe(view.preview_basis);
    const reordered = { ...draft, members: [...draft.members].reverse() };
    expect((await body(await f.call(f.platform, '/models/mdl_m/pool/preview', reordered))).preview_basis).toBe(view.preview_basis);

    const withQuant = { ...draft, members: [...draft.members, { deployment_id: 'dep_quant', deployment_revision: 1, priority: 30,
      approved_match_id: 'mt_quant', evidence_ids: ['ev_quant'] }] };
    const blocked = await body(await f.call(f.platform, '/models/mdl_m/pool/preview', withQuant));
    expect(blocked).toMatchObject({ publishable: false, actions: ['read'],
      blocking: [{ code: 'model_identity_unverified', deployment_id: 'dep_quant' }] });
    expect((await f.call(f.platform, '/models/mdl_m/pool/revisions', { ...withQuant, preview_basis: blocked.preview_basis }, 'quant')).status).toBe(409);

    const wrongRevision = await f.call(f.platform, '/models/mdl_m/pool/preview', { ...draft, expected_pool_revision: 5 });
    expect(wrongRevision.status).toBe(409);
    expect((await body(wrongRevision)).error.detail).toMatchObject({ reason: 'revision_changed', current_revision: 6 });
    expect((await f.call(f.platform, '/models/mdl_m/pool/preview', { ...draft, members: [draft.members[0], draft.members[0]] })).status).toBe(422);
    expect((await f.call(f.platform, '/models/mdl_m/pool/preview', { ...draft, routing: { ...draft.routing, strategy: 'weighted' } })).status).toBe(422);
    expect((await f.call(f.platform, '/models/mdl_m/pool/revisions', { ...draft, preview_basis: view.preview_basis })).status).toBe(422);

    // Evidence for dep_b expires at +10 min: a basis captured before expiry is stale afterwards.
    f.setClock(clock + 11 * 60_000);
    const expired = await f.call(f.platform, '/models/mdl_m/pool/revisions', { ...draft, preview_basis: view.preview_basis }, 'expired');
    expect(expired.status).toBe(409);
    expect((await body(expired)).error.detail).toMatchObject({ reason: 'preview_stale', current_revision: 6, changed: ['dep_b'] });
    expect((await body(await f.call(f.platform, '/models/mdl_m/pool/preview', draft))).blocking)
      .toEqual([expect.objectContaining({ code: 'evidence_expired', deployment_id: 'dep_b' })]);
    f.setClock(clock);

    const submit = { ...draft, preview_basis: view.preview_basis };
    const [one, two] = await Promise.all([
      f.call(f.platform, '/models/mdl_m/pool/revisions', submit, 'publish-1'),
      f.call(f.platform, '/models/mdl_m/pool/revisions', submit, 'publish-2'),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([201, 409]);
    const [won, lost] = one.status === 201 ? [one, two] : [two, one];
    const published = await body(won);
    expect(published).toMatchObject({ model_id: 'mdl_m', pool_revision: fixture.model.next_pool_revision, actions: ['read'] });
    expect(published.rollout_id).toMatch(/^rol_/);
    expect((await body(lost)).error.detail).toMatchObject({ reason: 'revision_changed', current_revision: 7 });

    const winner = one.status === 201 ? 'publish-1' : 'publish-2';
    const replay = await f.call(f.platform, '/models/mdl_m/pool/revisions', submit, winner);
    expect(replay.status).toBe(201);
    expect(await body(replay)).toEqual(published);
    const mismatch = await f.call(f.platform, '/models/mdl_m/pool/revisions', { ...submit, reason: 'different' }, winner);
    expect(mismatch.status).toBe(409);
    expect((await body(mismatch)).error.detail).toEqual({ reason: 'idempotency_mismatch' });
    expect((await f.call(f.platform, '/models/mdl_m/pool/revisions', submit, 'publish-3')).status).toBe(409);
    expect(f.store.system.get('SELECT count(*) AS n FROM model_pool_revisions WHERE model_id = ?', ['mdl_m'])).toEqual({ n: 2 });
    expect(f.store.system.all('SELECT model_id, pool_revision, job_kind, status FROM route_release_jobs'))
      .toEqual([{ model_id: 'mdl_m', pool_revision: 7, job_kind: 'project', status: 'pending' }]);
    expect(f.store.system.get("SELECT count(*) AS n FROM platform_audit WHERE action = 'model_pool.publish'")).toEqual({ n: 1 });

    const history = await body(await f.call(f.platform, '/models/mdl_m/pool/revisions'));
    expect(history).toMatchObject({ total: 2, current_pool_revision: 7, actions: ['preview_pool'] });
    expect(history.items.map((row: Json) => [row.pool_revision, row.current, row.member_count])).toEqual([[7, true, 2], [6, false, 1]]);
    const v7 = await body(await f.call(f.platform, '/models/mdl_m/pool/revisions/7'));
    expect(v7).toMatchObject({ model_id: 'mdl_m', pool_revision: 7, current: true, based_on_revision: 6, routing: draft.routing, reason: draft.reason,
      rollout: { rollout_id: published.rollout_id, status: 'pending' }, actions: ['read'] });
    expect(v7.members.map((row: Json) => row.deployment_id)).toEqual(fixture.model.follow_deployment_ids);
    expect(v7.members.map(({ provider_id, account_id, endpoint_id, raw_model, ...rest }: Json) => rest)).toEqual(draft.members);
    const v6 = await body(await f.call(f.platform, '/models/mdl_m/pool/revisions/6'));
    expect(v6).toMatchObject({ current: false });
    expect(v6.members.map((row: Json) => row.deployment_id)).toEqual(fixture.model.pinned_v6_deployment_ids);

    const models = await body(await f.call(f.platform, '/models'));
    expect(models.items.find((row: Json) => row.id === 'mdl_m')).toMatchObject({ current_pool_revision: 7, channel_count: 2 });
    const cards = await body(await f.call(f.platform, '/providers/prv_b/deployments'));
    expect(cards.items[0].archive_blockers).toEqual([{ kind: 'active_pool', model_id: 'mdl_m', pool_revision: 7 }]);
    const again = await body(await f.call(f.platform, '/models/mdl_m/pool/preview', { ...draft, expected_pool_revision: 7 }));
    expect(again).toMatchObject({ publishable: false, blocking: [{ code: 'no_change' }], diff: { added: [], removed: [], updated: [] } });
  } finally { f.close(); }
});

test('equal priorities stay publishable and order by deployment id', async () => {
  const f = await setup();
  try {
    const draft = { ...fixture.http.draft, members: fixture.http.draft.members.map((row) => ({ ...row, priority: 10 })).reverse() };
    const view = await body(await f.call(f.platform, '/models/mdl_m/pool/preview', draft));
    expect(view).toMatchObject({ publishable: true, warnings: [] });
    expect(view.draft.members.map((row: Json) => row.deployment_id)).toEqual(['dep_a', 'dep_b']);
    const response = await f.call(f.platform, '/models/mdl_m/pool/revisions', { ...draft, preview_basis: view.preview_basis }, 'tie');
    expect(response.status).toBe(201);
    const v7 = await body(await f.call(f.platform, '/models/mdl_m/pool/revisions/7'));
    expect(v7.members.map((row: Json) => [row.deployment_id, row.priority])).toEqual([['dep_a', 10], ['dep_b', 10]]);
  } finally { f.close(); }
});

async function stalePublish(f: Awaited<ReturnType<typeof setup>>, change: (sql: Transaction) => void, code: string, key: string) {
  const draft = fixture.http.draft;
  const view = await body(await f.call(f.platform, '/models/mdl_m/pool/preview', draft));
  expect(view.publishable).toBe(true);
  await f.store.system.write(change);
  const response = await f.call(f.platform, '/models/mdl_m/pool/revisions', { ...draft, preview_basis: view.preview_basis }, key);
  expect(response.status).toBe(409);
  expect((await body(response)).error.detail).toMatchObject({ reason: 'preview_stale', current_revision: 6 });
  const fresh = await body(await f.call(f.platform, '/models/mdl_m/pool/preview', draft));
  expect(fresh.blocking.map((row: Json) => row.code)).toContain(code);
  const candidates = await body(await f.call(f.platform, '/deployments?target_model_id=mdl_m&provider_id=prv_b&match=accepted'));
  expect(candidates.items[0]).toMatchObject({ eligible: false, actions: ['read'] });
  expect(candidates.items[0].reasons).toContain(code);
  expect(f.store.system.get('SELECT count(*) AS n FROM model_pool_revisions')).toEqual({ n: 1 });
}

test('an endpoint revision moved after preview makes the draft stale', async () => {
  const f = await setup();
  try {
    await stalePublish(f, (sql) => {
      sql.run(`INSERT INTO provider_endpoint_revisions (endpoint_id, endpoint_revision, protocol, base_url, region, fault_domain_id, auth_adapter, created_at)
        VALUES ('ep_b', 2, 'openai_responses', 'https://prv_b.example.test/v2', 'cn', 'fd_b', 'bearer', ?)`, [minutes(0)]);
      sql.run("UPDATE provider_endpoints SET current_revision = 2 WHERE endpoint_id = 'ep_b'");
    }, 'endpoint_revision_changed', 'endpoint');
  } finally { f.close(); }
});

test('superseded evidence makes the draft stale before its validity ends', async () => {
  const f = await setup();
  try {
    await stalePublish(f, (sql) => {
      sql.run(`INSERT INTO model_evidence (evidence_id, deployment_id, deployment_revision, source_kind, outcome, identity_verified, capabilities_json,
        observed_at, valid_until, supersedes_id, created_by) VALUES ('ev_b2', 'dep_b', 2, 'runtime_probe', 'failed', 0, '[]', ?, ?, 'ev_b', 'seed')`,
        [minutes(0), minutes(60)]);
    }, 'evidence_superseded', 'superseded');
  } finally { f.close(); }
});

test('a deployment revision cannot point at an endpoint other than its deployment head', async () => {
  const f = await setup();
  try {
    await expect(f.store.system.write((sql) => sql.run(`INSERT INTO model_deployment_revisions (deployment_id, deployment_revision, endpoint_id,
      endpoint_revision, upstream_model, capabilities_json, created_by, created_at) VALUES ('dep_b', 3, 'ep_a', 1, 'vendor-b/m', '[]', 'seed', ?)`,
      [minutes(0)]))).rejects.toThrow(/FOREIGN KEY/);
  } finally { f.close(); }
});

test('only the identity head authorizes; disabled models stay readable without drafting', async () => {
  const f = await setup();
  try {
    await f.store.system.write((sql) => sql.run(`INSERT INTO model_identity_revisions (model_id, identity_revision, maker_id, model_family,
      model_variant, identity_mode, model_snapshot, capability_floor_json, created_by, created_at)
      VALUES ('mdl_m', 2, 'deepseek', 'v4.1', 'flash', 'pinned_snapshot', '20261201', '["text","stream","images"]', 'seed', ?)`, [minutes(0)]));
    // An unopened higher identity revision does not change eligibility.
    const view = await body(await f.call(f.platform, '/models/mdl_m/pool/preview', fixture.http.draft));
    expect(view).toMatchObject({ publishable: true, blocking: [] });
    await f.store.system.write((sql) => sql.run("UPDATE models SET current_identity_revision = 2 WHERE id = 'mdl_m'"));
    const moved = await f.call(f.platform, '/models/mdl_m/pool/revisions', { ...fixture.http.draft, preview_basis: view.preview_basis }, 'identity');
    expect((await body(moved)).error.detail).toMatchObject({ reason: 'preview_stale' });
    const blocked = await body(await f.call(f.platform, '/models/mdl_m/pool/preview', fixture.http.draft));
    expect(blocked.blocking.map((row: Json) => row.code)).toEqual(expect.arrayContaining(['model_identity_unverified', 'capability_unverified']));

    await f.store.system.write((sql) => sql.run("UPDATE models SET status = 'disabled', current_identity_revision = 1 WHERE id = 'mdl_m'"));
    expect((await f.call(f.platform, '/models/mdl_m/pool/preview', fixture.http.draft)).status).toBe(403);
    expect((await f.call(f.platform, '/models/mdl_m/pool/revisions', { ...fixture.http.draft, preview_basis: view.preview_basis }, 'disabled')).status).toBe(403);
    expect(await body(await f.call(f.platform, '/models/mdl_m/pool/revisions'))).toMatchObject({ total: 1, actions: [] });
    expect((await f.call(f.platform, '/models/mdl_m/pool/revisions/6')).status).toBe(200);
    const candidates = await body(await f.call(f.platform, '/deployments?target_model_id=mdl_m&match=accepted'));
    expect(candidates.items.map((row: Json) => row.actions)).toEqual([['read'], ['read']]);
  } finally { f.close(); }
});

test('cursors reject a modified offset; raw model search is case-sensitive', async () => {
  const f = await setup();
  try {
    const first = await body(await f.call(f.platform, '/deployments?target_model_id=mdl_m&limit=1'));
    const [offset, signature] = String(first.next_cursor).split('.');
    expect(offset).toBe('1');
    expect((await f.call(f.platform, `/deployments?target_model_id=mdl_m&limit=1&cursor=2.${signature}`)).status).toBe(422);
    expect((await f.call(f.platform, `/deployments?target_model_id=mdl_m&limit=1&cursor=${first.next_cursor}`)).status).toBe(200);
    const raw = async (q: string) => (await body(await f.call(f.platform, `/providers/prv_b/deployments?q=${encodeURIComponent(q)}`))).items
      .map((row: Json) => row.id);
    expect(await raw('vendor-b/m-int4')).toEqual(['dep_quant']);
    expect(await raw('VENDOR-B/M-INT4')).toEqual([]);
    expect(await raw('b · m int4')).toEqual(['dep_quant']);
  } finally { f.close(); }
});
