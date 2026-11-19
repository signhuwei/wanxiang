import { test, expect } from 'bun:test'
import { idempotencyKey } from '../idempotency.js'

test('keys are unique across many calls and never collide', () => {
  const keys = new Set(Array.from({ length: 2000 }, idempotencyKey))
  expect(keys.size).toBe(2000)
})

test('keys are a fixed-length hex string, not crypto.randomUUID output', () => {
  const key = idempotencyKey()
  expect(key).toMatch(/^[0-9a-f]{32}$/)
})
