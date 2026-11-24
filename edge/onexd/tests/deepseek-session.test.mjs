import assert from 'node:assert/strict'
import { copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

test('native DeepSeek binds each turn to the selected approved provider model', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'onex-deepseek-selector-'))
  t.after(() => rm(folder, { recursive:true, force:true }))
  const workspace = await realpath(folder)
  const adapter = join(workspace, 'onex-desktop.mjs')
  const credentials = join(workspace, 'desktop.token')
  await Promise.all([
    copyFile(new URL('../src/desktop_adapters/deepseek.mjs', import.meta.url), adapter),
    copyFile(new URL('../src/desktop_adapters/deepseek-attachments.mjs', import.meta.url), join(workspace, 'onex-attachments.mjs')),
    writeFile(credentials, 'test-launch-control'),
  ])
  const { apply } = await import(pathToFileURL(adapter).href)
  const handlers = new Map()
  const requests = []
  const grants = []
  const nativeId = 'native-session-A'
  let currentGrant
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(request.headers.authorization, 'Bearer test-launch-control')
    assert.equal(String(url.origin), 'http://127.0.0.1:55123')
    if (url.pathname === '/v1/onex/desktop/ready') return Response.json({ ok:true })
    assert.equal(url.pathname, '/v1/onex/desktop/session')
    const body = JSON.parse(request.body)
    requests.push(body)
    return Response.json({ model_token:'grant-for-' + body.model })
  })
  const ctx = {
    loader:{ async import() { return { isAgentLoopRequest:options => options.type === 'agent' } } },
    workspaceRegistry:{ async create(path) { return { path } } },
    sessionPersistence:{
      async stat(id) { return { header:{ id, cwd:workspace } } },
      async list() { return [] },
    },
    credentials:{ withSession(token, action) { currentGrant = token; return action() } },
    llm:{ fileRequestText(ref) { return 'marker:' + ref.name } },
    attachments:{ async *readFileStream() { yield Buffer.from('approved attachment text') } },
    on(event, handler) { handlers.set(event, handler) },
  }
  await apply(ctx, {
    origin:'http://127.0.0.1:55123', workspace, credential:credentials,
    models:[
      { id:'approved-chat', provider:'onex', imageInput:false },
      { id:'approved-messages', provider:'onex-anthropic', imageInput:true },
    ],
  })
  t.after(() => handlers.get('dispose')())

  async function stream(provider, model, content = []) {
    const options = { type:'agent', sessionId:nativeId, provider, model, messages:[{ content }] }
    const output = []
    for await (const message of handlers.get('llm/stream')(options, async function* () {
      grants.push(currentGrant)
      yield 'native response'
    })) output.push(message)
    return output
  }

  assert.deepEqual(await stream('onex', 'approved-chat'), ['native response'])
  assert.deepEqual(await stream('onex-anthropic', 'approved-messages', [
    { type:'file', attachment:{ name:'note.txt', bytes:24 } },
    { type:'image' },
  ]), ['native response'])
  await assert.rejects(stream('onex', 'approved-messages'), /approved model/)
  await assert.rejects(stream('onex-anthropic', 'unapproved'), /approved model/)
  await assert.rejects(stream('onex', 'approved-chat', [{ type:'image' }]), /图片输入能力/)
  assert.deepEqual(grants, ['grant-for-approved-chat', 'grant-for-approved-messages'])
  assert.deepEqual(requests, [
    { native_id:nativeId, records:[], bind_model:true, model:'approved-chat' },
    { native_id:nativeId, records:[], bind_model:true, model:'approved-messages',
      documents:[{ name:'note.txt', marker:'marker:note.txt', text:'approved attachment text' }] },
  ])
})
