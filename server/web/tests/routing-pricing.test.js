import { test, expect } from 'bun:test'
import fixture from '../../../tests/fixtures/routing/p0-ab.json'
import {
  parseMicro, formatMicro, unitPriceText, parseRatio, formatRatio, formatMultiplier, parseMultiplier, pricingReason,
  calculationLabel, isoInput, submissionKeys, asOfRound
} from '../routing-format.js'

test('pricing: decimal strings, rational FX and multipliers from the shared A/B sample', () => {
  const [qa, qb, qbOut] = fixture.pricing.procurement_quotes
  expect(parseMicro('2')).toBe(qa.rate_micro)
  expect(parseMicro('0.40')).toBe(qb.rate_micro)
  expect(parseMicro('4')).toBe(qbOut.rate_micro)
  expect(parseMicro('')).toBeNull()
  expect(parseMicro('0')).toBe('0')
  expect(() => parseMicro('0.1234567')).toThrow('6 位小数')
  expect(() => parseMicro('-1')).toThrow()
  expect(formatMicro(qa.rate_micro, 'CNY')).toBe('¥2.00')
  expect(formatMicro(qb.rate_micro, 'USD')).toBe('US$0.40')
  expect(formatMicro(fixture.pricing.procurement_amount_micro, 'CNY')).toBe('¥0.05')
  expect(formatMicro('123', 'EUR')).toBe('0.000123 EUR')
  expect(formatMicro(null, 'CNY')).toBe('未知')
  expect(unitPriceText({ rate_micro: '400000', quantity_basis: 1000000, unit: 'token' }, 'USD')).toBe('US$0.40 / 1,000,000 token')
  expect(unitPriceText(undefined, 'USD')).toBe('缺项')
  expect(parseRatio('7.50')).toEqual({ rate_numerator: fixture.pricing.fx.rate_numerator, rate_denominator: fixture.pricing.fx.rate_denominator })
  expect(formatRatio('15', '2')).toBe('7.5')
  expect(formatRatio('1', '3')).toBe('≈0.333333')
  expect(() => parseRatio('0')).toThrow('大于 0')
  expect(formatMultiplier(fixture.pricing.recommended_input_multiplier_ppm)).toBe('3×')
  expect(formatMultiplier(fixture.pricing.signed_input_multiplier_ppm)).toBe('4×')
  expect(formatMultiplier(3250000)).toBe('3.25×')
  expect(formatMultiplier(null)).toBe('—')
  expect(parseMultiplier('4')).toBe(fixture.pricing.signed_input_multiplier_ppm)
  expect(parseMultiplier('0.001')).toBe(1000)
  expect(() => parseMultiplier('1.2345')).toThrow('3 位小数')
  expect(pricingReason('fx_expired')).toBe('汇率已过期')
  expect(calculationLabel('partial')).toBe('部分试算（有缺项）')
  expect(isoInput('2026-11-22T00:00:00Z', 't')).toBe('2026-11-22T00:00:00.000Z')
  expect(isoInput('', 't', false)).toBeNull()
  expect(() => isoInput('2026-11-22', 't')).toThrow('UTC')
})

test('as_of is frozen for a paging round and renewed only when the cursor resets', () => {
  let t = 0
  const asOf = asOfRound(() => 'T' + (++t))
  expect(asOf(null)).toBe('T1')
  expect(asOf('p2')).toBe('T1')
  expect(asOf('p3')).toBe('T1')
  expect(asOf(null)).toBe('T2')
  expect(asOf('p2')).toBe('T2')
  expect(pricingReason('missing_fx')).toBe('缺汇率')
  expect(pricingReason('quote_deployment_revision_changed')).toBe('报价对应的部署修订已变化')
})

test('submission keys reuse a key only for the identical body until the server answers', () => {
  let n = 0
  const keys = submissionKeys(() => 'k' + (++n))
  expect(keys.for({ a: 1 })).toBe('k1')
  expect(keys.for({ a: 1 })).toBe('k1')
  expect(keys.for({ a: 2 })).toBe('k2')
  keys.answered()
  expect(keys.for({ a: 2 })).toBe('k3')
})
