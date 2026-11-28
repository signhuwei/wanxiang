import { test, expect } from 'bun:test'
import { readStream, eventText } from '../observation.js'

test('event text never falls back to dumping metadata, tool inputs or unknown blocks',()=>{
  const e=(kind,payload)=>eventText({kind,payload,at:'2026-11-19T08:00:00Z'})
  expect(e('session_start',{agent:'claude-code',agent_version:'2.1.x',model:'fixture'})).toBe('Claude Code 2.1.x · 模型 fixture')
  expect(e('assistant_message',{content:[{type:'text',text:'正文'},{type:'thinking',thinking:'隐藏'},{type:'image',media_type:'image/png',bytes:20}]})).toBe('正文\n[图片 · image/png · 20 字节]')
  expect(e('tool_call',{tool:'Read',input:{path:'fixture'}})).toBe('Read')
  expect(e('tool_result',{output:'结果',truncated:true})).toBe('结果\n（结果已截断）')
  expect(e('compact',{summary:'摘要'})).toBe('摘要')
  expect(e('future',{other:'未公开'})).toBe('不支持展示此事件')
})
test('SSE decoder handles split UTF-8, CRLF, comments and named events', async () => {
  const bytes = new TextEncoder().encode(':ping\r\n\r\nevent: summary\r\ndata: {"name":"联调"}\r\n\r\n')
  const body = new ReadableStream({start(c){for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close()}})
  const events=[]
  await readStream(body, e=>events.push(e))
  expect(events).toEqual([{name:'联调'}])
})
