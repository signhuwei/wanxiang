// 设备投影 P2 真实联验：Server 分支的隔离启动脚本（tests/e2e/routing/projection-server.ts）提供 HTTP 与 WS，
// 本分支只提供 WebUI 静态文件。目标台账和应用回执全部走真实接口，/v1 不做任何拦截。
// 设备用测试进程内的 WebSocket 客户端模拟（合成私钥 0x07×32、合成凭据），不连接生产。
//
//   bun --no-env-file server/web/tests/routing-projection-live-check.js [--server-tree DIR] [截图目录]
//
// --server-tree 默认为 ../routing-projection-server（Server 分支工作树，需在 5ddd9ff 或之后）。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const argv = Bun.argv.slice(2)
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined }
const serverTree = resolve(flag('--server-tree') ?? join(import.meta.dir, '../../../../routing-projection-server'))
const shots = argv[0]
if (shots) await mkdir(shots, { recursive: true })
const script = join(serverTree, 'tests/e2e/routing/projection-server.ts')
const webRoot = join(import.meta.dir, '..')
const dir = await mkdtemp(join(tmpdir(), 'onex-projection-live-'))
const sockets = []
let child, browser

async function startServer() {
  // 保存子进程句柄，只经由句柄结束，不按名称查杀。
  child = Bun.spawn(['bun', '--no-env-file', script, '--data-dir', dir], { cwd: serverTree, stdout: 'pipe', stderr: 'inherit' })
  const reader = child.stdout.getReader()
  let text = ''
  while (!text.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error('projection-server exited before printing its JSON line')
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return JSON.parse(text.split('\n')[0])
}

function device(info, id) {
  const ws = new WebSocket(info.ws_url, { headers: { Authorization: 'Bearer ' + info.devices[id].token, 'OneX-Edge-Version': '0.1.0', 'OneX-Protocol': '0' } })
  sockets.push(ws)
  const queue = []
  ws.onmessage = event => queue.push(JSON.parse(String(event.data)))
  const opened = new Promise((ok, fail) => { ws.onopen = () => ok(); ws.onerror = fail })
  async function next(match) {
    const deadline = Date.now() + 5000
    for (;;) {
      const i = queue.findIndex(match)
      if (i >= 0) return queue.splice(i, 1)[0]
      if (Date.now() > deadline) throw new Error(id + ' 等待帧超时；已收到 ' + JSON.stringify(queue.map(f => f.type)))
      await Bun.sleep(10)
    }
  }
  return {
    opened, next,
    send: frame => ws.send(JSON.stringify(frame)),
    ack: id => next(f => f.type === 'ack' && f.re === id),
    hello: revision => ws.send(JSON.stringify({ type: 'hello', id: 'h_' + id, edge_version: '0.1.0', os: 'darwin', arch: 'arm64',
      config_revision: revision, outbox_last_seq: 0, lease_id: null, ...info.hello }))
  }
}

try {
  const info = await startServer()
  const http = info.http_url
  const me = await (await fetch(http + '/v1/me', { headers: { Authorization: 'Bearer ' + info.platform_session } })).json()
  assert.equal(me.is_platform_admin, true, '隔离 Server 的平台会话必须是平台管理员')
  // 与 login.js 平台管理员分支相同的会话形状，跳过验证码投递（隔离 Server 不投递验证码）。
  const session = { ...me, globalActions: me.actions || [], token: info.platform_session, globalToken: info.platform_session, tenantChoices: [] }

  browser = await chromium.launch({ channel: 'chrome', args: ['--disable-gpu', '--no-proxy-server'] })
  const context = await browser.newContext({ baseURL: http, viewport: { width: 1280, height: 720 } })
  await context.addInitScript(value => { localStorage.setItem('onex.session', value) }, JSON.stringify(session))
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const errors = [], apiCalls = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/platform/model-pool-rollouts/')) apiCalls.push(u.pathname + u.search) })
  // 只替换静态文件为本分支 WebUI；/v1 原样到真实 Server。
  await page.route(url => !url.pathname.startsWith('/v1/'), async route => {
    const path = new URL(route.request().url()).pathname
    const file = Bun.file(join(webRoot, path === '/' ? 'index.html' : path))
    if (!await file.exists()) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ status: 200, contentType: file.type, body: Buffer.from(await file.arrayBuffer()) })
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const link = name => page.getByRole('link', { name, exact: true })
  async function capture(label) {
    if (!shots) return
    for (const [width, height] of [[1280, 720], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      await page.locator('.rollout-targets').last().scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shots, `${width}x${height}-live-${label}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 720 })
  }
  async function openPool(reason) {
    await page.goto('/#/platform/models')
    await page.getByRole('cell', { name: 'DeepSeek V4.1 Flash', exact: true }).click()
    await page.locator('.inline-pane tr.clickable', { hasText: reason }).click()
    return page.locator('.rollout-targets')
  }
  const cells = async (section, id, from, to) => section.locator('tbody tr', { hasText: id }).locator('td').evaluateAll((t, [a, b]) => t.slice(a, b).map(n => n.textContent), [from, to])
  const refresh = async section => { await section.getByRole('button', { name: '刷新', exact: true }).click() }

  // 4. 收到合法 applied 之前：平台目标可见，已应用保持原值。设备未连接 → 离线。
  let v7 = await openPool('add B')
  await v7.getByText('池 v7 · 发布任务 rol_v7 · 任务状态').waitFor()
  await v7.locator('tbody tr', { hasText: 'dev_lin' }).waitFor()
  assert.deepEqual(await cells(v7, 'dev_lin', 3, 7), ['91', '未应用', '离线', '设备离线（device_offline）'])
  await capture('v7-offline')
  // 设备连上并协商 route_pool.v1，收到 v91 但尚未回执 → 等待应用。
  const lin = device(info, 'dev_lin')
  await lin.opened
  lin.hello(90)
  await lin.next(f => f.type === 'welcome')
  const config = await lin.next(f => f.type === 'config')
  assert.deepEqual([config.revision, config.route_pool.projection_id, config.rates[0].input_multiplier_ppm], [91, 'prj_91', 4000000])
  await refresh(v7)
  await v7.locator('tbody tr', { hasText: 'dev_lin' }).getByText('等待应用').waitFor()
  assert.deepEqual(await cells(v7, 'dev_lin', 3, 7), ['91', '未应用', '等待应用', '已发送，等待回执（awaiting_receipt）'])
  assert.equal(await cells(v7, 'dev_lin', 8, 9).then(v => v[0]), '—', '本目标尚无回执')

  // 5. 合法 applied：已应用推进到 91，回执时间只指本目标。
  const applied = { type: 'config_applied', id: 'ca91', config_revision: 91, policy_revision: config.policy.policy_revision, projection_id: 'prj_91', result: 'applied' }
  lin.send(applied)
  assert.deepEqual(await lin.ack('ca91'), { type: 'ack', re: 'ca91', ok: true })
  await refresh(v7)
  await v7.getByRole('button', { name: '已应用 1', exact: true }).waitFor()
  await v7.locator('tbody tr', { hasText: 'dev_lin' }).getByText('已应用').waitFor()
  assert.deepEqual(await cells(v7, 'dev_lin', 3, 7), ['91', '91', '已应用', '—'])
  assert.notEqual((await cells(v7, 'dev_lin', 8, 9))[0], '—', '成功回执后有本目标回执时间')
  await capture('v7-applied')

  // 6. 同 ID 同内容重放复用确认；同 ID 换 result 报 receipt_changed，台账不倒退。
  lin.send(applied)
  assert.deepEqual(await lin.ack('ca91'), { type: 'ack', re: 'ca91', ok: true })
  lin.send({ ...applied, result: 'rejected', error: { code: 'missing_route_credential', message: '新配置缺少可用的渠道凭据', detail: { reason: 'missing_envelope' } } })
  const changed = await lin.ack('ca91')
  assert.equal(changed.ok, false)
  assert.deepEqual([changed.error.code, changed.error.detail?.reason], ['conflict', 'receipt_changed'])
  // 错投影不推进
  lin.send({ ...applied, id: 'ca91_wrong', projection_id: 'prj_92' })
  const wrong = await lin.ack('ca91_wrong')
  assert.equal(wrong.ok, false)
  await refresh(v7)
  await v7.getByRole('button', { name: '已应用 1', exact: true }).waitFor()
  assert.deepEqual(await cells(v7, 'dev_lin', 3, 6), ['91', '91', '已应用'])

  // 设备拒绝：固定 v6 的 dev_fix 回 rejected，reason 取 error.detail.reason，已应用保持原值。
  const fix = device(info, 'dev_fix')
  await fix.opened
  fix.hello(90)
  await fix.next(f => f.type === 'welcome')
  const fixConfig = await fix.next(f => f.type === 'config')
  assert.deepEqual([fixConfig.revision, fixConfig.route_pool.projection_id], [92, 'prj_92'])
  fix.send({ type: 'config_applied', id: 'ca92_reject', config_revision: 92, policy_revision: fixConfig.policy.policy_revision, projection_id: 'prj_92',
    result: 'rejected', error: { code: 'missing_route_credential', message: '新配置缺少可用的渠道凭据', detail: { reason: 'missing_envelope', deployment_id: 'dep_a' } } })
  assert.equal((await fix.ack('ca92_reject')).ok, true)
  const v6 = await openPool('seed v6')
  await v6.getByText('池 v6 · 发布任务 rol_v6 · 任务状态').waitFor()
  await v6.getByRole('button', { name: '已拒绝 1', exact: true }).click()
  await v6.getByText('共 1 条').waitFor()
  await v6.locator('tbody tr', { hasText: 'dev_fix' }).waitFor()
  assert.deepEqual(await cells(v6, 'dev_fix', 3, 7), ['92', '未应用', '已拒绝', '缺推理密钥信封（missing_envelope）'])
  assert.ok(apiCalls.some(p => p.includes('/rol_v6/targets') && p.includes('state=rejected')), '筛选走真实 state 参数')
  assert.equal(await v6.locator('tbody button').count(), 0, '目标行无写操作')
  await capture('v6-rejected')
  // 筛选“已应用”时 v6 没有行，总数为过滤后总数
  await v6.getByRole('button', { name: '已应用 0', exact: true }).click()
  await v6.getByText('没有符合条件的目标设备').waitFor()

  assert.deepEqual(errors, [])
  console.log('routing-projection-live-check ok: real HTTP ledger via ' + script + ' — v91 offline→pending→applied, replay/receipt_changed/wrong projection keep head, v92 rejected missing_envelope, state filter')
} finally {
  for (const ws of sockets) ws.close()
  await browser?.close()
  if (child) { child.kill('SIGTERM'); await child.exited }
  await rm(dir, { recursive: true, force: true })
}
