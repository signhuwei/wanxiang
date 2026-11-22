import { commercePage,commerceAccountPage } from './commerce.js'
// 外壳：顶栏（工作域切换、租户与账号、登出）+ hash 路由。
// 路由最多两层：#/login、#/tenant/members、#/platform、#/platform/releases。钻取状态留在内存里，不进 URL。

import { createApi } from './api.js'
import { createSessionStore } from './session.js'
import { showToast } from './toast.js'
import { devicesPage } from './devices.js'
import { observePage,sharedSessions } from './observation.js'
import { statisticsPage } from './statistics.js'
import { billingPage } from './billing.js'
import { auditPage } from './audit.js'
import { agentReleasesPage } from './agent-releases.js'
import { catalog } from './catalog.js'
import { platformPolicyContracts, platformPolicyDefinitions, platformPolicyTemplates } from './policy-platform.js'
import { tenantPolicyPage, organizationPolicyPage, quotaPolicyPage } from './policy-configuration.js'
import { mountTabs, tenantPolicy } from './policy-controls.js'
import { rechargePage } from './policy-recharge.js'
import { platformToolsPage } from './policy-tools.js'
import { groupsPage } from './groups.js'
import { bindTokenLoginTrigger, renderLogin, tenantChoiceList } from './login.js'
import { renderMembersPage } from './members.js'
import { releasesPage } from './releases.js'
import { serverReleasesPage } from './server-releases.js'
import { personalTokensPage } from './personal-tokens.js'
import { formatMilli } from './format.js'
import { mockEnabled, installMock } from './mock/index.js'

const mockOn = mockEnabled()
if (mockOn) installMock()

const sessionStore = createSessionStore({ key: mockOn ? 'onex.session.mock' : 'onex.session' })
let session = sessionStore.load()
let restoredTenant = session?.tenant ? session : null
let checkingAuditPermission = Boolean(restoredTenant)
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
    : formatMilli(quota.remaining_milli) + ' 块橡皮'
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

const platformNavigation = [
  ['能力合约', [['contracts', '平台合约'], ['templates', '合约模板'], ['definitions', '条目库'], ['commerce','商业计费']]],
  ['能力管理', [['catalog', 'Provider'], ['agents', 'Agent'], ['tools', 'Tools']]],
  ['运维管理', [['maintenance', '维护与发布'], ['releases', 'Edge 安装包']]]
]
const platformPath = hash => hash.split('/')[2] || 'contracts'
const platformGroup = path => platformNavigation.find(([, pages]) => pages.some(([id]) => path === id)) ?? platformNavigation[0]
const tenantSelection = '#/tenant/select'
const inWorkspace = (hash, domain) => hash === '#/' + domain || hash.startsWith('#/' + domain + '/')
const canUsePlatform = () => session?.is_platform_admin === true && Boolean(session.globalToken)
const tenantChoices = () => Array.isArray(session?.tenantChoices) ? session.tenantChoices : []

function tenantHome(role) {
  if (role === 'group_admin') return '#/tenant/groups'
  if (role === 'member') return '#/tenant/contract'
  return '#/tenant/members'
}

function platformNavLink(path, label, selected) {
  const link = el('a', selected ? 'selected' : '', label)
  link.href = '#/platform/' + path
  if (selected) link.setAttribute('aria-current', 'page')
  return link
}

function renderTop(hash) {
  const top = el('div', 'top')
  const loginPage = !session && hash === '#/login'
  const brand = el(loginPage ? 'button' : 'div', loginPage ? 'brand token-login-trigger' : 'brand', 'OneX')
  brand.appendChild(el('small', null, '万象'))
  if (loginPage) bindTokenLoginTrigger(brand, 'OneX 万象，令牌登录', () => openLoginTokenForm())
  top.appendChild(brand)

  if (session) {
    const tenantView = inWorkspace(hash, 'tenant') && hash !== tenantSelection && session.tenant
    const platformView = inWorkspace(hash, 'platform') && canUsePlatform()
    const domains = el('nav', 'domains')
    if (tenantView) {
      const tenantLink = el('a', 'selected', '租户')
      tenantLink.href = tenantHome(session.role)
      domains.appendChild(tenantLink)
      const pages = [['members','成员'], ['groups','分组'], ['contract','合约'], ['billing','橡皮'], ['observe','监察'], ['statistics','统计'], ['devices','设备']]
      if (canReadAudit()) pages.push(['audit', '审计'])
      for (const [path, label] of pages) {
        const link = el('a', hash === '#/tenant/' + path ? 'selected' : '', label)
        link.href = '#/tenant/' + path
        domains.append(link)
      }
    }
    if (platformView) {
      const platformLink = el('a', 'selected', '平台')
      platformLink.href = '#/platform'
      domains.appendChild(platformLink)
      const active = platformGroup(platformPath(hash))
      for (const group of platformNavigation) domains.append(platformNavLink(group[1][0][0], group[0], group === active))
    }
    if (domains.childElementCount) top.appendChild(domains)

    const tools = el('div', 'top-tools')
    if (mockOn || session.mock_actions) tools.appendChild(el('span', 'mock-badge', mockOn ? '假数据' : '权限：假数据'))
    if (tenantView) {
      const tn = el('span', 'tenant-name muted', session.tenant.name)
      tools.appendChild(tn)
    }
    const account = el('details', 'account-menu')
    const name = session.user?.name
    const summary = el('summary')
    if (name) summary.appendChild(el('span', 'account-menu-label', '个人菜单'))
    summary.appendChild(el('span', 'account-name', name || '个人菜单'))
    const items = el('div', 'account-items')
    if (tenantView && session.quota) appendQuotaItem(items, session.quota)
    if (!tenantView && hash !== tenantSelection && (session.tenant || tenantChoices().length)) {
      const tenant = el('a', null, '进入租户工作台')
      tenant.href = tenantChoices().length ? tenantSelection : tenantHome(session.role)
      items.appendChild(tenant)
    }
    if (!platformView && canUsePlatform()) {
      const platform = el('a', null, '进入平台工作台')
      platform.href = '#/platform'
      items.appendChild(platform)
    }
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
  if (canUsePlatform()) return '#/platform'
  return session.tenant ? tenantHome(session.role) : '#/account/tokens'
}

function chooseTenant(ws, signal) {
  const current = session
  const wrap = el('div', 'login-wrap')
  const panel = el('div', 'login-panel')
  const hint = el('p', 'login-hint error')
  hint.setAttribute('role', 'alert')
  hint.hidden = true
  panel.append(el('h1', null, '进入租户工作台'), tenantChoiceList(tenantChoices(), async tenant => {
    hint.hidden = true
    const { token } = await platformApi.post('/auth/select-tenant', { tenant_id: tenant.id }, { signal })
    const tenantApi = createApi({ getToken: () => token })
    const me = await tenantApi.get('/me', { signal })
    if (signal.aborted || session !== current) return
    if (me.tenant?.id !== tenant.id) throw new Error('未能进入所选租户')
    const selected = { ...current, ...me, token }
    sessionStore.save(selected)
    session = selected
    checkingAuditPermission = false
    location.replace(tenantHome(selected.role))
  }, error => {
    if (signal.aborted) return
    hint.textContent = error.message || '选择租户失败，请重试'
    hint.hidden = false
  }), hint)
  wrap.appendChild(panel)
  ws.appendChild(wrap)
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

  if (inWorkspace(hash, 'platform')) {
    if (!canUsePlatform()) {
      location.replace(defaultHash())
      return
    }
    const signal = lifecycle.signal
    const path = platformPath(hash)
    const container = el('div', 'policy-tabs-root')
    const nav = el('nav', 'policy-tabs platform-policy-tabs')
    nav.setAttribute('aria-label', platformGroup(path)[0])
    for (const [id, label] of platformGroup(path)[1]) nav.append(platformNavLink(id, label, id === path))
    const view = el('div', 'policy-tab-content')
    container.append(nav, view)
    ws.append(container)
    if (path === 'maintenance') serverReleasesPage(view, platformApi, signal)
    else if (path === 'contracts') platformPolicyContracts(view, platformApi, signal)
    else if (path === 'templates') platformPolicyTemplates(view, platformApi, signal)
    else if (path === 'definitions') platformPolicyDefinitions(view, platformApi, signal)
    else if (path === 'commerce') commercePage(view,platformApi,signal)
    else if (path === 'agents') agentReleasesPage(view, platformApi, signal)
    else if (path === 'tools') platformToolsPage(view, platformApi, signal)
    else if (path === 'releases') releasesPage(view, platformApi, session.globalActions || [])
    else if (path === 'catalog') catalog(view, platformApi, session.globalActions || [])
    else location.replace('#/platform/contracts')
    return
  }

  if (inWorkspace(hash, 'tenant')) {
    if (hash === tenantSelection && canUsePlatform() && tenantChoices().length) {
      chooseTenant(ws, lifecycle.signal)
      return
    }
    if (hash === tenantSelection) {
      location.replace(defaultHash())
      return
    }
    if (!session.tenant) {
      location.replace(canUsePlatform() && tenantChoices().length ? tenantSelection : defaultHash())
      return
    }
    if (restoredTenant === session) {
      const restored = restoredTenant
      restoredTenant = null
      refreshTenantActions(restored).then(changed => {
        checkingAuditPermission = false
        if (inWorkspace(location.hash, 'tenant') && (changed || location.hash === '#/tenant/audit')) route()
      })
    }
    const signal = lifecycle.signal
    if (hash === '#/tenant/groups') {
      const view = el('div', 'policy-tabs-root')
      ws.append(view)
      const tabs = [['configuration', '组配置', (area, local) => organizationPolicyPage(area, api, 'group', local)]]
      if (session.role === 'owner' || session.role === 'admin') tabs.unshift(
        ['directory', '分组台账', area => groupsPage(area, api, session.actions || [], { policyManaged: true })])
      mountTabs(view, tabs, signal)
    }
    else if (hash === '#/tenant/devices') devicesPage(ws, api, lifecycle.signal, mockOn)
    else if (hash === '#/tenant/observe') {
      const view=el('div','policy-tabs-root');ws.append(view)
      mountTabs(view,[['sessions','会话监察',(area,local)=>observePage(area,api,session,local)],
        ['shared','分享给我',(area,local)=>sharedSessions(area,api,local)]],signal)
    }
    else if (hash === '#/tenant/statistics') statisticsPage(ws, api, lifecycle.signal)
    else if (hash === '#/tenant/billing') {
      if (session.role === 'group_admin' || session.role === 'member') {
        quotaPolicyPage(ws, api, session, signal)
        return
      }
      const view = el('div', 'policy-tabs-root')
      ws.append(view)
      mountTabs(view, [
        ['ledger', '橡皮流水', (area, local) => billingPage(area, api, local)],
        ['recharges', '充值记录', (area, local) => rechargePage(area, {
          api, endpoint: tenantPolicy + '/recharges', tenantName: session.tenant.name,
          getBalance: () => api.get('/balance', { signal: local }), signal: local
        })],
        ...(session.role==='owner'?[['account','商业计费',(area,local)=>commerceAccountPage(area,api,local)]]:[])
      ], signal)
    }
    else if (hash === '#/tenant/contract') tenantPolicyPage(ws, api, session, signal)
    else if (hash === '#/tenant/audit') {
      if (checkingAuditPermission) ws.appendChild(el('p', 'empty', '正在确认审计权限…'))
      else if (canReadAudit()) auditPage(ws, api, lifecycle.signal)
      else ws.appendChild(el('p', 'empty', '当前账号没有审计查询权限'))
    }
    else {
      const view = el('div', 'policy-tabs-root')
      ws.append(view)
      const tabs = [['configuration', '个人配置', (area, local) => organizationPolicyPage(area, api, 'member', local)]]
      if (session.role === 'owner' || session.role === 'admin') tabs.unshift(
        ['directory', '成员台账', area => renderMembersPage(area, { api, actions: session.actions || [], policyManaged: true })])
      mountTabs(view, tabs, signal)
    }
    return
  }

  location.replace(defaultHash())
}

async function refreshTenantActions(restored) {
  let me
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 5000)
  try {
    const tenantApi = createApi({ getToken: () => restored.token })
    me = await tenantApi.get('/me', { signal: ctrl.signal })
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
route()
