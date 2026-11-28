import { expect, test } from 'bun:test'
import { parsePolicyValue, policyValue } from '../policy-controls.js'

test('a registered clause uses its schema and label without a hard-coded policy identifier', () => {
  const base = { id: 'commercial.example', title: '试用折算' }
  const ratio = { ...base, schema: { kind: 'ratio_ppm', min: 0, max: 1000000 } }
  expect(parsePolicyValue(ratio, '0.812345')).toBe(812345)
  expect(policyValue(ratio, 812345)).toBe('0.812345 倍')
  expect(() => parsePolicyValue(ratio, '0.8123456')).toThrow()
  const money = { ...base, schema: { kind: 'money_milli', min: 0, max: 10000 } }
  expect(parsePolicyValue(money, '2.125')).toBe(2125)
  expect(policyValue(money, 2125)).toBe('2.125 粒')
  expect(() => parsePolicyValue(money, '10.001')).toThrow()
})

test('explicit zero, false and empty permissions are distinct from inheritance', () => {
  const boolean = { title: '测试开关', schema: { kind: 'boolean' } }
  expect(parsePolicyValue(boolean, 'false')).toBe(false)
  expect(policyValue(boolean, false)).toBe('关闭')
  expect(policyValue(boolean, undefined)).toBe('—')
  expect(parsePolicyValue({ title: '测试上限', schema: { kind: 'integer' } }, '0')).toBe(0)
  expect(policyValue({ schema: { kind: 'resource_set' } }, [])).toBe('无')
  expect(policyValue({ schema: { kind: 'resource_set' } }, ['item'], { item: '旧版名称' })).toBe('旧版名称')
})

test('enumeration choices are data, including fixed historical labels', () => {
  const clause = { title: '路由类型', schema: { kind: 'enum', options: [{ id: 'low_cost', label: '低成本' }] } }
  expect(parsePolicyValue(clause, 'low_cost')).toBe('low_cost')
  expect(policyValue(clause, 'low_cost')).toBe('低成本')
  expect(() => parsePolicyValue(clause, 'other')).toThrow()
})
