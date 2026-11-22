import { expect, test } from 'bun:test';
import fixture from '../../tests/fixtures/routing/p0-ab.json';
import { procurementCostCnyMicro, recommendInputMultiplier, salesCostMilli, type ProcurementPrice } from '../src/routing-money';

const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
const rates = {
  input_milli_per_mtok: 3000, output_milli_per_mtok: 15000, cache_read_milli_per_mtok: 300, cache_write_milli_per_mtok: 3750,
};
const input = (rate_micro: string, quantity_basis = 1_000_000) => ({ rate_micro, quantity_basis });
const channel = (amount: string, basis = 1_000_000) => ({ deployment_id: 'dep_a', currency: 'CNY', input: input(amount, basis) });

test('P0 A/B quote, signed sale and B procurement reconcile in their own units', () => {
  const { pricing, wire } = fixture;
  const a = pricing.procurement_quotes.find(row => row.deployment_id === 'dep_a' && row.dimension === 'input')!;
  const b = pricing.procurement_quotes.find(row => row.deployment_id === 'dep_b' && row.dimension === 'input')!;
  const bOutput = pricing.procurement_quotes.find(row => row.deployment_id === 'dep_b' && row.dimension === 'output')!;
  const recommendation = recommendInputMultiplier([{ ...a, input: a }, { ...b, input: b, fx: pricing.fx }]);
  expect(recommendation).toEqual({ calculation_status: 'complete', recommended_input_multiplier_ppm: 3_000_000, unavailable: [] });
  const rate = wire.config.rates[0]!;
  const actual = wire.usage.batch[0]!;
  expect(rate.input_multiplier_ppm).toBe(pricing.signed_input_multiplier_ppm);
  expect(salesCostMilli(actual, rate)).toBe(pricing.sales_cost_milli);
  expect(procurementCostCnyMicro(actual, { currency: b.currency, items: { input: b, output: bOutput } }, pricing.fx, 'exact'))
    .toBe(pricing.procurement_amount_micro);
});

test('compares exact regular-input prices and rounds the maximum up to a single ppm step', () => {
  // 2.001 CNY vs 2.001000333... CNY per million. Dropping the fraction would select the lower step.
  expect(recommendInputMultiplier([channel('2001000'), { ...channel('6003001', 3_000_000), deployment_id: 'dep_b' }])
    .recommended_input_multiplier_ppm).toBe(2_002_000);
  expect(recommendInputMultiplier([channel('2001000')]).recommended_input_multiplier_ppm).toBe(2_001_000);
  expect(recommendInputMultiplier([channel('1', Number.MAX_SAFE_INTEGER)]).recommended_input_multiplier_ppm).toBe(1000);
  expect(recommendInputMultiplier([channel('0')]).recommended_input_multiplier_ppm).toBe(0);
});

test('returns unknowns separately from confirmed zero and retains caller-supplied expiration reasons', () => {
  const expired = [
    { deployment_id: 'expired_fx', reason_code: 'fx_expired' },
    { deployment_id: 'expired_quote', reason_code: 'quote_expired' },
  ];
  const gaps = [
    ...expired,
    { deployment_id: 'missing_price', currency: 'CNY', input: null },
    { deployment_id: 'missing_fx', currency: 'USD', input: input('400000') },
  ];
  const unavailable = [
    ...expired, { deployment_id: 'missing_price', reason_code: 'missing_input_quote' },
    { deployment_id: 'missing_fx', reason_code: 'missing_fx' },
  ];
  expect(recommendInputMultiplier([])).toEqual({ calculation_status: 'unavailable', recommended_input_multiplier_ppm: null, unavailable: [] });
  expect(recommendInputMultiplier(gaps)).toEqual({ calculation_status: 'unavailable', recommended_input_multiplier_ppm: null, unavailable });
  expect(recommendInputMultiplier([channel('0'), ...gaps])).toEqual({
    calculation_status: 'partial', recommended_input_multiplier_ppm: 0, unavailable,
  });
});

test('rejects ambiguous decimals, invalid units and unusable FX pairs', () => {
  for (const malformed of ['', ' 1', '1\n', '-1', '+1', '01', '1.5', '1e4', '１', '9'.repeat(39)]) {
    expect(() => recommendInputMultiplier([channel(malformed)])).toThrow('rate_micro');
  }
  for (const basis of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => recommendInputMultiplier([channel('1', basis)])).toThrow('quantity_basis');
  }
  const usd = { ...channel('400000'), currency: 'USD' };
  for (const override of [{ base_currency: 'CNY' }, { quote_currency: 'USD' }, { rate_numerator: '0' }, { rate_denominator: '0' }]) {
    expect(() => recommendInputMultiplier([{ ...usd, fx: { ...fixture.pricing.fx, ...override } }])).toThrow();
  }
  expect(() => recommendInputMultiplier([channel('99999999999999999')])).toThrow('input_multiplier_ppm');
});

test('matches Edge pricing vectors and rounds the sum of four sale components once', () => {
  expect(salesCostMilli(usage, rates)).toBe(0);
  expect(salesCostMilli({ ...usage, input_tokens: 333334 }, rates)).toBe(1001);
  expect(salesCostMilli({ ...usage, input_tokens: 100, cache_read_tokens: 1000 }, rates)).toBe(1);
  expect(salesCostMilli({ input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1 }, rates)).toBe(1);
  expect(salesCostMilli({ input_tokens: 1000000, output_tokens: 1000000, cache_read_tokens: 1000000, cache_write_tokens: 1000000 }, rates))
    .toBe(22050);
  expect(() => salesCostMilli({ ...usage, output_tokens: -1 }, rates)).toThrow('output_tokens');
  expect(() => salesCostMilli(usage, { ...rates, input_milli_per_mtok: 0.5 })).toThrow('input_milli_per_mtok');
  expect(() => salesCostMilli({ ...usage, input_tokens: Number.MAX_SAFE_INTEGER }, { ...rates, input_milli_per_mtok: 1_000_001 }))
    .toThrow('cost_milli');
});

test('applies the specified procurement rounding once after summing units and an optional request fee', () => {
  const oneOfEach = { ...usage, input_tokens: 1, output_tokens: 1 };
  const quote: ProcurementPrice = { currency: 'CNY', items: { input: input('1', 3), output: input('1', 6), request: input('1', 1) } };
  expect(procurementCostCnyMicro(oneOfEach, quote, null, 'ceil')).toBe('2');
  expect(procurementCostCnyMicro(oneOfEach, quote, null, 'floor')).toBe('1');
  expect(procurementCostCnyMicro(oneOfEach, quote, null, 'half_up')).toBe('2');
  expect(() => procurementCostCnyMicro(oneOfEach, quote, null, 'exact')).toThrow('rounding rule');
  expect(procurementCostCnyMicro(usage, quote, null, 'exact')).toBe('1');
  expect(() => procurementCostCnyMicro({ ...usage, cache_write_tokens: 1 }, quote, null, 'ceil')).toThrow('missing cache_write price');
  expect(() => procurementCostCnyMicro(oneOfEach, { ...quote, currency: 'USD' }, null, 'exact')).toThrow('missing_fx');
  expect(procurementCostCnyMicro(oneOfEach, { ...quote, items: { input: input('0'), output: input('0') } }, null, 'exact')).toBe('0');
});

test('retains micro-CNY beyond JSON safe-integer range and rejects oversized wire results', () => {
  const measured = { ...usage, input_tokens: 1 };
  const items = { input: input('9007199254740993', 1) };
  expect(procurementCostCnyMicro(measured, { currency: 'CNY', items }, null, 'exact')).toBe('9007199254740993');
  expect(() => procurementCostCnyMicro({ ...measured, input_tokens: 2 }, {
    currency: 'CNY', items: { input: input('9'.repeat(38), 1) },
  }, null, 'exact')).toThrow('amount_micro');
});
