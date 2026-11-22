import { expect, test } from 'bun:test';
import fixture from '../../tests/fixtures/routing/p0-ab.json';
import { body, minutes, setup, type Json, type RoutingFixture } from './routing-fixture';

const items = (deployment: string) => fixture.pricing.procurement_quotes.filter((row) => row.deployment_id === deployment)
  .map(({ dimension, rate_micro, quantity_basis }) => ({ dimension, rate_micro, quantity_basis, unit: 'token' }));
export const quoteA = { deployment_revision: 3, expected_quote_revision: 0, currency: 'CNY', tariff_scope: { kind: 'deployment' },
  valid_from: minutes(-30), source: { kind: 'manual', reference: 'contract-a' }, reason: 'A 签约采购价', items: items('dep_a') };
export const quoteB = { deployment_revision: 2, expected_quote_revision: 0, currency: 'USD', tariff_scope: { kind: 'deployment' },
  valid_from: minutes(-30), source: { kind: 'manual' }, reason: 'B 签约采购价', items: items('dep_b') };
export const fxUsd = { base_currency: 'USD', quote_currency: 'CNY', expected_fx_revision: 0, rate_numerator: fixture.pricing.fx.rate_numerator,
  rate_denominator: fixture.pricing.fx.rate_denominator, observed_at: minutes(-31), valid_from: minutes(-30), valid_until: minutes(60),
  source: { kind: 'manual', reference: 'treasury' }, reason: '月度汇率' };

export async function publishSamplePricing(f: RoutingFixture) {
  for (const [path, payload, key] of [['/deployments/dep_a/quotes', quoteA, 'qa'], ['/deployments/dep_b/quotes', quoteB, 'qb'],
    ['/procurement/fx-rates', fxUsd, 'fx']] as const) {
    const response = await f.call(f.platform, path, payload, key);
    expect(response.status).toBe(201);
  }
}

test('quotes publish immutably, replay by key and read back exactly', async () => {
  const f = await setup();
  try {
    const published = await f.call(f.platform, '/deployments/dep_b/quotes', quoteB, 'quote-b');
    expect(published.status).toBe(201);
    const record = await body(published);
    expect(record).toMatchObject({ quote_revision: 1, deployment_id: 'dep_b', deployment_revision: 2, provider_id: 'prv_b', account_id: 'acct_b',
      currency: 'USD', tariff_scope: { kind: 'deployment' }, valid_from: quoteB.valid_from, valid_until: null,
      source: { kind: 'manual', reference: null }, items: quoteB.items, actions: ['read'] });
    expect(record.quote_id).toMatch(/^quote_/);

    const replayed = await f.call(f.platform, '/deployments/dep_b/quotes', quoteB, 'quote-b');
    expect(replayed.status).toBe(201);
    expect(await body(replayed)).toEqual(record);
    const mismatch = await f.call(f.platform, '/deployments/dep_b/quotes', { ...quoteB, reason: 'changed' }, 'quote-b');
    expect(mismatch.status).toBe(409);
    expect((await body(mismatch)).error.detail).toEqual({ reason: 'idempotency_mismatch' });
    const stale = await f.call(f.platform, '/deployments/dep_b/quotes', quoteB, 'quote-b-2');
    expect((await body(stale)).error.detail).toEqual({ reason: 'revision_changed', current_revision: 1, changed: ['quote_revision'] });
    const wrongDeployment = await f.call(f.platform, '/deployments/dep_b/quotes', { ...quoteB, expected_quote_revision: 1, deployment_revision: 1,
      valid_from: minutes(0) }, 'quote-b-3');
    expect((await body(wrongDeployment)).error.detail).toMatchObject({ reason: 'revision_changed', changed: ['deployment_revision'] });

    const list = await body(await f.call(f.platform, '/deployments/dep_b/quotes'));
    expect(list).toMatchObject({ total: 1, head_revision: 1, deployment_revision: 2, next_cursor: null, actions: ['publish_quote'] });
    expect(list.applicable).toBeUndefined();
    const { lookup_until, superseded_from, ...listed } = list.items[0];
    expect(listed).toEqual(record);
    expect([lookup_until, superseded_from]).toEqual([null, null]);
    const exact = await body(await f.call(f.platform, `/deployments/dep_b/quotes/${record.quote_id}/revisions/1`));
    expect(exact).toEqual(list.items[0]);
    expect((await f.call(f.platform, `/deployments/dep_a/quotes/${record.quote_id}/revisions/1`)).status).toBe(404);
    expect((await f.call(f.platform, `/deployments/dep_b/quotes/${record.quote_id}/revisions/2`)).status).toBe(404);
    expect(await body(await f.call(f.platform, '/deployments/dep_a/quotes'))).toMatchObject({ total: 0, head_revision: 0, deployment_revision: 3, items: [] });
    expect(f.configChanges()).toBe(0);
  } finally { f.close(); }
});

test('quote and FX input is validated field by field', async () => {
  const f = await setup();
  try {
    const bad: [string, Json][] = [
      ['currency', { currency: 'usd' }], ['currency', { currency: 'US' }], ['items[0].rate_micro', { items: [{ ...quoteB.items[0], rate_micro: '01' }] }],
      ['items[0].rate_micro', { items: [{ ...quoteB.items[0], rate_micro: '-1' }] }],
      ['items[0].rate_micro', { items: [{ ...quoteB.items[0], rate_micro: '9'.repeat(39) }] }],
      ['items[0].rate_micro', { items: [{ ...quoteB.items[0], rate_micro: 400000 }] }],
      ['items[0].unit', { items: [{ ...quoteB.items[0], unit: 'request' }] }],
      ['items[0].unit', { items: [{ dimension: 'request', rate_micro: '1', quantity_basis: 1, unit: 'token' }] }],
      ['items[0].quantity_basis', { items: [{ ...quoteB.items[0], quantity_basis: 0 }] }],
      ['items[0].dimension', { items: [{ ...quoteB.items[0], dimension: 'reasoning' }] }],
      ['items', { items: [quoteB.items[0], quoteB.items[0]] }], ['items', { items: [] }],
      ['items[0].tier', { items: [{ ...quoteB.items[0], tier: 1 }] }],
      ['tariff_scope.kind', { tariff_scope: { kind: 'account_plan' } }], ['valid_until', { valid_until: quoteB.valid_from }],
      ['valid_from', { valid_from: '2026-11-22 01:00:00' }], ['source.kind', { source: { kind: 'provider_api' } }], ['body.discount', { discount: 1 }],
    ];
    for (const [fieldName, change] of bad) {
      const response = await f.call(f.platform, '/deployments/dep_b/quotes', { ...quoteB, ...change }, 'bad-' + fieldName);
      expect([fieldName, response.status]).toEqual([fieldName, 422]);
      expect((await body(response)).error.detail.fields).toContain(fieldName);
    }
    const explicitZero = await f.call(f.platform, '/deployments/dep_b/quotes', { ...quoteB, items: [{ ...quoteB.items[0], rate_micro: '0' }] }, 'zero');
    expect((await body(explicitZero)).items).toEqual([{ ...quoteB.items[0], rate_micro: '0' }]);
    expect((await f.call(f.platform, '/deployments/dep_none/quotes', quoteB, 'none')).status).toBe(404);
    expect((await f.call(f.platform, '/deployments/dep_b/quotes', quoteB)).status).toBe(422);

    const fxBad: [string, Json][] = [['base_currency', { base_currency: 'CNY' }], ['quote_currency', { quote_currency: 'USD' }],
      ['rate_denominator', { rate_denominator: '0' }], ['rate_numerator', { rate_numerator: '7.5' }], ['valid_until', { valid_until: fxUsd.valid_from }],
      ['observed_at', { observed_at: minutes(5) }]];
    for (const [fieldName, change] of fxBad) {
      const response = await f.call(f.platform, '/procurement/fx-rates', { ...fxUsd, ...change }, 'fx-' + fieldName);
      expect([fieldName, response.status]).toEqual([fieldName, 422]);
      expect((await body(response)).error.detail.fields).toContain(fieldName);
    }
    expect((await f.call(f.platform, '/procurement/fx-rates')).status).toBe(422);
    expect((await f.call(f.platform, '/procurement/fx-rates?base_currency=CNY')).status).toBe(422);
  } finally { f.close(); }
});

test('the latest started version applies; a next start truncates, expiry never revives, and the deployment revision must match', async () => {
  const f = await setup();
  try {
    const first = await body(await f.call(f.platform, '/deployments/dep_b/quotes', quoteB, 'q1'));
    const later = { ...quoteB, expected_quote_revision: 1, valid_from: minutes(30), valid_until: minutes(90), reason: '下调',
      items: [{ ...quoteB.items[0], rate_micro: '300000' }] };
    expect((await f.call(f.platform, '/deployments/dep_b/quotes', later, 'q2')).status).toBe(201);
    const notLater = await f.call(f.platform, '/deployments/dep_b/quotes', { ...later, expected_quote_revision: 2, valid_from: minutes(30) }, 'q3');
    expect(notLater.status).toBe(422);
    expect((await body(notLater)).error.detail).toMatchObject({ fields: ['valid_from'], issues: [{ code: 'valid_from_not_after_head' }] });

    const at = async (offset: number) => body(await f.call(f.platform, `/deployments/dep_b/quotes?as_of=${encodeURIComponent(minutes(offset))}`));
    expect((await at(0)).applicable).toMatchObject({ quote_revision: 1, lookup_until: minutes(30), superseded_from: minutes(30) });
    expect((await at(30)).applicable).toMatchObject({ quote_revision: 2, lookup_until: minutes(90) });
    expect(await at(-31)).toMatchObject({ applicable: null, applicable_reason: 'missing_quote' });
    expect(await at(91)).toMatchObject({ applicable: null, applicable_reason: 'quote_expired' });
    const history = await at(0);
    expect(history.items.map((row: Json) => row.quote_revision)).toEqual([2, 1]);
    expect(history.items[1].quote_id).toBe(first.quote_id);

    await f.store.system.write((sql) => {
      sql.run(`INSERT INTO model_deployment_revisions (deployment_id, deployment_revision, endpoint_id, endpoint_revision, upstream_model,
        capabilities_json, created_by, created_at) VALUES ('dep_b', 3, 'ep_b', 1, 'vendor-b/m', '["text","stream"]', 'seed', ?)`, [minutes(0)]);
      sql.run("UPDATE model_deployments SET current_revision = 3 WHERE deployment_id = 'dep_b'");
    });
    expect(await at(0)).toMatchObject({ deployment_revision: 3, applicable: null, applicable_reason: 'quote_deployment_revision_changed' });
    expect((await f.call(f.platform, '/deployments/dep_b/quotes', { ...later, expected_quote_revision: 2, valid_from: minutes(95), valid_until: null }, 'q4')).status).toBe(409);
    expect((await f.call(f.platform, '/deployments/dep_b/quotes', { ...later, expected_quote_revision: 2, deployment_revision: 3, valid_from: minutes(95),
      valid_until: null }, 'q5')).status).toBe(201);
  } finally { f.close(); }
});

test('FX revisions publish, replay and resolve as of a time, and expired FX is not revived', async () => {
  const f = await setup();
  try {
    const published = await f.call(f.platform, '/procurement/fx-rates', fxUsd, 'fx-1');
    expect(published.status).toBe(201);
    const record = await body(published);
    expect(record).toEqual({ base_currency: 'USD', quote_currency: 'CNY', fx_revision: 1, rate_numerator: '15', rate_denominator: '2',
      observed_at: fxUsd.observed_at, valid_from: fxUsd.valid_from, valid_until: fxUsd.valid_until, source: { kind: 'manual', reference: 'treasury' },
      reason: fxUsd.reason, published_by: expect.any(String), published_at: minutes(0), actions: ['read'] });
    expect(await body(await f.call(f.platform, '/procurement/fx-rates', fxUsd, 'fx-1'))).toEqual(record);
    expect((await body(await f.call(f.platform, '/procurement/fx-rates', { ...fxUsd, reason: 'x' }, 'fx-1'))).error.detail)
      .toEqual({ reason: 'idempotency_mismatch' });
    expect((await body(await f.call(f.platform, '/procurement/fx-rates', fxUsd, 'fx-2'))).error.detail)
      .toEqual({ reason: 'revision_changed', current_revision: 1, changed: ['fx_revision'] });

    const at = async (offset: number) => body(await f.call(f.platform, `/procurement/fx-rates?base_currency=USD&as_of=${encodeURIComponent(minutes(offset))}`));
    expect(await at(0)).toMatchObject({ head_revision: 1, total: 1, actions: ['publish_fx_rate'], applicable: { fx_revision: 1, lookup_until: minutes(60) } });
    expect(await at(60)).toMatchObject({ applicable: null, applicable_reason: 'fx_expired' });
    expect(await at(-31)).toMatchObject({ applicable: null, applicable_reason: 'missing_fx' });
    expect(await body(await f.call(f.platform, '/procurement/fx-rates?base_currency=EUR'))).toMatchObject({ head_revision: 0, total: 0, items: [] });
    const { lookup_until, superseded_from, ...exact } = await body(await f.call(f.platform, '/procurement/fx-rates/USD/CNY/revisions/1'));
    expect(exact).toEqual(record);
    for (const path of ['/procurement/fx-rates/USD/EUR/revisions/1', '/procurement/fx-rates/USD/CNY/revisions/2', '/procurement/fx-rates/usd/CNY/revisions/1']) {
      expect((await f.call(f.platform, path)).status).toBe(404);
    }
    expect(f.store.system.get("SELECT count(*) AS n FROM platform_audit WHERE action = 'procurement_fx.publish'")).toEqual({ n: 1 });
  } finally { f.close(); }
});

test('procurement reads and writes are platform-only', async () => {
  const f = await setup();
  try {
    await publishSamplePricing(f);
    for (const token of [f.tenant, f.outsider]) {
      for (const path of ['/deployments/dep_b/quotes', '/procurement/fx-rates?base_currency=USD', '/procurement/fx-rates/USD/CNY/revisions/1']) {
        expect((await f.call(token, path)).status).toBe(403);
      }
      expect((await f.call(token, '/deployments/dep_b/quotes', { ...quoteB, expected_quote_revision: 1, valid_from: minutes(5) }, 'k' + token)).status).toBe(403);
      expect((await f.call(token, '/procurement/fx-rates', { ...fxUsd, expected_fx_revision: 1, valid_from: minutes(5) }, 'f' + token)).status).toBe(403);
    }
    expect(f.store.system.get('SELECT count(*) AS n FROM procurement_quotes')).toEqual({ n: 2 });
    expect(f.store.system.get('SELECT count(*) AS n FROM rates')).toEqual({ n: 1 });
  } finally { f.close(); }
});
