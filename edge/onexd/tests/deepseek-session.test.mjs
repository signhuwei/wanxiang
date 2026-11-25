import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

test('native DeepSeek binds models and journal records to each session workspace', { timeout:5000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'onex-deepseek-selector-'))
  t.after(() => rm(folder, { recursive:true, force:true }))
  const root = await realpath(folder)
  const workspace = join(root, 'launch')
  const project = join(root, 'new project')
  const unregistered = join(root, 'unregistered')
  const adapter = join(root, 'onex-desktop.mjs')
  const credentials = join(root, 'desktop.token')
  await Promise.all([
    mkdir(workspace),
    mkdir(project),
    mkdir(unregistered),
    copyFile(new URL('../src/desktop_adapters/deepseek.mjs', import.meta.url), adapter),
    copyFile(new URL('../src/desktop_adapters/deepseek-attachments.mjs', import.meta.url), join(root, 'onex-attachments.mjs')),
    writeFile(credentials, 'test-launch-control'),
  ])
  const { apply } = await import(pathToFileURL(adapter).href)
  const handlers = new Map()
  const requests = []
  const grants = []
  const nativeId = 'native-session-A'
  const projectId = 'native-session-B'
  const projectHeader = { id:projectId, cwd:pathToFileURL(project).href }
  const rejected = [
    { id:'not-registered', cwd:unregistered },
    { id:'not-attached', cwd:project },
    { id:'imported', cwd:workspace, origin:'from-another-session' },
    { id:'seeded', cwd:workspace, isSeeded:true },
    { id:'not-a-folder', cwd:credentials },
    { id:'relative', cwd:'.' },
  ]
  const headers = new Map([{ id:nativeId, cwd:workspace }, projectHeader, ...rejected].map(header => [header.id, header]))
  const { promise:journal, resolve:journalReported } = Promise.withResolvers()
  let listed = []
  let currentGrant
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(request.headers.authorization, 'Bearer test-launch-control')
    assert.equal(String(url.origin), 'http://127.0.0.1:55123')
    if (url.pathname === '/v1/onex/desktop/ready') return Response.json({ ok:true })
    assert.equal(url.pathname, '/v1/onex/desktop/session')
    const body = JSON.parse(request.body)
    requests.push(body)
    if (!body.bind_model) journalReported()
    return Response.json({ model_token:'grant-for-' + body.model })
  })
  const ctx = {
    loader:{ async import() { return { isAgentLoopRequest:options => options.type === 'agent' } } },
    workspaceRegistry:{
      async create(path) { assert.equal(path, workspace); return { path } },
      async resolveByPath(path) { return path === project ? { path, sessionIds:[projectId] } : undefined },
    },
    sessionPersistence:{
      async stat(id) { return { header:headers.get(id) } },
      async list() { return listed },
      async open(id, mode) {
        assert.equal(id, projectId)
        assert.equal(mode, 'read')
        return {
          async read(offset) {
            const events = offset === 0
              ? [{ type:'user/message', seq:1, data:{ source:{ kind:'user' }, content:[{ type:'text', text:'new directory' }] } }]
              : []
            return { events }
          },
          async close() {},
        }
      },
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

  async function stream(provider, model, content = [], sessionId = nativeId) {
    const options = { type:'agent', sessionId, provider, model, messages:[{ content }] }
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
  assert.deepEqual(await stream('onex', 'approved-chat', [], projectId), ['native response'])
  assert.deepEqual(await stream('onex', 'approved-chat'), ['native response'])
  await assert.rejects(stream('onex', 'approved-messages'), /approved model/)
  await assert.rejects(stream('onex-anthropic', 'unapproved'), /approved model/)
  await assert.rejects(stream('onex', 'approved-chat', [{ type:'image' }]), /图片输入能力/)
  for (const { id } of rejected) {
    await assert.rejects(stream('onex', 'approved-chat', [], id), /registered native workspace/)
  }
  listed = [...rejected, projectHeader].map(header => ({ header, revision:1 }))
  await journal
  assert.deepEqual(grants, ['grant-for-approved-chat', 'grant-for-approved-messages', 'grant-for-approved-chat', 'grant-for-approved-chat'])
  assert.deepEqual(requests, [
    { native_id:nativeId, workspace, records:[], bind_model:true, model:'approved-chat' },
    { native_id:nativeId, workspace, records:[], bind_model:true, model:'approved-messages',
      documents:[{ name:'note.txt', marker:'marker:note.txt', text:'approved attachment text' }] },
    { native_id:projectId, workspace:project, records:[], bind_model:true, model:'approved-chat' },
    { native_id:nativeId, workspace, records:[], bind_model:true, model:'approved-chat' },
    { native_id:projectId, workspace:project, bind_model:false, records:[{ seq:1, kind:'user', text:'new directory' }] },
  ])
})
