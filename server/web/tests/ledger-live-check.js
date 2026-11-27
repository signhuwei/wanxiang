import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const root = new URL('../', import.meta.url)
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  if (path === '/') return new Response('<link rel="stylesheet" href="/app.css"><div id="app"><main id="host" class="workspace"></main></div>', { headers: { 'Content-Type': 'text/html' } })
  if (!/^\/[\w-]+\.(css|js)$/.test(path)) return new Response(null, { status: 404 })
  const file = Bun.file(new URL('.' + path, root))
  return await file.exists() ? new Response(file) : new Response(null, { status: 404 })
} })
let browser
try {
  browser = await chromium.launch(process.env.ONEX_TEST_BROWSER ? { channel: process.env.ONEX_TEST_BROWSER } : {})
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  await page.goto(server.url.href)
  await page.evaluate(async () => {
    const { createLedger } = await import('/ledger.js')
    const { detailPanel } = await import('/panel.js')
    const host = document.querySelector('#host')
    const rows = ['A', 'B'].map(id => ({ id, name: id, actions: ['read'] }))
    let requests = 0
    let ledger
    const open = detailPanel(host, () => ledger, { live: true })
    ledger = createLedger(host, {
      title: '测试台账', columns: [{ key: 'name', title: '名称' }],
      fetchPage: async () => {
        requests++
        if (requests === 2) await new Promise(resolve => { window.releaseResponse = resolve })
        if (requests === 4) throw new Error('暂时不可用')
        return { items: requests === 1 ? rows : [rows[1], { ...rows[0], name: 'A updated' }] }
      },
      onOpen: item => open(item.id, pane => { pane.body.textContent = item.name })
    })
    window.refreshLedger = () => ledger.reloadInBackground()
    window.requestCount = () => requests
  })
  const rowA = page.locator('tr[data-key="A"]')
  const cell = rowA.getByText('A', { exact: true })
  await cell.waitFor()
  await rowA.evaluate(row => { window.originalRow = row; window.originalButton = row.querySelector('button') })
  await page.evaluate(() => window.refreshLedger())
  const bounds = await cell.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.evaluate(() => window.releaseResponse())
  assert.equal(await cell.textContent(), 'A')
  await page.mouse.up()
  await page.getByRole('heading', { name: 'A', exact: true }).waitFor()
  await rowA.getByText('A updated', { exact: true }).waitFor()
  assert.ok(await rowA.evaluate(row => row === window.originalRow && row.querySelector('button') === window.originalButton))
  await page.locator('tr[data-key="B"]').getByText('B', { exact: true }).click()
  await page.getByRole('heading', { name: 'B', exact: true }).waitFor()
  assert.equal(await page.locator('tr.selected').getAttribute('data-key'), 'B')
  assert.equal(await page.locator(':focus').textContent(), '← 返回')
  await page.getByRole('button', { name: '← 返回' }).click()
  await rowA.getByText('A updated', { exact: true }).waitFor()
  await page.evaluate(() => window.refreshLedger())
  assert.equal(await page.evaluate(() => window.requestCount()), 4)
  assert.equal(await rowA.getByText('A updated', { exact: true }).textContent(), 'A updated')
  console.log('台账局部刷新、单击钻取、同级切换和后台请求失败回归通过')
} finally {
  await browser?.close()
  server.stop(true)
}
