import {test, expect} from 'bun:test'
import {topupMilli, kinds} from '../billing.js'
test('topups convert decimal erasers to positive exact milli units', () => {
  expect(topupMilli('2.075')).toBe(2075)
  expect(topupMilli('0.001')).toBe(1)
  expect(topupMilli('10')).toBe(10000)
  for (const s of ['', '0', '-1', '0.0005', '1e6', '9007199254740992']) expect(() => topupMilli(s)).toThrow()
})
test('overage_pending ledger rows label as a pending reconciliation, not a settled charge', () => {
  expect(kinds.overage_pending).toBe('超租约差额待核对')
  expect(kinds.settle).not.toBe(kinds.overage_pending)
})
