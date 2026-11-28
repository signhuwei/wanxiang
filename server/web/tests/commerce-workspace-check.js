import { openCodeLogin } from './login-flow.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../../src/server.ts'
import { seedTenant } from '../../src/seed.ts'
import { MemoryPresence } from '../../src/presence.ts'

const dataDir = await mkdtemp(join(tmpdir(), 'onex-commerce-ui-'))
const target = 'commerce@example.test'
let code, browser, app
try {
  app = await createServer({ dataDir, hostname: '127.0.0.1', port: 0, heartbeatMs: 15000, tenantCacheSize: 1,
    presence: new MemoryPresence(), commit: 'test', codeSecret: crypto.randomUUID(),
    masterKey: crypto.getRandomValues(new Uint8Array(32)), deliverCode: (_, next) => { code = next } })
  await seedTenant(app.store, { target, platformAdmin: true })
  await app.store.system.write(sql => {
    sql.run("INSERT INTO providers(id,name,protocol,base_url,secret_ciphertext,status) VALUES('p','P','openai_chat','https://example.invalid',?,'active')", [new Uint8Array(0)])
    sql.run("INSERT INTO models(id,provider_id,upstream_name,display_name,context_window,status) VALUES('m','p','floor','基础模型',1024,'active')")
  })
  browser = await chromium.launch({ channel: 'chrome', args: ['--disable-gpu'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(7000)
  const button = name => page.getByRole('button', { name, exact: true })
  const link = name => page.getByRole('link', { name, exact: true })
  const pane = page.locator('.inline-pane').last()
  const label = name => pane.getByLabel(name, { exact: true })
  await page.goto(app.server.url.href)
  await openCodeLogin(page)
  await page.getByPlaceholder('邮箱或手机号').fill(target)
  await button('发送验证码').click()
  await page.getByText('验证码已发送，请查收').waitFor()
  await page.getByPlaceholder('6 位验证码').fill(code)
  await button('登录').click()
  await page.waitForURL(/#\/platform$/)
  await link('平台').waitFor()
  assert.equal(await link('租户').count(), 0)
  await link('能力合约').click()
  await link('商业计费').click()
  await button('发布方案').click()
  assert.equal(await page.locator('.drill-context .toolbar').count(), 1)
  await label('方案名称').fill('团队包')
  await label('每月发放（粒）').fill('123.456')
  await label('月费（元）').fill('9.99')
  await button('添加阶梯').click()
  await label('起始用量（粒）').fill('10')
  await label('折扣系数（0 至 1）').fill('0.90')
  await button('添加单模型月预算').click()
  await label('模型').selectOption('m')
  await label('每月额度（粒）').fill('12.345')
  await pane.getByRole('button', { name: '发布方案', exact: true }).click()
  await page.getByRole('cell', { name: '团队包' }).waitFor()
  const saved = app.store.system.get('SELECT terms_json FROM commerce_plans')
  assert.deepEqual(JSON.parse(saved.terms_json).model_budgets, [{ model_id: 'm', monthly_milli: 12345 }])
  await page.getByRole('cell', { name: '团队包' }).click()
  await label('发布到').selectOption('copy')
  await label('方案名称').fill('租户协议价')
  await label('每月发放（粒）').fill('456.789')
  await pane.getByRole('button', { name: '发布方案', exact: true }).click()
  await page.getByRole('cell', { name: '租户协议价' }).waitFor()
  assert.equal(app.store.system.get('SELECT count(DISTINCT plan_id) AS n FROM commerce_plans').n, 2)
  await button('模型档位').click()
  await label('倍率基准模型').selectOption('m')
  await button('添加模型档位').click()
  await label('模型').selectOption('m')
  await label('档位').selectOption('floor')
  await button('保存档位').click()
  await page.locator('.inline-pane').waitFor({ state: 'detached' })
  assert.equal(app.store.system.get('SELECT floor_model_id FROM commerce_tiers').floor_model_id, 'm')
  console.log('商业计费台账、月包小数、阶梯、模型月预算和价格档位已验证')
} finally {
  await browser?.close()
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
}
