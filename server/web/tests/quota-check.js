// 真实 Server 配额联调（S2B-W2）：临时库、真实 Edge WS 握手签发并续租一笔租约，
// 核对成员/组台账「本月已用/配额」、钻取详情的已结算/预留/剩余、个人菜单 /me.quota 与 API 返回一致。
// 参照 workspace-check.js 的真实 Server 起法和 observe-live.js 的 Edge WS 握手写法。
import { openCodeLogin } from './login-flow.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../../src/server.ts'
import { seedTenant } from '../../src/seed.ts'
import { MemoryPresence } from '../../src/presence.ts'

const dir = await mkdtemp(join(tmpdir(), 'onex-quota-test-'))
const owner = 'quota-owner@example.test'
let code
const app = await createServer({ dataDir: dir, hostname: '127.0.0.1', port: 0, heartbeatMs: 15000,
  tenantCacheSize: 2, presence: new MemoryPresence(), commit: 'test', codeSecret: crypto.randomUUID(), masterKey: crypto.getRandomValues(new Uint8Array(32)),
  deliverCode: (_, value) => { code = value } })
const browser = await chromium.launch({ channel: 'chrome', args: ['--disable-gpu'] })
try {
  // platformAdmin 让户主可以直接给自己的租户充值（/platform/ledger/topup 需要全局令牌 + 平台管理员）。
  const seed = await seedTenant(app.store, { target: owner, name: '配额联调租户', platformAdmin: true })
  const { tenantId } = seed

  const page = await browser.newPage({ baseURL: app.server.url.href, viewport: { width: 1280, height: 720 } })
  page.setDefaultTimeout(3500)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/v1/')) return route.continue()
    const file = Bun.file(new URL('..' + (path === '/' ? '/index.html' : path), import.meta.url))
    return route.fulfill({ status: await file.exists() ? 200 : 404, contentType: file.type, body: await file.exists() ? await file.text() : '' })
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const link = name => page.getByRole('link', { name, exact: true })
  const field = name => page.locator(`[name="${name}"]`)

  async function login(target) {
    await page.goto(app.server.url.href)
    await openCodeLogin(page)
    await page.getByPlaceholder('邮箱或手机号').fill(target)
    await button('发送验证码').click()
    await page.getByText('验证码已发送，请查收').waitFor()
    await page.getByPlaceholder('6 位验证码').fill(code)
    await button('登录').click()
  }

  await login(owner)
  await page.locator('tr.clickable').waitFor()
  console.log('owner 登录成功，成员台账可见')

  // 登录验证码一次性消费，不再单独请求第二份：从页面会话里取 globalToken 用于平台充值。
  const ownerSession = JSON.parse(await page.evaluate(() => localStorage.getItem('onex.session')))
  const ownerGlobalToken = ownerSession.globalToken
  const topup = await page.request.post('/v1/platform/ledger/topup', {
    data: { tenant_id: tenantId, amount_milli: 1000000 }, headers: { Authorization: 'Bearer ' + ownerGlobalToken }
  })
  assert(topup.ok(), '平台充值失败：' + topup.status())
  console.log('租户充值 1000 橡皮')

  // 两级组：部门（配额 2 橡皮）→ 小组（配额 1 橡皮，子组配额收得更紧）。
  await link('分组').click()
  await button('新建分组').click()
  await field('name').fill('部门')
  await field('quota_eraser').fill('2')
  await button('保存').click()
  await page.getByText('部门', { exact: true }).waitFor()
  const ownerAuth = { headers: { Authorization: 'Bearer ' + ownerSession.token } }
  const groupsAfterParent = await (await page.request.get('/v1/groups?limit=200', ownerAuth)).json()
  const parentId = groupsAfterParent.items.find(g => g.name === '部门').id

  await button('新建分组').click()
  await field('name').fill('小组')
  await field('parent_id').fill(parentId)
  await field('quota_eraser').fill('1')
  await button('保存').click()
  await page.getByText('小组', { exact: true }).waitFor()
  const groupsAfterChild = await (await page.request.get('/v1/groups?limit=200', ownerAuth)).json()
  const childGroup = groupsAfterChild.items.find(g => g.name === '小组')
  assert.equal(childGroup.parent_id, parentId)
  assert.equal(childGroup.quota_milli, 1000)
  console.log('两级组创建完成：部门(2 橡皮) → 小组(1 橡皮)')

  // 邀请一名成员加入小组，个人配额 0.5 橡皮（比子组配额更紧，预期 limited_by=member）。
  await link('成员').click()
  await button('生成邀请码').click()
  await field('group_id').fill(childGroup.id)
  await button('生成').click()
  const inviteCode = await page.getByLabel('一次性邀请码').inputValue()
  await button('← 返回').click()

  const staff = 'quota-staff@example.test'
  await page.request.post('/v1/auth/code', { data: { target: staff } })
  const staffCode = code
  const staffLogin = await page.request.post('/v1/auth/login', { data: { target: staff, code: staffCode, invite_code: inviteCode } })
  assert(staffLogin.ok())
  const { token: staffGlobalToken } = await staffLogin.json()
  const staffTenantRes = await page.request.post('/v1/auth/select-tenant', {
    data: { tenant_id: tenantId }, headers: { Authorization: 'Bearer ' + staffGlobalToken }
  })
  const { token: staffToken } = await staffTenantRes.json()
  const staffMe = await (await page.request.get('/v1/me', { headers: { Authorization: 'Bearer ' + staffToken } })).json()
  const staffId = staffMe.user.id

  // 成员是后台 API 加入的，台账需要重新挂载才能看到新行。
  await link('分组').click()
  await link('成员').click()
  const staffRow = page.locator('tr.clickable').filter({ hasText: staff })
  await staffRow.click()
  await button('编辑').click()
  await field('quota_eraser').fill('0.5')
  await button('保存').click()
  await page.getByText('0.5', { exact: true }).first().waitFor()
  await button('← 返回').click()
  console.log('成员 quota-staff 加入小组，个人配额 0.5 橡皮')

  // 注册设备、做一次 Edge WS 握手拿初始租约，再续租结清一笔，制造真实的 settle + 下一份 active 租约预留。
  const publicKey = Buffer.alloc(32, 7).toString('base64')
  const deviceRes = await page.request.post('/v1/devices', {
    data: { name: '联调 Edge', os: 'darwin', arch: 'arm64', public_key: publicKey },
    headers: { Authorization: 'Bearer ' + staffToken, 'Idempotency-Key': 'device-' + crypto.randomUUID() }
  })
  assert.equal(deviceRes.status(), 201)
  const { device_token: deviceToken } = await deviceRes.json()

  async function wsHandshake() {
    const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/v1/edge/ws`,
      { headers: { Authorization: 'Bearer ' + deviceToken, 'OneX-Edge-Version': '0.1.0', 'OneX-Protocol': '0' } })
    const queue = []
    ws.onmessage = ({ data }) => queue.push(JSON.parse(data))
    async function next(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      while (!queue.length) {
        if (Date.now() > deadline) throw new Error('等待 Edge WS 消息超时')
        await new Promise(r => setTimeout(r, 10))
      }
      return queue.shift()
    }
    // config/secret 随时可能插进来（config.connect 在 welcome 之后异步推送），跳过它们等真正要的类型。
    async function nextOf(...types) {
      for (;;) {
        const msg = await next()
        if (types.includes(msg.type)) return msg
        if (msg.type !== 'config' && msg.type !== 'secret') throw new Error(`期望 ${types.join('|')}，收到 ${msg.type}：${JSON.stringify(msg)}`)
      }
    }
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    ws.send(JSON.stringify({ type: 'hello', id: 'hello-1', edge_version: '0.1.0', os: 'darwin', arch: 'arm64', config_revision: 0, outbox_last_seq: 0 }))
    assert.equal((await nextOf('welcome')).type, 'welcome')
    const lease = await nextOf('lease', 'cutoff') // 紧跟 welcome 的初始租约（hello 没带 lease_id）
    assert.equal(lease.type, 'lease')
    return { ws, next, nextOf, lease }
  }

  const edge = await wsHandshake()
  // 个人配额 500 毫橡皮比余额 5% 下限（50000）和合约默认额度（2000）都紧，预期这份租约被配额收到 500。
  assert.equal(edge.lease.budget_milli, 500, 'Edge 初始租约应被 quota-staff 的 0.5 橡皮个人配额收紧到 500 毫橡皮')
  edge.ws.send(JSON.stringify({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: edge.lease.lease_id, used_milli: 300 }))
  const renewed = await edge.nextOf('lease', 'cutoff')
  // 结清 300/500；个人剩余配额变成 200，下一份租约按新剩余重新裁决（200 仍比组和余额宽裕的限额更紧）。
  assert.equal(renewed.type, 'lease', 'Edge 续租后应立即拿到下一份按新剩余裁决的租约，不是 cutoff：' + JSON.stringify(renewed))
  assert.equal(renewed.budget_milli, 200)
  edge.ws.close()
  console.log('Edge 续租结清 300 毫橡皮，个人配额剩余收紧到 200 毫橡皮，下一份租约 budget_milli=200')

  const staffUsage = await (await page.request.get(`/v1/quota/usage?scope=member&id=${staffId}`, { headers: { Authorization: 'Bearer ' + staffToken } })).json()
  // settle 300（已结算）+ 新租约预留 200（仍 active）= 本月已用口径 500，恰好等于个人配额，UI 应显示 error 态。
  assert.deepEqual(staffUsage, { scope: 'member', id: staffId, quota_distribution: true, quota_milli: 500,
    used_milli: 300, reserved_milli: 200, remaining_milli: 0, actions: ['read'] })
  console.log('quota-staff /quota/usage 核对通过：已结算 300 + 预留 200 = 配额 500，剩余 0')

  const groupUsage = await (await page.request.get(`/v1/quota/usage?scope=group&id=${parentId}`, ownerAuth)).json()
  assert.deepEqual(groupUsage, { scope: 'group', id: parentId, quota_distribution: true, quota_milli: 2000,
    used_milli: 300, reserved_milli: 200, remaining_milli: 1500, actions: ['read'] })
  console.log('部门组 /quota/usage 核对通过：已结算 300 + 预留 200，剩余 1500')

  // ---- 管理端台账：成员台账「本月已用/配额」列应与 /quota/usage 一致 ----
  await page.reload()
  await staffRow.waitFor()
  await staffRow.locator('.status').filter({ hasText: '0.5 / 0.5' }).waitFor()
  console.log('成员台账「本月已用/配额」列显示 0.5 / 0.5（与 settle+reserve 口径一致）')

  // kv 区块是 <span>标签</span>文本节点 交替排列，Playwright innerText() 按渲染行拆开：标签和值各占一行。
  function kvValue(lines, label) {
    const i = lines.indexOf(label)
    if (i === -1) throw new Error('kv 里没有标签「' + label + '」：' + lines.join(' | '))
    return lines[i + 1]
  }

  await staffRow.click()
  const memberKv = page.locator('.kv').first()
  await memberKv.getByText('本月已结算').waitFor()
  const memberKvLines = (await memberKv.innerText()).split('\n')
  assert.equal(kvValue(memberKvLines, '本月已结算（块）'), '0.3')
  assert.equal(kvValue(memberKvLines, '预留（块）'), '0.2')
  assert.equal(kvValue(memberKvLines, '剩余（块）'), '0')
  console.log('成员钻取详情：已结算 0.3、预留 0.2、剩余 0，与 /quota/usage 一致')
  await button('← 返回').click()

  // ---- 管理端台账：分组台账同口径 ----
  await link('分组').click()
  const parentRow = page.locator('tr.clickable').filter({ hasText: '部门' })
  await parentRow.locator('.status').filter({ hasText: '0.5 / 2' }).waitFor()
  console.log('部门组台账「本月已用/配额」列显示 0.5 / 2（已结算 0.3 + 预留 0.2）')

  await parentRow.click()
  const groupKv = page.locator('.kv').first()
  await groupKv.getByText('本月已结算').waitFor()
  const groupKvLines = (await groupKv.innerText()).split('\n')
  assert.equal(kvValue(groupKvLines, '本月已结算（块）'), '0.3')
  assert.equal(kvValue(groupKvLines, '预留（块）'), '0.2')
  assert.equal(kvValue(groupKvLines, '剩余（块）'), '1.5')
  console.log('部门组钻取详情：已结算 0.3、预留 0.2、剩余 1.5，与 /quota/usage 一致')
  await button('← 返回').click()

  // ---- /me.quota：以 quota-staff 本人登录查看个人菜单 ----
  // 登录验证码 60 秒冷却，staff 刚用过一次：复用已有令牌写会话存储，不再走一遍验证码登录。
  const staffPage = await browser.newPage({ baseURL: app.server.url.href, viewport: { width: 1280, height: 720 } })
  await staffPage.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/v1/')) return route.continue()
    const file = Bun.file(new URL('..' + (path === '/' ? '/index.html' : path), import.meta.url))
    return route.fulfill({ status: await file.exists() ? 200 : 404, contentType: file.type, body: await file.exists() ? await file.text() : '' })
  })
  await staffPage.goto(app.server.url.href)
  const freshStaffMe = await (await page.request.get('/v1/me', { headers: { Authorization: 'Bearer ' + staffToken } })).json()
  const staffSession = { ...freshStaffMe, token: staffToken, globalToken: staffGlobalToken, globalActions: [], is_platform_admin: false }
  await staffPage.evaluate(session => localStorage.setItem('onex.session', JSON.stringify(session)), staffSession)
  await staffPage.reload()
  await staffPage.locator('.account-menu summary').waitFor()
  await staffPage.locator('.account-menu summary').click()
  const quotaItem = staffPage.locator('.quota-item')
  await quotaItem.getByText('0 块橡皮', { exact: true }).waitFor()
  await quotaItem.getByText(/受分组|受个人配额限制/).waitFor()
  const quotaNote = await quotaItem.locator('.quota-item-note').innerText()
  assert(quotaNote.includes('个人配额'), 'remaining=0 时 limited_by 应为 member（个人配额），实际提示：' + quotaNote)
  console.log('个人菜单 /me.quota：本月剩余 0 块橡皮，提示「' + quotaNote + '」')
  await staffPage.close()

  assert.deepEqual(errors, [])
  console.log('真实 Server：两级组配额、Edge 握手续租、台账/钻取/个人菜单配额展示全部核对通过')
} finally {
  await browser.close()
  await app.close()
  await rm(dir, { recursive: true, force: true })
}
