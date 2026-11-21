import { test, expect } from 'bun:test'
import {
  formatMilli, formatDateTime, formatBytes, roleLabel, memberStatusLabel, tenantStatusLabel,
  formatQuotaUsage, quotaUsageLevel, parseQuotaEraserInput, QUOTA_INVALID_MESSAGE
} from '../format.js'

test('formatMilli renders 毫橡皮 as 橡皮 without floating point noise', () => {
  expect(formatMilli(1500)).toBe('1.5')
  expect(formatMilli(2000000)).toBe('2000')
  expect(formatMilli(1234567)).toBe('1234.567')
  expect(formatMilli(0)).toBe('0')
  expect(formatMilli(-250)).toBe('-0.25')
  expect(formatMilli(Number.MAX_SAFE_INTEGER)).toBe('9007199254740.991')
})

test('formatMilli shows 不限 for null/undefined quota', () => {
  expect(formatMilli(null)).toBe('不限')
  expect(formatMilli(undefined)).toBe('不限')
})

test('formatDateTime renders local YYYY-MM-DD HH:mm', () => {
  const out = formatDateTime('2026-11-19T08:30:00Z')
  expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  expect(formatDateTime(null)).toBe('—')
  expect(formatDateTime('')).toBe('—')
  expect(formatDateTime('not-a-date')).toBe('—')
})

test('formatBytes picks the largest unit that keeps the number readable', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(2048)).toBe('2 KB')
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(256 * 1024 * 1024)).toBe('256 MB')
  expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  expect(formatBytes(null)).toBe('—')
  expect(formatBytes(undefined)).toBe('—')
  expect(formatBytes(-1)).toBe('—')
})

test('role and status labels are Chinese', () => {
  expect(roleLabel('owner')).toBe('户主')
  expect(roleLabel('admin')).toBe('管理员')
  expect(roleLabel('group_admin')).toBe('组管')
  expect(roleLabel('member')).toBe('成员')
  expect(roleLabel('whatever')).toBe('whatever')
  expect(memberStatusLabel('active')).toBe('正常')
  expect(memberStatusLabel('disabled')).toBe('已禁用')
  expect(tenantStatusLabel('active')).toBe('正常')
  expect(tenantStatusLabel('suspended')).toBe('已暂停')
})

test('formatQuotaUsage shows used / quota, with 不限 for a null cap', () => {
  expect(formatQuotaUsage(120000, 500000)).toBe('120 / 500')
  expect(formatQuotaUsage(0, null)).toBe('0 / 不限')
  expect(formatQuotaUsage(undefined, 500000)).toBe('0 / 500')
})

test('quotaUsageLevel flags near-limit and over-limit usage, unlimited is always ok', () => {
  expect(quotaUsageLevel(100000, 500000)).toBe('ok')      // 20%
  expect(quotaUsageLevel(400000, 500000)).toBe('warn')    // 80%
  expect(quotaUsageLevel(500000, 500000)).toBe('error')   // 到量
  expect(quotaUsageLevel(600000, 500000)).toBe('error')   // 超量
  expect(quotaUsageLevel(999999999, null)).toBe('ok')     // 不限
})

test('parseQuotaEraserInput accepts non-negative 橡皮 with up to 3 decimals and null for 不限', () => {
  expect(parseQuotaEraserInput(null)).toEqual({ quotaMilli: null })
  expect(parseQuotaEraserInput('')).toEqual({ quotaMilli: null })
  expect(parseQuotaEraserInput(0)).toEqual({ quotaMilli: 0 })
  expect(parseQuotaEraserInput('500')).toEqual({ quotaMilli: 500000 })
  expect(parseQuotaEraserInput(500)).toEqual({ quotaMilli: 500000 })
  expect(parseQuotaEraserInput('123.456')).toEqual({ quotaMilli: 123456 })
  expect(parseQuotaEraserInput(0.001)).toEqual({ quotaMilli: 1 })
})

test('parseQuotaEraserInput rejects negative numbers and non-numeric input', () => {
  for (const bad of [-1, '-1', -0.001, '0.0005', '1e6', '9007199254740.992', 'abc', NaN]) {
    expect(parseQuotaEraserInput(bad)).toEqual({ error: QUOTA_INVALID_MESSAGE })
  }
})
