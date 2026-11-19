// 假数据开关与 fetch 拦截：Server 接口就绪前，页面默认走这里的假实现。
// 显式 ?mock=1 为离线验收，默认请求同源 Server；?mock=0 退出离线模式。

import { buildMockDb } from './data.js'

const FLAG = 'onex.mock'
const FIXED_CODE = '246810'
const LATENCY_MS = 80

export function mockEnabled() {
  let stored = null
  try {
    const url = new URL(globalThis.location.href)
    const p = url.searchParams.get('mock')
    if (p === '1' || p === '0') {
      localStorage.setItem(FLAG, p)
      return p === '1'
    }
    stored = localStorage.getItem(FLAG)
  } catch {
    return false
  }
  return stored === '1'
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function err(status, code, message, detail) {
  return json({ error: { code, message, detail } }, status)
}

function decodeCursor(raw) {
  if (!raw) return 0
  const n = Number(String(raw).replace(/^c/, ''))
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export function installMock() {
  const db = buildMockDb()
  const origFetch = globalThis.fetch

  function sessionOf(init) {
    const headers = (init && init.headers) || {}
    const auth = headers.Authorization || headers.authorization || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    return db.tokens.get(token) || null
  }

  function tenantScoped(session, init) {
    if (!session) return { error: err(401, 'unauthenticated', '未登录或登录已过期，请重新登录') }
    if (!session.tenantId) return { error: err(403, 'forbidden', '请先选择租户') }
    return { session }
  }

  function callerRole(session) {
    const ms = (db.memberships[session.target] || []).find(m => m.tenant_id === session.tenantId)
    return ms ? ms.role : 'member'
  }

  function withActions(member, session) {
    const role = callerRole(session)
    let actions = ['read']
    if (member.target !== session.target && member.role !== 'owner') {
      if (role === 'owner' || role === 'admin') {
        actions = ['read', 'update', 'disable']
      } else if (role === 'group_admin') {
        actions = ['read', 'update']
      }
    }
    return { ...member, actions }
  }

  function listMembers(url, session) {
    const all = db.members[session.tenantId] || []
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    // CONTRACT-PENDING: 契约只定义 q/cursor/limit，role/status 筛选参数待契约确认
    const role = url.searchParams.get('role') || ''
    const status = url.searchParams.get('status') || ''
    let filtered = all
    if (q) filtered = filtered.filter(m => m.name.toLowerCase().includes(q) || m.target.toLowerCase().includes(q))
    if (role) filtered = filtered.filter(m => m.role === role)
    if (status) filtered = filtered.filter(m => m.status === status)
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200)
    const offset = decodeCursor(url.searchParams.get('cursor'))
    const items = filtered.slice(offset, offset + limit).map(m => withActions(m, session))
    const next = offset + limit < filtered.length ? 'c' + (offset + limit) : null
    return json({ items, next_cursor: next, total: filtered.length })
  }

  function findMember(tenantId, id) {
    return (db.members[tenantId] || []).find(m => m.user_id === id)
  }

  async function route(url, init) {
    const method = ((init && init.method) || 'GET').toUpperCase()
    const path = url.pathname.replace(/^\/v1/, '')
    const body = init && init.body ? JSON.parse(init.body) : {}

    // ---- 认证 ----
    if (method === 'POST' && path === '/auth/code') {
      if (!body.target) return err(422, 'invalid', '请输入邮箱或手机号', { fields: ['target'] })
      return json({}, 202) // 开发环境固定验证码 246810
    }

    if (method === 'POST' && path === '/auth/login') {
      const user = db.users[body.target]
      if (!user || body.code !== FIXED_CODE) {
        return err(422, 'invalid', '账号或验证码错误', { fields: ['target', 'code'] })
      }
      if (body.invite_code !== undefined) {
        if (!db.inviteCodes.has(body.invite_code)) {
          return err(422, 'invalid', '邀请码无效或已过期', { fields: ['invite_code'] })
        }
        // 邀请码把账号加入示例制造（幂等）
        const ms = db.memberships[body.target]
        if (!ms.some(m => m.tenant_id === 'ten_demo02')) ms.push({ tenant_id: 'ten_demo02', role: 'member' })
      }
      const token = 'mock-global-' + Math.random().toString(36).slice(2)
      db.tokens.set(token, { target: body.target, tenantId: null })
      const tenants = db.memberships[body.target].map(m => {
        const t = db.tenants.find(t => t.id === m.tenant_id)
        return { id: t.id, name: t.name, role: m.role }
      })
      return json({ token, user, tenants })
    }

    if (method === 'POST' && path === '/auth/select-tenant') {
      const s = sessionOf(init)
      if (!s) return err(401, 'unauthenticated', '未登录或登录已过期，请重新登录')
      const ms = (db.memberships[s.target] || []).find(m => m.tenant_id === body.tenant_id)
      if (!ms) return err(403, 'forbidden', '你不是该租户的成员')
      const token = 'mock-tenant-' + Math.random().toString(36).slice(2)
      db.tokens.set(token, { target: s.target, tenantId: body.tenant_id })
      return json({ token })
    }

    if (method === 'POST' && path === '/auth/logout') {
      const token = new Headers(init.headers).get('Authorization')?.replace(/^Bearer\s+/i, '')
      if (!db.tokens.delete(token)) return err(401, 'unauthenticated', '未登录')
      return new Response(null, { status: 204 })
    }

    if (method === 'GET' && path === '/me') {
      const s = sessionOf(init)
      if (!s) return err(401, 'unauthenticated', '未登录或登录已过期，请重新登录')
      const user = db.users[s.target]
      const is_platform_admin = !!user.platform_admin
      if (!s.tenantId) return json({ user, tenant: null, role: null, agents: [], is_platform_admin, actions: is_platform_admin ? ['create_provider','create_model','create_rate','topup','create_desktop_release'] : [] })
      const t = db.tenants.find(t => t.id === s.tenantId)
      const ms = db.memberships[s.target].find(m => m.tenant_id === s.tenantId)
      const actions = ['owner','admin'].includes(ms?.role) ? ['create_group','create_invite','assign_role:member'] : []
      if (ms?.role === 'owner') actions.push('assign_role:admin','assign_role:group_admin')
      return json({ user, tenant: t, role: ms?.role, agents: [], is_platform_admin, actions })
    }

    // ---- 成员与组（租户范围）----
    if (method === 'GET' && path === '/members') {
      const { session, error } = tenantScoped(sessionOf(init))
      if (error) return error
      return listMembers(url, session)
    }

    const memberMatch = path.match(/^\/members\/([\w-]+)$/)
    if (memberMatch && method === 'GET') {
      const { session, error } = tenantScoped(sessionOf(init))
      if (error) return error
      const m = findMember(session.tenantId, memberMatch[1])
      if (!m) return err(404, 'not_found', '成员不存在')
      return json(withActions(m, session))
    }
    if (memberMatch && method === 'POST') {
      const { session, error } = tenantScoped(sessionOf(init))
      if (error) return error
      const m = findMember(session.tenantId, memberMatch[1])
      if (!m) return err(404, 'not_found', '成员不存在')
      const role = callerRole(session)
      if (role !== 'owner' && role !== 'admin' && role !== 'group_admin') {
        return err(403, 'forbidden', '没有修改成员的权限')
      }
      if (body.revision !== m.revision) {
        return err(409, 'conflict', '数据已被他人修改，请刷新后重试', { revision: m.revision })
      }
      if (body.role !== undefined) {
        if (!['admin', 'group_admin', 'member'].includes(body.role)) {
          return err(422, 'invalid', '角色取值无效', { fields: ['role'] })
        }
        m.role = body.role
      }
      if (body.group_id !== undefined) {
        const g = (db.groups[session.tenantId] || []).find(g => g.id === body.group_id)
        m.group_id = g ? g.id : null
        m.group_name = g ? g.name : null
      }
      if (body.quota_milli !== undefined) {
        if (body.quota_milli !== null && (!Number.isFinite(body.quota_milli) || body.quota_milli < 0)) {
          return err(422, 'invalid', '配额必须是不小于 0 的整数（毫橡皮）', { fields: ['quota_milli'] })
        }
        m.quota_milli = body.quota_milli
      }
      if (body.status !== undefined) {
        if (!['active', 'disabled'].includes(body.status)) {
          return err(422, 'invalid', '状态取值无效', { fields: ['status'] })
        }
        if (m.target === session.target) return err(403, 'forbidden', '不能禁用自己的账号')
        m.status = body.status
      }
      m.revision += 1
      return json(withActions(m, session))
    }

    if (method === 'GET' && path === '/groups') {
      const { session, error } = tenantScoped(sessionOf(init))
      if (error) return error
      const items = db.groups[session.tenantId] || []
      return json({ items, next_cursor: null, total: items.length })
    }

    return err(404, 'not_found', '接口不存在（假数据未覆盖）：' + method + ' ' + path)
  }

  globalThis.fetch = async function mockFetch(input, init) {
    const raw = typeof input === 'string' ? input : input.url
    const url = new URL(raw, globalThis.location.origin)
    if (!url.pathname.startsWith('/v1/')) return origFetch(input, init)
    await new Promise(r => setTimeout(r, LATENCY_MS))
    try {
      return await route(url, init)
    } catch (e) {
      return err(500, 'internal', '假数据服务出错：' + (e && e.message), { trace_id: 'mock' })
    }
  }
}
