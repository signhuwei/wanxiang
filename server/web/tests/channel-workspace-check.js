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
  { label: '渠道 A', origin: 'https://channel-a.example.test', model: 'vendor-a/m', key: 'local-fixture-key-a', balanceKey: 'local-management-a', price: '2' },
  { label: '渠道 B', origin: 'https://channel-b.example.test', model: 'vendor-b/m', key: 'local-fixture-key-b', balanceKey: 'local-management-b', price: '3' }
]
let balanceDenied = false
const upstreams = settings.map((setting, index) => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.url)
  if (index === 0 && url.pathname === '/api/user/self' && request.method === 'GET') {
    if (request.headers.get('Authorization') !== setting.balanceKey || request.headers.get('New-Api-User') !== '42') return new Response(null, { status: 401 })
    if (balanceDenied) return new Response(null, { status: 403 })
    return Response.json({ success: true, data: { id: 42, quota: 5250000 } })
  }
  if (index === 1 && url.pathname === '/api/v1/user/profile' && request.method === 'GET') {
    if (request.headers.get('Authorization') !== 'Bearer ' + setting.balanceKey) return new Response(null, { status: 401 })
    return Response.json({ code: 0, data: { id: 84, balance: '16.1254329' } })
  }
  if (url.pathname !== '/v1/models' || request.method !== 'GET') return new Response(null, { status: 404 })
  if (request.headers.get('Authorization') !== 'Bearer ' + setting.key) return new Response(null, { status: 401 })
  if (index === 0 && url.searchParams.get('after') === 'first-page-end') return Response.json({ data: [{ id: 'z-full-directory-last' }], has_more: false })
  const main = { id: setting.model, context_window: 32768, capabilities: ['text'] }
  const filler = index === 0 ? Array.from({ length: 25 }, (_, i) => ({ id: 'w-filler-' + String(i).padStart(2, '0') })) : []
  return Response.json({ data: [main, ...filler], has_more: index === 0, last_id: 'first-page-end' })
} }))
const allowed = new Map(settings.map((setting, index) => [setting.origin, upstreams[index].url.origin]))
let app, browser, otp
const target = 'channel-qa@example.test'
const errors = []

try {
  app = await createServer({ dataDir: scratch, hostname: '127.0.0.1', port: 0, heartbeatMs: 15000, tenantCacheSize: 2,
    presence: new MemoryPresence(), commit: 'channel-browser-check', codeSecret: crypto.randomUUID(),
    masterKey: crypto.getRandomValues(new Uint8Array(32)), now: () => now, deliverCode: (_, value) => { otp = value },
    providerChannelFetch: (url, headers, signal) => {
      const fixture = allowed.get(url.origin)
      assert(fixture, 'browser fixture may reach only local fixture providers')
      return fetch(new URL(url.pathname + url.search, fixture), { headers, signal, redirect: 'error', proxy: '' })
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
  async function submit(name, suffix, status, scope = page) {
    const pending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(suffix))
    await scope.getByRole('button', { name, exact: true }).click()
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
  let modelId, providerToRotate
  for (const [index, setting] of settings.entries()) {
    await button('新建 Provider').click()
    await label('名称').fill(setting.label)
    await label('协议').selectOption('openai_chat')
    await label('服务地址').fill(setting.origin)
    await label('上游密钥').fill(setting.key)
    const provider = await submit('保存', '/platform/providers', 201)
    if (index === 0) providerToRotate = provider
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
    await button('渠道资金').click()
    if (index === 0) {
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
    }
    await button('查看上游账户查询').click()
    await button('编辑余额查询配置').click()
    await label('余额接口').selectOption(index === 0 ? 'new_api' : 'sub2api')
    await label('上游账户 ID').fill(index === 0 ? '42' : '84')
    if (index === 0) await label('每币种单位对应额度').fill('500000')
    else {
      assert.equal(await label('币种').inputValue(), 'USD')
      await label('同步到账面余额').selectOption('on')
    }
    const password = label('余额查询凭据')
    assert.equal(await password.getAttribute('type'), 'password')
    await password.fill(setting.balanceKey)
    const saved = await submit('保存查询配置', '/balance-profile', 200)
    assert.equal(saved.profile.credential_usable, true)
    assert(!JSON.stringify(saved).includes(setting.balanceKey))
    const sample = await submit('查询上游余额', '/balance-probes', 202)
    assert.equal(sample.status, 'ok')
    assert.equal(sample.amount_micro, index === 0 ? 10500000 : 16125432)
    assert.equal(sample.scope, index === 0 ? 'account_quota' : 'account_balance')
    assert.equal(sample.wallet_synced, index === 1)
    const upstreamBalance = page.getByRole('region', { name: '上游余额状态' })
    const readout = index === 0 ? '5,250,000 额度单位 · 配置折算 ¥10.50' : 'US$16.125432'
    await upstreamBalance.getByText(readout, { exact: true }).waitFor()
    assert.equal((await page.content()).includes(setting.balanceKey), false)
    if (index === 0) {
      await button('编辑余额查询配置').click()
      assert.equal(await label('余额查询凭据').inputValue(), '')
      await button('取消编辑').click()
      balanceDenied = true
      const failed = await submit('查询上游余额', '/balance-probes', 202)
      assert.equal(failed.reason_code, 'permission_denied')
      await upstreamBalance.getByText('未取得读数 · 查询凭据缺少账户查看权限', { exact: true }).waitFor()
      await upstreamBalance.getByText(readout, { exact: true }).waitFor()
      await button('清除余额查询配置').click()
      assert.equal((await submit('确认清除配置', '/balance-profile/clear', 200)).profile, null)
      await upstreamBalance.getByText('历史配置 v' + saved.profile.profile_revision, { exact: true }).waitFor()
      assert.equal(await button('查询上游余额').count(), 0)
    }
    await button('返回渠道资金').click()
    if (index === 0) await text('¥11.15').waitFor()
    else {
      const synced = page.getByRole('table', { name: '渠道资金流水' }).getByRole('row').filter({ hasText: sample.id })
      await synced.getByRole('cell', { name: '上游核验', exact: true }).waitFor()
      await synced.getByRole('cell', { name: readout, exact: true }).waitFor()
    }
    await button('返回渠道').click()
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
  await link('能力合约').click()
  await link('商业计费').click()
  await button('发布方案').click()
  await label('方案名称').fill('双渠道销售方案')
  await button('添加模型协议价').click()
  const price = right().locator('.commerce-price-row').last()
  await price.getByLabel('模型', { exact: true }).selectOption(modelId)
  assert.equal(await price.getByLabel('费率来源', { exact: true }).inputValue(), rate.source_rate_key)
  const plan = await submit('发布方案', '/commerce/plans', 201, right())
  assert.equal(plan.terms.model_prices[0].input_milli_per_mtok, 4000)
  const contract = '/policy/contracts/' + tenant.tenantId
  await link('平台合约').click()
  await button('单链路联验租户').click()
  await button('首次签发').click()
  await label('签发原因').fill('将双渠道签约型号授予租户')
  async function chooseClause(title, value) {
    const picker = right().locator('.policy-picker', { has: page.locator('summary').getByText('从条目库添加', { exact: true }) })
    await picker.locator('summary').click()
    await picker.locator('input[type=search]').fill(title)
    await picker.locator('tr').getByText(title, { exact: true }).click()
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

  await link('能力管理').click()
  const source = settings[0]
  await cell(source.label).click()
  await button('编辑').click()
  source.key += '-rotated'
  await label('上游密钥').fill(source.key)
  await submit('保存', '/platform/providers/' + providerToRotate.id, 200)
  await cell(source.label).click()
  const history = page.getByRole('region', { name: '历史目录（只读）' })
  await history.getByText('共 27 个', { exact: true }).waitFor()
  await history.getByText('此目录来自渠道修订 v' + providerToRotate.revision + '。拉取当前修订的目录后可继续归并。', { exact: true }).waitFor()
  await button('下一页目录').click()
  await history.getByText('z-full-directory-last', { exact: true }).waitFor()
  await label('查询已拉取模型').fill(source.model)
  await history.getByText(source.model, { exact: true }).waitFor()
  assert.equal(await history.getByRole('button', { name: '归并 ' + source.model }).count(), 0)
  assert.equal((await submit('拉取模型', '/discoveries', 202)).status, 'succeeded')
  const refreshed = page.getByRole('region', { name: '上游发现目录' })
  await refreshed.getByRole('button', { name: '归并 ' + source.model }).waitFor()
  assert.equal(await history.count(), 0)
  assert.deepEqual(errors, [])
  console.log('channel-workspace-check ok', JSON.stringify({ discovered: 28, one_to_many: 2, signed_pool: 1, multiplier: 4, balance_micro: 11150000,
    historical_catalog_read_only: true, balance_adapters: ['new_api', 'sub2api'] }))
} finally {
  await browser?.close()
  await app?.close()
  for (const server of upstreams) server.stop(true)
  await rm(scratch, { recursive: true, force: true })
}
