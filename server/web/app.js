// 外壳：顶栏（工作域切换、租户与账号、登出）+ hash 路由。
// 路由最多两层：#/login、#/tenant/members、#/platform、#/platform/releases。钻取状态留在内存里，不进 URL。

import { createApi } from './api.js'
import { createSessionStore } from './session.js'
import { showToast } from './toast.js'
import { devicesPage } from './devices.js'
import { observePage } from './observation.js'
import { billingPage } from './billing.js'
import { auditPage } from './audit.js'
import { catalog } from './catalog.js'
import { contractPage } from './contract.js'
import { groupsPage } from './groups.js'
import { renderLogin } from './login.js'
import { renderMembersPage } from './members.js'
import { releasesPage } from './releases.js'
import { mockEnabled, installMock } from './mock/index.js'

const mockOn = mockEnabled()
if (mockOn) installMock()

const sessionStore = createSessionStore({ key: mockOn ? 'onex.session.mock' : 'onex.session' })
let session = sessionStore.load()
let checkingAuditPermission = Boolean(session?.tenant)
let pendingToken = null // 登录流程中、选租户之前的全局令牌

const api = createApi({
  getToken: () => (session && session.token) || pendingToken,
  onUnauthorized: () => {
    const hadSession = !!session
    session = null
    pendingToken = null
    sessionStore.clear()
    if (location.hash === '#/login') {
      route()
    } else {
      location.hash = '#/login'
    }
    if (hadSession) showToast('登录已过期，请重新登录', 'error')
  }
})

const platformApi = createApi({ getToken: () => session?.globalToken, onUnauthorized: () => {
  sessionStore.clear(); session = null; location.hash = '#/login'
} })
const app = document.getElementById('app')

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

function canReadAudit() {
  return Boolean(session?.tenant && Array.isArray(session.actions) && session.actions.includes('read_audit'))
}

function renderTop(hash) {
  const top = el('div', 'top')
  const brand = el('div', 'brand', 'OneX')
  brand.appendChild(el('small', null, '万象'))
  top.appendChild(brand)

  if (session) {
    const domains = el('nav', 'domains')
    const tenantLink = el('a', null, '租户')
    tenantLink.href = '#/tenant/members'
    tenantLink.classList.toggle('selected', hash.startsWith('#/tenant'))
    domains.appendChild(tenantLink)
    if (session.tenant && hash.startsWith('#/tenant')) {
      const pages = [['members','成员'], ['groups','分组'], ['contract','合约'], ['billing','橡皮'], ['observe','监察'], ['devices','设备']]
      if (canReadAudit()) pages.push(['audit', '审计'])
      for (const [path, label] of pages) {
        const link = el('a', hash === '#/tenant/' + path ? 'selected' : '', label)
        link.href = '#/tenant/' + path
        domains.append(link)
      }
    }
    if (session.is_platform_admin) {
      const platformLink = el('a', null, '平台')
      platformLink.href = '#/platform'
      platformLink.classList.toggle('selected', hash.startsWith('#/platform'))
      domains.appendChild(platformLink)
      if (hash.startsWith('#/platform')) {
        for (const [path, label] of [['catalog', 'Provider'], ['releases', '安装包发布']]) {
          const sel = hash === '#/platform/' + path || (path === 'catalog' && hash === '#/platform')
          const link = el('a', sel ? 'selected' : '', label)
          link.href = '#/platform/' + path
          domains.append(link)
        }
      }
    }
    top.appendChild(domains)

    const tools = el('div', 'top-tools')
    if (mockOn || session.mock_actions) tools.appendChild(el('span', 'mock-badge', mockOn ? '假数据' : '权限：假数据'))
    if (session.tenant) {
      const tn = el('span', 'tenant-name muted', session.tenant.name)
      tools.appendChild(tn)
    }
    if (session.user && session.user.name) tools.appendChild(el('span', null, session.user.name))
    const logout = el('button', 'link', '退出')
    logout.addEventListener('click', async () => {
      const globalToken = session?.globalToken
      const scopedToken = session?.token
      try {
        await api.post('/auth/logout')
      } catch {
        // 登出失败也清本地会话
      }
      if (globalToken && globalToken !== scopedToken) {
        await createApi({ getToken: () => globalToken }).post('/auth/logout').catch(() => {})
      }
      session = null
      sessionStore.clear()
      location.hash = '#/login'
    })
    tools.appendChild(logout)
    top.appendChild(tools)
  }

  app.appendChild(top)
}

function renderPlatformPlaceholder(ws) {
  const page = el('div', 'page')
  const toolbar = el('div', 'toolbar')
  toolbar.appendChild(el('h1', null, '平台'))
  page.appendChild(toolbar)
  const scroll = el('div', 'table-scroll')
  scroll.appendChild(el('p', 'empty', '平台管理能力（租户管理、Provider 与倍率、发行目录）将在下一批交付'))
  page.appendChild(scroll)
  ws.appendChild(page)
}

function defaultHash() {
  if (!session) return '#/login'
  return session.tenant ? '#/tenant/members' : '#/platform'
}

let lifecycle
function route() {
  lifecycle?.abort()
  lifecycle = new AbortController()
  const hash = location.hash || '#/'
  app.textContent = ''
  renderTop(hash)
  const ws = el('div', 'workspace')
  app.appendChild(ws)

  if (hash === '#/login') {
    if (session) {
      location.replace(defaultHash())
      return
    }
    renderLogin(ws, {
      api,
      mockOn,
      setPendingToken: t => { pendingToken = t },
      onSession: s => {
        session = s
        pendingToken = null
        sessionStore.save(s)
        location.hash = defaultHash()
      }
    })
    return
  }

  if (!session) {
    location.replace('#/login')
    return
  }

  if (hash.startsWith('#/platform')) {
    if (!(session.is_platform_admin)) {
      location.replace(defaultHash())
      return
    }
    if (hash === '#/platform/releases') releasesPage(ws, platformApi, session.globalActions || [])
    else catalog(ws, platformApi, session.globalActions || [])
    return
  }

  if (hash.startsWith('#/tenant')) {
    if (!session.tenant) {
      location.replace(defaultHash())
      return
    }
    if (hash === '#/tenant/groups') groupsPage(ws, api, session.actions || [])
    else if (hash === '#/tenant/devices') devicesPage(ws, api, lifecycle.signal, mockOn)
    else if (hash === '#/tenant/observe') observePage(ws, api, session, lifecycle.signal)
    else if (hash === '#/tenant/billing') billingPage(ws, api, platformApi, session)
    else if (hash === '#/tenant/contract') contractPage(ws, api)
    else if (hash === '#/tenant/audit') {
      if (checkingAuditPermission) ws.appendChild(el('p', 'empty', '正在确认审计权限…'))
      else if (canReadAudit()) auditPage(ws, api, lifecycle.signal)
      else ws.appendChild(el('p', 'empty', '当前账号没有审计查询权限'))
    }
    else renderMembersPage(ws, { api, actions: session.actions || [] })
    return
  }

  location.replace(defaultHash())
}

async function refreshTenantActions(restored) {
  let me
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 5000)
  try {
    me = await api.get('/me', { signal: ctrl.signal })
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
  if (session !== restored || me?.tenant?.id !== restored.tenant.id || !Array.isArray(me.actions)) return false
  const existing = new Set(Array.isArray(restored.actions) ? restored.actions : [])
  if (existing.size === me.actions.length && me.actions.every(action => existing.has(action))) return false
  session = { ...restored, actions: me.actions }
  try { sessionStore.save(session) } catch {
    // 浏览器禁止持久化时，本次页面仍使用刷新后的权限。
  }
  return true
}

window.addEventListener('hashchange', route)
const restored = session?.tenant ? session : null
route()
if (restored) {
  refreshTenantActions(restored).then(changed => {
    checkingAuditPermission = false
    if (changed || location.hash === '#/tenant/audit') route()
  })
}
