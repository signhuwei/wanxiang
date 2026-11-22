import { expect, test } from 'bun:test';
import fixture from '../../fixtures/routing/p0-ab.json';

test('pool draft, Edge projection, and use share the same model and deployment versions', () => {
  const { draft } = fixture.http;
  const { config, usage, events, lease, lease_renew, events_ack } = fixture.wire;
  const pool = config.route_pool.pools[0]!;
  const binding = config.route_pool.bindings[0]!;
  const debit = usage.batch[0]!;
  const planned = events.batch.find(row => row.kind === 'route_decision' && row.payload.state === 'planned')!;
  expect(draft.expected_pool_revision + 1).toBe(pool.pool_revision);
  expect(pool.model_id).toBe(fixture.model.id);
  expect(binding.deployment_ids).toEqual(draft.members.map(row => row.deployment_id));
  expect(config.routes.map(row => [row.deployment_id, row.deployment_revision, row.priority]))
    .toEqual(draft.members.map(row => [row.deployment_id, row.deployment_revision, row.priority]));
  expect(debit.request_id).toBe(planned.payload.request_id);
  expect(debit.config_revision).toBe(config.revision);
  expect(debit.deployment_id).toBe('dep_b');
  expect(debit.session_id).toBe(planned.session_id);
  expect(debit.lease_id).toBe(lease.lease_id);
  expect(lease.model_budgets.mdl_m).toBeGreaterThan(debit.cost_milli);
  expect(lease_renew.model_used_milli.mdl_m).toBe(debit.cost_milli);
  expect(events_ack.ack_seq).toBe(debit.seq);
});

test('published procurement values and the frozen sales rate reconcile independently', () => {
  const { pricing, wire } = fixture;
  const row = wire.usage.batch[0]!;
  const rate = wire.config.rates[0]!;
  const fxNumerator = BigInt(pricing.fx.rate_numerator);
  const fxDenominator = BigInt(pricing.fx.rate_denominator);
  const million = 1_000_000n;
  const [aInput, bInput, bOutput] = pricing.procurement_quotes.map(quote => ({
    ...quote, value: BigInt(quote.rate_micro), basis: BigInt(quote.quantity_basis),
  }));
  const aCnyPerMillion = aInput!.value * million / aInput!.basis;
  const bCnyPerMillion = bInput!.value * million * fxNumerator / (bInput!.basis * fxDenominator);
  const highest = aCnyPerMillion > bCnyPerMillion ? aCnyPerMillion : bCnyPerMillion;
  expect(highest).toBe(BigInt(pricing.recommended_input_multiplier_ppm));
  expect(rate.input_multiplier_ppm).toBe(rate.input_milli_per_mtok * 1_000);
  const sales = BigInt(row.input_tokens) * BigInt(rate.input_milli_per_mtok)
    + BigInt(row.output_tokens) * BigInt(rate.output_milli_per_mtok)
    + BigInt(row.cache_read_tokens) * BigInt(rate.cache_read_milli_per_mtok)
    + BigInt(row.cache_write_tokens) * BigInt(rate.cache_write_milli_per_mtok);
  expect((sales + million - 1n) / million).toBe(BigInt(pricing.sales_cost_milli));
  const commonBasis = bInput!.basis * bOutput!.basis * fxDenominator;
  const purchase =
    (BigInt(row.input_tokens) * bInput!.value * bOutput!.basis
      + BigInt(row.output_tokens) * bOutput!.value * bInput!.basis) * fxNumerator;
  expect(purchase % commonBasis).toBe(0n);
  expect(purchase / commonBasis).toBe(BigInt(pricing.procurement_amount_micro));
});
