// 真实租户 API 测试：临时库、本地端口、一次性开发验证码；缺失的 /me 投影单独注入。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../../src/server.ts'
import { seedTenant } from '../../src/seed.ts'
import { MemoryPresence } from '../../src/presence.ts'

const dir = await mkdtemp(join(tmpdir(), 'onex-web-test-'))
const target = 'owner@example.test'
let code
const app = await createServer({ dataDir: dir, hostname: '127.0.0.1', port: 0, heartbeatMs: 15000,
  tenantCacheSize: 2, presence: new MemoryPresence(), commit: 'test', codeSecret: crypto.randomUUID(), masterKey: crypto.getRandomValues(new Uint8Array(32)),
  deliverCode: (_, value) => { code = value } })
const browser = await chromium.launch({ channel: 'chrome' })
try {
  await seedTenant(app.store, { target, name: '联调租户', platformAdmin: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.setDefaultTimeout(3500)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/v1/')) {
      const res = await route.fetch()
      if (path === '/v1/me') {
        const me = await res.json()
        if (res.ok() && !Array.isArray(me.actions)) {
          return route.fulfill({ response: res, json: { ...me, is_platform_admin: true, actions: me.tenant ? ['create_group', 'create_invite'] : ['create_provider','create_model','create_rate','topup'], mock_actions: true } })
        }
      }
      return route.fulfill({ response: res })
    }
    const file = Bun.file(new URL('..' + (path === '/' ? '/index.html' : path), import.meta.url))
    return route.fulfill({ status: await file.exists() ? 200 : 404, contentType: file.type, body: await file.exists() ? await file.text() : '' })
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const link = name => page.getByRole('link', { name, exact: true })
  const field = name => page.locator(`[name="${name}"]`)
  await page.goto(app.server.url.href)
  await page.getByPlaceholder('邮箱或手机号').fill(target)
  await button('发送验证码').click()
  await page.getByText('验证码已发送，请查收').waitFor()
  await page.getByPlaceholder('6 位验证码').fill(code)
  await button('登录').click()
  await page.locator('tr.clickable').waitFor()
  await link('分组').click()
  await button('新建分组').click()
  await field('name').fill('研发组')
  await button('保存').click()
  await page.locator('tr.clickable').getByText('研发组').waitFor()
  await link('成员').click()
  await button('生成邀请码').click()
  await button('生成').click()
  const invite = await page.getByLabel('一次性邀请码').inputValue()
  assert(invite.length > 16)
  await button('← 返回').click()
  assert.equal(await page.getByLabel('一次性邀请码').count(), 0)
  assert(!await page.evaluate(v => JSON.stringify(localStorage).includes(v), invite))
  assert.deepEqual(errors, [])
  console.log('真实 Server：验证码登录、空列表新建组、邀请码一次性展示通过')
} finally {
  await browser.close()
  app.close()
  await rm(dir, { recursive: true, force: true })
}
