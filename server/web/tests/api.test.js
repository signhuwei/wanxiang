import { test, expect } from 'bun:test'
import { createApi, ApiError } from '../api.js'

function fakeFetch(responses) {
  const calls = []
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts })
    const next = responses.shift()
    if (!next) throw new Error('no more fake responses')
    if (next.networkError) throw Object.assign(new Error('boom'), { name: 'TypeError' })
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body
    }
  }
  fn.calls = calls
  return fn
}

test('attaches bearer token and serializes query params', async () => {
  const fetchImpl = fakeFetch([{ body: { items: [], next_cursor: null, total: 0 } }])
  const api = createApi({ fetchImpl, getToken: () => 'tok123' })
  await api.get('/members', { params: { q: '张', cursor: null, limit: 50 } })
  const { url, opts } = fetchImpl.calls[0]
  expect(opts.headers.Authorization).toBe('Bearer tok123')
  expect(url).toContain('/v1/members?')
  expect(url).toContain('q=%E5%BC%A0')
  expect(url).toContain('limit=50')
  expect(url).not.toContain('cursor=')
})

test('sends JSON body and idempotency key on writes', async () => {
  const fetchImpl = fakeFetch([{ body: { ok: true } }])
  const api = createApi({ fetchImpl, getToken: () => 't' })
  await api.post('/members/usr_1', { role: 'admin', revision: 3 }, { idempotencyKey: 'k1' })
  const { opts } = fetchImpl.calls[0]
  expect(opts.method).toBe('POST')
  expect(JSON.parse(opts.body)).toEqual({ role: 'admin', revision: 3 })
  expect(opts.headers['Idempotency-Key']).toBe('k1')
})

test('maps server error payload to ApiError with Chinese message', async () => {
  const fetchImpl = fakeFetch([{
    ok: false,
    status: 409,
    body: { error: { code: 'conflict', message: '数据已被他人修改，请刷新后重试', detail: { revision: 4 } } }
  }])
  const api = createApi({ fetchImpl })
  const err = await api.post('/members/usr_1', {}).catch(e => e)
  expect(err).toBeInstanceOf(ApiError)
  expect(err.code).toBe('conflict')
  expect(err.status).toBe(409)
  expect(err.message).toBe('数据已被他人修改，请刷新后重试')
  expect(err.detail).toEqual({ revision: 4 })
})

test('401 triggers onUnauthorized and throws unauthenticated', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } }])
  let kicked = 0
  const api = createApi({ fetchImpl, onUnauthorized: () => kicked++ })
  const err = await api.get('/me').catch(e => e)
  expect(kicked).toBe(1)
  expect(err.code).toBe('unauthenticated')
  expect(err.message).toBe('登录已过期，请重新登录')
})

test('network failure maps to a Chinese network error', async () => {
  const fetchImpl = fakeFetch([{ networkError: true }])
  const api = createApi({ fetchImpl })
  const err = await api.get('/members').catch(e => e)
  expect(err).toBeInstanceOf(ApiError)
  expect(err.code).toBe('network')
  expect(err.message).toContain('网络')
})

test('non-JSON error body falls back to status text message', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 503, body: null }])
  const api = createApi({ fetchImpl })
  const err = await api.get('/healthz').catch(e => e)
  expect(err.code).toBe('internal')
  expect(err.message).toContain('503')
})
