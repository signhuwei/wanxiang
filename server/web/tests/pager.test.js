import { test, expect } from 'bun:test'
import { createPager } from '../pager.js'

test('starts at page 1 with no cursor and cannot go back', () => {
  const p = createPager()
  expect(p.page).toBe(0)
  expect(p.cursor()).toBe(null)
  expect(p.canPrev()).toBe(false)
  expect(p.canNext()).toBe(false)
})

test('records next_cursor after each fetch and walks forward', () => {
  const p = createPager()
  p.applyResult('cur-page-2')
  expect(p.canNext()).toBe(true)
  expect(p.next()).toBe(true)
  expect(p.page).toBe(1)
  expect(p.cursor()).toBe('cur-page-2')
  expect(p.canNext()).toBe(false) // no result applied for page 2 yet
  p.applyResult('cur-page-3')
  expect(p.next()).toBe(true)
  expect(p.page).toBe(2)
  expect(p.cursor()).toBe('cur-page-3')
})

test('walks back through visited pages without refetching cursors', () => {
  const p = createPager()
  p.applyResult('c2')
  p.next()
  p.applyResult('c3')
  p.next()
  expect(p.page).toBe(2)
  expect(p.prev()).toBe(true)
  expect(p.page).toBe(1)
  expect(p.cursor()).toBe('c2')
  // after going back, forward is possible again because page 3 start is known
  expect(p.canNext()).toBe(true)
  expect(p.prev()).toBe(true)
  expect(p.page).toBe(0)
  expect(p.cursor()).toBe(null)
})

test('end of list: null next_cursor disables forward nav', () => {
  const p = createPager()
  p.applyResult(null)
  expect(p.canNext()).toBe(false)
  expect(p.next()).toBe(false)
})

test('reset drops all cursor history (query or filter changed)', () => {
  const p = createPager()
  p.applyResult('c2')
  p.next()
  p.applyResult('c3')
  p.next()
  p.reset()
  expect(p.page).toBe(0)
  expect(p.cursor()).toBe(null)
  expect(p.canPrev()).toBe(false)
  expect(p.canNext()).toBe(false)
})

test('snapshot and restore round-trips the full navigation state', () => {
  const p = createPager()
  p.applyResult('c2')
  p.next()
  p.applyResult('c3')
  p.next()
  const snap = p.snapshot()
  const q = createPager(snap)
  expect(q.page).toBe(2)
  expect(q.cursor()).toBe('c3')
  expect(q.canNext()).toBe(false)
  expect(q.prev()).toBe(true)
  expect(q.cursor()).toBe('c2')
})
