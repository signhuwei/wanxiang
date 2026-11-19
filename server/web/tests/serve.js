// 开发用静态服务器：bun tests/serve.js [端口]
// 只服务 server/web 目录；/v1/* 在 mock 模式下由浏览器内拦截，不需要代理。
// 生产部署由 Server（Hono）托管本目录，不在此实现。

import { extname, normalize } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const port = Number(process.argv[2]) || 8123

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(req) {
    const url = new URL(req.url)
    let path = normalize(decodeURIComponent(url.pathname))
    if (path === '/' || path === '\\') path = '/index.html'
    const full = normalize(root + path)
    if (!full.startsWith(normalize(root))) return new Response('forbidden', { status: 403 })
    const file = Bun.file(full)
    if (!(await file.exists())) return new Response('not found: ' + path, { status: 404 })
    return new Response(file, {
      headers: { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' }
    })
  }
})

console.log(`OneX web dev server: http://127.0.0.1:${port}/ (mock 默认开，?mock=0 走真实 API)`)
