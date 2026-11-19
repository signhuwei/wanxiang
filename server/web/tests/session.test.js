import { test, expect } from 'bun:test'
import { createSessionStore } from '../session.js'

function memStorage() {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  }
}

test('save and load round-trip the session', () => {
  const s = createSessionStore({ storage: memStorage() })
  const session = { token: 't1', user: { id: 'usr_1', name: '张三' }, tenant: { id: 'ten_1', name: '万象' } }
  s.save(session)
  expect(s.load()).toEqual(session)
})

test('load returns null when nothing is stored', () => {
  const s = createSessionStore({ storage: memStorage() })
  expect(s.load()).toBe(null)
})

test('corrupt stored value is treated as logged out, not as empty session', () => {
  const storage = memStorage()
  storage.setItem('onex.session', '{broken json')
  const s = createSessionStore({ storage })
  expect(s.load()).toBe(null)
})

test('session without token is treated as logged out', () => {
  const s = createSessionStore({ storage: memStorage() })
  s.save({ user: { id: 'usr_1' } })
  expect(s.load()).toBe(null)
})

test('clear removes the session', () => {
  const s = createSessionStore({ storage: memStorage() })
  s.save({ token: 't', user: {}, tenant: {} })
  s.clear()
  expect(s.load()).toBe(null)
})
