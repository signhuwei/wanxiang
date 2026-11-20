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
import { bindTokenLoginTrigger, renderLogin } from './login.js'
import { renderMembersPage } from './members.js'
import { releasesPage } from './releases.js'
import { personalTokensPage } from './personal-tokens.js'
import { formatMilli } from './format.js'
import { mockEnabled, installMock } from './mock/index.js'

const mockOn = mockEnabled()
if (mockOn) installMock()

const sessionStore = createSessionStore({ key: mockOn ? 'onex.session.mock' : 'onex.session' })
let session = sessionStore.load()
let checkingAuditPermission = Boolean(session?.tenant)
let pendingToken = null // 登录流程中、选租户之前的全局令牌
let openLoginTokenForm

const api = createApi({
  getToken: () => session?.token || pendingToken,
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

// 个人菜单的配额提示：remaining_milli 为 null 表示不限；limited_by 为 group:<id> 时异步解出组名。
function appendQuotaItem(items, quota) {
  const remainingText = quota.remaining_milli === null || quota.remaining_milli === undefined
    ? '不限'
    : formatMilli(quota.remaining_milli) + ' 橡皮'
  const line = el('div', 'quota-item muted')
  const label = el('span', null, '本月剩余：')
  const value = el('span', 'quota-item-value', remainingText)
  line.append(label, value)
  const groupId = typeof quota.limited_by === 'string' && quota.limited_by.startsWith('group:')
    ? quota.limited_by.slice('group:'.length)
    : null
  if (groupId) {
    const note = el('small', 'quota-item-note', '受分组限制')
    line.appendChild(note)
    api.get('/groups/' + encodeURIComponent(groupId)).then(g => {
      note.textContent = '受分组「' + (g.name || groupId) + '」限制'
    }).catch(() => {
      // 组详情拉取失败时保留通用提示，不打断菜单渲染
    })
  } else if (quota.limited_by === 'member') {
    line.appendChild(el('small', 'quota-item-note', '受个人配额限制'))
  }
  items.appendChild(line)
}

function renderTop(hash) {
  const top = el('div', 'top')
  const loginPage = !session && hash === '#/login'
  const brand = el(loginPage ? 'button' : 'div', loginPage ? 'brand token-login-trigger' : 'brand', 'OneX')
  brand.appendChild(el('small', null, '万象'))
  if (loginPage) bindTokenLoginTrigger(brand, 'OneX 万象，令牌登录', () => openLoginTokenForm())
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
    const account = el('details', 'account-menu')
    const name = session.user?.name
    const summary = el('summary')
    if (name) summary.appendChild(el('span', 'account-menu-label', '个人菜单'))
    summary.appendChild(el('span', 'account-name', name || '个人菜单'))
    const items = el('div', 'account-items')
    if (session.tenant && session.quota) appendQuotaItem(items, session.quota)
    const download = el('a', null, '下载 OneX Desktop')
    download.href = '/download'
    const tokens = el('a', null, '令牌管理')
    tokens.href = '#/account/tokens'
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
    account.addEventListener('keydown', e => {
      if (e.key === 'Escape' && account.open) {
        account.open = false
        summary.focus()
      }
    })
    account.addEventListener('focusout', e => {
      if (!account.contains(e.relatedTarget)) account.open = false
    })
    items.append(download, tokens, logout)
    account.append(summary, items)
    tools.append(account)
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
  if (session.tenant) return '#/tenant/members'
  return session.is_platform_admin ? '#/platform' : '#/account/tokens'
}

let lifecycle
function route() {
  lifecycle?.abort()
  lifecycle = new AbortController()
  openLoginTokenForm = null
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
    const signal = lifecycle.signal
    pendingToken = null
    openLoginTokenForm = renderLogin(ws, {
      api,
      mockOn,
      signal,
      setPendingToken: t => { pendingToken = t },
      onSession: s => {
        if (signal.aborted) return
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

  if (hash === '#/account/tokens') {
    personalTokensPage(ws, api, lifecycle.signal)
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
  const actionsChanged = existing.size !== me.actions.length || !me.actions.every(action => existing.has(action))
  const quotaChanged = JSON.stringify(me.quota ?? null) !== JSON.stringify(restored.quota ?? null)
  if (!actionsChanged && !quotaChanged) return false
  session = { ...restored, actions: me.actions, quota: me.quota ?? null }
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
