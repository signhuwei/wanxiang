import { createLedger } from './ledger.js'
import { button, editForm, el } from './panel.js'
import { createPager } from './pager.js'
import { formatDateTime, formatMilli, parseEraserMilli } from './format.js'
import { idempotencyKey } from './idempotency.js'
import { hasAction, inputField } from './policy-controls.js'
import { capabilityList } from './routing-format.js'

const enc = encodeURIComponent
const capabilities = [
  ['text', '文本'], ['stream', '流式'], ['function_tools', '函数工具'],
  ['images', '图像'], ['reasoning', '推理'], ['json_schema', '结构化输出']
]
const jobStatus = { succeeded: '成功', partial: '部分完成', failed: '失败', queued: '排队中', running: '执行中' }
const jobReasons = {
  missing_credential: '缺少查询凭据', credential_scope_changed: '地址或认证已变更，请保存适用的上游密钥',
  credential_rejected: '上游拒绝认证', permission_denied: '上游限制访问',
  unsupported_capability: '此接口不提供模型目录', probe_timeout: '请求上游超时', schema_mismatch: '上游目录格式无法读取',
  upstream_unavailable: '上游暂不可达', probe_unreachable: '上游暂不可达', redirect_denied: '上游返回重定向',
  destination_denied: '目标地址无法用于查询', upstream_error: '上游返回错误', malformed_items: '部分条目格式错误',
  pagination_incomplete: '供应方分页未完成', response_limit: '响应体超出读取限制', catalog_limit: '目录超过单次作业上限'
}
const success = (notice, text) => { notice.textContent = text; notice.className = 'notice' }
const failure = (notice, text) => { notice.textContent = text; notice.className = 'notice error' }
const modelPath = id => '/platform/models/' + enc(id)
const modelProbePath = id => '/platform/probe-jobs/' + enc(id) + '/model-tests'
const modelTestStates = { running: '进行中', succeeded: '通过', failed: '失败', pending_reconciliation: '待核对' }
const modelTestLabel = test => test ? modelTestStates[test.status] ?? test.status : '待实测'
const modelTestReasons = {
  model_test_requires_current_catalogue: '请拉取当前渠道目录后再实测。', model_test_key_unavailable: '服务端尚未配置渠道密钥。',
  model_test_quota_required: '当前管理员尚未分配实测橡皮配额。', model_test_quota_exhausted: '当前管理员可用配额不足。',
  model_test_cost_limit_exceeded: '此费率下单次预留超过实测成本上限。', model_test_in_progress: '当前管理员已有实测执行中。',
  model_test_price_required: '请填写经核实的实测输入、输出费率。', completion_unknown: '请求结果尚待核对。',
  upstream_model_mismatch: '上游响应型号与测试目标不符。', no_text_returned: '上游未返回文本。',
  reconciled_manually: '已按凭证核对费用。'
}

function capabilityChecklist(defaults = []) {
  const section = el('fieldset', 'form-grid channel-capabilities')
  section.append(el('legend', null, '确认能力'))
  const fields = []
  for (const [cap, name] of capabilities) {
    const box = el('input')
    box.type = 'checkbox'
    box.checked = defaults.includes(cap)
    const label = el('label')
    label.append(box, el('span', null, name))
    section.append(label)
    fields.push([cap, box])
  }
  return { node: section, collect: () => fields.filter(([, box]) => box.checked).map(([cap]) => cap) }
}

function describeJob(job, discovery) {
  if (!job) return '尚未运行'
  const parts = [jobStatus[job.status] ?? job.status]
  if (discovery && job.summary?.model_count != null) parts.push(job.summary.model_count + ' 个模型')
  if (job.summary?.reason) parts.push(jobReasons[job.summary.reason] ?? job.summary.reason)
  if (job.observed_at) parts.push(formatDateTime(job.observed_at))
  return parts.join(' · ')
}

function discoveryResults(host, api, job, signal, onReview, onTest) {
  const section = el('section', 'deployment-section')
  const title = onReview ? '上游发现目录' : '历史目录（只读）'
  section.setAttribute('aria-label', title)
  const header = el('div', 'deployment-toolbar')
  const count = el('span', 'muted')
  const search = el('input', 'search')
  search.type = 'search'
  search.placeholder = '查询上游原始型号'
  search.setAttribute('aria-label', '查询已拉取模型')
  header.append(el('h3', null, title), count, search)
  const cards = el('div', 'deployment-grid')
  const nav = el('div', 'card-pager')
  const currentPage = el('span', 'muted')
  let q = '', timer, controller, pager = createPager()
  const prev = button('上一页目录', () => { if (pager.prev()) load() })
  const next = button('下一页目录', () => { if (pager.next()) load() })
  nav.append(prev, next, currentPage)
  section.append(header)
  if (!onReview) {
    const revision = job.scope?.provider_revision
    const source = revision == null ? '较早的渠道修订' : '渠道修订 v' + revision
    section.append(el('p', 'muted', '此目录来自' + source + '。拉取当前修订的目录后可继续归并。'))
  }
  section.append(cards, nav)
  host.replaceChildren(section)

  function card(row, reviewable) {
    const entry = el('article', 'deployment-card')
    entry.setAttribute('aria-label', '发现模型 ' + row.raw_model)
    entry.append(el('strong', 'deployment-raw', row.raw_model), el('small', 'muted', '上下文 ' + (row.context_tokens ?? '未知')))
    const declared = capabilityList(row.capabilities_claim)
    if (declared.length) entry.append(el('small', 'muted', '上游声明 ' + declared.join('、')))
    if (reviewable || row.latest_model_test) {
      entry.append(el('small', 'muted', '文本实测 ' + modelTestLabel(row.latest_model_test)))
      if (onTest) {
        const test = button('模型实测', () => onTest(row, reviewable), 'link')
        test.setAttribute('aria-label', '实测 ' + row.raw_model)
        entry.append(test)
      }
    }
    for (const record of row.adoptions ?? []) {
      const state = record.status === 'rejected' ? '已拒绝' : record.pool_revision ? '当前池 v' + record.pool_revision : '已采纳 · 待入池'
      entry.append(el('small', 'muted', record.display_name + ' · ' + state))
    }
    if (row.intake && !row.adoptions?.some(record => record.status === 'accepted')) entry.append(el('small', 'muted', '已登记 · 待核对'))
    if (reviewable) {
      const review = button('归并到签约型号', () => onReview(row), 'link')
      review.setAttribute('aria-label', '归并 ' + row.raw_model)
      entry.append(review)
    }
    return entry
  }

  async function load() {
    controller?.abort()
    const current = controller = new AbortController()
    const requestSignal = AbortSignal.any([current.signal, signal])
    prev.disabled = next.disabled = true
    cards.replaceChildren(el('p', 'muted', '正在读取已拉取模型…'))
    try {
      const page = await api.get('/platform/probe-jobs/' + enc(job.id) + '/results', {
        params: { q, cursor: pager.cursor(), limit: 25 }, signal: requestSignal
      })
      if (requestSignal.aborted || !section.isConnected) return
      pager.applyResult(page.next_cursor ?? null)
      count.textContent = '共 ' + page.total + ' 个'
      const rows = page.items ?? []
      const reviewable = Boolean(onReview) && hasAction(page, 'review_candidates')
      cards.replaceChildren(...(rows.length ? rows.map(row => card(row, reviewable)) :
        [el('p', 'muted', q ? '没有匹配的上游型号' : '本批目录为空')]))
    } catch (error) {
      if (!requestSignal.aborted && section.isConnected) {
        cards.replaceChildren(el('p', 'error-row', '读取发现目录失败。' + error.message), button('重试读取', load))
      }
    } finally {
      if (controller === current) {
        prev.disabled = !pager.canPrev(); next.disabled = !pager.canNext()
        currentPage.textContent = '第 ' + (pager.page + 1) + ' 页'
      }
    }
  }

  search.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => { q = search.value; pager = createPager(); load() }, 250)
  })
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  load()
}

export function channelOperations(host, api, provider, signal, onReview, onTest) {
  const base = '/platform/providers/' + enc(provider.id)
  const operations = el('section', 'deployment-section channel-overview')
  operations.setAttribute('aria-label', '渠道管理')
  const notice = el('p', 'notice')
  notice.setAttribute('role', 'status')
  const tools = el('div', 'actions')
  const summary = el('dl', 'policy-facts')
  const directory = el('div')
  operations.append(el('h3', null, '渠道管理'), notice, tools,
    el('p', 'muted', '连通测试仅访问授权目录接口。拉取范围为当前渠道授权凭据可见的全部模型。'), summary, directory)
  host.append(operations)
  let busy = false, lastDirectory, directoryController, request = 0

  function draw(state) {
    summary.replaceChildren()
    const descriptions = [['渠道账户', (state.accounts ?? []).map(row => row.name).join('、') || '尚未建立'],
      ['最近目录连通测试', describeJob(state.latest_probe)], ['最近模型拉取', describeJob(state.latest_discovery, true)]]
    for (const [label, value] of descriptions) {
      const row = el('div')
      row.append(el('dt', null, label), el('dd', null, value))
      summary.append(row)
    }
    tools.replaceChildren()
    if (hasAction(state, 'probe_connectivity')) tools.append(button('测试连通性', () => run('probe', state.revision)))
    if (hasAction(state, 'discover')) tools.append(button('拉取模型', () => run('discovery', state.revision), 'primary'))
    tools.append(button('刷新渠道状态', () => load()))
    const current = state.latest_catalog
    const catalog = current ?? state.historical_catalog
    const key = catalog ? (current ? 'current:' : 'history:') + catalog.id : null
    if (key === lastDirectory) return
    lastDirectory = key
    directoryController?.abort()
    if (!catalog) { directory.replaceChildren(); return }
    directoryController = new AbortController()
    const catalogSignal = AbortSignal.any([signal, directoryController.signal])
    discoveryResults(directory, api, catalog, catalogSignal, current ? onReview : null, onTest)
  }

  async function load() {
    if (signal.aborted) return
    const generation = ++request
    try {
      const state = await api.get(base + '/channel', { signal })
      if (generation === request && !signal.aborted && operations.isConnected) draw(state)
    } catch (error) {
      if (!signal.aborted && operations.isConnected) failure(notice, '渠道状态读取失败。' + error.message)
    }
  }

  async function run(type, revision) {
    if (busy || signal.aborted) return
    busy = true
    const discovery = type === 'discovery'
    const headline = discovery ? '拉取模型' : '目录连通测试'
    for (const control of tools.children) control.disabled = true
    success(notice, headline + '中…')
    try {
      const job = await api.post(base + (discovery ? '/discoveries' : '/probes'),
        discovery ? { revision } : { revision, kind: 'connectivity' }, { signal, idempotencyKey: idempotencyKey() })
      if (signal.aborted || !operations.isConnected) return
      const message = headline + ' · ' + describeJob(job, discovery)
      if (job.status === 'failed' || job.status === 'partial') failure(notice, message)
      else success(notice, message)
      await load()
    } catch (error) {
      if (!signal.aborted && operations.isConnected) failure(notice, headline + '失败。' + error.message)
    } finally {
      busy = false
      if (!signal.aborted) for (const control of tools.children) control.disabled = false
    }
  }
  load()
}

export function modelTestsPanel(pane, api, discovered, writable, signal, back) {
  const path = modelProbePath(discovered.discovery_id)
  pane.setTitle('模型文本实测 / ' + discovered.raw_model)
  pane.headActions.replaceChildren(button('返回渠道', back), button('刷新实测记录', () => load()))

  async function load() {
    if (signal.aborted) return
    pane.foot.replaceChildren()
    pane.body.replaceChildren(el('p', 'muted', '正在读取实测记录…'))
    try {
      const data = await api.get(path, { params: { catalog_item_id: discovered.catalog_item_id, limit: 15 }, signal })
      if (signal.aborted) return
      draw(data)
    } catch (error) {
      if (!signal.aborted) pane.body.replaceChildren(el('p', 'error-row', error.message))
    }
  }

  function reconcile(test) {
    pane.setTitle('核对实测费用 / ' + discovered.raw_model)
    editForm(pane, { mode: 'edit', label: '确认费用', fields: [
      { key: 'amount', label: '应扣费用（块橡皮）', hint: '本次预留 ' + formatMilli(test.reserved_milli) + ' 块橡皮' },
      { key: 'reference', label: '结算凭证' }, { key: 'reason', label: '核对说明', type: 'textarea' }
    ], submit(form, options) {
      const amount = parseEraserMilli(form.amount)
      if (amount === null || amount > test.reserved_milli) throw Error('应扣费用须在本次预留范围内')
      return api.post(modelProbePath(test.discovery_id) + '/' + enc(test.id) + '/reconcile', {
        charged_milli: amount, evidence_reference: form.reference?.trim(), reason: form.reason?.trim()
      }, { ...options, signal })
    }, done() { void load() } })
    pane.foot.prepend(button('返回实测记录', () => load()))
  }

  function draw(data) {
    pane.setTitle('模型文本实测 / ' + discovered.raw_model)
    pane.body.replaceChildren()
    if (writable && hasAction(data, 'run_model_test')) editForm(pane, { mode: 'edit', label: '执行一次文本实测', fields: data.requires_tariff ? [
      { key: 'input', label: '实测输入计费（块橡皮/百万 Token）' },
      { key: 'output', label: '实测输出计费（块橡皮/百万 Token）' },
      { key: 'source', label: '实测计费依据', hint: '填写供应商价表或经批准的测试报价。' },
    ] : [], async submit(form, options) {
      const payload = { catalog_item_id: discovered.catalog_item_id }
      if (data.requires_tariff) {
        const input = parseEraserMilli(form.input)
        const output = parseEraserMilli(form.output)
        const source = form.source?.trim()
        if (input === null || output === null || !source) throw Error('请同时填写输入、输出费率及其计费依据')
        payload.test_tariff = { input_milli_per_mtok: input, output_milli_per_mtok: output, source_reference: source }
      }
      try { return await api.post(path, payload, { ...options, signal }) }
      catch (error) { throw Error(modelTestReasons[error.detail?.reason] ?? error.message) }
    }, done() { void load() } })
    pane.body.prepend(el('p', 'muted', '实测发送固定短文本，最多生成 ' + data.output_token_limit +
      ' 个 Token。实际用量计入当前管理员橡皮配额。'))
    if (data.blocked_reason) pane.body.append(el('p', 'notice', modelTestReasons[data.blocked_reason] ?? jobReasons[data.blocked_reason] ?? data.blocked_reason))
    if (writable && !data.requires_tariff && hasAction(data, 'run_model_test')) pane.body.append(el('p', 'muted', '本次使用此渠道原始型号已登记的生效费率。'))
    const rows = el('section', 'deployment-section')
    rows.append(el('h3', null, '最近实测'))
    for (const test of data.items ?? []) {
      const line = el('article', 'deployment-card')
      line.append(el('strong', null, modelTestLabel(test) + ' · ' + formatDateTime(test.completed_at ?? test.created_at)))
      if (test.usage) line.append(el('p', null,
        '输入 ' + test.usage.input_tokens + ' · 输出 ' + test.usage.output_tokens + ' Token'))
      if (test.charged_milli != null) line.append(el('p', null, '实扣 ' + formatMilli(test.charged_milli) + ' 块橡皮'))
      else if (test.reserved_milli > 0) line.append(el('p', null, '已预留 ' + formatMilli(test.reserved_milli) + ' 块橡皮'))
      if (test.reason_code) line.append(el('p', 'muted', modelTestReasons[test.reason_code] ?? jobReasons[test.reason_code] ?? test.reason_code))
      if (hasAction(test, 'reconcile')) line.append(button('核对实测费用', () => reconcile(test), 'link'))
      rows.append(line)
    }
    if (!data.items?.length) rows.append(el('p', 'muted', '暂无实测记录'))
    pane.body.append(rows)
  }
  void load()
}

function establishIdentity(pane, api, model, status, signal, next) {
  const title = '确定签约型号身份'
  pane.setTitle(title + ' / ' + model.display_name)
  const mode = 'family_follow'
  editForm(pane, { mode: 'create', label: '保存型号身份', values: { identity_mode: mode, model_variant: 'standard' }, fields: [
    { key: 'maker_id', label: '原厂标识' }, { key: 'model_family', label: '型号系列' }, { key: 'model_variant', label: '型号变体' },
    { key: 'identity_mode', label: '身份要求', type: 'select', allowEmpty: false, options: [
      { value: mode, label: '同系列版本' }, { value: 'pinned_snapshot', label: '固定原厂快照' }
    ] }, { key: 'model_snapshot', label: '原厂快照标识', hint: '固定原厂快照时必填' }
  ],
  async submit(values, options) {
    const payload = { revision: status.revision, maker_id: values.maker_id?.trim(), model_family: values.model_family?.trim(),
      model_variant: values.model_variant?.trim(), identity_mode: values.identity_mode, capability_floor: floor.collect() }
    if (payload.identity_mode === 'pinned_snapshot') payload.model_snapshot = values.model_snapshot?.trim()
    const value = await api.post(modelPath(model.id) + '/identity', payload, { ...options, signal })
    const current = value?.identity ? value : await api.get(modelPath(model.id) + '/identity', { signal })
    if (!current.identity) throw new Error('服务端未返回型号身份')
    return current.identity
  }, done: identity => { if (!signal.aborted) next(identity) } })
  const floor = capabilityChecklist(['text'])
  floor.node.querySelector('legend').textContent = '入池能力门槛'
  pane.body.append(floor.node)
}

function confirmReview(pane, api, discovered, model, identity, signal, done) {
  pane.setTitle(model.display_name + ' / 渠道归并审核')
  const notice = el('p', 'notice')
  notice.setAttribute('role', 'status')
  const reason = el('textarea')
  const checks = capabilityChecklist()
  const facts = el('div', 'policy-facts')
  facts.append(el('p', null, '原始型号 ' + discovered.raw_model),
    el('p', null, '签约型号 ' + [identity.maker_id, identity.model_family, identity.model_variant, identity.model_snapshot].filter(Boolean).join(' / ')))
  if (discovered.snapshot_claim) facts.append(el('p', null, '上游声明快照 ' + discovered.snapshot_claim))
  if (discovered.variant_claim) facts.append(el('p', null, '上游声明变体 ' + discovered.variant_claim))
  pane.body.replaceChildren(notice, facts, el('p', 'muted', '核对型号身份和证据后勾选已确认的能力。归并后的候选可在签约型号中选入活动池。'),
    checks.node, inputField('归并证据与理由', reason, true))
  let busy = false, signature, key
  const accept = button('确认归并', () => review('accept'), 'primary')
  const reject = button('拒绝归并', () => review('reject'))
  pane.foot.replaceChildren(accept, reject)
  async function review(decision) {
    if (busy || signal.aborted) return
    const explanation = reason.value.trim()
    if (!explanation) { failure(notice, '请填写证据与理由'); return }
    const confirmed = decision === 'accept' ? checks.collect() : []
    if (decision === 'accept' && !confirmed.length) { failure(notice, '请勾选已确认的能力'); return }
    const payload = { expected_identity_revision: identity.identity_revision, reason: explanation, decisions: [{
      discovery_id: discovered.discovery_id, catalog_item_id: discovered.catalog_item_id, decision, capabilities: confirmed
    }] }
    const print = JSON.stringify(payload)
    if (print !== signature) { signature = print; key = idempotencyKey() }
    busy = accept.disabled = reject.disabled = true
    success(notice, '正在保存审核…')
    try {
      const result = await api.post(modelPath(model.id) + '/pool/candidates/review', payload, { signal, idempotencyKey: key })
      if (signal.aborted) return
      pane.changed()
      done(result, model, decision)
    } catch (error) {
      if (!signal.aborted) failure(notice, '归并审核失败。' + error.message)
    } finally { busy = accept.disabled = reject.disabled = false }
  }
}

export function reviewDiscoveredModel(pane, api, provider, discovered, signal, back) {
  pane.headActions.replaceChildren(button('返回渠道', back))

  function reviewed(result, model, decision) {
    pane.setTitle(model.display_name + ' / 渠道归并审核')
    const note = decision === 'accept' ? '已归并到 ' + model.display_name + '，可在签约型号中选入模型池。' : '已记录拒绝。'
    const link = el('a', null, '打开签约型号台账')
    link.href = '#/platform/models'
    pane.body.replaceChildren(el('p', 'notice', note), link)
    if (result.items?.[0]?.deployment_id) pane.body.append(el('p', 'muted', '渠道部署 ' + result.items[0].deployment_id))
    pane.foot.replaceChildren()
  }

  async function selectModel(model) {
    pane.foot.replaceChildren()
    pane.body.replaceChildren(el('p', 'muted', '正在读取签约型号身份…'))
    try {
      const current = await api.get(modelPath(model.id) + '/identity', { signal })
      if (signal.aborted) return
      const next = identity => {
        if (!identity) throw new Error('服务端未返回型号身份')
        confirmReview(pane, api, discovered, model, identity, signal, reviewed)
      }
      if (current.identity) next(current.identity)
      else if (hasAction(current, 'create_identity')) establishIdentity(pane, api, model, current, signal, next)
      else pane.body.replaceChildren(el('p', 'error-row', '该签约型号尚未配置身份'))
    } catch (error) {
      if (!signal.aborted) pane.body.replaceChildren(el('p', 'error-row', error.message), button('重试读取', () => selectModel(model)))
    }
  }

  function createModel() {
    pane.setTitle('新建签约型号')
    editForm(pane, { mode: 'create', label: '建立签约型号', values: { display_name: discovered.raw_model, context_window: discovered.context_tokens }, fields: [
      { key: 'display_name', label: '签约型号名称' }, { key: 'context_window', label: '上下文窗口', type: 'number' }
    ], submit(values, options) {
      const display_name = values.display_name?.trim()
      const context_window = Number(values.context_window)
      if (!display_name) throw Error('请填写签约型号名称')
      if (!Number.isSafeInteger(context_window) || context_window < 1) throw Error('上下文窗口须为正整数')
      return api.post('/platform/models', { display_name, context_window, provider_id: provider.id, upstream_name: discovered.raw_model }, { ...options, signal })
    }, done: model => { if (!signal.aborted) selectModel(model) } })
    pane.foot.prepend(button('返回选择型号', chooser))
  }

  function adoptChannelModel(reference = discovered.reference_suggestions?.length === 1 ? discovered.reference_suggestions[0] : null) {
    pane.setTitle('采用渠道型号 / ' + discovered.raw_model)
    const snapshot = discovered.snapshot_claim
    const values = {
      display_name: reference?.display_name ?? discovered.raw_model,
      context_window: discovered.context_tokens ?? reference?.context_tokens,
      maker_id: reference?.maker_id,
      model_family: reference?.model_family,
      model_variant: discovered.variant_claim ?? reference?.model_variant,
      identity_mode: snapshot ? 'pinned_snapshot' : 'family_follow',
      model_snapshot: snapshot,
    }
    const checks = capabilityChecklist()
    checks.node.querySelector('legend').textContent = '确认此渠道提供的能力'
    let lastPayload, submitKey
    editForm(pane, { mode: 'create', label: '采用为签约型号', values, fields: [
      { key: 'display_name', label: '签约型号名称', hint: '租户选型时看到的名称。默认取参考码表或渠道原名。' },
      { key: 'context_window', label: '上下文窗口', type: 'number', hint: '单位 Token。优先采用当前渠道声明值。' },
      { key: 'maker_id', label: '原厂标识', hint: '使用发布模型的厂商标识，例如 Qwen。渠道名用于识别供货方。' },
      { key: 'model_family', label: '型号系列', hint: '填原厂系列名。型号不同的渠道请选择分别建立。' },
      { key: 'model_variant', label: '型号变体', hint: '填已核实的规格或量化变体，有上游声明时沿用。' },
      { key: 'identity_mode', label: '身份要求', type: 'select', allowEmpty: false, options: [
        { value: 'family_follow', label: '同系列版本' }, { value: 'pinned_snapshot', label: '固定原厂快照' }
      ] },
      { key: 'model_snapshot', label: '原厂快照标识', hint: '固定原厂快照时，填写当前渠道目录给出的精确快照。' },
      { key: 'reason', label: '采纳依据', type: 'textarea', hint: '记录已核对的目录、官方规格或测试证据。' },
    ], submit(form) {
      const context = Number(form.context_window)
      if (!Number.isSafeInteger(context) || context < 1) throw Error('请填写已确认的上下文窗口')
      const confirmed = checks.collect()
      if (!confirmed.includes('text')) throw Error('请核对这个渠道并勾选文本能力')
      const payload = {
        catalog_item_id: discovered.catalog_item_id, display_name: form.display_name?.trim(), context_window: context,
        maker_id: form.maker_id?.trim(), model_family: form.model_family?.trim(), model_variant: form.model_variant?.trim(),
        identity_mode: form.identity_mode, capabilities: confirmed, reason: form.reason?.trim(),
      }
      if (payload.identity_mode === 'pinned_snapshot') payload.model_snapshot = form.model_snapshot?.trim()
      const fingerprint = JSON.stringify(payload)
      if (fingerprint !== lastPayload) { lastPayload = fingerprint; submitKey = idempotencyKey() }
      return api.post('/platform/probe-jobs/' + enc(discovered.discovery_id) + '/adoptions', payload, { idempotencyKey: submitKey, signal })
    }, done: result => { if (!signal.aborted) reviewed({ items: [result] }, result, 'accept') } })
    const facts = el('section', 'deployment-section')
    facts.append(el('p', null, '供货渠道 ' + provider.name + ' · 原始型号 ' + discovered.raw_model))
    const claims = capabilityList(discovered.capabilities_claim)
    if (claims.length) facts.append(el('p', 'muted', '渠道目录声明 ' + claims.join('、')))
    if (reference) {
      const hint = el('p', 'muted', '参考来源 ')
      const url = URL.canParse(reference.source_url) && new URL(reference.source_url)
      if (url && url.protocol === 'https:') {
        const source = el('a', null, reference.source)
        source.href = url.href
        source.target = '_blank'
        source.rel = 'noopener noreferrer'
        hint.append(source)
      } else hint.append(reference.source)
      facts.append(hint)
    }
    const choices = el('div', 'actions')
    for (const suggestion of discovered.reference_suggestions ?? []) {
      if (suggestion === reference) continue
      choices.append(button('采用参考 ' + suggestion.display_name, () => adoptChannelModel(suggestion), 'link'))
    }
    if (choices.childElementCount) facts.append(choices)
    facts.append(el('p', 'muted', '采用后会新增或复用本渠道同原名的签约型号。模型池、采购报价和租户签发在签约型号台账继续设置。'))
    pane.body.prepend(facts)
    pane.body.append(checks.node)
    pane.foot.prepend(button('返回选择型号', chooser))
  }

  function chooser() {
    pane.setTitle(discovered.raw_model + ' / 选择签约型号')
    pane.body.replaceChildren()
    pane.foot.replaceChildren()
    const choices = el('section', 'deployment-section')
    const status = el('p', 'notice', discovered.intake ? '已登记 · 待核对' : '')
    status.setAttribute('role', 'status')
    const stage = button('登记待核对', async () => {
      stage.disabled = true
      try {
        const reply = await api.post('/platform/probe-jobs/' + enc(discovered.discovery_id) + '/adoptions', {
          mode: 'draft', catalog_item_id: discovered.catalog_item_id
        }, { signal, idempotencyKey: idempotencyKey() })
        if (signal.aborted) return
        discovered.intake = reply
        pane.changed()
        success(status, '已登记 · 待核对')
      } catch (error) {
        if (!signal.aborted) { failure(status, error.message); stage.disabled = false }
      }
    }, 'link')
    stage.disabled = Boolean(discovered.intake)
    choices.append(el('p', null, '可以沿用此渠道的原始型号与已发现参数，或将它作为供货渠道归并到已有签约型号。'),
      button('采用此渠道型号', () => adoptChannelModel(), 'primary'), stage, status)
    pane.body.append(choices)
    createLedger(pane.body, {
      title: '签约型号目录', searchLabel: '查询签约型号', signal, rowKey: 'id',
      createAction: 'create_model', createLabel: '新建签约型号', onCreate: createModel, onOpen: selectModel,
      columns: [{ key: 'display_name', title: '名称' }, { key: 'id', title: '签约型号 ID' },
        { title: '活动渠道', render: model => model.channel_count == null ? '—' : String(model.channel_count) }],
      fetchPage: ({ q, cursor, limit, signal: requestSignal }) => api.get('/platform/models', { params: { q, cursor, limit }, signal: requestSignal })
    })
  }
  chooser()
}
