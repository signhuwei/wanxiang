// 签约型号台账与模型池版本（contracts/routing-p0.md）。
// 台账 → 右栏「模型池版本」嵌套台账 → 版本详情或起草表单。按钮只看接口 actions；
// 候选直接使用服务端的 approved_match_id/evidence_ids；409 保留草稿并提供重新预览。

import { createLedger } from './ledger.js'
import { button, detailPanel, el } from './panel.js'
import { createPager } from './pager.js'
import { formatDateTime } from './format.js'
import { idempotencyKey } from './idempotency.js'
import {
  DEFAULT_ROUTING, buildDraft, candidateState, capabilityList, conflictMessage, isMemberOf, memberChanges, reasonText,
  revisionText, shortValue, toggleMember
} from './routing-format.js'

const enc = encodeURIComponent
const hasAction = (data, action) => data?.actions?.includes(action) === true
const modelPath = id => '/platform/models/' + enc(id)

function facts(host, rows) {
  const list = el('dl', 'policy-facts')
  for (const [label, value] of rows) {
    const row = el('div')
    row.append(el('dt', null, label), el('dd', null, value ?? '—'))
    list.append(row)
  }
  host.append(list)
  return list
}

function table(head, rows, label) {
  const wrap = el('div', 'routing-table')
  const t = el('table')
  if (label) t.setAttribute('aria-label', label)
  const tr = el('tr')
  for (const h of head) tr.append(el('th', null, h))
  const thead = el('thead')
  thead.append(tr)
  const tbody = el('tbody')
  for (const cells of rows) {
    const r = el('tr')
    for (const cell of cells) {
      const td = el('td')
      if (cell instanceof Node) td.append(cell)
      else td.textContent = cell ?? '—'
      r.append(td)
    }
    tbody.append(r)
  }
  t.append(thead, tbody)
  wrap.append(t)
  return wrap
}

const routingText = r => r ? [r.strategy === 'ordered' ? '有序主备' : r.strategy, '最多 ' + r.max_attempts + ' 次',
  '单次 ' + r.attempt_timeout_ms + ' ms', '总计 ' + r.total_timeout_ms + ' ms'].join(' · ') : '—'

function membersTable(members, label = '池成员') {
  return table(['优先级', '部署', '部署修订', '归纳审核', '证据'],
    [...(members ?? [])].sort((a, b) => a.priority - b.priority).map(m =>
      [String(m.priority), m.deployment_id, 'v' + m.deployment_revision, m.approved_match_id, (m.evidence_ids ?? []).join('、') || '—']), label)
}

export function renderRevision(host, data) {
  host.append(el('h3', null, '模型池 v' + data.pool_revision))
  facts(host, [['签约型号', data.model_id], ['状态', data.current ? '活动池' : '历史版本'], ['发布原因', data.reason],
    ['路由', routingText(data.routing)], ...(data.released_at ? [['发布时间', formatDateTime(data.released_at)]] : []),
    ...(data.released_by ? [['发布人', data.released_by]] : [])])
  host.append(el('h3', null, '成员'), membersTable(data.members))
}

function errorText(e) {
  const fields = e?.detail?.fields
  return e.message + (Array.isArray(fields) && fields.length ? '（' + fields.join('、') + '）' : '')
}

// 起草：基于活动池成员，从候选中选取；预览后才出现发布，草稿变化即作废预览。
function draftPool(pane, api, model, base, signal, done) {
  const notice = el('div', 'notice')
  let expected = base?.pool_revision ?? 0
  let members = (base?.members ?? []).map(m => ({ ...m, evidence_ids: [...(m.evidence_ids ?? [])] }))
  const routing = { ...DEFAULT_ROUTING, ...(base?.routing ?? {}) }
  let preview = null, previewFingerprint = null, publishKey = null, publishFingerprint = null, busy = false, generation = 0
  const review = new Map() // deployment_id → memberChanges()：预览过期后需用户显式处理的成员
  const sync = () => { previewBtn.disabled = busy || review.size > 0 }

  const basis = el('p', 'muted')
  const candidates = el('div')
  const memberHost = el('div')
  const routeGrid = el('div', 'form-grid')
  const reason = el('textarea')
  reason.setAttribute('aria-label', '发布原因')
  reason.name = 'reason'
  const result = el('div', 'pool-preview')
  result.setAttribute('aria-live', 'polite')
  pane.body.replaceChildren(notice, basis, el('h3', null, '候选渠道'), candidates, el('h3', null, '草稿成员'), memberHost,
    el('h3', null, '路由'), routeGrid, el('h3', null, '发布原因'), reason, el('h3', null, '预览结果'), result)
  const previewBtn = button('预览', () => runPreview(), 'primary')
  const publishBtn = button('发布', () => runPublish(), 'primary')
  publishBtn.hidden = true
  pane.foot.replaceChildren(previewBtn, publishBtn)

  const drawBasis = () => { basis.textContent = '基于 ' + revisionText(expected) + ' 起草 · 发布前须预览，计划发布与设备应用分别回执' }
  drawBasis()
  const strategy = el('div', 'field')
  const out = el('output', null, '有序主备（ordered）')
  out.dataset.field = 'strategy'
  strategy.append(el('span', null, '策略'), out)
  routeGrid.append(strategy)
  for (const [key, label] of [['max_attempts', '最多尝试次数'], ['attempt_timeout_ms', '单次时限（ms）'], ['total_timeout_ms', '总时限（ms）']]) {
    const wrap = el('label', 'field')
    const input = el('input')
    input.type = 'number'
    input.name = key
    input.min = '1'
    input.step = '1'
    input.value = String(routing[key])
    input.setAttribute('aria-label', label)
    input.addEventListener('input', () => { routing[key] = input.value === '' ? NaN : Number(input.value); invalidate() })
    wrap.append(el('span', null, label), input)
    routeGrid.append(wrap)
  }
  reason.addEventListener('input', invalidate)

  function current() {
    return { expected_pool_revision: expected, members, routing, reason: reason.value }
  }
  function fingerprint() {
    try { return JSON.stringify(buildDraft(current())) } catch { return null }
  }
  function invalidate() {
    generation += 1 // 任何草稿变化都让在途预览作废
    if (preview && fingerprint() !== previewFingerprint) {
      preview = null
      publishBtn.hidden = true
      result.replaceChildren(el('p', 'notice warn', '草稿已修改，需重新预览后才能发布。'))
    }
  }

  function drawMembers() {
    memberHost.replaceChildren()
    if (!members.length) { memberHost.append(el('p', 'muted', '尚未选择渠道')); return }
    const rows = [...members].sort((a, b) => a.priority - b.priority).map(m => {
      const input = el('input')
      input.type = 'number'
      input.step = '1'
      input.min = '0'
      input.value = String(m.priority)
      input.className = 'priority-input'
      input.setAttribute('aria-label', m.deployment_id + ' 优先级')
      input.addEventListener('change', () => {
        m.priority = input.value === '' ? NaN : Number(input.value)
        invalidate()
        drawMembers()
      })
      const remove = button('移除', () => { members = members.filter(x => x !== m); review.delete(m.deployment_id); invalidate(); drawMembers(); drawCandidates() }, 'link')
      remove.setAttribute('aria-label', '移除 ' + m.deployment_id)
      const change = review.get(m.deployment_id)
      let check = el('span', 'eligible', '一致')
      if (change?.kind === 'changed') {
        check = el('span', 'review-cell')
        check.append(el('span', 'ineligible', '需核对：' + change.diffs.map(([label, a, b]) => label + ' ' + a + ' → ' + b).join('；')))
        const adopt = button('采用新版本', () => {
          members = toggleMember(members, change.row, true)
          review.delete(m.deployment_id)
          invalidate(); drawMembers(); drawCandidates()
        }, 'link')
        adopt.setAttribute('aria-label', '采用 ' + m.deployment_id + ' 新版本')
        check.append(adopt)
      } else if (change?.kind === 'gone') {
        check = el('span', 'ineligible', '已不可入池：' + change.reasons.join('；') + '，请移除')
      }
      return [input, m.deployment_id, 'v' + m.deployment_revision, m.approved_match_id, m.evidence_ids.join('、'), check, remove]
    })
    memberHost.append(table(['优先级', '部署', '部署修订', '归纳审核', '证据', '核对', ''], rows, '草稿成员'))
    sync()
  }

  // 候选列表：服务端分页，可选行带 select 动作；不可选行显示原因。
  let pager = createPager(), q = '', items = [], abort, timer
  const search = el('input', 'search')
  search.type = 'search'
  search.placeholder = '查询原始型号'
  search.setAttribute('aria-label', '查询候选')
  const listHost = el('div')
  const nav = el('div', 'card-pager')
  const prev = button('上一页', () => { if (pager.prev()) loadCandidates() })
  const next = button('下一页', () => { if (pager.next()) loadCandidates() })
  const info = el('span', 'muted')
  nav.append(prev, next, info)
  candidates.append(search, listHost, nav)
  search.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => { q = search.value; pager = createPager(); loadCandidates() }, 300)
  })

  function drawCandidates() {
    if (!items.length) { listHost.replaceChildren(el('p', 'muted', '没有候选')); return }
    const rows = items.map(row => {
      const state = candidateState(row)
      const box = el('input')
      box.type = 'checkbox'
      box.disabled = !state.selectable
      box.checked = state.selectable && isMemberOf(members, row)
      box.setAttribute('aria-label', '选择 ' + (row.deployment_id ?? row.candidate_id) + ' ' + row.raw_model)
      box.addEventListener('change', () => {
        members = toggleMember(members, row, box.checked)
        review.delete(row.deployment_id)
        invalidate()
        drawMembers()
        drawCandidates()
      })
      const match = row.match ? [row.match.review_status, row.match.reason, row.match.confidence].filter(v => v != null && v !== '').join(' · ') : '—'
      const verdict = state.selectable
        ? el('span', 'eligible', '可入池 · ' + row.approved_match_id)
        : el('span', 'ineligible', '未获准：' + state.reasons.join('；'))
      return [box, row.raw_model, row.deployment_id ? row.deployment_id + ' v' + row.deployment_revision : '—',
        [row.provider_id, row.account_id, row.endpoint_id].map(v => v ?? '—').join(' / '),
        capabilityList(row.capabilities).join('、') || '—', match, shortValue(row.health), shortValue(row.quote_ref), verdict]
    })
    listHost.replaceChildren(table(['', '原始型号', '部署', 'Provider / 账号 / 端点', '能力', '匹配', '健康', '报价', '资格'], rows, '候选渠道'))
  }

  async function loadCandidates() {
    abort?.abort()
    const ctrl = abort = new AbortController()
    signal?.addEventListener('abort', () => ctrl.abort(), { once: true })
    prev.disabled = next.disabled = true
    listHost.replaceChildren(el('p', 'muted', '加载候选…'))
    try {
      const data = await api.get('/platform/deployments', { params: { target_model_id: model.id, q, cursor: pager.cursor(), limit: 50 }, signal: ctrl.signal })
      if (ctrl.signal.aborted) return
      pager.applyResult(data.next_cursor ?? null)
      items = data.items ?? []
      drawCandidates()
    } catch (e) {
      if (ctrl.signal.aborted || e?.name === 'AbortError') return
      listHost.replaceChildren(el('p', 'error-row', '候选读取失败：' + e.message))
    } finally {
      if (abort === ctrl) {
        prev.disabled = !pager.canPrev()
        next.disabled = !pager.canNext()
        info.textContent = '第 ' + (pager.page + 1) + ' 页'
      }
    }
  }

  function issues(title, list, cls) {
    if (!list?.length) return
    const ul = el('ul', cls)
    ul.setAttribute('aria-label', title)
    for (const item of list) ul.append(el('li', null, reasonText(item) + (item?.field ? ' · ' + item.field : '')))
    result.append(el('h4', null, title), ul)
  }

  function conflict(e) {
    const reasonCode = e.detail?.reason
    preview = null
    publishBtn.hidden = true
    const box = el('div', 'notice error')
    box.append(el('p', null, conflictMessage(reasonCode)))
    const latest = e.detail?.current_revision
    if (reasonCode === 'revision_changed' && Number.isSafeInteger(latest)) {
      box.append(el('p', null, '当前活动池为 v' + latest + '，你的草稿基于 ' + revisionText(expected) + '。'))
      box.append(button('按 v' + latest + ' 重新预览', () => { expected = latest; drawBasis(); runPreview() }, 'primary'))
    } else if (reasonCode === 'preview_stale') {
      box.append(button('重新核对候选', () => reconcile(), 'primary'))
    } else {
      box.append(button('重新预览', () => runPreview(), 'primary'))
    }
    result.replaceChildren(box)
    box.scrollIntoView({ block: 'nearest' })
  }

  // 预览过期：重新拉活动池和候选，保留理由与已选成员，逐个标出变化，必须显式采用或移除后才能再预览。
  async function reconcile() {
    result.replaceChildren(el('p', 'muted', '正在重新读取活动池和候选…'))
    try {
      const revisions = await api.get(modelPath(model.id) + '/pool/revisions', { signal })
      const cur = (revisions.items ?? []).find(item => item.current)
      const want = new Set(members.map(m => m.deployment_id)), found = new Map()
      const better = (a, b) => {
        const sa = candidateState(a).selectable, sb = candidateState(b).selectable
        return sa !== sb ? sa : (a.deployment_revision ?? 0) > (b.deployment_revision ?? 0)
      }
      let cursor = null, pages = 0
      do {
        const page = await api.get('/platform/deployments', { params: { target_model_id: model.id, cursor, limit: 200 }, signal })
        for (const row of page.items ?? []) {
          if (!row.deployment_id || !want.has(row.deployment_id)) continue
          const prev = found.get(row.deployment_id)
          if (!prev || better(row, prev)) found.set(row.deployment_id, row)
        }
        cursor = page.next_cursor ?? null
      } while (cursor && ++pages < 25)
      review.clear()
      generation += 1
      for (const m of members) {
        const change = memberChanges(m, found.get(m.deployment_id))
        if (change) review.set(m.deployment_id, change)
      }
      const lines = []
      if (cur && cur.pool_revision !== expected) {
        lines.push('活动池已变为 v' + cur.pool_revision + '，草稿改为基于该版本。')
        expected = cur.pool_revision
        drawBasis()
      }
      pager = createPager()
      loadCandidates()
      drawMembers()
      const box = el('div', review.size ? 'notice warn' : 'notice')
      lines.push(review.size ? review.size + ' 个已选成员的候选已变化，请在「草稿成员」逐个核对，采用新版本或移除后再预览。'
        : '已选成员与最新候选一致，发布理由已保留。')
      for (const line of lines) box.append(el('p', null, line))
      if (!review.size) box.append(button('重新预览', () => runPreview(), 'primary'))
      result.replaceChildren(box)
      ;(review.size ? memberHost : box).scrollIntoView({ block: 'nearest' })
    } catch (e) {
      if (e?.name === 'AbortError') return
      const box = el('div', 'notice error')
      box.append(el('p', null, '重新核对失败：' + errorText(e)), button('重新核对候选', () => reconcile(), 'primary'))
      result.replaceChildren(box)
    }
  }

  async function runPreview() {
    if (busy) return
    if (review.size) { notice.textContent = '请先处理需核对的成员'; notice.className = 'notice error'; return }
    let draft
    try { draft = buildDraft(current()) } catch (e) { notice.textContent = e.message; notice.className = 'notice error'; return }
    notice.textContent = ''
    notice.className = 'notice'
    busy = true
    previewBtn.disabled = true
    publishBtn.hidden = true
    result.replaceChildren(el('p', 'muted', '正在预览…'))
    const gen = generation, sent = JSON.stringify(draft)
    // 响应返回时草稿已变化（generation 或规范形不同），丢弃旧结果，不显示发布按钮
    const outdated = () => gen !== generation || fingerprint() !== sent
    const discard = () => {
      preview = null
      publishBtn.hidden = true
      result.replaceChildren(el('p', 'notice warn', '草稿在预览期间已修改，旧结果已丢弃，请重新预览。'))
    }
    try {
      const data = await api.post(modelPath(model.id) + '/pool/preview', draft, { signal })
      if (outdated()) return discard()
      preview = data
      previewFingerprint = sent
      result.replaceChildren()
      facts(result, [['可发布', data.publishable ? '是' : '否'], ['基于', revisionText(data.expected_pool_revision)],
        ['新增', (data.diff?.added ?? []).join('、') || '无'], ['移除', (data.diff?.removed ?? []).join('、') || '无'],
        ['更新', (data.diff?.updated ?? []).join('、') || '无'],
        ['影响目标', data.impact ? data.impact.tenant_count + ' 个租户 · ' + data.impact.device_count + ' 台设备' : '—']])
      result.append(el('p', 'muted', '影响为配置目标数；设备是否已应用以设备回执为准，与活动池分开显示。'))
      issues('阻止发布', data.blocking, 'issue-list blocking')
      issues('提醒', data.warnings, 'issue-list')
      publishBtn.hidden = !(data.publishable && hasAction(data, 'publish_pool') && data.preview_basis)
      if (data.publishable && !hasAction(data, 'publish_pool')) result.append(el('p', 'muted', '当前账号没有发布权限'))
      result.scrollIntoView({ block: 'nearest' })
    } catch (e) {
      if (e?.name === 'AbortError') return
      if (outdated()) return discard()
      if (e.code === 'conflict') conflict(e)
      else result.replaceChildren(el('p', 'notice error', errorText(e)))
    } finally {
      busy = false
      sync()
    }
  }

  async function runPublish() {
    if (busy || !preview) return
    let draft
    try { draft = buildDraft(current()) } catch { invalidate(); return }
    if (JSON.stringify(draft) !== previewFingerprint) { invalidate(); return }
    const body = { ...draft, preview_basis: preview.preview_basis }
    const print = JSON.stringify(body)
    if (publishFingerprint !== print) { publishKey = idempotencyKey(); publishFingerprint = print }
    busy = true
    publishBtn.disabled = previewBtn.disabled = true
    try {
      const res = await api.post(modelPath(model.id) + '/pool/revisions', body, { idempotencyKey: publishKey, signal })
      done(res)
    } catch (e) {
      if (e?.name === 'AbortError') return
      // 只有网络失败（服务端未应答）才用原参数原键重试；服务端已应答的失败一律作废旧键，
      // 即使重新预览得到相同的 preview_basis，下一次提交也换新键。
      if (e.status !== 0) { publishKey = null; publishFingerprint = null }
      if (e.code === 'conflict') conflict(e)
      else {
        const box = el('p', 'notice error', '发布未完成：' + errorText(e) + (e.status === 0 ? '。重试将使用同一提交键，不会重复发布。' : ''))
        result.append(box)
        box.scrollIntoView({ block: 'nearest' })
      }
    } finally {
      busy = false
      publishBtn.disabled = false
      sync()
    }
  }

  drawMembers()
  loadCandidates()
}

function poolPanel(pane, api, model, signal, onChanged) {
  pane.body.replaceChildren()
  pane.foot.replaceChildren()
  pane.body.classList.add('child-ledger')
  let ledger, active = Number.isSafeInteger(model.current_pool_revision) ? model.current_pool_revision : 0
  const open = detailPanel(pane.body, () => ledger)

  function readback(sub, revision, published) {
    sub.setTitle('模型池 v' + revision)
    sub.foot.replaceChildren()
    sub.body.replaceChildren(el('p', 'muted', '正在回读…'))
    return api.get(modelPath(model.id) + '/pool/revisions/' + revision, { signal }).then(data => {
      sub.body.replaceChildren()
      if (published) {
        const ok = el('div', 'notice')
        ok.textContent = '已发布模型池 v' + published.pool_revision + (published.rollout_id ? ' · 发布任务 ' + published.rollout_id : '')
          + '。设备是否已应用以回执为准。'
        sub.body.append(ok)
      }
      renderRevision(sub.body, data)
    })
  }

  function showRevision(row) {
    open('模型池 v' + row.pool_revision, sub => readback(sub, row.pool_revision))
  }

  function draft() {
    open('起草模型池', async sub => {
      sub.body.append(el('p', 'muted', '正在读取活动池…'))
      const base = active > 0 ? await api.get(modelPath(model.id) + '/pool/revisions/' + active, { signal }) : null
      draftPool(sub, api, model, base, signal, res => {
        sub.changed()
        onChanged()
        active = res.pool_revision
        readback(sub, res.pool_revision, res).catch(e => sub.body.replaceChildren(el('p', 'error-row', e.message)))
      })
    })
  }

  ledger = createLedger(pane.body, {
    title: '模型池版本', searchable: false, signal, rowKey: 'pool_revision', createAction: 'preview_pool', createLabel: '起草新版本',
    columns: [
      { title: '版本', render: item => 'v' + item.pool_revision },
      { title: '状态', render: item => item.current ? '活动池' : '历史' },
      { key: 'reason', title: '发布原因' },
      { title: '发布时间', render: item => item.released_at ? formatDateTime(item.released_at) : '—' }
    ],
    fetchPage: async ({ cursor, limit, signal: s }) => {
      const page = await api.get(modelPath(model.id) + '/pool/revisions', { params: { cursor, limit }, signal: s })
      const cur = (page.items ?? []).find(item => item.current)
      if (cur) active = cur.pool_revision
      return page
    },
    onOpen: showRevision, onCreate: draft
  })
}

export function signedModelsPage(host, api, signal) {
  let ledger
  const open = detailPanel(host, () => ledger)
  ledger = createLedger(host, {
    title: '签约型号', signal, searchLabel: '查询型号',
    columns: [
      { key: 'display_name', title: '型号' },
      { key: 'id', title: '型号 ID' },
      { title: '活动池', render: item => Number.isSafeInteger(item.current_pool_revision) ? revisionText(item.current_pool_revision) : '—' },
      { title: '平台渠道', render: item => Number.isSafeInteger(item.channel_count) ? String(item.channel_count) : '—' },
      { title: '状态', render: item => item.status === 'disabled' ? '停用' : item.status === 'active' ? '启用' : (item.status ?? '—') }
    ],
    fetchPage: ({ q, cursor, limit, signal: s }) => api.get('/platform/models', { params: { q, cursor, limit }, signal: s }),
    onOpen: row => open(row.display_name || row.id, pane => poolPanel(pane, api, row, signal, () => pane.changed()))
  })
}
