// Model policy for the signed WorkBuddy 5.3.8 daemon, isolated to a OneX launch.
const fs = require('node:fs')
const path = require('node:path')

// The desktop renders this vendor RPC catalogue, independently of the task sidecar.
function restrictModelAccess(server, name) {
  const id = 'custom-local:' + name
  const invoke = server.invokeLocal.bind(server)
  const push = server.push.bind(server)
  const requireModel = value => {
    if (value !== undefined && value !== null && value !== '' && value !== id && value !== name) {
      throw Object.assign(new Error('此 WorkBuddy 模型未获 OneX 能力合约授权。'), {code:'model_not_allowed', httpStatus:403})
    }
    return id
  }
  const modelPatch = value => {
    if (!value || typeof value !== 'object') return value
    const next = {...value}
    for (const key of ['model', 'modelId']) if (key in value) next[key] = requireModel(value[key])
    return next
  }
  const catalog = config => {
    const available = config.availableModels
    const admitted = (!Array.isArray(available) || available.includes(id) || available.includes(name))
      && config.models?.find(model => model.id === id && !model.disabled)
    const ids = admitted ? [name] : []
    // WorkBuddy hides its custom rows when editing is disabled. The renderer sees
    // a provisioned model, while the task engine still uses its custom adapter ID.
    const option = {id:name, name, tags:['chat'], isDefault:true, supportsImages:false, supportsReasoning:false}
    return {...config, models:admitted ? [option] : [], availableModels:ids, modelGroups:[], modelPromotions:[],
      agents:config.agents?.map(agent => ({...agent, models:
        Array.isArray(agent.models) && !agent.models.includes(id) && !agent.models.includes(name) ? [] : ids}))}
  }
  const inSession = result => {
    if (!result || typeof result !== 'object') return result
    return {...result, model:name}
  }
  const promptMetadata = (meta, key, model) => {
    const workbuddy = meta?.['codebuddy.ai']
    if (!workbuddy || typeof workbuddy !== 'object' || !(key in workbuddy)) return meta
    return {...meta, 'codebuddy.ai':{...workbuddy, [key]:model(workbuddy[key])}}
  }
  const promptContent = content => Array.isArray(content)
    ? content.map(block => block?._meta ? {...block, _meta:promptMetadata(block._meta, 'model', requireModel)} : block)
    : content
  server.invokeLocal = async (channel, ...args) => {
    if (channel.startsWith('cloudAgent:') || channel === 'cloudAssistant:initializeOrchestrator') {
      throw Object.assign(new Error('受管 WorkBuddy 的模型调用须经 OneX。'), {code:'forbidden', httpStatus:403})
    }
    switch (channel) {
      case 'enterprisePolicy:getMemberCustomModelPolicy':
      case 'enterprisePolicy:refreshMemberCustomModelPolicy': {
        const vendor = await invoke(channel, ...args)
        if (vendor?.allowed === false) return vendor
        return {allowed:false, reason:'DISABLED', source:'onex', fetchedAt:Date.now()}
      }
      case 'cloudAssistant:getEntitlement':
        return {enabled:false, orchestratorEnabled:false, installed:false, teamsEnabled:false}
      case 'config:saveLocalCustomModel':
      case 'config:deleteLocalCustomModel':
        throw Object.assign(new Error('受管模型由 OneX 能力合约配置。'), {code:'forbidden', httpStatus:403})
      case 'config:getLocalCustomModels':
        return {models:[]}
      case 'config:getProductConfiguration':
        return catalog(await invoke(channel, ...args))
      case 'session:create':
        args[0] = modelPatch(args[0])
        return inSession(await invoke(channel, ...args))
      case 'session:load':
      case 'session:get':
        return inSession(await invoke(channel, ...args))
      case 'session:setModel':
        args[1] = requireModel(args[1])
        break
      case 'session:setConfigOption':
        if (args[1] === 'model' || args[1] === 'modelId') args[2] = requireModel(args[2])
        break
      case 'session:updateConfig':
        args[1] = modelPatch(args[1])
        break
      case 'session:sendMessage':
        if (args[1] && typeof args[1] === 'object' && !Array.isArray(args[1])) {
          const payload = args[1]
          args[1] = {...payload}
          if ('content' in payload) args[1].content = promptContent(payload.content)
          if ('_meta' in payload) args[1]._meta = promptMetadata(payload._meta, 'model', requireModel)
        } else {
          args[1] = promptContent(args[1])
        }
        args[2] = promptMetadata(args[2], 'model', requireModel)
        break
    }
    return invoke(channel, ...args)
  }
  server.push = (channel, data) => {
    if (channel === 'config:productConfigurationChanged' && data?.productConfiguration) {
      data = {...data, productConfiguration:catalog(data.productConfiguration)}
    }
    if (channel.startsWith('session:event:') && data?.update?.sessionUpdate === 'current_mode_update') {
      data = {...data, _meta:promptMetadata(data._meta, 'modelId', () => name),
        update:{...data.update, _meta:promptMetadata(data.update._meta, 'modelId', () => name)}}
    }
    if (channel.startsWith('session:event:') && data?.update?.sessionUpdate === 'config_option_update') {
      const configOptions = data.update.configOptions?.map(option => {
        if (option.category !== 'model') return option
        const options = Array.isArray(option.options)
          ? option.options.filter(item => [id, name].includes(item?.value ?? item?.id))
            .map(item => ({...item, ...('value' in item && {value:name}), ...('id' in item && {id:name})}))
          : option.options
        return {...option, currentValue:name, ...(options && {options})}
      })
      data = {...data, update:{...data.update, configOptions}}
    }
    return push(channel, data)
  }
  return server
}

// Let the native CLI resolve the managed model's apiKey placeholder from its own
// task environment. The GUI and the native account retain their separate login.
function prepareTask(create, policy, modelTokenFor) {
  return async function(params, ...rest) {
    if (typeof params?.cwd !== 'string' || !Array.isArray(params.args) ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(params.sessionId ?? '')) {
      throw new Error('WorkBuddy did not supply a native task')
    }
    const cwd = fs.realpathSync(params.cwd)
    const privateRoot = path.join(policy.privateHome, 'WorkBuddy') + path.sep
    if (cwd !== policy.workspace && !cwd.startsWith(privateRoot)) {
      throw new Error('The WorkBuddy task is outside the managed workspace')
    }
    if (fs.existsSync(path.join(cwd, '.codebuddy', 'models.json'))) {
      throw new Error('The WorkBuddy workspace overrides its managed model')
    }
    // 5.3.8 loads the daemon bootstrap catalog before the managed profile's
    // CustomModelsProductProvider. No vendor inference endpoint is needed here.
    const product = JSON.parse(params.env?.ACC_PRODUCT_CONFIG_V3 ?? 'null')
    if (!product || typeof product !== 'object' || Array.isArray(product)) {
      throw new Error('WorkBuddy did not supply its native model catalog')
    }
    const id = 'custom-local:' + policy.model
    const matches = candidate => candidate === id || candidate === policy.model
    if (product.models?.some(model => matches(model.id) && model.disabled)) {
      throw new Error('WorkBuddy disabled the selected model')
    }
    const bootstrap = {...product, models:[], modelGroups:[], modelPromotions:[],
      availableModels:Array.isArray(product.availableModels) ? product.availableModels.filter(matches) : []}
    if (Array.isArray(product.agents)) {
      bootstrap.agents = product.agents.map(agent => Array.isArray(agent.models)
        ? {...agent, models:agent.models.filter(matches)} : agent)
    }
    const project = cwd.replace(/[/\\:]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    const modelToken = await modelTokenFor(params.sessionId, {project, cwd})
    const args = []
    for (let i = 0; i < params.args.length; ++i) {
      const arg = params.args[i]
      if (arg === '--model' || arg === '--fallback-model') { ++i; continue }
      if (!arg.startsWith('--model=') && !arg.startsWith('--fallback-model=')) args.push(arg)
    }
    args.push('--model', id)
    const env = {...params.env, ACC_PRODUCT_CONFIG_V3:JSON.stringify(bootstrap),
      CODEBUDDY_MODEL:id, CODEBUDDY_SMALL_FAST_MODEL:id, ONEX_WORKBUDDY_SESSION_MODEL_TOKEN:modelToken}
    delete env.ACC_PRODUCT_CONFIG_PATH
    delete env.ACC_PRODUCT_CONFIG_V2
    delete env.ACC_PRODUCT_CONFIG
    delete env.ONEX_WORKBUDDY_POLICY
    return create.call(this, {...params, env, args}, ...rest)
  }
}

function install(policyFile, entry) {
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'))
  const expected = path.join(policy.bundle, 'Contents/Resources/app.asar/main/daemon-app-server-entry.js')
  if (entry !== expected || fs.realpathSync(policy.bundle) !== policy.bundle ||
      path.dirname(policyFile) !== __dirname || path.dirname(policy.credential) !== __dirname ||
      !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(policy.origin) || !policy.model) {
    throw new Error('Invalid OneX WorkBuddy launch policy')
  }
  const modelTokenFor = async (native_id, source) => {
    const bearer = fs.readFileSync(policy.credential, 'utf8').trim()
    const res = await fetch(policy.origin + '/v1/onex/workbuddy/session', {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(5000),
      headers:{authorization:'Bearer ' + bearer, 'content-type':'application/json'},
      body:JSON.stringify({native_id, source}),
    })
    if (!res.ok) throw new Error('OneX could not admit this WorkBuddy task')
    const {model_token} = await res.json()
    if (typeof model_token !== 'string' || !model_token) throw new Error('Missing WorkBuddy task grant')
    return model_token
  }

  // Its entry sets up the original daemon context synchronously. Bind the two
  // version-pinned interfaces before the native async entry starts dispatching.
  queueMicrotask(() => {
    const api = require(path.join(path.dirname(expected), 'initialize.js'))
    const daemon = api.DaemonServer.prototype
    const manager = Object.getPrototypeOf(api.createWorkbuddySidecarManager())
    if (![daemon.invokeLocal, daemon.push, manager.createSession].every(f => typeof f === 'function')) {
      throw new Error('Unsupported WorkBuddy daemon interfaces')
    }
    const originalInvoke = daemon.invokeLocal
    const originalPush = daemon.push
    const policies = new WeakMap()
    function forServer(server) {
      let scoped = policies.get(server)
      if (!scoped) {
        scoped = restrictModelAccess({invokeLocal:originalInvoke.bind(server), push:originalPush.bind(server)}, policy.model)
        policies.set(server, scoped)
      }
      return scoped
    }
    daemon.invokeLocal = function(...args) { return forServer(this).invokeLocal(...args) }
    daemon.push = function(...args) { return forServer(this).push(...args) }
    manager.createSession = prepareTask(manager.createSession, policy, modelTokenFor)
    // Signals the same authenticated readiness endpoint as the other native adapters.
    const control = fs.readFileSync(policy.credential, 'utf8').trim()
    fetch(policy.origin + '/v1/onex/desktop/ready', {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(5000),
      headers:{authorization:'Bearer ' + control},
    }).catch(() => {})
  })
}

const entry = process.argv[1]
if (process.env.ONEX_WORKBUDDY_POLICY && entry?.endsWith('/Contents/Resources/app.asar/main/daemon-app-server-entry.js')) {
  install(process.env.ONEX_WORKBUDDY_POLICY, entry)
}
module.exports = {restrictModelAccess, prepareTask}
