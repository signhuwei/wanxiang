import { createLedger } from './ledger.js'
import { button, editForm, el } from './panel.js'
import { createPager } from './pager.js'
import { formatDateTime } from './format.js'
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
  missing_credential: '缺少查询凭据', credential_rejected: '上游拒绝认证', permission_denied: '上游限制访问',
  unsupported_capability: '此接口不提供模型目录', probe_timeout: '请求上游超时', schema_mismatch: '上游目录格式无法读取',
  upstream_unavailable: '上游暂不可达', redirected: '上游返回重定向'
}
const success = (notice, text) => { notice.textContent = text; notice.className = 'notice' }
const failure = (notice, text) => { notice.textContent = text; notice.className = 'notice error' }
const modelPath = id => '/platform/models/' + enc(id)

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

function discoveryResults(host, api, job, signal, onReview) {
  const section = el('section', 'deployment-section')
  section.setAttribute('aria-label', '上游发现目录')
  const header = el('div', 'deployment-toolbar')
  const count = el('span', 'muted')
  const search = el('input', 'search')
  search.type = 'search'
  search.placeholder = '查询上游原始型号'
  search.setAttribute('aria-label', '查询已拉取模型')
  header.append(el('h3', null, '上游发现目录'), count, search)
  const cards = el('div', 'deployment-grid')
  const nav = el('div', 'card-pager')
  const currentPage = el('span', 'muted')
  let q = '', timer, controller, pager = createPager()
  const prev = button('上一页目录', () => { if (pager.prev()) load() })
  const next = button('下一页目录', () => { if (pager.next()) load() })
  nav.append(prev, next, currentPage)
  section.append(header, cards, nav)
  host.replaceChildren(section)

  function card(row, reviewable) {
    const entry = el('article', 'deployment-card')
    entry.setAttribute('aria-label', '发现模型 ' + row.raw_model)
    entry.append(el('strong', 'deployment-raw', row.raw_model), el('small', 'muted', '上下文 ' + (row.context_tokens ?? '未知')))
    const declared = capabilityList(row.capabilities_claim)
    if (declared.length) entry.append(el('small', 'muted', '上游声明 ' + declared.join('、')))
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
      cards.replaceChildren(...(rows.length ? rows.map(row => card(row, hasAction(page, 'review_candidates'))) :
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

export function channelOperations(host, api, provider, signal, onReview) {
  const base = '/platform/providers/' + enc(provider.id)
  const operations = el('section', 'deployment-section channel-overview')
  operations.setAttribute('aria-label', '渠道管理')
  const notice = el('p', 'notice')
  notice.setAttribute('role', 'status')
  const tools = el('div', 'actions')
  const summary = el('dl', 'policy-facts')
  const directory = el('div')
  operations.append(el('h3', null, '渠道管理'), notice, tools, summary, directory)
  host.append(operations)
  let busy = false, lastJob, request = 0

  function draw(state) {
    summary.replaceChildren()
    const descriptions = [['渠道账户', (state.accounts ?? []).map(row => row.name).join('、') || '尚未建立'],
      ['最近连通测试', describeJob(state.latest_probe)], ['最近模型拉取', describeJob(state.latest_discovery, true)]]
    for (const [label, value] of descriptions) {
      const row = el('div')
      row.append(el('dt', null, label), el('dd', null, value))
      summary.append(row)
    }
    tools.replaceChildren()
    if (hasAction(state, 'probe_connectivity')) tools.append(button('测试连通性', () => run('probe', state.revision)))
    if (hasAction(state, 'discover')) tools.append(button('拉取模型', () => run('discovery', state.revision), 'primary'))
    tools.append(button('刷新渠道状态', () => load()))
    const fresh = state.latest_catalog ?? (['succeeded', 'partial'].includes(state.latest_discovery?.status) ? state.latest_discovery : null)
    if (fresh?.id && fresh.id !== lastJob) {
      lastJob = fresh.id
      discoveryResults(directory, api, fresh, signal, onReview)
    }
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
    const headline = discovery ? '拉取模型' : '连通测试'
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

  function chooser() {
    pane.setTitle(discovered.raw_model + ' / 选择签约型号')
    pane.body.replaceChildren()
    pane.foot.replaceChildren()
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
