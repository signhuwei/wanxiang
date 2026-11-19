import { test, expect } from 'bun:test'
import { readStream } from '../observation.js'
test('SSE decoder handles split UTF-8, CRLF, comments and named events', async () => {
  const bytes = new TextEncoder().encode(':ping\r\n\r\nevent: summary\r\ndata: {"name":"联调"}\r\n\r\n')
  const body = new ReadableStream({start(c){for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close()}})
  const events=[]
  await readStream(body, e=>events.push(e))
  expect(events).toEqual([{name:'联调'}])
})
