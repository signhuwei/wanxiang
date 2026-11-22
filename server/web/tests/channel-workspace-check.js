// Chrome → local OneX → HTTP fixture. No browser request interception or production traffic.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../../src/server.ts'
import { seedTenant } from '../../src/seed.ts'
import { MemoryPresence } from '../../src/presence.ts'
import { openCodeLogin } from './login-flow.js'

const scratch = await mkdtemp(join(tmpdir(), 'onex-channel-browser-'))
const now = Date.now()
const settings = [
  { label: '渠道 A', model: 'vendor-a/m', key: 'local-fixture-key-a', price: '2' },
  { label: '渠道 B', model: 'vendor-b/m', key: 'local-fixture-key-b', price: '3' }
]
const upstreams = settings.map((setting, index) => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.url)
  if (url.pathname !== '/v1/models' || request.method !== 'GET') return new Response(null, { status: 404 })
  if (request.headers.get('Authorization') !== 'Bearer ' + setting.key) return new Response(null, { status: 401 })
  if (index === 0 && url.searchParams.get('after') === 'first-page-end') return Response.json({ data: [{ id: 'z-full-directory-last' }], has_more: false })
  const main = { id: setting.model, context_window: 32768, capabilities: ['text'] }
  const filler = index === 0 ? Array.from({ length: 25 }, (_, i) => ({ id: 'w-filler-' + String(i).padStart(2, '0') })) : []
  return Response.json({ data: [main, ...filler], has_more: index === 0, last_id: 'first-page-end' })
} }))
const allowed = new Set(upstreams.map(upstream => upstream.url.origin))
let app, browser, otp
const target = 'channel-qa@example.test'
const errors = []

try {
  app = await createServer({ dataDir: scratch, hostname: '127.0.0.1', port: 0, heartbeatMs: 15000, tenantCacheSize: 2,
    presence: new MemoryPresence(), commit: 'channel-browser-check', codeSecret: crypto.randomUUID(),
    masterKey: crypto.getRandomValues(new Uint8Array(32)), now: () => now, deliverCode: (_, value) => { otp = value },
    providerChannelFetch: (url, headers, signal) => {
      assert(allowed.has(url.origin), 'browser fixture may reach only local fixture providers')
      return fetch(url, { headers, signal, redirect: 'error', proxy: '' })
    } })
  const tenant = await seedTenant(app.store, { target, name: '单链路联验租户', platformAdmin: true, now })
  browser = await chromium.launch({ channel: 'chrome', args: ['--disable-gpu', '--no-proxy-server'] })
  const page = await browser.newPage({ baseURL: app.server.url.href, viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (process.env.ONEX_CHANNEL_DEBUG === '1' && response.status() >= 400) console.error(response.status(), new URL(response.url()).pathname)
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const link = name => page.getByRole('link', { name, exact: true })
  const label = name => page.getByLabel(name, { exact: true })
  const text = name => page.getByText(name, { exact: true })
  const cell = name => page.getByRole('cell', { name, exact: true })
  const right = () => page.locator('.inline-pane').last()
  async function submit(name, suffix, status) {
    const pending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(suffix))
    await button(name).click()
    const response = await pending
    assert.equal(response.status(), status, await response.text())
    return response.json()
  }

  assert.equal((await page.goto('/'))?.status(), 200)
  await openCodeLogin(page)
  await page.getByPlaceholder('邮箱或手机号').fill(target)
  await button('发送验证码').click()
  await text('验证码已发送，请查收').waitFor()
  await page.getByPlaceholder('6 位验证码').fill(otp)
  const login = await submit('登录', '/auth/login', 200)
  await page.waitForURL(/#\/platform$/)
  const call = async (path, body, status = 200) => {
    const response = await fetch(new URL('/v1/platform' + path, app.server.url), {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + login.token,
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() } : {}) },
      body: body && JSON.stringify(body)
    })
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify({ path, result }))
    return result
  }

  await link('能力管理').click()
  const reviewed = []
  const signedName = '跨渠道样例 M'
  let modelId
  for (const [index, setting] of settings.entries()) {
    await button('新建 Provider').click()
    await label('名称').fill(setting.label)
    await label('协议').selectOption('openai_chat')
    await label('服务地址').fill(upstreams[index].url.href)
    await label('上游密钥').fill(setting.key)
    const provider = await submit('保存', '/platform/providers', 201)
    await cell(setting.label).click()
    await right().getByRole('heading', { name: '渠道管理', exact: true }).waitFor()
    const probe = await submit('测试连通性', '/probes', 202)
    assert.equal(probe.status, 'succeeded')
    const discovered = await submit('拉取模型', '/discoveries', 202)
    assert.equal(discovered.status, 'succeeded')
    const directory = page.getByRole('region', { name: '上游发现目录' })
    await directory.getByText('共 ' + (index === 0 ? 27 : 1) + ' 个', { exact: true }).waitFor()
    if (index === 0) {
      await button('下一页目录').click()
      await directory.getByText('z-full-directory-last', { exact: true }).waitFor()
      await label('查询已拉取模型').fill(setting.model)
    }
    await button('归并 ' + setting.model).click()
    if (index === 0) {
      await button('新建签约型号').click()
      await label('签约型号名称').fill(signedName)
      const model = await submit('建立签约型号', '/platform/models', 201)
      modelId = model.id
      await label('原厂标识').fill('fixture-maker')
      await label('型号系列').fill('model-m')
      await submit('保存型号身份', '/identity', 201)
    } else await cell(signedName).click()
    await right().getByRole('group', { name: '确认能力' }).getByRole('checkbox', { name: '文本', exact: true }).check()
    await label('归并证据与理由').fill('本地测试厂商的样例声明确认同一文本模型')
    const decision = await submit('确认归并', '/pool/candidates/review', 200)
    assert.equal(decision.items[0].raw_model, setting.model)
    reviewed.push(decision.items[0])
    await text('已归并到 ' + signedName + '，可在签约型号中选入模型池。').waitFor()
    await button('返回渠道').click()
    if (index === 0) {
      await button('渠道资金').click()
      for (const [entry, field, value, ref, suffix] of [
        ['核对渠道余额', '核对余额', '10', 'opening-1', 'observations'],
        ['登记渠道充值', '充值金额', '1.25', 'recharge-1', 'recharges'],
        ['登记渠道扣费', '扣费金额', '0.1', 'expense-1', 'expenses']
      ]) {
        await button(entry).click()
        await label(field).fill(value)
        await label('账单或交易凭证').fill(ref)
        await label('备注').fill('浏览器单链路凭证')
        await submit('保存登记', '/channel-ledger/' + suffix, 201)
        await page.getByRole('table', { name: '渠道资金流水' }).getByText(ref, { exact: true }).waitFor()
      }
      const after = await call('/providers/' + provider.id + '/channel-ledger')
      assert.equal(after.accounts[0].balance_micro, 11150000)
      await text('¥11.15').waitFor()
      await button('返回渠道').click()
    }
    await button('采购报价 ' + reviewed.at(-1).deployment_id).click()
    await button('发布新报价').click()
    await label('币种').fill('CNY')
    await label('生效时间（UTC）').fill(new Date(now - 60000).toISOString())
    await label('普通输入单价').fill(setting.price)
    await label('普通输入数量基数').fill('1000000')
    await label('输出单价').fill('10')
    await label('输出数量基数').fill('1000000')
    await label('报价原因').fill('本地渠道采购合同样例')
    await submit('发布报价', '/quotes', 201)
    await page.getByText(/^已发布采购报价 v1/).waitFor()
    await link('签约型号').click()
    if (index === 0) await link('Provider').click()
  }

  await cell(signedName).click()
  await button('起草新版本').click()
  for (const candidate of reviewed) await label('选择 ' + candidate.deployment_id + ' ' + candidate.raw_model).check()
  await label('发布原因').fill('签约型号有两条已复核供货渠道')
  const proposed = await submit('预览', '/pool/preview', 200)
  assert.equal(proposed.publishable, true)
  const pool = await submit('发布', '/pool/revisions', 201)
  assert.equal(pool.pool_revision, 1)
  await page.getByRole('heading', { name: '模型池 v1', exact: true }).last().waitFor()
  await button('基础销售费率').click()
  await button('新建倍率').click()
  for (const name of ['输入', '输出', '缓存读取', '缓存写入']) await label(name + '（块/百万 token）').fill(name === '输出' ? '12' : '0')
  await label('生效时间（UTC）').fill(new Date(now - 30000).toISOString())
  await submit('保存', '/platform/rates', 201)
  await button('输入倍率').click()
  const calculation = await submit('试算倍率', '/input-multiplier/preview', 200)
  assert.equal(calculation.recommended_input_multiplier_ppm, 3000000)
  await label('最终倍率（×）').fill('4')
  await label('倍率理由').fill('确定合同价格')
  await submit('重新试算', '/input-multiplier/preview', 200)
  const rate = await submit('发布可签倍率', '/input-multiplier/revisions', 201)
  const plan = await call('/commerce/plans', { name: '双渠道销售方案', expected_version: 0,
    terms: { model_prices: [{ model_id: modelId, source_rate_key: rate.source_rate_key }] } }, 201)
  const contract = '/policy/contracts/' + tenant.tenantId
  await link('能力合约').click()
  await button('单链路联验租户').click()
  await button('首次签发').click()
  await label('签发原因').fill('将双渠道签约型号授予租户')
  async function chooseClause(title, value) {
    await text('从条目库添加').click()
    await right().locator('.policy-picker[open] input[type=search]').fill(title)
    await right().locator('.policy-picker[open] tr').getByText(title, { exact: true }).click()
    const row = right().locator('.policy-entry', { has: page.getByText(title, { exact: true }) })
    await row.getByLabel('调节方式', { exact: true }).selectOption('adjust')
    await row.getByText('选择' + title, { exact: true }).click()
    await row.locator('input[type=search]').fill(value)
    await row.getByRole('checkbox', { name: new RegExp(value) }).check()
  }
  await chooseClause('可用模型', signedName)
  await chooseClause('商业计费方案', plan.name)
  const signing = await submit('预览变更', '/preview', 200)
  assert.equal(signing.route_pools.find(row => row.model_id === modelId).member_count, 2)
  const signature = await submit('发布', '/signatures', 201)
  assert.equal(signature.route_pools.find(row => row.model_id === modelId).member_count, 2)
  await page.getByRole('table', { name: '签约模型池' }).getByRole('cell', { name: '固定本版' }).waitFor()
  const persisted = await call(contract + '/signatures/' + signature.revision)
  assert.equal(persisted.route_pools.find(row => row.model_id === modelId).pool_revision, 1)
  assert.deepEqual(errors, [])
  console.log('channel-workspace-check ok', JSON.stringify({ discovered: 28, one_to_many: 2, signed_pool: 1, multiplier: 4, balance_micro: 11150000 }))
} finally {
  await browser?.close()
  await app?.close()
  for (const server of upstreams) server.stop(true)
  await rm(scratch, { recursive: true, force: true })
}
