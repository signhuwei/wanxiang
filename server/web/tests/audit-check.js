// Chrome 独立验收：页面和审计 API 都由浏览器测试拦截提供。
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'chrome', args: ['--disable-gpu', '--no-proxy-server'] })
const user = { id: 'usr_audit_test', name: '审计测试' }
const tenant = { id: 'ten_audit_test', name: '联调租户' }
const item = { id: 'aud_first', actor: '审计操作者', action: 'observe.events.read', target: 'ses_%_', at: '2026-01-01T12:00:00Z',
  revision: 1, actions: ['read'], detail_json: '内部详情不展示' }
const session = { user, tenant, role: 'owner', token: 'fixture-scoped', globalToken: 'fixture-global',
  globalActions: ['topup'], is_platform_admin: true }

async function open(savedActions, actions, auditHandler) {
  const page = await browser.newPage({ baseURL: 'http://onex-audit.test' })
  page.setDefaultTimeout(6000)
  await page.addInitScript(saved => localStorage.setItem('onex.session', JSON.stringify(saved)),
    { ...session, actions: savedActions })
  const requests = []
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.hostname !== 'onex-audit.test') return route.abort()
    if (!url.pathname.startsWith('/v1/')) {
      const path = url.pathname === '/' ? '/index.html' : url.pathname
      if (!/^\/(?:mock\/)?[a-zA-Z0-9_-]+\.(?:html|css|js)$/.test(path)) return route.abort()
      const file = Bun.file(new URL('..' + path, import.meta.url))
      if (!(await file.exists())) return route.fulfill({ status: 404 })
      return route.fulfill({ contentType: file.type, body: await file.text() })
    }
    if (url.pathname === '/v1/me') {
      return route.fulfill({ json: { tenant, user, role: 'owner', actions } })
    }
    if (url.pathname === '/v1/audit') {
      requests.push({ method: route.request().method(), params: Object.fromEntries(url.searchParams),
        authorization: route.request().headers().authorization })
      return auditHandler(route, url.searchParams)
    }
    return route.fulfill({ json: { total: 0, items: [], next_cursor: null } })
  })
  await page.goto('/#/tenant/audit')
  return { page, requests }
}

try {
  let finishFirst
  const waitFirst = new Promise(resolve => { finishFirst = resolve })
  let fail = true
  const { page, requests } = await open([], ['read_audit'], async (route, params) => {
    if (params.get('q') === '失败' && fail) {
      fail = false
      return route.fulfill({ status: 503, json: { error: { code: 'internal', message: '审计请求失败' } } })
    }
    const cursor = params.get('cursor')
    if (!params.has('q') && !params.has('action')) {
      await waitFirst
      return route.fulfill({ json: { total: 1, items: [item], next_cursor: null } })
    }
    if (params.get('q') === ' %_ ' && params.get('action') === item.action) {
      return route.fulfill({ json: { total: 2, items: [cursor ? { ...item, id: 'aud_second', target: '第二页目标' } : item],
        next_cursor: cursor ? null : 'next-audit-page' } })
    }
    return route.fulfill({ json: { total: 0, items: [], next_cursor: null } })
  })
  await page.getByRole('heading', { name: '审计台账' }).waitFor()
  await page.getByText('加载中…', { exact: true }).waitFor()
  finishFirst()
  await page.getByText(item.target, { exact: true }).waitFor()
  assert.equal(await page.getByText(item.detail_json).count(), 0)
  assert.equal(await page.getByRole('button', { name: '查看', exact: true }).count(), 0)
  assert.equal(await page.getByRole('link', { name: '审计', exact: true }).count(), 1)
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('onex.session')).globalActions), ['topup'])
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('onex.session')).globalToken), session.globalToken)
  const q = page.getByRole('searchbox', { name: '查询动作、操作者或目标' })
  await page.getByRole('searchbox', { name: '精确动作' }).fill(item.action)
  await q.fill(' %_ ')
  await page.getByRole('button', { name: '下一页' }).click()
  await page.getByText('第二页目标', { exact: true }).waitFor()
  assert.deepEqual(requests.at(-1), { method: 'GET', params: {
    action: item.action, q: ' %_ ', cursor: 'next-audit-page', limit: '50'
  }, authorization: 'Bearer fixture-scoped' })
  await q.fill('失败')
  await page.getByText('审计请求失败', { exact: true }).waitFor()
  assert.equal(requests.at(-1).params.cursor, undefined)
  await page.getByRole('button', { name: '重试' }).click()
  await page.getByText('没有符合条件的审计记录', { exact: true }).waitFor()
  await page.close()

  const denied = await open(['read_audit'], [], async route => route.fulfill({ status: 403 }))
  await denied.page.getByText('当前账号没有审计查询权限', { exact: true }).waitFor()
  assert.equal(new URL(denied.page.url()).hash, '#/tenant/audit')
  assert.equal(await denied.page.getByRole('link', { name: '审计', exact: true }).count(), 0)
  assert.deepEqual(denied.requests, [])
  await denied.page.close()
  console.log('审计台账权限刷新、直接路由、只读字段、查询分页和失败重试通过')
} finally {
  await browser.close()
}
