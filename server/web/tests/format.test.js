import { test, expect } from 'bun:test'
import { formatMilli, formatDateTime, roleLabel, memberStatusLabel, tenantStatusLabel } from '../format.js'

test('formatMilli renders 毫橡皮 as 橡皮 without floating point noise', () => {
  expect(formatMilli(1500)).toBe('1.5')
  expect(formatMilli(2000000)).toBe('2000')
  expect(formatMilli(1234567)).toBe('1234.567')
  expect(formatMilli(0)).toBe('0')
  expect(formatMilli(-250)).toBe('-0.25')
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
