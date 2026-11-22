import { expect, test } from 'bun:test';
import fixture from '../../tests/fixtures/routing/p0-ab.json';
import { body, clock, minutes, setup, type Json, type RoutingFixture } from './routing-fixture';
import { fxUsd, publishSamplePricing, quoteB } from './routing-procurement.test';

async function publishPoolV7(f: RoutingFixture) {
  const view = await body(await f.call(f.platform, '/models/mdl_m/pool/preview', fixture.http.draft));
  expect((await f.call(f.platform, '/models/mdl_m/pool/revisions', { ...fixture.http.draft, preview_basis: view.preview_basis }, 'pool-v7')).status).toBe(201);
}
const preview = (f: RoutingFixture, request: Json) => f.call(f.platform, '/models/mdl_m/input-multiplier/preview', request);
const publish = (f: RoutingFixture, request: Json, key: string) => f.call(f.platform, '/models/mdl_m/input-multiplier/revisions', request, key);
const base = { expected_pool_revision: 7, expected_source_rate_key: null };
const manual = { ...base, manual_input_multiplier_ppm: fixture.pricing.signed_input_multiplier_ppm, reason: '按签约标准报价' };
/** Keep pool evidence valid beyond the FX window so FX expiry is observed on its own. */
const extendEvidence = (f: RoutingFixture, until = minutes(240)) =>
  f.store.system.write((sql) => sql.run("UPDATE model_evidence SET valid_until = ? WHERE evidence_id IN ('ev_a', 'ev_b')", [until]));

test('A/B sample recommends 3x, publishes a manual 4x and reads back its basis without touching issued prices', async () => {
  const f = await setup();
  try {
    await publishPoolV7(f);
    const legacy = (await body(await f.call(f.platform, '/models'))).items.find((row: Json) => row.id === 'mdl_m');
    expect(legacy).toMatchObject({ current_source_rate_key: null, input_multiplier_ppm: 3_500_000, actions: ['read', 'update', 'preview_input_multiplier'] });
    await publishSamplePricing(f);

    const suggested = await body(await preview(f, base));
    expect(suggested).toMatchObject({ model_id: 'mdl_m', pool_revision: 7, pricing_at: minutes(0), input_multiplier_basis: 'cny_1_per_mtok_input',
      calculation_status: 'complete', recommended_input_multiplier_ppm: fixture.pricing.recommended_input_multiplier_ppm, input_multiplier_ppm: 3_000_000,
      input_milli_per_mtok: 3000, output_milli_per_mtok: 12000, cache_read_milli_per_mtok: 1000, cache_write_milli_per_mtok: 5000,
      blocking: [], actions: ['read', 'publish_input_multiplier'] });
    expect(suggested.channels).toEqual([
      { deployment_id: 'dep_a', deployment_revision: 3, quote_id: expect.stringMatching(/^quote_/), quote_revision: 1, currency: 'CNY', amount_micro: '2000000',
        quantity_basis: 1_000_000, unit: 'token', fx_revision: null, rate_numerator: '1', rate_denominator: '1', input_cny_micro_per_mtok: '2000000' },
      { deployment_id: 'dep_b', deployment_revision: 2, quote_id: expect.stringMatching(/^quote_/), quote_revision: 1, currency: 'USD', amount_micro: '400000',
        quantity_basis: 1_000_000, unit: 'token', fx_revision: 1, rate_numerator: '15', rate_denominator: '2', input_cny_micro_per_mtok: '3000000' },
    ]);
    expect((await body(await preview(f, base))).preview_basis).toBe(suggested.preview_basis);

    const unexplained = await body(await preview(f, { ...manual, reason: undefined }));
    expect(unexplained).toMatchObject({ input_multiplier_ppm: 4_000_000, blocking: [{ code: 'reason_required' }], actions: ['read'] });
    const view = await body(await preview(f, manual));
    expect(view).toMatchObject({ input_multiplier_ppm: 4_000_000, input_milli_per_mtok: 4000, recommended_input_multiplier_ppm: 3_000_000, blocking: [] });
    expect((await publish(f, { ...manual, preview_basis: view.preview_basis }, 'no-time')).status).toBe(422);

    const request = { ...manual, pricing_at: view.pricing_at, preview_basis: view.preview_basis };
    const created = await publish(f, request, 'rate-1');
    expect(created.status).toBe(201);
    const result = await body(created);
    expect(result).toEqual({ model_id: 'mdl_m', source_rate_key: expect.stringMatching(/^prate_/), input_multiplier_basis: 'cny_1_per_mtok_input',
      input_multiplier_ppm: 4_000_000, input_milli_per_mtok: 4000, status: 'available_to_sign' });
    expect(await body(await publish(f, request, 'rate-1'))).toEqual(result);
    expect((await body(await publish(f, { ...request, reason: 'other' }, 'rate-1'))).error.detail).toEqual({ reason: 'idempotency_mismatch' });
    const again = await body(await publish(f, request, 'rate-2'));
    expect(again.error.detail).toEqual({ reason: 'revision_changed', current_pool_revision: 7, current_source_rate_key: result.source_rate_key,
      changed: ['source_rate_key'] });

    const detail = await body(await f.call(f.platform, `/models/mdl_m/input-multiplier/revisions/${result.source_rate_key}`));
    expect(detail).toMatchObject({ source_rate_key: result.source_rate_key, input_multiplier_ppm: 4_000_000, recommended_input_multiplier_ppm: 3_000_000,
      input_milli_per_mtok: 4000, output_milli_per_mtok: 12000, cache_read_milli_per_mtok: 1000, cache_write_milli_per_mtok: 5000,
      sales_rates_source: expect.stringMatching(/^legacy_rate:mdl_m@/), pool_revision: 7, pricing_at: view.pricing_at, calculation_status: 'complete',
      override_reason: '按签约标准报价', based_on_source_rate_key: null, status: 'available_to_sign', current: true, actions: ['read'] });
    expect(detail.channels).toEqual(suggested.channels);
    expect((await f.call(f.platform, '/models/mdl_legacy/input-multiplier/revisions/' + result.source_rate_key)).status).toBe(404);

    const ledger = (await body(await f.call(f.platform, '/models'))).items;
    expect(ledger.find((row: Json) => row.id === 'mdl_m')).toMatchObject({ current_source_rate_key: result.source_rate_key, input_multiplier_ppm: 4_000_000 });
    expect(ledger.find((row: Json) => row.id === 'mdl_legacy')).toMatchObject({ current_source_rate_key: null, input_multiplier_ppm: null });
    const next = await body(await preview(f, { ...base, expected_source_rate_key: result.source_rate_key }));
    expect(next).toMatchObject({ recommended_input_multiplier_ppm: 3_000_000, sales_rates_source: `platform_rate:${result.source_rate_key}` });

    expect(f.store.system.all('SELECT input_milli_per_mtok, output_milli_per_mtok FROM rates')).toEqual([{ input_milli_per_mtok: 3500, output_milli_per_mtok: 12000 }]);
    expect(f.store.tenant(f.tenantId).get('SELECT count(*) AS n FROM policy_signatures')).toEqual({ n: 0 });
    expect(f.configChanges()).toBe(0);
  } finally { f.close(); }
});

test('missing, expired and ineligible samples are shown per channel and require a reason', async () => {
  const f = await setup();
  try {
    await publishPoolV7(f);
    const none = await body(await preview(f, base));
    expect(none).toMatchObject({ calculation_status: 'unavailable', recommended_input_multiplier_ppm: null, input_multiplier_ppm: null,
      blocking: [{ code: 'multiplier_unavailable' }, { code: 'reason_required' }], actions: ['read'] });
    expect(none.channels.map((row: Json) => [row.deployment_id, row.reason_code])).toEqual([['dep_a', 'missing_input_quote'], ['dep_b', 'missing_input_quote']]);
    expect((await body(await preview(f, manual))).actions).toEqual(['read', 'publish_input_multiplier']);

    await f.call(f.platform, '/deployments/dep_b/quotes', quoteB, 'qb');
    const noFx = await body(await preview(f, base));
    expect(noFx.channels[1]).toMatchObject({ deployment_id: 'dep_b', currency: 'USD', amount_micro: '400000', reason_code: 'missing_fx', fx_revision: null });
    await publishSamplePricing({ ...f, call: (token, path, payload, key) => path.includes('dep_b') ? Promise.resolve(new Response(null, { status: 201 }))
      : f.call(token, path, payload, key) });
    await extendEvidence(f);
    const partialLater = await body(await preview(f, { ...base, pricing_at: minutes(61) }));
    expect(partialLater).toMatchObject({ calculation_status: 'partial', recommended_input_multiplier_ppm: 2_000_000 });
    expect(partialLater.channels.map((row: Json) => row.reason_code ?? null)).toEqual([null, 'fx_expired']);
    expect(partialLater.channels[0].eligibility_codes).toBeUndefined();

    await f.store.system.write((sql) => sql.run("UPDATE model_evidence SET valid_until = ? WHERE evidence_id = 'ev_b'", [minutes(10)]));
    f.setClock(clock + 11 * 60_000);
    const ineligible = await body(await preview(f, base));
    expect(ineligible.channels[1]).toMatchObject({ deployment_id: 'dep_b', reason_code: 'deployment_ineligible', eligibility_codes: ['evidence_expired'] });
    expect(ineligible).toMatchObject({ calculation_status: 'partial', recommended_input_multiplier_ppm: 2_000_000, blocking: [{ code: 'reason_required' }] });
    const zero = await body(await preview(f, { ...base, manual_input_multiplier_ppm: 0, reason: '免费试点' }));
    expect(zero).toMatchObject({ input_multiplier_ppm: 0, input_milli_per_mtok: 0, blocking: [] });
    expect((await preview(f, { ...base, manual_input_multiplier_ppm: 4_000_500, reason: 'x' })).status).toBe(422);
    expect((await preview(f, { expected_pool_revision: 7 })).status).toBe(422);
  } finally { f.close(); }
});

test('a preview is not publishable after a quote boundary, an FX expiry or a revision change', async () => {
  const f = await setup();
  try {
    await publishPoolV7(f);
    await publishSamplePricing(f);
    await extendEvidence(f);
    // A later B quote starts at +5 min: a preview priced now cannot be published after the boundary.
    expect((await f.call(f.platform, '/deployments/dep_b/quotes', { ...quoteB, expected_quote_revision: 1, valid_from: minutes(5),
      items: [{ ...quoteB.items[0], rate_micro: '500000' }] }, 'qb2')).status).toBe(201);
    const view = await body(await preview(f, manual));
    f.setClock(clock + 6 * 60_000);
    const crossed = await publish(f, { ...manual, pricing_at: view.pricing_at, preview_basis: view.preview_basis }, 'boundary');
    expect((await body(crossed)).error.detail).toEqual({ reason: 'preview_stale', current_pool_revision: 7, current_source_rate_key: null, changed: ['pricing_window'] });
    const after = await body(await preview(f, manual));
    expect(after).toMatchObject({ recommended_input_multiplier_ppm: 3_750_000 });
    expect(after.channels[1]).toMatchObject({ quote_revision: 2, input_cny_micro_per_mtok: '3750000' });
    f.setClock(clock);

    // Priced in the future after FX expiry: refused at publish because the current instant differs.
    const future = await body(await preview(f, { ...manual, pricing_at: minutes(61) }));
    expect(future.channels[1].reason_code).toBe('fx_expired');
    expect((await body(await publish(f, { ...manual, pricing_at: future.pricing_at, preview_basis: future.preview_basis }, 'future'))).error.detail)
      .toMatchObject({ reason: 'preview_stale', changed: ['pricing_window'] });

    const current = await body(await preview(f, manual));
    expect((await f.call(f.platform, '/procurement/fx-rates', { ...fxUsd, expected_fx_revision: 1, valid_from: minutes(1), rate_numerator: '73',
      rate_denominator: '10' }, 'fx2')).status).toBe(201);
    expect((await body(await publish(f, { ...manual, pricing_at: current.pricing_at, preview_basis: current.preview_basis }, 'tampered-basis')))
      .error.detail).toMatchObject({ reason: 'preview_stale' });
    expect((await body(await publish(f, { ...manual, pricing_at: current.pricing_at, preview_basis: 'pv_forged' }, 'forged'))).error.detail)
      .toMatchObject({ reason: 'preview_stale', changed: ['preview_basis'] });
    const stalePool = await preview(f, { ...manual, expected_pool_revision: 6 });
    expect((await body(stalePool)).error.detail).toEqual({ reason: 'revision_changed', current_pool_revision: 7, current_source_rate_key: null,
      changed: ['pool_revision'] });
    expect(f.store.system.get('SELECT count(*) AS n FROM platform_rate_versions')).toEqual({ n: 0 });
  } finally { f.close(); }
});

test('a legacy model with an old rate but no active pool cannot form a signable version', async () => {
  const f = await setup();
  try {
    await f.store.system.write((sql) => sql.run(`INSERT INTO rates (model_id, input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok,
      cache_write_milli_per_mtok, effective_from) VALUES ('mdl_legacy', 2000, 8000, 500, 2500, ?)`, [minutes(-120)]));
    const request = { expected_pool_revision: 0, expected_source_rate_key: null, manual_input_multiplier_ppm: 4_000_000, reason: '旧型号人工定价' };
    const response = await f.call(f.platform, '/models/mdl_legacy/input-multiplier/preview', request);
    expect(response.status).toBe(200);
    const view = await body(response);
    expect(view).toMatchObject({ pool_revision: 0, channels: [], calculation_status: 'unavailable', input_multiplier_ppm: 4_000_000,
      output_milli_per_mtok: 8000, blocking: [{ code: 'missing_pool_revision' }], actions: ['read'] });
    const refused = await f.call(f.platform, '/models/mdl_legacy/input-multiplier/revisions',
      { ...request, pricing_at: view.pricing_at, preview_basis: view.preview_basis }, 'legacy-no-pool');
    expect(refused.status).toBe(422);
    expect((await body(refused)).error.detail).toEqual({ fields: ['body'], issues: [expect.objectContaining({ code: 'missing_pool_revision' })] });
    expect(f.store.system.get('SELECT count(*) AS n FROM platform_rate_versions')).toEqual({ n: 0 });
    expect(f.store.system.get('SELECT count(*) AS n FROM platform_rate_heads')).toEqual({ n: 0 });
    const ledger = (await body(await f.call(f.platform, '/models'))).items.find((row: Json) => row.id === 'mdl_legacy');
    expect(ledger).toMatchObject({ current_source_rate_key: null, input_multiplier_ppm: 2_000_000 });
  } finally { f.close(); }
});

test('multiplier routes are platform-only and closed for disabled models', async () => {
  const f = await setup();
  try {
    await publishPoolV7(f);
    for (const token of [f.tenant, f.outsider]) {
      expect((await f.call(token, '/models/mdl_m/input-multiplier/preview', base)).status).toBe(403);
      expect((await f.call(token, '/models/mdl_m/input-multiplier/revisions', { ...manual, pricing_at: minutes(0), preview_basis: 'pv_x' }, 'k' + token)).status).toBe(403);
      expect((await f.call(token, '/models/mdl_m/input-multiplier/revisions/prate_x')).status).toBe(403);
    }
    await f.store.system.write((sql) => sql.run("UPDATE models SET status = 'disabled' WHERE id = 'mdl_m'"));
    expect((await preview(f, base)).status).toBe(403);
    expect((await body(await f.call(f.platform, '/models'))).items.find((row: Json) => row.id === 'mdl_m').actions).toEqual(['read', 'update']);
  } finally { f.close(); }
});
