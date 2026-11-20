// fetch 封装：统一 /v1 前缀、Bearer 令牌、错误码映射。
// 401 时回调 onUnauthorized（由 app.js 负责跳登录页），本模块不直接碰 location，保持可测试。

export class ApiError extends Error {
  constructor({ status, code, message, detail }) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export function createApi({ baseUrl = '/v1', getToken = () => null, onUnauthorized = () => {}, fetchImpl = globalThis.fetch } = {}) {
  async function request(path, { method = 'GET', params, body, rawBody, idempotencyKey, signal, binary = false, contentType } = {}) {
    let url = baseUrl + path
    if (params) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
      }
      const s = qs.toString()
      if (s) url += '?' + s
    }
    const headers = { Accept: binary ? 'application/octet-stream' : 'application/json' }
    const token = getToken()
    if (token) headers.Authorization = 'Bearer ' + token
    if (rawBody !== undefined) headers['Content-Type'] = contentType || 'application/octet-stream'
    else if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

    let res
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined),
        signal,
        ...(binary && { redirect: 'error' })
      })
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      throw new ApiError({ status: 0, code: 'network', message: '网络连接失败，请检查网络后重试' })
    }

    if (res.status === 401) {
      if (path === '/auth/login') {
        throw new ApiError({ status: 401, code: 'unauthenticated', message: '账号或验证码无效，请重新获取验证码' })
      }
      if (path === '/auth/token-login') {
        throw new ApiError({ status: 401, code: 'unauthenticated', message: '令牌无效、已过期或已撤销' })
      }
      onUnauthorized()
      throw new ApiError({ status: 401, code: 'unauthenticated', message: '登录已过期，请重新登录' })
    }

    if (binary && res.ok) return res.blob()

    let data = null
    try {
      data = await res.json()
    } catch {
      data = null
    }

    if (!res.ok) {
      const err = (data && data.error) || {}
      throw new ApiError({
        status: res.status,
        code: err.code || 'internal',
        message: err.message || ('请求失败（HTTP ' + res.status + '）'),
        detail: err.detail
      })
    }
    return data
  }

  return {
    request,
    get: (path, opts) => request(path, { ...opts, method: 'GET' }),
    download: (path, opts) => request(path, { ...opts, method: 'GET', binary: true }),
    post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
    put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
    putBinary: (path, rawBody, opts) => request(path, { ...opts, method: 'PUT', rawBody })
  }
}
