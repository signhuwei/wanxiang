// 用同一 Server 验证管理端发布和员工下载。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../../src/server.ts'
import { seedTenant } from '../../src/seed.ts'
import { MemoryPresence } from '../../src/presence.ts'

// 最小但结构合规的 XAR：固定 28 字节头 + zlib 压缩的 TOC XML。真实安装包可通过
// ONEX_TEST_PKG_FIXTURE 指到一个实际的 .pkg（例如 RC3），走同一条断言路径。
function buildMinimalXar() {
  const toc = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><xar><toc></toc></xar>', 'utf8')
  const compressed = deflateSync(toc)
  const header = Buffer.alloc(28)
  header.write('xar!', 0, 'ascii')          // magic
  header.writeUInt16BE(28, 4)                // header size
  header.writeUInt16BE(1, 6)                 // version
  header.writeBigUInt64BE(BigInt(compressed.length), 8)   // toc_length_compressed
  header.writeBigUInt64BE(BigInt(toc.length), 16)          // toc_length_uncompressed
  header.writeUInt32BE(1, 24)                // checksum algorithm (SHA-1 = 1)
  return Buffer.concat([header, compressed])
}

async function artifactFixture(dir) {
  const override = process.env.ONEX_TEST_PKG_FIXTURE
  const path = join(dir, 'fixture.pkg')
  if (override) {
    await Bun.write(path, Bun.file(override))
  } else {
    await Bun.write(path, buildMinimalXar())
  }
  return path
}

const dir = await mkdtemp(join(tmpdir(), 'onex-web-releases-test-'))
const target = 'owner@example.test'
let code
const app = await createServer({ dataDir: dir, hostname: '127.0.0.1', port: 0, heartbeatMs: 15000,
  tenantCacheSize: 2, presence: new MemoryPresence(), commit: 'test', codeSecret: crypto.randomUUID(), masterKey: crypto.getRandomValues(new Uint8Array(32)),
  deliverCode: (_, value) => { code = value } })
// Map a plain HTTP origin to loopback so Chrome exercises the same context as the intranet.
const browserUrl = new URL(app.server.url)
browserUrl.hostname = 'onex-release.test'
const browser = await chromium.launch({ channel: 'chrome',
  args: ['--disable-gpu', '--no-proxy-server', '--host-resolver-rules=MAP onex-release.test 127.0.0.1'] })
try {
  await seedTenant(app.store, { target, name: '联调租户', platformAdmin: true })
  const page = await browser.newPage({ baseURL: browserUrl.href, viewport: { width: 1280, height: 720 } })
  page.setDefaultTimeout(3500)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const button = name => page.getByRole('button', { name, exact: true })
  const link = name => page.getByRole('link', { name, exact: true })
  const field = name => page.locator(`[name="${name}"]`)

  await page.goto('/')
  assert.equal(await page.evaluate(() => window.isSecureContext), false)
  await page.getByPlaceholder('邮箱或手机号').fill(target)
  await button('发送验证码').click()
  await page.getByText('验证码已发送，请查收').waitFor()
  await page.getByPlaceholder('6 位验证码').fill(code)
  await button('登录').click()
  await link('平台').click()
  await link('安装包发布').click()
  await page.getByRole('heading', { name: '安装包发布' }).waitFor()

  await button('新建发布').click()
  await field('version').fill('1.4.0')
  await field('os').selectOption('darwin') // 架构由平台派生，S2 阶段不单独选
  const draft = page.waitForResponse(res => new URL(res.url()).pathname === '/v1/platform/desktop-releases'
    && res.request().method() === 'POST')
  await button('新建草稿').click()
  assert.equal((await draft).status(), 201)
  await page.getByLabel('安装包文件').waitFor()

  const fixture = await artifactFixture(dir)
  await page.getByLabel('安装包文件').setInputFiles(fixture)
  await button('上传').click()
  await page.getByText('上传完成', { exact: false }).waitFor()
  await button('发布').click()
  await button('下架').waitFor()

  const guestContext = await browser.newContext({ baseURL: browserUrl.href,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' })
  const guestPage = await guestContext.newPage()
  await guestPage.goto('/download')
  await guestPage.getByText('该平台暂无已发布的安装包').waitFor()
  await guestPage.getByRole('button', { name: 'macOS', exact: true }).click()
  await guestPage.getByText('1.4.0', { exact: false }).waitFor()
  const downloadLink = guestPage.getByRole('link', { name: '下载' })
  const oldPath = new URL(await downloadLink.getAttribute('href'), browserUrl).pathname
  const downloadPromise = guestPage.waitForEvent('download')
  await downloadLink.click()
  const download = await downloadPromise
  assert.equal(await download.failure(), null)
  const digest = async path => createHash('sha256').update(await Bun.file(path).bytes()).digest('hex')
  assert.equal(await digest(await download.path()), await digest(fixture))
  assert.equal(
    await guestPage.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('onex.session'))),
    false
  )
  await guestContext.close()

  // 下架后，同一个无登录入口应变为空态，旧下载链接不可用。
  await button('下架').click()
  await page.locator('.kv').getByText(/状态\s*已下架/).waitFor()
  assert.equal((await fetch(new URL(oldPath, app.server.url))).status, 404)
  const afterUnpublish = await browser.newContext({ baseURL: browserUrl.href })
  const afterPage = await afterUnpublish.newPage()
  await afterPage.goto('/download')
  await afterPage.getByText('暂无已发布的安装包').waitFor()
  await afterUnpublish.close()

  assert.deepEqual(errors, [])
  console.log('真实 Server：安装包发布台账（草稿、上传、发布、下架）与员工下载（发布后可下载、下架后空态）通过')
} finally {
  await browser.close()
  await app.close()
  await rm(dir, { recursive: true, force: true })
}
