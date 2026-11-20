// 假数据契约覆盖（v0.12）：members/groups 带 month_used_milli，demo 账号配额接近上限
// 用于驱动 UI 的接近/超出状态截图验收。Server 接口就绪后随 mock/ 整体删除。
import { test, expect } from 'bun:test'
import { buildMockDb } from '../mock/data.js'
import { quotaUsageLevel } from '../format.js'

test('every member and group row carries month_used_milli', () => {
  const db = buildMockDb()
  for (const tenantId of Object.keys(db.members)) {
    for (const m of db.members[tenantId]) {
      expect(typeof m.month_used_milli).toBe('number')
      expect(m.month_used_milli).toBeGreaterThanOrEqual(0)
    }
    for (const g of db.groups[tenantId]) {
      expect(typeof g.month_used_milli).toBe('number')
      expect('quota_milli' in g).toBe(true)
    }
  }
})

test('demo@onex.dev is fixtured near its personal quota for warn-state screenshots', () => {
  const db = buildMockDb()
  const demo = db.members.ten_demo01.find(m => m.target === 'demo@onex.dev')
  expect(demo.quota_milli).toBe(500000)
  expect(quotaUsageLevel(demo.month_used_milli, demo.quota_milli)).toBe('warn')
})

test('group month_used_milli equals the sum of its members usage', () => {
  const db = buildMockDb()
  for (const tenantId of Object.keys(db.groups)) {
    for (const g of db.groups[tenantId]) {
      const sum = db.members[tenantId].filter(m => m.group_id === g.id).reduce((s, m) => s + (m.month_used_milli || 0), 0)
      expect(g.month_used_milli).toBe(sum)
    }
  }
})
