import { expect, test } from 'bun:test';
import { restrictModelAccess } from '../../edge/onexd/src/desktop_adapters/workbuddy.cjs';

test('WorkBuddy exposes and accepts only the model granted by OneX', async () => {
  const id = 'custom-local:managed-model';
  const upstream = {
    models: [{ id: 'vendor-default' }, { id: 'custom-local:personal' }, { id, apiKey: 'private' }],
    availableModels: ['vendor-default', id],
    modelGroups: [{ models: ['vendor-default'] }],
    agents: [{ name: 'cli', models: ['vendor-default', id] }],
  };
  const calls = [];
  const pushed = [];
  const server = restrictModelAccess({
    invokeLocal(channel, ...args) {
      calls.push([channel, ...args]);
      if (channel === 'config:getProductConfiguration') return upstream;
      if (channel === 'session:load') return { model: 'vendor-default', sessionId: 'session' };
    },
    push(channel, data) { pushed.push([channel, data]); },
  }, 'managed-model');

  const catalog = await server.invokeLocal('config:getProductConfiguration');
  expect(catalog.models.map(model => model.id)).toEqual(['managed-model']);
  expect(catalog.availableModels).toEqual(['managed-model']);
  expect(catalog.models[0].tags).toEqual(['chat']);
  expect(catalog.models[0]).not.toHaveProperty('apiKey');
  expect(catalog.agents[0].models).toEqual(['managed-model']);
  expect(catalog.modelGroups).toEqual([]);
  server.push('config:productConfigurationChanged', { productConfiguration: upstream });
  expect(pushed[0][1].productConfiguration).toEqual(catalog);
  expect((await server.invokeLocal('session:load', 'session')).model).toBe('managed-model');
  for (const action of ['getMemberCustomModelPolicy', 'refreshMemberCustomModelPolicy']) {
    expect(await server.invokeLocal('enterprisePolicy:' + action)).toMatchObject({ allowed: false, reason: 'DISABLED' });
  }
  server.push('session:event:session', {
    update: { sessionUpdate: 'config_option_update', configOptions: [{ category: 'model', currentValue: id }] },
  });
  expect(pushed.at(-1)[1].update.configOptions[0].currentValue).toBe('managed-model');

  const before = calls.length;
  await expect(server.invokeLocal('session:create', { model: 'vendor-default' })).rejects.toMatchObject({ code: 'model_not_allowed' });
  await expect(server.invokeLocal('session:setModel', 'session', 'vendor-default')).rejects.toMatchObject({ code: 'model_not_allowed' });
  await expect(server.invokeLocal('session:sendMessage', 'session', {
    _meta: { 'codebuddy.ai': { model: 'vendor-default' } },
  })).rejects.toMatchObject({ code: 'model_not_allowed' });
  await expect(server.invokeLocal('session:sendMessage', 'session', {
    content: [{ type: 'text', text: 'test', _meta: { 'codebuddy.ai': { model: 'vendor-default' } } }],
  })).rejects.toMatchObject({ code: 'model_not_allowed' });
  await expect(server.invokeLocal('config:saveLocalCustomModel', {})).rejects.toMatchObject({ code: 'forbidden' });
  await expect(server.invokeLocal('cloudAgent:createConversationSession', {})).rejects.toMatchObject({ code: 'forbidden' });
  expect((await server.invokeLocal('cloudAssistant:getEntitlement')).enabled).toBe(false);
  expect(calls).toHaveLength(before);
  await server.invokeLocal('session:setModel', 'session', 'managed-model');
  expect(calls.at(-1)).toEqual(['session:setModel', 'session', id]);
  const block = { type: 'text', text: 'test', _meta: { 'codebuddy.ai': { model: 'managed-model' } } };
  await server.invokeLocal('session:sendMessage', 'session', [block]);
  expect(calls.at(-1)[2][0]).toEqual({ ...block, _meta: { 'codebuddy.ai': { model: id } } });
});

test('the original enterprise policy and vendor catalog can further narrow a contract', async () => {
  const granted = 'custom-local:approved';
  let config = { models:[{id:granted}], availableModels:['other'], agents:[] };
  const vendor = {allowed:false, source:'enterprise', reason:'ORG_POLICY'};
  const messages = [];
  const server = restrictModelAccess({
    invokeLocal(channel) { return channel.endsWith('CustomModelPolicy') ? vendor : config; },
    push(_,data) { messages.push(data); },
  }, 'approved');
  expect(await server.invokeLocal('enterprisePolicy:getMemberCustomModelPolicy')).toBe(vendor);
  expect((await server.invokeLocal('config:getProductConfiguration')).models).toEqual([]);
  config = {models:[{id:granted, disabled:true}], availableModels:[granted]};
  expect((await server.invokeLocal('config:getProductConfiguration')).availableModels).toEqual([]);
  config = {models:[{id:granted}], availableModels:[granted], agents:[{name:'restricted',models:['other']}]};
  expect((await server.invokeLocal('config:getProductConfiguration')).agents[0].models).toEqual([]);
  server.push('session:event:a', {update:{sessionUpdate:'config_option_update', configOptions:[{
    category:'model', currentValue:'other', options:[{value:'other'}, {value:granted}]
  }]}});
  expect(messages[0].update.configOptions[0].options).toEqual([{value:'approved'}]);
});

test('native sidecars receive only their own OneX task grant', async () => {
  const {prepareTask} = await import('../../edge/onexd/src/desktop_adapters/workbuddy.cjs');
  const {realpathSync, mkdtempSync, rmSync, mkdirSync, writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'onex-s3-workbuddy-')));
  try {
    const created = [];
    const requests = [];
    const create = prepareTask(p => { created.push(p); return p.sessionId; },
      {workspace, privateHome:workspace, model:'approved'},
      async (id,source) => { requests.push({id,source}); return 'local-grant-' + id; });
    const nativeCatalog = {models:[{id:'other'}], availableModels:['other'], agents:[{name:'cli',models:['other']}],
      enterprise:{account:'fixture'}, modelGroups:[{models:['other']}]};
    const original = {cwd:workspace, args:['--model','other','--flag','--model=other','--fallback-model=other'],
      env:{ONEX_WORKBUDDY_POLICY:'private', ACC_PRODUCT_CONFIG_V3:JSON.stringify(nativeCatalog),
        ACC_PRODUCT_CONFIG_PATH:'another-catalog', ACC_PRODUCT_CONFIG_V2:'{}', CODEBUDDY_SMALL_FAST_MODEL:'other'}};
    for (const id of ['A','B','A']) {
      expect(await create({...original,sessionId:id})).toBe(id);
    }
    expect(created.map(x => x.env.ONEX_WORKBUDDY_SESSION_MODEL_TOKEN)).toEqual(['local-grant-A','local-grant-B','local-grant-A']);
    expect(created[0].env.ONEX_WORKBUDDY_POLICY).toBeUndefined();
    const bootstrap = JSON.parse(created[0].env.ACC_PRODUCT_CONFIG_V3);
    expect(bootstrap).toMatchObject({models:[],availableModels:[],modelGroups:[],agents:[{name:'cli',models:[]}],
      enterprise:nativeCatalog.enterprise});
    expect(created[0].env.ACC_PRODUCT_CONFIG_PATH).toBeUndefined();
    expect(created[0].env.ACC_PRODUCT_CONFIG_V2).toBeUndefined();
    expect(created[0].env.CODEBUDDY_SMALL_FAST_MODEL).toBe('custom-local:approved');
    expect(created.every(x => x.args.join(' ') === '--flag --model custom-local:approved')).toBe(true);
    expect(requests.every(x => x.source.cwd === workspace)).toBe(true);
    expect(original.args).toEqual(['--model','other','--flag','--model=other','--fallback-model=other']);
    await expect(create({...original, sessionId:'disabled', env:{ACC_PRODUCT_CONFIG_V3:JSON.stringify({
      models:[{id:'custom-local:approved',disabled:true}],availableModels:['custom-local:approved']})}})).rejects.toThrow('disabled');
    await expect(create({...original, sessionId:'missing', env:{}})).rejects.toThrow('catalog');
    mkdirSync(join(workspace,'.codebuddy'));
    writeFileSync(join(workspace,'.codebuddy','models.json'),'{}');
    await expect(create({...original,sessionId:'C'})).rejects.toThrow('overrides');
    expect(requests).toHaveLength(3);
  } finally { rmSync(workspace,{recursive:true,force:true}); }
});
