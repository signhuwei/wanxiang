// 设备投影阶段 WebUI 验收：真实临时 Server 与隔离 SQLite，Chrome 走真实商业方案、签发和户主历史售价接口；
// 设备目标两个接口在 Server 落地前由 routing-projection-stub.js 拦截应答。
// 用法：bun --no-env-file server/web/tests/routing-projection-check.js [截图目录]
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../../src/server.ts'
import { seedTenant } from '../../src/seed.ts'
import { hash } from '../../src/credentials.ts'
import { MemoryPresence } from '../../src/presence.ts'
import { seedSupply } from '../../test/routing-fixture.ts'
import fixture from '../../../tests/fixtures/routing/p0-ab.json'
import { rolloutStub } from './routing-projection-stub.js'

const shots = process.argv[2]
if (shots) await mkdir(shots, { recursive: true })
const dir = await mkdtemp(join(tmpdir(), 'onex-routing-projection-'))
const target = 'projection-owner@example.test'
const tenantName = '投影联验租户'
const now = new Date().toISOString()
const oldPlanId = 'plan_01HZZZZZZZZZZZZZZZZZZZZZZZ'
let code, browser
const app = await createServer({ dataDir: dir, hostname: '127.0.0.1', port: 0, heartbeatMs: 15000, tenantCacheSize: 2,
  presence: new MemoryPresence(), commit: 'test', codeSecret: crypto.randomUUID(), masterKey: crypto.getRandomValues(new Uint8Array(32)),
  deliverCode: (_, value) => { code = value } })
const stub = rolloutStub({ rolloutId: 'rol_stub_6', poolRevision: 6, pageSize: 2 })

function seedRates(sql) {
  seedSupply(sql)
  // 旧型号只有展示倍率（legacy rates），没有可签版本引用。
  sql.run(`INSERT INTO rates (model_id,input_milli_per_mtok,output_milli_per_mtok,cache_read_milli_per_mtok,cache_write_milli_per_mtok,effective_from)
    VALUES ('mdl_legacy',2000,6000,500,2500,?)`, [now])
  for (const [key, input, based] of [['prate_m_1', 3000, null], ['prate_m_2', 4000, 'prate_m_1']]) {
    sql.run(`INSERT INTO platform_rate_versions (source_rate_key,model_id,input_multiplier_basis,input_multiplier_ppm,recommended_input_multiplier_ppm,
      input_milli_per_mtok,output_milli_per_mtok,cache_read_milli_per_mtok,cache_write_milli_per_mtok,sales_rates_source,pool_revision,pricing_at,
      calculation_status,based_on_source_rate_key,source_digest,override_reason,status,created_by,created_at)
      VALUES (?,'mdl_m','cny_1_per_mtok_input',?,3000000,?,12000,1000,5000,'fixture',6,?,'complete',?,?,?,'available_to_sign','seed',?)`,
      [key, input * 1000, input, now, based, hash(key), input === 3000 ? null : '按签约标准报价', now])
  }
  sql.run("INSERT INTO platform_rate_heads (model_id,source_rate_key,updated_at) VALUES ('mdl_m','prate_m_2',?)", [now])
  sql.run(`INSERT INTO route_release_jobs (job_id,model_id,pool_revision,job_kind,source_digest,status,created_at)
    VALUES ('rol_stub_6','mdl_m',6,'project','seed','done',?)`, [now])
  // 旧方案：引用早先的 prate_m_1，输出为显式手调值 11 块。
  const terms = { monthly_grant_milli: 0, monthly_fee_fen: 0, tiers: [], commitment: null, model_budgets: [], tool_prices: [],
    model_prices: [{ model_id: 'mdl_m', source_rate_key: 'prate_m_1', input_milli_per_mtok: 3000, output_milli_per_mtok: 11000,
      cache_read_milli_per_mtok: 1000, cache_write_milli_per_mtok: 5000 }] }
  sql.run('INSERT INTO commerce_plans VALUES (?,?,?,?,?,?,?)', ['cmp_old', oldPlanId, 1, '旧协议方案', JSON.stringify(terms), now, 'seed'])
}

try {
  const { tenantId } = await seedTenant(app.store, { target, name: tenantName, platformAdmin: true })
  await app.store.system.write(seedRates)
  browser = await chromium.launch({ channel: 'chrome', args: ['--disable-gpu', '--no-proxy-server'] })
  const page = await browser.newPage({ baseURL: app.server.url.href, viewport: { width: 1280, height: 720 } })
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/v1/platform/model-pool-rollouts/**', route => {
    const hit = stub.handle(route.request().method(), new URL(route.request().url()))
    return hit ? route.fulfill({ status: hit.status ?? 200, contentType: 'application/json', body: JSON.stringify(hit.json) }) : route.continue()
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const link = name => page.getByRole('link', { name, exact: true })
  const pane = page.locator('.inline-pane').last()
  async function capture(label) {
    for (const [width, height] of [[1280, 720], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      const overflow = await page.evaluate(() => [document.documentElement.scrollWidth - document.documentElement.clientWidth,
        document.body.scrollWidth - document.body.clientWidth, document.documentElement.scrollHeight - document.documentElement.clientHeight - 1])
      assert.deepEqual(overflow.map(n => n <= 0), [true, true, true], label + ' 外层溢出 ' + overflow)
      if (shots) await page.screenshot({ path: join(shots, `${width}x${height}-${label}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 720 })
  }

  await page.goto('/')
  await page.getByPlaceholder('邮箱或手机号').fill(target)
  await button('发送验证码').click()
  await page.getByText('验证码已发送，请查收').waitFor()
  await page.getByPlaceholder('6 位验证码').fill(code)
  const login = page.waitForResponse(r => new URL(r.url()).pathname === '/v1/auth/login')
  await button('登录').click()
  const { token } = await (await login).json()
  await page.waitForURL(/#\/platform$/)

  // W1-1 新方案：签约型号默认引用当前可签版本，只发 {model_id,source_rate_key}；旧展示价型号不可引用。
  await link('能力合约').click()
  await link('商业计费').click()
  await button('发布方案').click()
  await pane.getByLabel('方案名称', { exact: true }).fill('可签费率方案')
  await button('添加模型协议价').click()
  const row = pane.locator('.commerce-price-row').last()
  await row.getByLabel('模型', { exact: true }).selectOption('mdl_legacy')
  assert.deepEqual(await row.getByLabel('费率来源', { exact: true }).locator('option').evaluateAll(o => o.map(n => n.value)), [''])
  await row.getByText('手填完整四项，不引用平台费率版本。').waitFor()
  await row.getByLabel('模型', { exact: true }).selectOption('mdl_m')
  assert.equal(await row.getByLabel('费率来源', { exact: true }).inputValue(), 'prate_m_2')
  await row.getByText('引用 prate_m_2 · 输入倍率 4× · 输入 4 · 输出 12 · 缓存读 1 · 缓存写 5 块／百万 Token。四项留空，按该版本展开。').waitFor()
  await capture('plan-rate-reference')
  // 引用时只填一部分显式价：客户端拒绝，不发送
  await row.getByLabel('输入（块 / 百万 Token）', { exact: true }).fill('4.5')
  await pane.getByRole('button', { name: '发布方案', exact: true }).click()
  await pane.getByText('mdl_m 引用费率版本时四项须全部留空或全部填写').waitFor()
  await row.getByLabel('输入（块 / 百万 Token）', { exact: true }).fill('')
  const created = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/v1/platform/commerce/plans')
  await pane.getByRole('button', { name: '发布方案', exact: true }).click()
  assert.deepEqual((await created).postDataJSON().terms.model_prices, [{ model_id: 'mdl_m', source_rate_key: 'prate_m_2' }])
  await page.getByRole('cell', { name: '可签费率方案' }).waitFor()
  const fresh = app.store.system.get("SELECT id, terms_json FROM commerce_plans WHERE name='可签费率方案'")
  assert.deepEqual(JSON.parse(fresh.terms_json).model_prices, [{ model_id: 'mdl_m', source_rate_key: 'prate_m_2', input_milli_per_mtok: 4000,
    output_milli_per_mtok: 12000, cache_read_milli_per_mtok: 1000, cache_write_milli_per_mtok: 5000 }])

  // W1-2 复制旧方案：保留原引用 prate_m_1 和显式手调值，原样另存
  await page.getByRole('cell', { name: '旧协议方案' }).click()
  const old = pane.locator('.commerce-price-row').last()
  assert.equal(await old.getByLabel('费率来源', { exact: true }).inputValue(), 'prate_m_1')
  assert.deepEqual(await old.getByLabel('费率来源', { exact: true }).locator('option').evaluateAll(o => o.map(n => n.value)), ['', 'prate_m_2', 'prate_m_1'])
  assert.equal(await old.getByLabel('输出（块 / 百万 Token）', { exact: true }).inputValue(), '11')
  await old.getByText(/引用 prate_m_1 · 输入倍率 3× .*显式价与版本不同，按显式价保存（手调）。/).waitFor()
  // 切到当前版本会清空显式价；切回原引用恢复原值
  await old.getByLabel('费率来源', { exact: true }).selectOption('prate_m_2')
  assert.equal(await old.getByLabel('输出（块 / 百万 Token）', { exact: true }).inputValue(), '')
  await old.getByLabel('费率来源', { exact: true }).selectOption('prate_m_1')
  assert.equal(await old.getByLabel('输出（块 / 百万 Token）', { exact: true }).inputValue(), '11')
  await pane.getByLabel('发布到', { exact: true }).selectOption('copy')
  await pane.getByLabel('方案名称', { exact: true }).fill('旧协议方案副本')
  const copied = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/v1/platform/commerce/plans')
  await pane.getByRole('button', { name: '发布方案', exact: true }).click()
  const keptPrice = { model_id: 'mdl_m', source_rate_key: 'prate_m_1', input_milli_per_mtok: 3000, output_milli_per_mtok: 11000,
    cache_read_milli_per_mtok: 1000, cache_write_milli_per_mtok: 5000 }
  assert.deepEqual((await copied).postDataJSON().terms.model_prices, [keptPrice])
  await page.getByRole('cell', { name: '旧协议方案副本' }).waitFor()
  assert.deepEqual(JSON.parse(app.store.system.get("SELECT terms_json FROM commerce_plans WHERE name='旧协议方案副本'").terms_json).model_prices, [keptPrice])

  // W2 平台签发：模板带可用型号和新方案；预览显示拟签售价，签发后显示冻结售价
  const template = await fetch(new URL('/v1/platform/policy/templates', app.server.url), { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ id: 'projection-template', expected_version: 0, name: '投影签发模板', description: '', scope: 'platform',
      entries: [{ clause_ref: { id: 'access.models', version: 1 }, value: ['mdl_m'] }, { clause_ref: { id: 'billing.plan', version: 1 }, value: ['cmp_old'] }] }) })
  assert.equal(template.status, 201, await template.clone().text())
  await link('平台合约').click()
  await button(tenantName).click()
  await button('首次签发').click()
  const recordPane = page.locator('.policy-records-workspace > .inline-drill > .inline-pane')
  await recordPane.getByLabel('签发原因', { exact: true }).fill('引用可签 4× 签发')
  await recordPane.getByText('添加模板条目', { exact: true }).click()
  await recordPane.locator('.policy-picker tr').getByText('投影签发模板', { exact: true }).click()
  // 经办人在 billing.plan 条目里辨认：模板基准是旧方案（3× · prate_m_1），改选可签 4× 方案
  const planEntry = recordPane.locator('.policy-entry').filter({ hasText: '商业计费方案' })
  await planEntry.getByText('所含型号：mdl_m 3× · prate_m_1').waitFor()
  await planEntry.getByText('在商业计费发布引用新费率的方案', { exact: true }).waitFor()
  await planEntry.getByLabel('调节方式', { exact: true }).selectOption('adjust')
  await planEntry.getByText('选择商业计费方案', { exact: true }).click()
  const option = planEntry.locator('label.contract-choice').filter({ hasText: '可签费率方案 v1' })
  await option.getByText('所含型号：mdl_m 4× · prate_m_2').waitFor()
  await planEntry.locator('label.contract-choice').filter({ hasText: '旧协议方案副本 v1' }).getByText('所含型号：mdl_m 3× · prate_m_1').waitFor()
  await option.getByRole('checkbox').check()
  await planEntry.locator('.policy-picker > p.policy-catalog-detail').getByText('所含型号：mdl_m 4× · prate_m_2').waitFor()
  await capture('signature-plan-choice')
  const previewRequest = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/preview'))
  await button('预览变更').click()
  const planChoice = (await previewRequest).postDataJSON().entries.find(e => e.clause_ref.id === 'billing.plan')
  assert.deepEqual(planChoice, { clause_ref: { id: 'billing.plan', version: 1 }, template_ref: { id: 'projection-template', version: 1 }, adjustment: [fresh.id] },
    '只沿用既有 billing.plan 调整值，不新增签发字段')
  const proposed = recordPane.getByRole('table', { name: '拟签售价' })
  await proposed.getByRole('cell', { name: '4×', exact: true }).waitFor()
  await proposed.getByRole('cell', { name: 'prate_m_2', exact: true }).waitFor()
  assert.equal(await proposed.getByRole('columnheader', { name: '费率版本' }).count(), 0, '拟签售价尚无费率版本')
  await capture('signature-proposed-rates')
  await button('发布').click()
  const frozen = recordPane.getByRole('table', { name: '已签售价' })
  await frozen.getByRole('cell', { name: /^rate_/ }).waitFor()
  await frozen.getByRole('cell', { name: '4×', exact: true }).waitFor()
  const snapshot = app.store.tenant(tenantId).get('SELECT rate_version_id, source_rate_key, input_multiplier_ppm FROM sales_rate_snapshots')
  assert.deepEqual([snapshot.source_rate_key, snapshot.input_multiplier_ppm], ['prate_m_2', fixture.pricing.signed_input_multiplier_ppm])
  await frozen.getByRole('cell', { name: snapshot.rate_version_id, exact: true }).waitFor()
  await recordPane.getByText('设备是否已应用以设备回执为准', { exact: false }).waitFor()
  await capture('signature-frozen-rates')

  // W4 池版本右栏：设备目标汇总与目标台账，目标配置与已应用配置分列
  await link('能力管理').click()
  await link('签约型号').click()
  await page.getByRole('cell', { name: 'DeepSeek V4.1 Flash', exact: true }).click()
  await page.locator('.inline-pane tr.clickable', { hasText: 'seed v6' }).click()
  const section = page.locator('.rollout-targets')
  await section.waitFor().catch(async e => { console.error((await page.locator('.inline-pane').last().innerText()).slice(0, 1500)); throw e })
  await section.getByText('池 v6 · 发布任务 rol_stub_6 · 任务状态 已完成 · 名册设备 4 台').waitFor()
  await section.getByText('任务完成不等于设备已应用；已应用只看设备回执。').waitFor()
  const targetRow = id => section.locator('tbody tr', { hasText: id })
  await targetRow('dev_lin').getByText('等待应用').waitFor()
  assert.deepEqual(await targetRow('dev_lin').locator('td').evaluateAll(t => t.slice(3, 6).map(n => n.textContent)), ['91', '90', '等待应用'])
  assert.equal(await section.locator('tbody button').count(), 0, '目标行本批无写操作')
  await section.getByRole('button', { name: '下一页' }).click()
  await targetRow('dev_new').waitFor()
  assert.deepEqual(await targetRow('dev_new').locator('td').evaluateAll(t => t.slice(3, 5).map(n => n.textContent)), ['尚未生成', '未应用'])
  assert.deepEqual(stub.state.requests.at(-1), { state: '', cursor: 'c::2' })
  await capture('rollout-pending')
  // 合法成功回执后才显示已应用；拒绝回执 reason 取 detail.reason，已应用保持原值
  stub.applied('dev_lin')
  stub.rejected('dev_wu')
  stub.superseded('dev_old')
  await section.getByRole('button', { name: '刷新', exact: true }).click()
  await section.getByRole('button', { name: '已应用 1', exact: true }).waitFor()
  await targetRow('dev_lin').getByText('已应用').waitFor()
  assert.deepEqual(await targetRow('dev_lin').locator('td').evaluateAll(t => t.slice(3, 6).map(n => n.textContent)), ['91', '91', '已应用'])
  await section.getByRole('button', { name: '已拒绝 1', exact: true }).click()
  await section.getByText('共 1 条').waitFor()
  await targetRow('dev_wu').waitFor()
  assert.equal(stub.state.requests.at(-1).state, 'rejected')
  assert.deepEqual(await targetRow('dev_wu').locator('td').evaluateAll(t => t.slice(3, 7).map(n => n.textContent)),
    ['91', '90', '已拒绝', '缺推理密钥信封（missing_envelope）'])
  await section.getByRole('button', { name: '已被新池取代 1', exact: true }).click()
  await targetRow('dev_old').getByText('已被新池取代').waitFor()
  await capture('rollout-receipts')
  // 游标失效回第一页
  await section.getByRole('button', { name: '全部', exact: true }).click()
  await section.getByText('共 4 条').waitFor()
  stub.state.breakNextCursor = true
  await section.getByRole('button', { name: '下一页' }).click()
  await section.getByText('分页游标已失效，已回到第一页。').waitFor()
  await targetRow('dev_lin').waitFor()
  assert.equal(stub.state.requests.at(-1).cursor, null)

  // W3 户主读历史售价：只显示户主字段，不出现平台费率来源
  await page.locator('.account-menu summary').click()
  await link('进入租户工作台').click()
  await page.waitForURL(/#\/tenant\/select$/)
  await page.getByRole('button', { name: new RegExp('^' + tenantName + '(?:\\s|$)') }).click()
  await link('合约').click()
  await button('签发记录').click()
  await page.locator('tr.clickable').getByText('v1', { exact: true }).click()
  const tenantRates = page.getByRole('table', { name: '已签售价' })
  await tenantRates.getByRole('cell', { name: '4×', exact: true }).waitFor()
  await tenantRates.getByRole('cell', { name: snapshot.rate_version_id, exact: true }).waitFor()
  assert.equal(await tenantRates.getByRole('columnheader', { name: '费率来源' }).count(), 0)
  assert.equal(await page.getByText('prate_m_2').count(), 0, '户主侧不显示平台费率来源')
  await capture('tenant-signature-rates')
  assert.deepEqual(errors, [])
  console.log('routing-projection-check ok: plan rate reference/keep-old, proposed and frozen 4× rates, tenant owner history, rollout targets and receipts')
} finally {
  await browser?.close()
  await app.close()
  await rm(dir, { recursive: true, force: true })
}
