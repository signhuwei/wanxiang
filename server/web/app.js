// 外壳：顶栏（工作域切换、租户与账号、登出）+ hash 路由。
// 路由只有两层：#/login、#/tenant/members、#/platform。钻取状态留在内存里，不进 URL。

import { createApi } from './api.js'
import { createSessionStore } from './session.js'
import { showToast } from './toast.js'
import { renderLogin } from './login.js'
import { renderMembersPage } from './members.js'
import { mockEnabled, installMock } from './mock/index.js'

const mockOn = mockEnabled()
if (mockOn) installMock()

const sessionStore = createSessionStore({ key: mockOn ? 'onex.session.mock' : 'onex.session' })
let session = sessionStore.load()
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

const app = document.getElementById('app')

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
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
    // CONTRACT-PENDING: /me 是否返回平台管理员标识（mock 用 user.platform_admin）
    if (session.user && session.user.platform_admin) {
      const platformLink = el('a', null, '平台')
      platformLink.href = '#/platform'
      platformLink.classList.toggle('selected', hash.startsWith('#/platform'))
      domains.appendChild(platformLink)
    }
    top.appendChild(domains)

    const tools = el('div', 'top-tools')
    if (mockOn) tools.appendChild(el('span', 'mock-badge', '假数据'))
    if (session.tenant) {
      const tn = el('span', 'tenant-name muted', session.tenant.name)
      tools.appendChild(tn)
    }
    if (session.user && session.user.name) tools.appendChild(el('span', null, session.user.name))
    const logout = el('button', 'link', '退出')
    logout.addEventListener('click', async () => {
      try {
        await api.post('/auth/logout')
      } catch {
        // 登出失败也清本地会话
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

function route() {
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
    if (!(session.user && session.user.platform_admin)) {
      location.replace(defaultHash())
      return
    }
    renderPlatformPlaceholder(ws)
    return
  }

  if (hash.startsWith('#/tenant')) {
    if (!session.tenant) {
      location.replace(defaultHash())
      return
    }
    renderMembersPage(ws, { api })
    return
  }

  location.replace(defaultHash())
}

window.addEventListener('hashchange', route)
route()
