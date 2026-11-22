import { test, expect } from 'bun:test'
import fixture from '../../../tests/fixtures/routing/p0-ab.json'
import { eraserMilli } from '../contract-controls.js'
import {
  modelPriceBody, priceRowFromSaved, rateSourceOptions, salesRateHead, salesRateRow, targetReasonLabel, targetStateLabel,
  rolloutCounts, TARGET_STATES, jobStatusLabel, planRateSummary
} from '../routing-format.js'

const four = { input_milli_per_mtok: 4000, output_milli_per_mtok: 12000, cache_read_milli_per_mtok: 1000, cache_write_milli_per_mtok: 5000 }
const amounts = { input: '4', output: '12', cache_read: '1', cache_write: '5' }

test('commerce price rows: reference only, reference with explicit rates, manual four rates', () => {
  expect(modelPriceBody({ model_id: 'mdl_m', source_rate_key: 'prate_m_2', amounts: {} }, eraserMilli))
    .toEqual({ model_id: 'mdl_m', source_rate_key: 'prate_m_2' })
  expect(modelPriceBody({ model_id: 'mdl_m', source_rate_key: 'prate_m_1', amounts }, eraserMilli))
    .toEqual({ model_id: 'mdl_m', source_rate_key: 'prate_m_1', ...four })
  expect(modelPriceBody({ model_id: 'mdl_m', source_rate_key: null, amounts }, eraserMilli)).toEqual({ model_id: 'mdl_m', ...four })
  expect(() => modelPriceBody({ model_id: 'mdl_m', source_rate_key: 'prate_m_2', amounts: { input: '4' } }, eraserMilli)).toThrow('全部留空或全部填写')
  expect(() => modelPriceBody({ model_id: 'mdl_m', source_rate_key: null, amounts: { input: '4' } }, eraserMilli)).toThrow()
  expect(() => modelPriceBody({ model_id: '', amounts }, eraserMilli)).toThrow('请选择')
})

test('saved plan rows round-trip unchanged, keeping the original reference', () => {
  const saved = { model_id: 'mdl_m', source_rate_key: 'prate_m_1', ...four }
  const row = priceRowFromSaved(saved)
  expect(row).toEqual({ model_id: 'mdl_m', source_rate_key: 'prate_m_1', amounts })
  expect(modelPriceBody(row, eraserMilli)).toEqual(saved)
  const legacy = { model_id: 'm', input_milli_per_mtok: 1500, output_milli_per_mtok: 0, cache_read_milli_per_mtok: 0, cache_write_milli_per_mtok: 0 }
  expect(modelPriceBody(priceRowFromSaved(legacy), eraserMilli)).toEqual(legacy)
})

test('only models with a signable version key are reference options', () => {
  expect(rateSourceOptions({ current_source_rate_key: 'prate_m_2', input_multiplier_ppm: 4000000 }).map(o => o.value)).toEqual(['', 'prate_m_2'])
  expect(rateSourceOptions({ current_source_rate_key: 'prate_m_2', input_multiplier_ppm: 4000000 })[1].label).toBe('当前可签版本 prate_m_2 · 4×')
  // 只有旧展示倍率、没有版本引用：不可引用
  expect(rateSourceOptions({ current_source_rate_key: null, input_multiplier_ppm: 3000000 }).map(o => o.value)).toEqual([''])
  expect(rateSourceOptions({ current_source_rate_key: 'prate_m_2' }, 'prate_m_1').map(o => o.value)).toEqual(['', 'prate_m_2', 'prate_m_1'])
  expect(rateSourceOptions({ current_source_rate_key: 'prate_m_2' }, 'prate_m_2').map(o => o.value)).toEqual(['', 'prate_m_2'])
})

test('sales rate rows: platform shows source, tenant view drops platform-only fields', () => {
  const rate = { rate_version_id: 'rate_m_12', model_id: 'mdl_m', commerce_plan_id: 'cpl_1', source_rate_key: 'prate_m_2', terms_digest: 'x',
    input_multiplier_basis: 'cny_1_per_mtok_input', input_multiplier_ppm: fixture.pricing.signed_input_multiplier_ppm,
    valid_from: '2026-11-22T02:00:00.000Z', valid_until: null, ...four }
  expect(salesRateRow(rate)).toEqual(['mdl_m', '4×', '4', '12', '1', '5', 'prate_m_2', 'cpl_1', '2026-11-22 02:00:00 UTC 起 · 长期', 'rate_m_12'])
  expect(salesRateRow(rate, { tenant: true })).toEqual(['mdl_m', '4×', '4', '12', '1', '5', '2026-11-22 02:00:00 UTC 起 · 长期', 'rate_m_12'])
  expect(salesRateRow({ ...rate, source_rate_key: null }, { frozen: false })).toEqual(['mdl_m', '4×', '4', '12', '1', '5', '方案手填', 'cpl_1'])
  expect(salesRateHead({ tenant: true })).not.toContain('费率来源')
  expect(salesRateHead({ tenant: true }).length).toBe(salesRateRow(rate, { tenant: true }).length)
  expect(salesRateHead({ frozen: false }).length).toBe(salesRateRow(rate, { frozen: false }).length)
})

test('signing plan labels name each model, its multiplier and exact rate source', () => {
  expect(planRateSummary({ terms: { model_prices: [{ model_id: 'mdl_m', source_rate_key: 'prate_m_2', ...four }] } })).toBe('mdl_m 4× · prate_m_2')
  expect(planRateSummary({ terms: { model_prices: [{ model_id: 'm', input_milli_per_mtok: 1500 }] } })).toBe('m 1.5× · 方案手填')
  expect(planRateSummary({ terms: { model_prices: [] } })).toBe('不含模型协议价')
})

test('target states follow the contract and device reasons come from detail.reason', () => {
  expect(TARGET_STATES.map(([k]) => k)).toEqual(['applied', 'superseded', 'rejected', 'needs_upgrade', 'offline', 'pending'])
  expect(targetStateLabel('pending')).toBe('等待应用')
  expect(targetStateLabel('sent')).toBe('sent')
  const reason = fixture.wire.config_applied_rejected.error.detail.reason
  expect(targetReasonLabel(reason)).toBe('缺推理密钥信封（missing_envelope）')
  expect(targetReasonLabel('new_code')).toBe('new_code')
  expect(targetReasonLabel(null)).toBe('—')
  expect(jobStatusLabel('done')).toBe('已完成')
  expect(rolloutCounts({ counts: { applied: 1, pending: 2 } }).map(([, , n]) => n)).toEqual([1, 0, 0, 0, 0, 2])
})
