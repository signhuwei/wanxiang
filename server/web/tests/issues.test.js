import { test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'

test('platform issues page is available only under platform maintenance navigation', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const page = await readFile(new URL('../issues.js', import.meta.url), 'utf8')
  expect(app).toContain("['issues', '用户反馈']")
  expect(app).toContain("issuesPage(view, platformApi, signal)")
  expect(page).toContain("api.download(`${path}/images/${i}`")
  expect(page).toContain('ledger.resume(snapshot)')
})
