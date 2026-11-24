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

test('a delayed 401 from an old session does not sign out a new session', async () => {
  let token = 'old'
  let unauthorized = 0
  let respond
  const api = createApi({
    getToken: () => token,
    onUnauthorized: () => unauthorized++,
    fetchImpl: () => new Promise(resolve => { respond = resolve })
  })
  const previous = api.get('/me')
  token = 'new'
  respond(new Response(null, { status: 401 }))
  await expect(previous).rejects.toMatchObject({ status: 401 })
  expect(unauthorized).toBe(0)
})

test('downloads diagnostic bytes with the session token and rejects redirects', async () => {
  const fetchImpl = async (url, opts) => {
    expect(url).toBe('/v1/diag/dia_1/download')
    expect(opts.headers.Authorization).toBe('Bearer test-token')
    expect(opts.headers.Accept).toBe('application/octet-stream')
    expect(opts.redirect).toBe('error')
    return new Response(new Uint8Array([1, 2, 3]))
  }
  const api = createApi({ fetchImpl, getToken: () => 'test-token' })
  const blob = await api.download('/diag/dia_1/download')
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
})

test('a rejected login stays on the form and explains the invalid credentials', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 401 }])
  let kicked = 0
  const api = createApi({ fetchImpl, onUnauthorized: () => kicked++ })
  const err = await api.post('/auth/login', {}).catch(e => e)
  expect(err.message).toContain('验证码')
  expect(kicked).toBe(0)
})

test('password sign-in refuses redirects and leaves the login form in place on 401', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 401 }])
  let kicked = 0
  const api = createApi({ fetchImpl, onUnauthorized: () => kicked++ })
  const err = await api.post('/auth/password-login', {}).catch(e => e)
  expect(err.message).toContain('租户、用户名或密码')
  expect(fetchImpl.calls[0].opts.redirect).toBe('error')
  expect(kicked).toBe(0)
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

test('a rejected personal-token login stays on the selected login form', async () => {
  let unauthorized = 0
  const api = createApi({
    onUnauthorized: () => { unauthorized++ },
    fetchImpl: async () => new Response('{}', { status: 401 })
  })
  await expect(api.post('/auth/token-login', { token: 'fixture-only' })).rejects.toMatchObject({
    status: 401, code: 'unauthenticated', message: '令牌无效、已过期或已撤销'
  })
  expect(unauthorized).toBe(0)
})
