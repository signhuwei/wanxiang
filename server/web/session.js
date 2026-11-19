// 会话存储：token + user + tenant。损坏或缺 token 一律视为未登录。

const DEFAULT_KEY = 'onex.session'

export function createSessionStore({ storage = globalThis.localStorage, key = DEFAULT_KEY } = {}) {
  function load() {
    let raw = null
    try {
      raw = storage.getItem(key)
    } catch {
      return null
    }
    if (!raw) return null
    let session = null
    try {
      session = JSON.parse(raw)
    } catch {
      return null
    }
    if (!session || typeof session !== 'object' || !session.token) return null
    return session
  }

  function save(session) {
    storage.setItem(key, JSON.stringify(session))
  }

  function clear() {
    try {
      storage.removeItem(key)
    } catch {
      // 存储不可用时无操作
    }
  }

  return { load, save, clear }
}
