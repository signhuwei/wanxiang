import { realpathSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prepareAttachments } from './onex-attachments.mjs'

export const name = 'onex-managed-session'
export const inject = ['llm', 'sessionPersistence', 'workspaceRegistry', 'credentials', 'attachments']

function path(value) {
  try { return realpathSync(value.startsWith('file:') ? fileURLToPath(value) : value) }
  catch { return null }
}

function publicText(blocks) {
  return Array.isArray(blocks)
    ? blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
    : ''
}

function userText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.flatMap(block => {
    if (block.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block.type === 'image') return ['[图片附件]']
    if (block.type === 'file' && typeof block.attachment?.name === 'string') return [`[文件附件 ${block.attachment.name}]`]
    return []
  }).join('\n')
}

function bounded(text) {
  if (Buffer.byteLength(text) <= 48 * 1024) return { text }
  return { text:text.slice(0, 12 * 1024 - 1).replace(/[\uD800-\uDBFF]$/, '') + '…', truncated:true }
}

function visibleMessage(event, offset) {
  const at = typeof event.time === 'string' ? Date.parse(event.time) : event.time
  const source = { seq:Number.isSafeInteger(event.seq) && event.seq > 0 ? event.seq : offset + 1 }
  if (Number.isSafeInteger(at) && at >= 0 && at <= 253402300799999) source.at_ms = at
  const data = event.data
  if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
    return { ...source, kind:'tool_call', call_id:data.callId, tool:data.name, ...bounded(typeof data.arguments === 'string' ? data.arguments : '') }
  }
  if (event.type === 'tool/result') {
    const block = data.message?.content?.find(item => item.type === 'tool-result')
    if (block?.toolCallId) {
      return { ...source, kind:'tool_result', call_id:block.toolCallId, failed:block.isError === true, ...bounded(publicText(block.content)) }
    }
  }
  const kind = event.type === 'user/message' && data.source?.kind === 'user' ? 'user'
    : event.type === 'assistant/message' ? 'assistant' : null
  const text = kind === 'user' ? userText(data.content) : kind === 'assistant' ? publicText(data.message?.content) : ''
  return text ? { ...source, kind, ...bounded(text) } : null
}

export async function apply(ctx, config) {
  const bearer = readFileSync(config.credential, 'utf8').trim()
  if (!bearer || !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.origin)) throw new Error('Missing OneX session adapter')
  const { isAgentLoopRequest } = await ctx.loader.import('@deepseek-ai/dsh-llm')
  const workspace = path(config.workspace)
  if (!workspace) throw new Error('OneX workspace is unavailable')
  const nativeWorkspace = await ctx.workspaceRegistry.create(workspace)
  if (path(nativeWorkspace.path) !== workspace) throw new Error('OneX workspace did not bind')
  const binding = new URL('/v1/onex/desktop/session', config.origin)
  if (typeof ctx.credentials.withSession !== 'function') throw new Error('OneX session credentials are unavailable')
  let disposed = false
  const offsets = new Map()
  const bound = new Set()

  async function register(id, records, bindModel = false, documents = []) {
    const body = JSON.stringify({ native_id:id, records, bind_model:bindModel, ...(documents.length && { documents }) })
    if (!bindModel && records.length > 1 && Buffer.byteLength(body) > 1536 * 1024) {
      const split = Math.floor(records.length / 2)
      if (!await register(id, records.slice(0, split))) return null
      return register(id, records.slice(split))
    }
    const response = await fetch(binding, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(5000),
      headers:{ authorization:'Bearer ' + bearer, 'content-type':'application/json' },
      body,
    })
    if (!bindModel && response.status === 403) return null
    if (!response.ok) throw new Error('OneX could not bind the original session')
    return bindModel ? (await response.json()).model_token : true
  }

  const belongs = header => !header.origin && !header.isSeeded && path(header.cwd) === workspace
  ctx.on('llm/stream', (options, next) => (async function* () {
    const id = options.sessionId
    if (!isAgentLoopRequest(options) || !id || options.provider !== 'onex' || options.model !== config.model) {
      throw new Error('OneX requires an approved model and a native workspace session')
    }
    const stat = await ctx.sessionPersistence.stat(id)
    if (!stat || stat.header.id !== id || !belongs(stat.header)) throw new Error('This workspace is outside the OneX launch')
    const documents = await prepareAttachments(ctx, config, options.messages, options.signal)
    const token = await register(id, [], true, documents)
    bound.add(id)
    if (offsets.get(id)?.unbound) offsets.delete(id)
    const source = ctx.credentials.withSession(token, () => next()[Symbol.asyncIterator]())
    try {
      while (!disposed) {
        const item = await ctx.credentials.withSession(token, () => source.next())
        if (item.done) return item.value
        yield item.value
      }
    } finally { await ctx.credentials.withSession(token, () => source.return?.()) }
  })())

  let scanning = false
  async function scan() {
    if (scanning || disposed) return
    scanning = true
    try {
      for (const {header, revision} of await ctx.sessionPersistence.list()) {
        if (disposed || !belongs(header)) continue
        const cursor = offsets.get(header.id)
        if (cursor?.revision === revision) continue
        const handle = await ctx.sessionPersistence.open(header.id, 'read')
        try {
          let offset = cursor?.offset ?? 0
          for (let page = 0; page < 32 && !disposed; page++) {
            const {events} = await handle.read(offset, 32)
            const records = events.map((event,i) => visibleMessage(event, offset + i)).filter(Boolean)
            if (records.length && !await register(header.id, records)) {
              offsets.set(header.id, {offset, revision:bound.has(header.id) ? undefined : revision, unbound:true})
              break
            }
            offset += events.length
            offsets.set(header.id, {offset, revision:events.length < 32 ? revision : undefined})
            if (events.length < 32) break
          }
        } finally { await handle.close() }
      }
    } catch {
      // The original journal is durable. Retry unacknowledged records on the next pass.
    } finally { scanning = false }
  }

  const ready = await fetch(new URL('/v1/onex/desktop/ready', config.origin), {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(5000), headers:{authorization:'Bearer ' + bearer},
  })
  if (!ready.ok) {
    throw new Error('OneX Desktop is no longer active')
  }
  const timer = setInterval(() => void scan(), 500)
  ctx.on('dispose', () => {
    disposed = true
    clearInterval(timer)
  })
}
