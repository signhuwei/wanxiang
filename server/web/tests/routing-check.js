// 路由首批 WebUI 验收：真实临时 Server（隔离 SQLite、非安全上下文源），
// 首批路由接口在 Server 落地前由共享 fixture（tests/fixtures/routing/p0-ab.json）驱动的浏览器拦截应答。
// 用法：bun --no-env-file server/web/tests/routing-check.js [截图目录]
import { openCodeLogin } from './login-flow.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../../src/server.ts'
import { seedTenant } from '../../src/seed.ts'
import { MemoryPresence } from '../../src/presence.ts'
import fixture from '../../../tests/fixtures/routing/p0-ab.json'
import { pricingStub } from './routing-pricing-stub.js'

const shots = process.argv[2]
if (shots) await mkdir(shots, { recursive: true })
const clone = value => JSON.parse(JSON.stringify(value))
const draft = fixture.http.draft
const [memberA, memberB] = draft.members

// —— fixture 驱动的接口桩：只覆盖 contracts/routing-p0.md 首批路由接口 ——
function routingStub(extraModel = () => ({})) {
  const revisions = new Map([[6, { model_id: 'mdl_m', pool_revision: 6, members: [clone(memberA)], routing: clone(draft.routing),
    reason: 'M 首个平台渠道', released_at: '2026-11-21T08:00:00Z' }]])
  const state = { current: 6, keys: new Map(), previews: [], publishes: [], abortNextPublish: false, forceMismatchNext: false, epoch: 0, lastBasis: null }
  const candidate = (m, raw, extra = {}) => ({ candidate_id: 'cand_' + m.deployment_id, discovery_id: 'dsc_1', catalog_item_id: 'cat_' + m.deployment_id,
    deployment_id: m.deployment_id, deployment_revision: m.deployment_revision, provider_id: m.deployment_id === 'dep_a' ? 'prv_a' : 'prv_b',
    account_id: m.deployment_id === 'dep_a' ? 'acct_a' : 'acct_b', endpoint_id: 'ep_' + m.deployment_id, raw_model: raw,
    match: { match_rule_id: 'rule_m', rule_revision: 1, reason: 'catalog_exact', confidence: 'high', review_status: 'accepted' },
    capabilities: ['text', 'stream', 'function_tools'], health: { state: 'eligible' }, quote_ref: { quote_id: 'quote_' + m.deployment_id },
    approved_match_id: m.approved_match_id, evidence_ids: m.evidence_ids, actions: ['read', 'select'], ...extra })
  const candidates = [
    candidate(memberA, 'vendor-a/m-20261121'),
    candidate(memberB, 'vendor-b/m'),
    { candidate_id: 'cand_quant', discovery_id: 'dsc_1', catalog_item_id: 'cat_quant', deployment_id: fixture.http.ineligible_candidate.deployment_id,
      deployment_revision: 1, provider_id: 'prv_b', account_id: 'acct_b', endpoint_id: 'ep_dep_b', raw_model: 'vendor-b/m-int4',
      match: { match_rule_id: 'rule_loose', rule_revision: 1, reason: 'loose_normalized', confidence: 'low', review_status: 'needs_review' },
      capabilities: ['text'], health: { state: 'eligible' }, quote_ref: null, reason_code: fixture.http.ineligible_candidate.reason, actions: ['read'] },
    { candidate_id: 'cand_new', discovery_id: 'dsc_1', catalog_item_id: 'cat_new', deployment_id: null, deployment_revision: null,
      provider_id: 'prv_c', account_id: 'acct_c', endpoint_id: 'ep_c', raw_model: 'vendor-c/m', match: { match_rule_id: 'rule_m', rule_revision: 1,
        reason: 'catalog_exact', confidence: 'high', review_status: 'suggested' }, capabilities: ['text'], health: null, quote_ref: null, actions: ['read'] }
  ]
  const cards = [
    { id: 'dep_b', revision: 2, display_name: 'DeepSeek V4.1 Flash', raw_model: 'vendor-b/m', account_id: 'acct_b', endpoint_id: 'ep_dep_b',
      capabilities: ['text', 'stream', 'function_tools'], status: 'active', archive_blockers: [{ code: 'deployment_in_use', message: '活动池 mdl_m v6 引用' }],
      actions: ['read', 'update', 'probe', 'archive', 'read_quotes'] },
    { id: 'dep_b_mini', revision: 1, display_name: 'Mini', raw_model: 'vendor-b/Mini-Flash', account_id: 'acct_b', endpoint_id: 'ep_dep_b',
      capabilities: { text: true, images: false }, status: 'active', archive_blockers: [], actions: ['read', 'update', 'archive'] },
    { id: 'dep_b_old', revision: 3, display_name: '旧版 M', raw_model: 'vendor-b/m-2025', account_id: 'acct_b', endpoint_id: 'ep_dep_b',
      capabilities: [], status: 'archived', archive_blockers: [], actions: ['read'] }
  ]
  // 第二个 Provider（渠道 A）只有 dep_a；卡片 revision 是可编辑资料修订，与部署修订 v4 不同
  const cardsA = [{ id: 'dep_a', revision: 1, display_name: 'DeepSeek V4.1 Flash', raw_model: 'vendor-a/m-20261121', account_id: 'acct_a', endpoint_id: 'ep_dep_a',
    capabilities: ['text', 'stream', 'function_tools'], status: 'active', archive_blockers: [], actions: ['read', 'update', 'read_quotes'] }]
  const providers = []
  const conflict = (reason, extra = {}) => ({ status: 409, json: { error: { code: 'conflict', message: '数据已变化', detail: { reason, ...extra } } } })
  const view = rev => ({ ...clone(revisions.get(rev)), current: rev === state.current, actions: ['read'] })
  const norm = body => JSON.stringify({ expected_pool_revision: body.expected_pool_revision, members: body.members, routing: body.routing, reason: body.reason })
  // 确定性预览根据：同一草稿、同一依赖状态得到同一值；证据变化（epoch）使旧值失效。
  const basisOf = body => 'pvb_' + Bun.hash(norm(body) + '|' + state.epoch).toString(36)
  const staleMember = body => body.members.some(m => {
    const c = candidates.find(row => row.deployment_id === m.deployment_id && row.actions.includes('select'))
    return !c || c.deployment_revision !== m.deployment_revision || c.approved_match_id !== m.approved_match_id
      || c.evidence_ids.join() !== m.evidence_ids.join()
  })

  function handle(method, url, body, headers) {
    const path = url.pathname
    const q = url.searchParams.get('q') ?? ''
    const modelRow = () => ({ id: 'mdl_m', display_name: 'DeepSeek V4.1 Flash', status: 'active', revision: 1, current_pool_revision: state.current,
      channel_count: revisions.get(state.current).members.length, ...extraModel(), actions: ['read', 'update', 'preview_input_multiplier'] })
    if (method === 'GET' && path === '/v1/platform/models' && !url.searchParams.has('provider_id')) {
      return { json: { items: [modelRow()], total: 1, next_cursor: null, actions: ['create_model'] } }
    }
    if (method === 'GET' && path === '/v1/platform/models/mdl_m') return { json: modelRow() }
    if (method === 'GET' && /^\/v1\/platform\/providers\/[^/]+\/deployments$/.test(path)) {
      const providerId = path.split('/')[4]
      if (!providers.includes(providerId)) providers.push(providerId)
      const set = providers.indexOf(providerId) === 0 ? cards : cardsA
      const hits = set.filter(c => c.display_name.includes(q) || c.raw_model.includes(q))
      const start = url.searchParams.get('cursor') === 'p2' ? 2 : 0
      return { json: { items: hits.slice(start, start + 2), total: hits.length, next_cursor: start === 0 && hits.length > 2 ? 'p2' : null, actions: ['create_deployment'] } }
    }
    if (method === 'GET' && path === '/v1/platform/deployments' && url.searchParams.get('target_model_id') === 'mdl_m') {
      const hits = candidates.filter(c => c.raw_model.includes(q))
      return { json: { items: hits, total: hits.length, next_cursor: null, actions: [] } }
    }
    if (method === 'GET' && path === '/v1/platform/models/mdl_m/pool/revisions') {
      const items = [...revisions.keys()].sort((x, y) => y - x).map(view)
      return { json: { items, total: items.length, next_cursor: null, actions: ['preview_pool'] } }
    }
    const one = path.match(/^\/v1\/platform\/models\/mdl_m\/pool\/revisions\/(\d+)$/)
    if (method === 'GET' && one) return revisions.has(Number(one[1])) ? { json: view(Number(one[1])) } : { status: 404, json: { error: { code: 'not_found', message: '不存在' } } }
    if (method === 'POST' && path === '/v1/platform/models/mdl_m/pool/preview') {
      state.previews.push(body)
      if (state.failNextPreview) { state.failNextPreview = false; return conflict('preview_stale', { changed: ['evidence'] }) }
      if (body.expected_pool_revision !== state.current) return conflict('revision_changed', { current_revision: state.current, changed: ['pool_revision'] })
      if (staleMember(body)) return conflict('preview_stale', { changed: ['evidence'] })
      const before = new Set(revisions.get(state.current).members.map(m => m.deployment_id))
      const after = new Set(body.members.map(m => m.deployment_id))
      const preview_basis = state.lastBasis = basisOf(body)
      return { json: { ...clone(fixture.http.expected_preview), expected_pool_revision: state.current, preview_basis,
        diff: { added: [...after].filter(id => !before.has(id)), removed: [...before].filter(id => !after.has(id)), updated: [] },
        impact: { tenant_count: 1, device_count: 1 } } }
    }
    if (method === 'POST' && path === '/v1/platform/models/mdl_m/pool/revisions') {
      const key = headers['idempotency-key']
      state.publishes.push({ key, body })
      if (!key) return { status: 422, json: { error: { code: 'invalid', message: '缺少幂等键', detail: { fields: ['Idempotency-Key'] } } } }
      if (state.forceMismatchNext) { state.forceMismatchNext = false; return conflict('idempotency_mismatch') }
      const seen = state.keys.get(key)
      if (seen) return seen.body === JSON.stringify(body) ? seen.response : conflict('idempotency_mismatch')
      if (body.expected_pool_revision !== state.current) return conflict('revision_changed', { current_revision: state.current, changed: ['pool_revision'] })
      if (body.preview_basis !== basisOf(body) || staleMember(body)) return conflict('preview_stale', { changed: ['evidence'] })
      const pool_revision = Math.max(...revisions.keys()) + 1
      revisions.set(pool_revision, { model_id: 'mdl_m', pool_revision, members: clone(body.members), routing: clone(body.routing), reason: body.reason,
        released_at: fixture.clock_utc, released_by: 'owner@example.test' })
      state.current = pool_revision
      const response = { status: fixture.http.required_publish_status, json: { model_id: 'mdl_m', pool_revision, rollout_id: 'rol_stub_' + pool_revision, actions: ['read'] } }
      state.keys.set(key, { body: JSON.stringify(body), response })
      return response
    }
    return null
  }
  return {
    state, revisions, handle,
    concurrentPublish(members, reason) {
      const pool_revision = Math.max(...revisions.keys()) + 1
      revisions.set(pool_revision, { model_id: 'mdl_m', pool_revision, members: clone(members), routing: clone(draft.routing), reason, released_at: fixture.clock_utc })
      state.current = pool_revision
      return pool_revision
    },
    // 部署 A 换到新修订、新审核和新证据：旧预览根据失效
    changeEvidence() {
      Object.assign(candidates[0], { deployment_revision: 4, approved_match_id: 'mt_a2', evidence_ids: ['ev_a2'] })
      state.epoch += 1
    }
  }
}

const dir = await mkdtemp(join(tmpdir(), 'onex-web-routing-test-'))
const target = 'owner@example.test'
let code
const app = await createServer({ dataDir: dir, hostname: '127.0.0.1', port: 0, heartbeatMs: 15000, tenantCacheSize: 2,
  presence: new MemoryPresence(), commit: 'test', codeSecret: crypto.randomUUID(), masterKey: crypto.getRandomValues(new Uint8Array(32)),
  deliverCode: (_, value) => { code = value } })
const browserUrl = new URL(app.server.url)
browserUrl.hostname = 'onex-routing.test'
const browser = await chromium.launch({ channel: 'chrome', args: ['--disable-gpu', '--no-proxy-server', '--host-resolver-rules=MAP onex-routing.test 127.0.0.1'] })
const stub = routingStub(() => pricing.modelFields())
const pricing = pricingStub({ pool: () => stub.revisions.get(stub.state.current).members })
try {
  await seedTenant(app.store, { target, name: '路由租户', platformAdmin: true })
  const page = await browser.newPage({ baseURL: browserUrl.href, viewport: { width: 1280, height: 720 } })
  page.setDefaultTimeout(4000)
  const errors = []
  page.on('pageerror', e => { errors.push(e.message); console.error('pageerror:', e.message) })
  page.on('requestfailed', r => console.error('requestfailed:', r.method(), r.url(), r.failure()?.errorText))
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.startsWith('/v1/')) {
      const body = request.postData() ? JSON.parse(request.postData()) : undefined
      const hit = stub.handle(request.method(), url, body, request.headers())
        ?? pricing.handle(request.method(), url, body, request.headers(), () => stub.state.current)
      if (!hit) {
        // 其余 /v1 原样转发到真实临时 Server（在测试进程内取回，避免浏览器侧 continue 受主机映射影响）
        const res = await fetch(new URL(url.pathname + url.search, app.server.url), { method: request.method(),
          headers: Object.fromEntries(Object.entries(request.headers()).filter(([k]) => !['host', 'origin', 'referer'].includes(k))),
          body: request.postData() ?? undefined })
        return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) })
      }
      if (request.method() === 'POST' && url.pathname.endsWith('/pool/revisions') && stub.state.abortNextPublish) {
        stub.state.abortNextPublish = false
        return route.abort('connectionreset') // 服务端已提交、响应丢失：重试须复用同一提交键
      }
      if (url.pathname.endsWith('/pool/preview') && stub.state.delayNextPreview) {
        const ms = stub.state.delayNextPreview
        stub.state.delayNextPreview = 0
        await Bun.sleep(ms) // 慢响应：期间操作者修改草稿
      }
      if (url.pathname.endsWith('/input-multiplier/preview') && pricing.state.delayNextRatePreview) {
        const ms = pricing.state.delayNextRatePreview
        pricing.state.delayNextRatePreview = 0
        await Bun.sleep(ms)
      }
      return route.fulfill({ status: hit.status ?? 200, contentType: 'application/json', body: JSON.stringify(hit.json) })
    }
    const file = Bun.file(new URL('..' + (url.pathname === '/' ? '/index.html' : url.pathname), import.meta.url))
    const exists = await file.exists()
    return route.fulfill({ status: exists ? 200 : 404, contentType: file.type, body: exists ? await file.text() : '' })
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const link = name => page.getByRole('link', { name, exact: true })
  const field = name => page.locator(`[name="${name}"]`)
  async function capture(label) {
    for (const [width, height] of [[1280, 720], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      const r = await page.evaluate(async label => (await import('/tests/layout-check.js')).runLayoutChecks(label), label)
      assert(r.pass, label + ' ' + JSON.stringify(r.checks.filter(c => !c.pass)))
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      if (shots) await page.screenshot({ path: join(shots, `${width}x${height}-${label}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 720 })
  }

  await page.goto('/')
  await openCodeLogin(page)
  await page.getByPlaceholder('邮箱或手机号').fill(target)
  await button('发送验证码').click()
  await page.getByText('验证码已发送，请查收').waitFor()
  await page.getByPlaceholder('6 位验证码').fill(code)
  await button('登录').click()
  await page.waitForURL(/#\/platform$/)

  // 1. Provider 右栏渠道卡片：真实 Provider + 拦截的卡片接口，只读，无写入按钮
  await link('能力管理').click()
  await button('新建 Provider').click()
  await field('name').fill('渠道 B')
  await field('base_url').fill('http://127.0.0.1:9')
  await field('secret').fill('fixture-only')
  await button('保存').click()
  await page.getByText('渠道 B', { exact: true }).click()
  const cards = page.locator('.deployment-section')
  await cards.getByText('共 3 个').waitFor()
  assert.equal(await cards.locator('.deployment-card').count(), 2)
  await cards.getByText('活动池 mdl_m v6 引用').waitFor()
  await cards.getByText('占用中，暂不可归档').waitFor()
  assert.equal(await cards.getByRole('button', { name: /编辑|归档|删除|新增/ }).count(), 0, '首批不渲染写入按钮')
  await capture('provider-cards')
  await cards.getByRole('button', { name: '下一页' }).click()
  await cards.getByText('vendor-b/m-2025').waitFor()
  await cards.getByText('已归档').waitFor()
  await cards.getByLabel('查询渠道模型').fill('Mini-Flash')
  await cards.getByText('共 1 个').waitFor()
  await cards.getByLabel('查询渠道模型').fill('mini-flash')
  await cards.getByText('没有匹配的渠道模型').waitFor() // 原始型号区分大小写，由服务端匹配
  assert.equal(await button('模型目录').count(), 1, '旧模型目录入口保留')

  // 2. 独立签约型号台账 → 模型池版本
  await link('签约型号').click()
  const modelRow = page.locator('tr.clickable', { hasText: 'DeepSeek V4.1 Flash' })
  await modelRow.getByText('v6').waitFor()
  await capture('signed-models')
  await modelRow.click()
  await page.locator('tr.clickable', { hasText: '活动池' }).getByText('v6').waitFor()
  await capture('pool-revisions')

  // 3. 起草：活动池成员预选，候选按 select 动作可选，未获准原因可见
  await button('起草新版本').click()
  const boxA = page.getByLabel('选择 dep_a vendor-a/m-20261121')
  const boxB = page.getByLabel('选择 dep_b vendor-b/m', { exact: true })
  await boxA.waitFor()
  assert.equal(await boxA.isChecked(), true)
  assert.equal(await boxB.isChecked(), false)
  assert.equal(await page.getByLabel('选择 dep_quant vendor-b/m-int4').isDisabled(), true)
  await page.getByText('未获准：型号身份未核验').waitFor()
  await page.getByText('未获准：尚未登记为部署').waitFor()
  assert.equal(await page.getByLabel('选择 cand_new vendor-c/m').isDisabled(), true)
  await boxB.check()
  await page.getByLabel('dep_b 优先级').waitFor()
  assert.equal(await page.getByLabel('dep_b 优先级').inputValue(), '20')
  await page.getByLabel('发布原因').fill(draft.reason)
  assert.equal(await button('发布').isVisible(), false, '未预览不可发布')
  await button('预览').click()
  await page.getByText('1 个租户 · 1 台设备').waitFor()
  assert.deepEqual(stub.state.previews.at(-1), draft, '预览请求与共享草稿一致')
  await button('发布').waitFor()
  await capture('pool-preview')
  await page.getByLabel('发布原因').fill(draft.reason + '（改）')
  await page.getByText('草稿已修改，需重新预览后才能发布。').waitFor()
  assert.equal(await button('发布').isVisible(), false)
  await page.getByLabel('发布原因').fill(draft.reason)
  // 竞态：预览在途时修改草稿，成功或失败的旧响应都必须丢弃，不出现发布按钮
  stub.state.delayNextPreview = 800
  await button('预览').click()
  await page.getByLabel('发布原因').fill(draft.reason + '（在途修改）')
  await page.getByText('草稿在预览期间已修改，旧结果已丢弃，请重新预览。').waitFor()
  assert.equal(await button('发布').isVisible(), false)
  stub.state.delayNextPreview = 800
  stub.state.failNextPreview = true
  await button('预览').click()
  await page.getByLabel('发布原因').fill(draft.reason)
  await page.getByText('草稿在预览期间已修改，旧结果已丢弃，请重新预览。').waitFor()
  assert.equal(await page.getByText('预览依据已过期', { exact: false }).count(), 0, '失败的旧响应也不渲染')
  assert.equal(await button('发布').isVisible(), false)
  await button('预览').click()
  await button('发布').waitFor()

  // 4. 幂等发布：首个响应丢失，重试复用同一键，只产生一个 v7；随后回读版本详情
  stub.state.abortNextPublish = true
  await button('发布').click()
  await page.getByText(/发布未完成：.*重试将使用同一提交键/).waitFor()
  await button('发布').click()
  await page.getByText('已发布模型池 v7 · 发布任务 rol_stub_7。设备是否已应用以回执为准。').waitFor()
  const [first, retry] = stub.state.publishes
  assert.equal(stub.state.publishes.length, 2)
  assert.equal(first.key, retry.key)
  assert.deepEqual(retry.body, { ...draft, preview_basis: retry.body.preview_basis })
  assert.equal(Math.max(...stub.revisions.keys()), fixture.model.next_pool_revision)
  assert.deepEqual(stub.revisions.get(7).members.map(m => m.deployment_id), fixture.model.follow_deployment_ids)
  await page.getByRole('table', { name: '池成员' }).getByText('dep_b').waitFor()
  await capture('pool-published')
  await page.locator('.inline-pane .inline-pane').getByRole('button', { name: '← 返回' }).click()
  await page.locator('tr.clickable', { hasText: '活动池' }).getByText('v7').waitFor()
  await page.locator('tr.clickable', { hasText: '历史' }).getByText('v6').waitFor()

  // 5. 同优先级 + 并发 409 revision_changed（保留草稿）→ idempotency_mismatch（同一确定性预览根据仍换新键）
  //    → 证据变化 preview_stale → 重新核对候选、显式采用新版本 → 发布并回读
  await button('起草新版本').click()
  await boxB.waitFor()
  assert.equal(await boxB.isChecked(), true)
  await page.getByLabel('dep_b 优先级').fill('10')
  await page.getByLabel('dep_b 优先级').press('Tab')
  await page.getByLabel('发布原因').fill('同档主备')
  await button('预览').click()
  await button('发布').waitFor()
  assert.deepEqual(stub.state.previews.at(-1).members.map(m => [m.deployment_id, m.priority]), [['dep_a', 10], ['dep_b', 10]], '允许同优先级')
  const other = stub.concurrentPublish([memberA, memberB], '另一位管理员')
  await button('发布').click()
  await page.getByText('模型池已被他人更新，草稿已保留。请基于最新版本重新预览。').waitFor()
  await page.getByText('当前活动池为 v' + other + '，你的草稿基于 v7。').waitFor()
  assert.equal(await page.getByLabel('dep_b 优先级').inputValue(), '10', '草稿成员保留')
  assert.equal(await page.getByLabel('发布原因').inputValue(), '同档主备', '草稿原因保留')
  assert.equal(await button('发布').isVisible(), false)
  await capture('pool-conflict')
  await button('按 v' + other + ' 重新预览').click()
  await button('发布').waitFor()
  assert.equal(stub.state.previews.at(-1).expected_pool_revision, other)
  const basis = stub.state.lastBasis

  stub.state.forceMismatchNext = true
  await button('发布').click()
  await page.getByText('同一提交键对应的内容已变化，草稿已保留。请重新预览后再发布。').waitFor()
  const mismatchKey = stub.state.publishes.at(-1).key
  await button('重新预览').click()
  await button('发布').waitFor()
  assert.equal(stub.state.lastBasis, basis, '预览根据确定性不变')

  stub.changeEvidence()
  await button('发布').click()
  await page.getByText('预览依据已过期（部署、审核或证据已变化），草稿已保留。请重新预览。').waitFor()
  const staleTry = stub.state.publishes.at(-1)
  assert.equal(staleTry.body.preview_basis, basis)
  assert.notEqual(staleTry.key, mismatchKey, 'idempotency_mismatch 后即使根据相同也必须换新键')
  await button('重新核对候选').click()
  await page.getByText('需核对：部署修订 v3 → v4；归纳审核 mt_a → mt_a2；证据 ev_a → ev_a2').waitFor()
  await page.getByText('1 个已选成员的候选已变化', { exact: false }).waitFor()
  assert.equal(await button('预览').isDisabled(), true, '未核对的证据变化不能直接预览发布')
  assert.equal(await button('发布').isVisible(), false)
  assert.equal(await page.getByLabel('发布原因').inputValue(), '同档主备', '理由保留')
  assert.equal(await page.getByLabel('dep_b 优先级').inputValue(), '10', '已选记录保留')
  assert.equal(await page.getByLabel('选择 dep_a vendor-a/m-20261121').isChecked(), false, '新修订候选尚未采用')
  await capture('pool-reconcile')
  await button('采用 dep_a 新版本').click()
  assert.equal(await page.getByLabel('选择 dep_a vendor-a/m-20261121').isChecked(), true)
  await button('预览').click()
  await button('发布').waitFor()
  assert.deepEqual(stub.state.previews.at(-1).members[0], { deployment_id: 'dep_a', deployment_revision: 4, priority: 10, approved_match_id: 'mt_a2', evidence_ids: ['ev_a2'] })
  await button('发布').click()
  const final = other + 1
  await page.getByText('已发布模型池 v' + final + ' · 发布任务 rol_stub_' + final + '。设备是否已应用以回执为准。').waitFor()
  assert.deepEqual(stub.revisions.get(final).members.map(m => [m.deployment_id, m.deployment_revision, m.priority]), [['dep_a', 4, 10], ['dep_b', 2, 10]])
  assert.notEqual(stub.state.publishes.at(-1).key, staleTry.key)
  await page.getByRole('table', { name: '池成员' }).getByText('mt_a2').waitFor()

  // 6. 采购报价、人工汇率、可签输入倍率（contracts/routing-pricing-and-staging.md）
  const at = ms => new Date(Date.now() + ms).toISOString()
  const ps = pricing.state
  const innerBack = () => page.locator('.inline-pane .inline-pane .inline-head').getByRole('button', { name: '← 返回' }).click()
  // 6.1 B 报价：入口受 read_quotes 控制；部署修订取自报价列表；冲突保留表单；双页游标沿用同一 as_of
  await page.getByRole('link', { name: 'Provider', exact: true }).click()
  await page.getByText('渠道 B', { exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '采购报价 dep_b_mini' }).count(), 0, '无 read_quotes 不显示入口')
  await page.getByRole('button', { name: '采购报价 dep_b' }).click()
  await page.locator('tr.clickable').getByText('v2', { exact: true }).waitFor()
  await button('发布新报价').click()
  await page.getByText('部署 dep_b · 部署修订 v2 · 基于报价修订 v2（0 表示首次）').waitFor()
  await field('currency').fill('USD')
  await field('price_input').fill('0.40')
  await field('price_output').fill('4')
  await field('basis_output').fill('3000000')
  await page.getByLabel('报价原因').fill('B 渠道 2026 年 11 月合同价')
  await capture('quote-form')
  ps.deploymentRevision.dep_b = 3
  await button('发布报价').click()
  await page.getByText('部署修订已变化，表单已保留。请刷新报价头并核对部署修订后再发布。').waitFor()
  assert.equal(await field('price_input').inputValue(), '0.40')
  ps.deploymentRevision.dep_b = 2
  await button('刷新报价头').click()
  await page.getByText('已基于报价修订 v2、部署修订 v2 更新，请核对后再发布。').waitFor()
  await button('发布报价').click()
  await page.getByText(/^已发布采购报价 v3。/).waitFor()
  await page.getByRole('table', { name: '报价条目' }).getByText('US$0.40 / 1,000,000 token').waitFor()
  const [qConflict, qOk] = ps.quotePosts.slice(-2)
  assert.notEqual(qConflict.key, qOk.key, '明确 409 后换键')
  assert.deepEqual(qOk.body.items, [
    { dimension: 'input', rate_micro: fixture.pricing.procurement_quotes[1].rate_micro, quantity_basis: 1000000, unit: 'token' },
    { dimension: 'output', rate_micro: fixture.pricing.procurement_quotes[2].rate_micro, quantity_basis: 3000000, unit: 'token' }])
  assert.equal(qOk.body.deployment_revision, 2)
  assert.equal(qOk.body.expected_quote_revision, 2)
  await innerBack()
  await page.locator('tr.clickable').getByText('v3 · 当前适用').waitFor()
  const quotePager = page.locator('.inline-pane .pager')
  await quotePager.getByRole('button', { name: '下一页' }).click()
  await page.locator('tr.clickable').getByText('v1', { exact: true }).waitFor()
  assert(ps.secondPages >= 1, '第二页沿用同一 as_of，未返回 422')
  // 6.2 A 报价：卡片 revision=1 是资料修订，报价写入列表给出的部署修订 v4
  await button('← 返回').click()
  await button('新建 Provider').click()
  await field('name').fill('渠道 A')
  await field('base_url').fill('http://127.0.0.1:9')
  await field('secret').fill('fixture-only')
  await button('保存').click()
  await page.getByText('渠道 A', { exact: true }).click()
  await page.getByRole('button', { name: '采购报价 dep_a' }).click()
  await page.getByText('尚无已发布报价').waitFor()
  await button('发布新报价').click()
  await field('currency').fill('CNY')
  await field('price_input').fill('2')
  await page.getByLabel('报价原因').fill('A 渠道合同价')
  await button('发布报价').click()
  await page.getByText(/^已发布采购报价 v1。/).waitFor()
  assert.equal(ps.quotePosts.at(-1).body.deployment_revision, 4)
  await page.getByRole('table', { name: '报价条目' }).getByText('¥2.00 / 1,000,000 token').waitFor()
  await innerBack()
  await button('← 返回').click()

  const openMultiplier = async () => {
    await link('签约型号').click()
    await page.locator('tr.clickable', { hasText: 'DeepSeek V4.1 Flash' }).click()
    await button('输入倍率').click()
  }
  // 6.3 缺汇率：部分试算，首个试算省略 pricing_at，无理由不可发布
  await openMultiplier()
  await page.getByText('尚无可签版本').waitFor()
  await page.getByText('平台可签：仅表示可选入签发。', { exact: false }).waitFor()
  const previewsBefore = ps.ratePreviews.length
  await button('试算倍率').click()
  await page.getByText('部分试算（有缺项）').waitFor()
  await page.getByRole('table', { name: '渠道输入价' }).getByText('缺汇率').waitFor()
  assert.equal(Object.hasOwn(ps.ratePreviews[previewsBefore], 'pricing_at'), false, '首次试算省略 pricing_at')
  assert.equal(ps.lastRatePreview.recommended_input_multiplier_ppm, 2000000)
  assert.equal(await button('发布可签倍率').isVisible(), false)
  // 6.4 人工汇率：先登记已过期的 v1，倍率显示“汇率已过期”
  await link('采购汇率').click()
  await page.getByText('该币种尚无已发布汇率').waitFor()
  await button('登记汇率').click()
  await field('rate').fill('7.20')
  await page.getByText('= 36/5').waitFor()
  await field('valid_from').fill(at(-2 * 3600000))
  await field('valid_until').fill(at(-60000))
  await page.getByLabel('汇率原因').fill('上月人工汇率')
  await button('发布汇率').click()
  await page.getByText(/^已发布汇率 v1。/).waitFor()
  assert.deepEqual([ps.fxPosts.at(-1).body.rate_numerator, ps.fxPosts.at(-1).body.rate_denominator, ps.fxPosts.at(-1).body.expected_fx_revision], ['36', '5', 0])
  await openMultiplier()
  await button('试算倍率').click()
  await page.getByRole('table', { name: '渠道输入价' }).getByText('汇率已过期').waitFor()
  // 有效 15/2：他人先发布 v2 → 409 保留表单 → 刷新头 → 发布 v3；列表双页
  await link('采购汇率').click()
  await page.locator('tr.clickable').getByText('v1', { exact: true }).waitFor()
  await button('登记汇率').click()
  await field('rate').fill('7.50')
  await page.getByText('= 15/2').waitFor()
  await field('valid_from').fill(at(-3600000))
  await field('valid_until').fill(at(24 * 3600000))
  await page.getByLabel('汇率原因').fill('本月人工汇率')
  pricing.concurrentFx({ rate_numerator: '15', rate_denominator: '2', observed_at: at(-5400000), valid_from: at(-5400000), valid_until: at(24 * 3600000) })
  await button('发布汇率').click()
  await page.getByText('已被他人更新到新的修订，表单已保留。').waitFor()
  assert.equal(await field('rate').inputValue(), '7.50')
  await button('刷新汇率头').click()
  await page.getByText('已基于汇率修订 v2 更新，请核对后再发布。').waitFor()
  await button('发布汇率').click()
  await page.getByText(/^已发布汇率 v3。/).waitFor()
  assert.equal(ps.fxPosts.at(-1).body.expected_fx_revision, 2)
  assert.deepEqual([ps.fxPosts.at(-1).body.rate_numerator, ps.fxPosts.at(-1).body.rate_denominator], [fixture.pricing.fx.rate_numerator, fixture.pricing.fx.rate_denominator])
  await page.locator('.inline-pane').first().getByRole('button', { name: '← 返回' }).click()
  await page.locator('tr.clickable').getByText('v3 · 当前适用').waitFor()
  const before = ps.secondPages
  await page.locator('.pager').getByRole('button', { name: '下一页' }).click()
  await page.locator('tr.clickable').getByText('v1', { exact: true }).waitFor()
  assert.equal(ps.secondPages, before + 1)
  await capture('fx-ledger')

  // 6.5 完整试算 3× → 手调 4×；慢响应丢弃；409 保留手调与理由后二次发布；5xx 同体同键重放
  await openMultiplier()
  await button('试算倍率').click()
  await page.getByText('完整试算').waitFor()
  const channels = page.getByRole('table', { name: '渠道输入价' })
  await channels.getByText('US$0.40 / 1,000,000').waitFor()
  await channels.getByText('¥7.5/USD · v3').waitFor()
  await channels.getByText('¥3.00').waitFor()
  assert.equal(ps.lastRatePreview.recommended_input_multiplier_ppm, fixture.pricing.recommended_input_multiplier_ppm)
  await button('发布可签倍率').waitFor()
  await page.getByLabel('最终倍率（×）').fill('4')
  await page.getByText('最终倍率或理由已修改，需重新试算后才能发布。').waitFor()
  assert.equal(await button('发布可签倍率').isVisible(), false)
  await page.getByLabel('倍率理由').fill('按签约标准报价')
  ps.delayNextRatePreview = 800
  await button('重新试算').click()
  await page.getByLabel('倍率理由').fill('按签约标准报价（改）')
  await page.getByText('试算期间表单已修改，旧结果已丢弃，请重新试算。').waitFor()
  assert.equal(await button('发布可签倍率').isVisible(), false)
  await page.getByLabel('倍率理由').fill('按签约标准报价')
  await button('重新试算').click()
  await page.getByText('4 块／百万输入 Token').waitFor()
  await button('发布可签倍率').waitFor()
  assert.equal(ps.lastRatePreview.input_multiplier_ppm, fixture.pricing.signed_input_multiplier_ppm)
  await capture('multiplier-preview')
  const otherRate = pricing.concurrentRate()
  await button('发布可签倍率').click()
  await page.getByText('已被他人更新到新的修订，表单已保留。').waitFor()
  assert.equal(await page.getByLabel('最终倍率（×）').inputValue(), '4')
  assert.equal(await page.getByLabel('倍率理由').inputValue(), '按签约标准报价')
  const conflictKey = ps.ratePosts.at(-1).key
  await button('按最新数据重新计算').click()
  await button('发布可签倍率').waitFor()
  assert.equal(ps.ratePreviews.at(-1).expected_source_rate_key, otherRate, '冲突详情刷新可签头')
  assert.equal(Object.hasOwn(ps.ratePreviews.at(-1), 'pricing_at'), false, '冲突后去掉旧时点重算')
  ps.fail5xxNextRate = true
  await button('发布可签倍率').click()
  await page.getByText(/结果不明，重试将使用同一提交键/).waitFor()
  await button('发布可签倍率').click()
  await page.getByText(/^已发布平台可签输入倍率 4×（prate_m_2）。/).waitFor()
  const [gateway, published] = ps.ratePosts.slice(-2)
  assert.equal(gateway.key, published.key, '网关 5xx 同体同键重放')
  assert.deepEqual(gateway.body, published.body)
  assert.notEqual(published.key, conflictKey)
  assert.deepEqual(published.body, { expected_pool_revision: stub.state.current, expected_source_rate_key: otherRate,
    pricing_at: ps.lastRatePreview.pricing_at, manual_input_multiplier_ppm: 4000000, reason: '按签约标准报价', preview_basis: ps.lastRatePreview.preview_basis })
  await page.getByText('平台可签', { exact: true }).waitFor()
  await page.getByText('平台可签：仅表示可选入签发。', { exact: false }).waitFor()
  assert.equal(await page.getByText(/^(已应用|已签发|设备已应用)/).count(), 0, '可签与设备应用、租户签发严格区分')
  await capture('multiplier-published')
  // 切换表单保护：慢试算期间返回概览，旧结果不得渲染
  await button('返回概览').click()
  await page.getByText('prate_m_2', { exact: true }).waitFor()
  ps.delayNextRatePreview = 800
  await button('试算倍率').click()
  await button('返回概览').click()
  await page.waitForTimeout(1200)
  assert.equal(await page.getByText('完整试算').count(), 0)
  await button('试算倍率').waitFor()
  await page.locator('.inline-head').first().getByRole('button', { name: '← 返回' }).click()
  await page.locator('tr.clickable', { hasText: 'DeepSeek V4.1 Flash' }).getByText('4×').waitFor()
  assert.deepEqual(errors, [])
  console.log('routing-check ok: cards, signed models, candidates, preview, idempotent publish v7, equal priority, 409 keep-draft, key rotation, stale reconcile, readback v' + final
    + '; pricing: quotes, FX (expired/conflict/two pages), multiplier 3x→4x, 409 retain, 5xx replay, stale-view guard')
} catch (e) {
  for (const p of browser.contexts().flatMap(c => c.pages())) await p.screenshot({ path: join(dir, 'failure.png') }).then(() => Bun.write('.local/routing-failure.png', Bun.file(join(dir, 'failure.png')))).catch(() => {})
  console.error('rate posts:', JSON.stringify(pricing.state.ratePosts.map(p => ({ key: p.key, body: p.body })), null, 1))
  throw e
} finally {
  await browser.close()
  await app.close()
  await rm(dir, { recursive: true, force: true })
}
