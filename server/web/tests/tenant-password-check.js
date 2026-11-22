import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const serverSrc = process.env.ONEX_PASSWORD_SERVER_TREE
  ? pathToFileURL(resolve(process.env.ONEX_PASSWORD_SERVER_TREE, 'server/src') + '/')
  : new URL('../../src/', import.meta.url)
const [{ createServer }, { seedTenant }, { MemoryPresence }, { hashLoginPassword, normalizeLoginName }, { hash, day, iso, randomToken }] = await Promise.all(
  ['server.ts', 'seed.ts', 'presence.ts', 'tenant-passwords.ts', 'credentials.ts'].map(file => import(new URL(file, serverSrc).href)))
const dir = await mkdtemp(join(tmpdir(), 'onex-tenant-password-web-'))
let app, browser
try {
  app = await createServer({ dataDir: dir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 3,
    heartbeatMs: 15_000, commit: 'password-test', codeSecret: crypto.randomUUID(), presence: new MemoryPresence() })
  const oneC = await seedTenant(app.store, { target: 'operator@example.test', name: 'OneC 测试', platformAdmin: true })
  const sa = await seedTenant(app.store, { target: 'other-operator@example.test', name: 'SA 测试' })
  const password = ' ' + crypto.randomUUID() + ' '
  const passwordHash = await hashLoginPassword(password)
  const masterToken = 'onex_login_' + randomToken()
  const tenantName = normalizeLoginName('OneC')
  const username = normalizeLoginName('testowner')
  const now = Date.now()
  await app.store.system.write(sql => {
    sql.run('UPDATE tenants SET short_name = ?, short_name_key = ? WHERE id = ?', [tenantName.display, tenantName.key, oneC.tenantId])
    sql.run('INSERT INTO tenant_login_accounts (tenant_id, username, username_key, user_id, password_hash) VALUES (?, ?, ?, ?, ?)',
      [oneC.tenantId, username.display, username.key, oneC.userId, passwordHash])
    sql.run('INSERT INTO personal_login_tokens (id, user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['fixture-master', oneC.userId, 'Master 测试令牌', hash(masterToken), iso(now), iso(now + day)])
  })

  browser = await chromium.launch({ channel: 'chrome', args: ['--disable-gpu', '--no-proxy-server'] })
  const page = await browser.newPage({ baseURL: app.server.url.href })
  const errors = [], requested = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() === 'POST') requested.push(new URL(request.url()).pathname) })
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/v1/')) return route.continue()
    const file = Bun.file(new URL('..' + (path === '/' ? '/index.html' : path), import.meta.url))
    const exists = await file.exists()
    return route.fulfill({ status: exists ? 200 : 404, contentType: file.type, body: exists ? await file.text() : '' })
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const account = page.locator('.account-menu summary')
  await page.goto('/')
  await page.getByPlaceholder('租户 ID 或简称').fill(' OneC ')
  await page.getByPlaceholder('用户名').fill(' TESTOWNER ')
  assert.equal(await page.getByPlaceholder('登录令牌').count(), 0)
  assert.equal(await button('验证码登录').isVisible(), false)
  await page.getByPlaceholder('密码').fill('wrong-fixture-password')
  await button('登录').click()
  await page.getByText(/租户、用户名或密码有误/).waitFor()
  assert.equal(await page.getByPlaceholder('用户名').inputValue(), ' TESTOWNER ')
  assert.equal(await page.getByPlaceholder('密码').inputValue(), '')
  await page.getByPlaceholder('密码').fill(password)
  await page.getByPlaceholder('密码').press('Enter')
  await page.waitForURL(/#\/tenant\/members$/)
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('onex.session')))
  assert.equal(session.tenant.id, oneC.tenantId)
  assert.equal(session.role, 'owner')
  assert.equal(session.tenant_password_login, true)
  assert(Array.isArray(session.actions))
  assert.equal(session.globalToken, undefined)
  assert(!JSON.stringify(session).includes(password))
  assert(!requested.includes('/v1/auth/select-tenant'))
  await account.click()
  assert.equal(await page.getByRole('link', { name: '进入平台工作台' }).count(), 0)
  assert.equal(await page.getByRole('link', { name: '令牌管理' }).count(), 0)
  await button('退出').click()
  await page.getByPlaceholder('租户 ID 或简称').waitFor()

  const oneX = page.locator('.top .brand')
  await oneX.click()
  assert.equal(await page.getByPlaceholder('登录令牌').count(), 0)
  await oneX.dblclick()
  await page.getByPlaceholder('登录令牌').fill(masterToken)
  await button('登录').click()
  await page.waitForURL(/#\/platform$/)
  await page.getByRole('row', { name: /OneC 测试.*OneC/ }).waitFor()
  await button('SA 测试').click()
  await button('租户资料').click()
  await button('编辑简称').click()
  const edit = page.locator('.inline-pane').last()
  await edit.getByRole('textbox', { name: '租户简称' }).fill('OneC')
  await edit.getByRole('button', { name: '保存', exact: true }).click()
  await edit.locator('output[data-field="short_name"]').getByText('OneC', { exact: true }).waitFor()
  assert.equal(app.store.system.get('SELECT short_name FROM tenants WHERE id = ?', [sa.tenantId]).short_name, 'OneC')
  assert.deepEqual(errors, [])
  console.log('tenant-password-check ok: real password and hidden master login, tenant-owned session, duplicate short name saved in the right form')
} finally {
  await browser?.close()
  await app?.close()
  await rm(dir, { recursive: true, force: true })
}
