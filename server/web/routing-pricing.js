// 采购报价、人工汇率、可签输入倍率（contracts/routing-pricing-and-staging.md）。
// 台账左缩、右侧单表单；按钮只看接口 actions；报价/汇率写入与倍率试算分开；冲突保留表单。
// 平台可签倍率只表示“可选入签发”，与租户实际签发、设备已应用严格区分。

import { createLedger } from './ledger.js'
import { button, detailPanel, el } from './panel.js'
import { formatDateTime, formatMilli } from './format.js'
import { idempotencyKey } from './idempotency.js'
import {
  DIMENSIONS, calculationLabel, conflictMessage, dimensionLabel, formatMicro, formatMultiplier, formatRatio, isoInput,
  parseMicro, parseMultiplier, parseRatio, pricingReason, submissionKeys, unitPriceText, asOfRound
} from './routing-format.js'

const enc = encodeURIComponent
const hasAction = (data, action) => data?.actions?.includes(action) === true
export const SIGNABLE_NOTE = '平台可签：仅表示可选入签发。租户实际签发价以签发记录为准，设备是否已应用以设备回执为准。'

function facts(host, rows) {
  const list = el('dl', 'policy-facts')
  for (const [label, value] of rows) {
    const row = el('div')
    const dd = el('dd')
    if (value instanceof Node) dd.append(value)
    else dd.textContent = value ?? '—'
    row.append(el('dt', null, label), dd)
    list.append(row)
  }
  host.append(list)
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

function field(label, control, hint) {
  const wrap = el('label', 'field')
  control.setAttribute('aria-label', label)
  wrap.append(el('span', null, label), control)
  if (hint) wrap.append(hint)
  return wrap
}
function input(name, value = '', type = 'text') {
  const n = el(type === 'textarea' ? 'textarea' : 'input')
  if (type !== 'textarea') n.type = type
  n.name = name
  n.value = value
  return n
}
const errorText = e => e.message + (Array.isArray(e?.detail?.fields) && e.detail.fields.length ? '（' + e.detail.fields.join('、') + '）' : '')
const range = (from, until) => (from ? formatDateTime(from) : '—') + ' 至 ' + (until ? formatDateTime(until) : '不限')
const sourceText = s => s ? (s.kind === 'manual' ? '人工' : s.kind) + (s.reference ? ' · ' + s.reference : '') : '—'
// 发布经办人：服务端字段为 published_by（旧样例 created_by 兼容）
const operator = v => { const who = v.published_by ?? v.created_by; return who ? [['经办人', who]] : [] }

// 报价、汇率、倍率的冲突文案（不能沿用模型池措辞）
const PRICING_CONFLICTS = {
  revision_changed: '已被他人更新到新的修订，表单已保留。',
  preview_stale: '试算依据已过期（池、报价或汇率已变化），表单已保留。请重新计算。',
  idempotency_mismatch: '同一提交键对应的内容已变化，表单已保留。请核对后重新提交。'
}
const pricingConflict = reason => PRICING_CONFLICTS[reason] ?? (reason ? conflictMessage(reason).replace('草稿已保留', '表单已保留') : '数据已变化，表单已保留。')

// 统一的写入：响应不明（网络失败或网关 5xx）原参数原键重放；明确应答的 4xx 换键；409 保留表单并给出处理入口。
export const responseUnclear = e => e?.status === 0 || e?.status >= 500
async function submit({ api, path, body, keys, notice, signal, onConflict }) {
  try {
    return await api.post(path, body, { idempotencyKey: keys.for(body), signal })
  } catch (e) {
    if (e?.name === 'AbortError') throw e
    if (!responseUnclear(e)) keys.answered()
    notice.replaceChildren()
    const box = el('div', 'notice error')
    if (e.code === 'conflict') {
      box.append(el('p', null, pricingConflict(e.detail?.reason)))
      onConflict?.(e, box)
    } else {
      box.append(el('p', null, '发布未完成：' + errorText(e) + (responseUnclear(e) ? '。结果不明，重试将使用同一提交键，不会重复发布。' : '')))
    }
    notice.append(box)
    box.scrollIntoView({ block: 'nearest' })
    return null
  }
}

// ——— 渠道采购报价 ———

function renderQuote(host, q) {
  facts(host, [['报价', q.quote_id + ' v' + q.quote_revision], ['部署', q.deployment_id + (q.deployment_revision ? ' v' + q.deployment_revision : '')],
    ['币种', q.currency], ['适用范围', q.tariff_scope?.kind === 'deployment' ? '该部署及其账户' : q.tariff_scope?.kind],
    ['生效区间', range(q.valid_from, q.valid_until)], ['来源', sourceText(q.source)], ['原因', q.reason],
    ...operator(q)])
  const items = new Map((q.items ?? []).map(i => [i.dimension, i]))
  host.append(table(['计价维度', '单价'], DIMENSIONS.map(([key, label]) => [label, unitPriceText(items.get(key), q.currency)]), '报价条目'))
}

function quoteForm(sub, api, card, base, signal, done, refreshHead) {
  const notice = el('div')
  const keys = submissionKeys(idempotencyKey)
  let expected = base.head, deploymentRevision = base.deploymentRevision
  const head = el('p', 'muted')
  const drawHead = () => { head.textContent = '部署 ' + card.id + ' · 部署修订 ' + (Number.isSafeInteger(deploymentRevision) ? 'v' + deploymentRevision : '未知')
    + ' · 基于报价修订 v' + expected + '（0 表示首次）' }
  drawHead()
  const currency = input('currency', base.latest?.currency ?? 'CNY')
  const validFrom = input('valid_from', new Date().toISOString())
  const validUntil = input('valid_until')
  const reference = input('source_reference')
  const reason = input('reason', '', 'textarea')
  const grid = el('div', 'form-grid')
  grid.append(field('币种', currency), field('生效时间（UTC）', validFrom), field('失效时间（UTC，可空）', validUntil), field('来源说明', reference))
  const rows = DIMENSIONS.map(([key, label, unit]) => {
    const price = input('price_' + key)
    price.setAttribute('aria-label', label + '单价')
    price.placeholder = '空为缺项，0 为明确零价'
    const basis = input('basis_' + key, unit === 'token' ? '1000000' : '1', 'number')
    basis.setAttribute('aria-label', label + '数量基数')
    return { key, unit, label, price, basis }
  })
  sub.body.replaceChildren(notice, head, grid, el('h3', null, '计价条目'),
    table(['维度', '单价（原币）', '数量基数', '单位'], rows.map(r => [r.label, r.price, r.basis, r.unit === 'token' ? 'token' : '次']), '报价输入'),
    el('h3', null, '发布原因'), reason)
  reason.setAttribute('aria-label', '报价原因')
  const save = button('发布报价', async () => {
    let body
    try {
      if (!Number.isSafeInteger(deploymentRevision)) throw new Error('报价列表未返回当前部署修订，无法登记报价')
      const cur = currency.value.trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(cur)) throw new Error('币种须为三位大写字母')
      const items = []
      for (const r of rows) {
        const rate = parseMicro(r.price.value, r.label + '单价')
        if (rate === null) continue
        const qb = Number(r.basis.value)
        if (!Number.isSafeInteger(qb) || qb < 1) throw new Error(r.label + '数量基数须为正整数')
        items.push({ dimension: r.key, rate_micro: rate, quantity_basis: qb, unit: r.unit })
      }
      if (!items.length) throw new Error('请至少填写一个计价维度')
      if (!reason.value.trim()) throw new Error('请填写发布原因')
      const until = isoInput(validUntil.value, '失效时间', false)
      const ref = reference.value.trim()
      body = { deployment_revision: deploymentRevision, expected_quote_revision: expected, currency: cur, tariff_scope: { kind: 'deployment' },
        valid_from: isoInput(validFrom.value, '生效时间'), ...(until ? { valid_until: until } : {}),
        source: { kind: 'manual', ...(ref ? { reference: ref } : {}) }, reason: reason.value.trim(), items }
    } catch (e) { notice.replaceChildren(el('p', 'notice error', e.message)); return }
    save.disabled = true
    try {
      const res = await submit({ api, path: '/platform/deployments/' + enc(card.id) + '/quotes', body, keys, notice, signal,
        onConflict: (e, box) => {
          box.append(el('p', null, '报价发布头或部署修订已变化。表单已保留，请刷新后确认仍要发布。'),
            button('刷新报价头', async () => {
              try {
                const fresh = await refreshHead()
                expected = fresh.head
                deploymentRevision = fresh.deploymentRevision
                drawHead()
                notice.replaceChildren(el('p', 'notice', '已基于报价修订 v' + expected + '、部署修订 v' + deploymentRevision + ' 更新，请核对后再发布。'))
              } catch (err) { notice.replaceChildren(el('p', 'notice error', '刷新失败：' + err.message)) }
            }, 'primary'))
        } })
      if (res) done(res)
    } finally { save.disabled = false }
  }, 'primary')
  sub.foot.replaceChildren(save)
}

export function quotePanel(pane, api, card, signal) {
  pane.setTitle((card.display_name || card.id) + ' / 采购报价')
  pane.body.replaceChildren()
  pane.foot.replaceChildren()
  pane.body.classList.add('child-ledger')
  const base = { head: 0, deploymentRevision: null, applicable: null, latest: null }
  let ledger
  const open = detailPanel(pane.body, () => ledger)
  const path = '/platform/deployments/' + enc(card.id) + '/quotes'
  const absorb = page => Object.assign(base, { head: Number.isSafeInteger(page.head_revision) ? page.head_revision : 0,
    deploymentRevision: Number.isSafeInteger(page.deployment_revision) ? page.deployment_revision : null, applicable: page.applicable ?? null })
  const refreshHead = async () => {
    ledger.refresh() // 换时点前先重置游标：列表回到第一页并开启新一轮 as_of
    const page = await api.get(path, { params: { limit: 1, as_of: new Date().toISOString() }, signal })
    base.head = Number.isSafeInteger(page.head_revision) ? page.head_revision : 0
    base.deploymentRevision = Number.isSafeInteger(page.deployment_revision) ? page.deployment_revision : null
    return { head: base.head, deploymentRevision: base.deploymentRevision }
  }
  const asOf = asOfRound()
  const read = (sub, quoteId, revision, published) => api.get(path + '/' + enc(quoteId) + '/revisions/' + revision, { signal }).then(q => {
    sub.setTitle('报价 v' + q.quote_revision)
    sub.foot.replaceChildren()
    sub.body.replaceChildren()
    if (published) sub.body.append(el('p', 'notice', '已发布采购报价 v' + q.quote_revision + '。报价参与倍率建议须重新试算并发布可签倍率。'))
    renderQuote(sub.body, q)
  })
  ledger = createLedger(pane.body, {
    title: '采购报价', searchable: false, signal, rowKey: 'key', createAction: 'publish_quote', createLabel: '发布新报价',
    emptyText: '尚无已发布报价',
    columns: [
      { title: '版本', render: q => 'v' + q.quote_revision + (base.applicable?.quote_id === q.quote_id && base.applicable?.quote_revision === q.quote_revision ? ' · 当前适用' : '') },
      { key: 'currency', title: '币种' },
      { title: '普通输入', render: q => unitPriceText((q.items ?? []).find(i => i.dimension === 'input'), q.currency) },
      { title: '生效区间', render: q => range(q.valid_from, q.valid_until) },
      { key: 'reason', title: '原因' }
    ],
    fetchPage: async ({ cursor, limit, signal: s }) => {
      const page = await api.get(path, { params: { cursor, limit, as_of: asOf(cursor) }, signal: s })
      absorb(page)
      if (!cursor) base.latest = page.items?.[0] ?? null
      return { ...page, items: (page.items ?? []).map(q => ({ ...q, key: q.quote_id + '@' + q.quote_revision })) }
    },
    onOpen: q => open('报价 v' + q.quote_revision, sub => read(sub, q.quote_id, q.quote_revision)),
    onCreate: () => open('发布新报价', sub => quoteForm(sub, api, card, { ...base }, signal, res => {
      sub.changed()
      ledger.refresh() // 写成功：先重置游标，再以新时点读第一页
      return read(sub, res.quote_id, res.quote_revision, true).catch(e => sub.body.replaceChildren(el('p', 'error-row', e.message)))
    }, refreshHead))
  })
}

function renderFx(host, fx) {
  facts(host, [['版本', fx.base_currency + '→CNY v' + fx.fx_revision],
    ['汇率', '1 ' + fx.base_currency + ' = ¥' + formatRatio(fx.rate_numerator, fx.rate_denominator) + '（' + fx.rate_numerator + '/' + fx.rate_denominator + '）'],
    ['观测时间', fx.observed_at ? formatDateTime(fx.observed_at) : '—'], ['生效区间', range(fx.valid_from, fx.valid_until)],
    ['来源', sourceText(fx.source)], ['原因', fx.reason], ...operator(fx)])
}

function fxForm(sub, api, base, signal, done, refreshHead) {
  const notice = el('div')
  const keys = submissionKeys(idempotencyKey)
  let expected = base.head
  const head = el('p', 'muted')
  const drawHead = () => { head.textContent = base.currency + '→CNY · 基于汇率修订 v' + expected + '（0 表示首次）' }
  drawHead()
  const rate = input('rate')
  rate.placeholder = '如 7.50'
  const ratio = el('small', 'field-hint')
  rate.addEventListener('input', () => {
    try { const r = parseRatio(rate.value); ratio.textContent = '= ' + r.rate_numerator + '/' + r.rate_denominator } catch { ratio.textContent = '' }
  })
  const now = new Date().toISOString()
  const observed = input('observed_at', now)
  const from = input('valid_from', now)
  const until = input('valid_until')
  const reference = input('source_reference')
  const reason = input('reason', '', 'textarea')
  reason.setAttribute('aria-label', '汇率原因')
  const grid = el('div', 'form-grid')
  grid.append(field('1 ' + base.currency + ' 兑人民币', rate, ratio), field('观测时间（UTC）', observed), field('生效时间（UTC）', from),
    field('失效时间（UTC）', until), field('来源说明', reference))
  sub.body.replaceChildren(notice, head, grid, el('h3', null, '登记原因'), reason)
  const save = button('发布汇率', async () => {
    let body
    try {
      if (!reason.value.trim()) throw new Error('请填写登记原因')
      const ref = reference.value.trim()
      body = { base_currency: base.currency, quote_currency: 'CNY', expected_fx_revision: expected, ...parseRatio(rate.value),
        observed_at: isoInput(observed.value, '观测时间'), valid_from: isoInput(from.value, '生效时间'), valid_until: isoInput(until.value, '失效时间'),
        source: { kind: 'manual', ...(ref ? { reference: ref } : {}) }, reason: reason.value.trim() }
    } catch (e) { notice.replaceChildren(el('p', 'notice error', e.message)); return }
    save.disabled = true
    try {
      const res = await submit({ api, path: '/platform/procurement/fx-rates', body, keys, notice, signal,
        onConflict: (e, box) => {
          box.append(el('p', null, base.currency + ' 汇率发布头已变化。表单已保留，请刷新后确认仍要发布。'),
            button('刷新汇率头', async () => {
              try {
                expected = await refreshHead()
                drawHead()
                notice.replaceChildren(el('p', 'notice', '已基于汇率修订 v' + expected + ' 更新，请核对后再发布。'))
              } catch (err) { notice.replaceChildren(el('p', 'notice error', '刷新失败：' + err.message)) }
            }, 'primary'))
        } })
      if (res) done(res)
    } finally { save.disabled = false }
  }, 'primary')
  sub.foot.replaceChildren(save)
}

export function fxRatesPage(host, api, signal) {
  const base = { currency: 'USD', head: 0, applicable: null }
  let ledger
  const open = detailPanel(host, () => ledger)
  const asOf = asOfRound()
  const refreshHead = async () => {
    ledger.refresh() // 换时点前先重置游标
    const page = await api.get('/platform/procurement/fx-rates', { params: { base_currency: base.currency, limit: 1, as_of: new Date().toISOString() }, signal })
    return Number.isSafeInteger(page.head_revision) ? page.head_revision : 0
  }
  const read = (sub, currency, revision, published) => api.get('/platform/procurement/fx-rates/' + enc(currency) + '/CNY/revisions/' + revision, { signal }).then(fx => {
    sub.setTitle(currency + '→CNY v' + fx.fx_revision)
    sub.foot.replaceChildren()
    sub.body.replaceChildren()
    if (published) sub.body.append(el('p', 'notice', '已发布汇率 v' + fx.fx_revision + '。依赖该汇率的可签倍率须重新试算并发布。'))
    renderFx(sub.body, fx)
  })
  ledger = createLedger(host, {
    title: '采购汇率', searchable: false, signal, rowKey: 'key', createAction: 'publish_fx_rate', createLabel: '登记汇率',
    filters: [{ key: 'base_currency', label: '原币（如 USD）', value: 'USD' }], emptyText: '该币种尚无已发布汇率',
    columns: [
      { title: '版本', render: fx => 'v' + fx.fx_revision + (base.applicable?.fx_revision === fx.fx_revision ? ' · 当前适用' : '') },
      { title: '汇率', render: fx => '1 ' + fx.base_currency + ' = ¥' + formatRatio(fx.rate_numerator, fx.rate_denominator) },
      { title: '生效区间', render: fx => range(fx.valid_from, fx.valid_until) },
      { key: 'reason', title: '原因' }
    ],
    fetchPage: async ({ filters, cursor, limit, signal: s }) => {
      const currency = String(filters.base_currency ?? '').trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('请输入三位原币代码，如 USD')
      const page = await api.get('/platform/procurement/fx-rates', { params: { base_currency: currency, cursor, limit, as_of: asOf(cursor) }, signal: s })
      Object.assign(base, { currency, head: Number.isSafeInteger(page.head_revision) ? page.head_revision : 0, applicable: page.applicable ?? null })
      return { ...page, items: (page.items ?? []).map(fx => ({ ...fx, key: fx.base_currency + '@' + fx.fx_revision })) }
    },
    onOpen: fx => open(fx.base_currency + '→CNY v' + fx.fx_revision, sub => read(sub, fx.base_currency, fx.fx_revision)),
    onCreate: () => open('登记 ' + base.currency + ' 汇率', sub => fxForm(sub, api, { ...base }, signal, res => {
      sub.changed()
      ledger.refresh() // 写成功：先重置游标，再以新时点读第一页
      return read(sub, base.currency, res.fx_revision, true).catch(e => sub.body.replaceChildren(el('p', 'error-row', e.message)))
    }, refreshHead))
  })
}

// ——— 可签输入倍率 ———

function channelRows(channels) {
  return (channels ?? []).map(c => {
    const amount = c.amount_micro ?? c.rate_micro ?? null
    const basis = c.quantity_basis ?? c.input_tokens
    const fx = c.currency === 'CNY' ? '1/1' : c.rate_numerator && c.rate_denominator
      ? '¥' + formatRatio(c.rate_numerator, c.rate_denominator) + '/' + c.currency + (c.fx_revision ? ' · v' + c.fx_revision : '') : '—'
    return [c.deployment_id + (c.deployment_revision ? ' v' + c.deployment_revision : ''),
      c.quote_id ? c.quote_id + ' v' + c.quote_revision : '—',
      amount == null ? '未知' : formatMicro(amount, c.currency) + (basis ? ' / ' + Number(basis).toLocaleString('en-US') : ''),
      fx, c.input_cny_micro_per_mtok == null ? '未知' : formatMicro(c.input_cny_micro_per_mtok, 'CNY'),
      c.reason_code ? el('span', 'ineligible', pricingReason(c.reason_code)) : el('span', 'eligible', '有效')]
  })
}
const channelHead = ['部署', '报价', '原币输入价', '汇率', '人民币 / 百万输入', '状态']

function renderRate(host, r) {
  facts(host, [['费率版本', r.source_rate_key], ['状态', r.status === 'available_to_sign' ? '平台可签' : (r.status ?? '平台可签')],
    ['可签输入倍率', formatMultiplier(r.input_multiplier_ppm)],
    ['签约输入价', Number.isSafeInteger(r.input_milli_per_mtok) ? formatMilli(r.input_milli_per_mtok) + ' 块／百万输入 Token' : '—'],
    ['建议倍率', formatMultiplier(r.recommended_input_multiplier_ppm)], ['试算状态', calculationLabel(r.calculation_status)],
    ['计算时刻', r.pricing_at ? formatDateTime(r.pricing_at) : '—'], ['基准', r.input_multiplier_basis === 'cny_1_per_mtok_input' ? '¥1／百万普通输入 Token = 1×' : r.input_multiplier_basis],
    ['手调理由', r.override_reason ?? r.reason], ...operator(r)])
  if (r.channels?.length) host.append(el('h3', null, '计算依据'), table(channelHead, channelRows(r.channels), '倍率依据'))
  host.append(el('p', 'muted', SIGNABLE_NOTE))
}

export function multiplierTab(area, api, model, signal, onChanged) {
  const body = el('div', 'routing-scroll')
  const foot = el('div', 'inline-foot')
  area.append(body, foot)
  let view = 0 // 每次切换概览/回读/表单递增；旧视图的在途响应不得渲染

  function overview() {
    view += 1
    body.replaceChildren()
    foot.replaceChildren()
    const ppm = model.input_multiplier_ppm ?? model.input_pricing?.input_multiplier_ppm ?? null
    const key = model.current_source_rate_key ?? model.input_pricing?.source_rate_key ?? null
    facts(body, [['平台可签输入倍率', formatMultiplier(ppm)], ['费率版本', key ?? '尚无可签版本'], ['模型池', model.current_pool_revision ? 'v' + model.current_pool_revision : '无活动池']])
    body.append(el('p', 'muted', SIGNABLE_NOTE))
    if (key) foot.append(button('查看计算依据', () => readback(key)))
    if (hasAction(model, 'preview_input_multiplier')) foot.append(button('试算倍率', () => form(), 'primary'))
    else body.append(el('p', 'muted', '当前账号没有试算权限'))
  }

  function readback(key, published) {
    const my = ++view
    body.replaceChildren(el('p', 'muted', '正在回读…'))
    foot.replaceChildren(button('返回概览', overview))
    return api.get('/platform/models/' + enc(model.id) + '/input-multiplier/revisions/' + enc(key), { signal }).then(r => {
      if (my !== view) return
      body.replaceChildren()
      if (published) body.append(el('p', 'notice', '已发布平台可签输入倍率 ' + formatMultiplier(r.input_multiplier_ppm) + '（' + r.source_rate_key + '）。'))
      renderRate(body, r)
    }).catch(e => { if (my === view && e?.name !== 'AbortError') body.replaceChildren(el('p', 'error-row', e.message)) })
  }

  function form() {
    const my = ++view
    const alive = () => my === view && !signal?.aborted
    let expectedPool = model.current_pool_revision ?? 0
    let expectedKey = model.current_source_rate_key ?? model.input_pricing?.source_rate_key ?? null
    let pricingAt = null, preview = null, previewPrint = null, generation = 0, busy = false
    const keys = submissionKeys(idempotencyKey)
    const notice = el('div')
    const basis = el('p', 'muted')
    const drawBasis = () => { basis.textContent = '基于模型池 v' + expectedPool + ' · 当前可签版本 ' + (expectedKey ?? '无') + (pricingAt ? ' · 计算时刻 ' + pricingAt : '') }
    drawBasis()
    const manual = input('manual_multiplier')
    manual.placeholder = '留空采用建议'
    const reason = input('reason', '', 'textarea')
    reason.setAttribute('aria-label', '倍率理由')
    const grid = el('div', 'form-grid')
    grid.append(field('最终倍率（×）', manual, el('small', 'field-hint', '最多 3 位小数；缺项、偏离建议或手调为零须填写理由')))
    const result = el('div', 'pool-preview')
    body.replaceChildren(notice, basis, el('h3', null, '试算结果'), result, el('h3', null, '最终倍率'), grid, el('h3', null, '理由'), reason)
    const run = button('重新试算', () => calc(), 'primary')
    const adopt = button('采用建议', () => { manual.value = ''; changed(); calc() })
    const publish = button('发布可签倍率', () => doPublish(), 'primary')
    publish.hidden = true
    adopt.hidden = true
    foot.replaceChildren(button('返回概览', overview), adopt, run, publish)

    // 固定字段顺序的规范请求：预览指纹与发布体用同一构造，避免 pricing_at 插入位置不同导致比较失败。
    function canonical({ pricing_at = pricingAt } = {}) {
      const text = manual.value.trim()
      const req = { expected_pool_revision: expectedPool, expected_source_rate_key: expectedKey }
      if (pricing_at) req.pricing_at = pricing_at
      if (text) req.manual_input_multiplier_ppm = parseMultiplier(text)
      if (reason.value.trim()) req.reason = reason.value.trim()
      return req
    }
    const request = () => canonical()
    function changed() {
      generation += 1
      if (preview) {
        preview = null
        publish.hidden = true
        notice.replaceChildren(el('p', 'notice warn', '最终倍率或理由已修改，需重新试算后才能发布。'))
      }
    }
    manual.addEventListener('input', changed)
    reason.addEventListener('input', changed)

    async function calc() {
      if (busy) return
      let req
      try { req = request() } catch (e) { notice.replaceChildren(el('p', 'notice error', e.message)); return }
      busy = true
      run.disabled = true
      publish.hidden = true
      notice.replaceChildren()
      result.replaceChildren(el('p', 'muted', '正在试算…'))
      const gen = generation
      try {
        const data = await api.post('/platform/models/' + enc(model.id) + '/input-multiplier/preview', req, { signal })
        if (!alive()) return
        if (gen !== generation) { result.replaceChildren(el('p', 'notice warn', '试算期间表单已修改，旧结果已丢弃，请重新试算。')); return }
        pricingAt = data.pricing_at ?? pricingAt
        drawBasis()
        preview = data
        previewPrint = JSON.stringify(canonical({ pricing_at: pricingAt }))
        result.replaceChildren()
        facts(result, [['试算状态', calculationLabel(data.calculation_status)],
          ['建议倍率', data.recommended_input_multiplier_ppm == null ? '无法给出建议' : formatMultiplier(data.recommended_input_multiplier_ppm)],
          ['最终倍率', formatMultiplier(data.input_multiplier_ppm)],
          ['签约输入价', Number.isSafeInteger(data.input_milli_per_mtok) ? formatMilli(data.input_milli_per_mtok) + ' 块／百万输入 Token' : '—']])
        result.append(table(channelHead, channelRows(data.channels), '渠道输入价'))
        adopt.hidden = data.recommended_input_multiplier_ppm == null
        publish.hidden = !(hasAction(data, 'publish_input_multiplier') && data.preview_basis)
        if (publish.hidden) result.append(el('p', 'notice warn', data.calculation_status !== 'complete' || req.manual_input_multiplier_ppm != null
          ? '存在缺项、偏离建议或手调为零时须填写理由后重新试算；仍不可发布时以服务端为准。' : '当前账号没有发布权限。'))
        result.scrollIntoView({ block: 'nearest' })
      } catch (e) {
        if (e?.name === 'AbortError' || !alive()) return
        if (gen !== generation) { result.replaceChildren(el('p', 'notice warn', '试算期间表单已修改，旧结果已丢弃，请重新试算。')); return }
        if (e.code === 'conflict') conflict(e)
        else result.replaceChildren(el('p', 'notice error', errorText(e)))
      } finally { busy = false; run.disabled = false }
    }

    // 冲突：保留手调值和理由，按 409 详情的 current_pool_revision/current_source_rate_key 刷新期望头，
    // 去掉旧计算时刻后重算（详情缺字段时回读型号）。
    function recomputeButton(e) {
      return button('按最新数据重新计算', async () => {
        const d = e.detail ?? {}
        if (Object.hasOwn(d, 'current_pool_revision') || Object.hasOwn(d, 'current_source_rate_key')) {
          if (Number.isSafeInteger(d.current_pool_revision)) model.current_pool_revision = d.current_pool_revision
          if (Object.hasOwn(d, 'current_source_rate_key')) model.current_source_rate_key = d.current_source_rate_key
        } else {
          try { Object.assign(model, await api.get('/platform/models/' + enc(model.id), { signal })) } catch {}
        }
        if (!alive()) return
        expectedPool = model.current_pool_revision ?? expectedPool
        expectedKey = model.current_source_rate_key ?? null
        pricingAt = null
        drawBasis()
        calc()
      }, 'primary')
    }
    function conflict(e) {
      preview = null
      publish.hidden = true
      const box = el('div', 'notice error')
      box.append(el('p', null, pricingConflict(e.detail?.reason)), recomputeButton(e))
      result.replaceChildren(box)
      box.scrollIntoView({ block: 'nearest' })
    }

    async function doPublish() {
      if (busy || !preview) return
      let req
      try { req = canonical({ pricing_at: pricingAt }) } catch { changed(); return }
      if (JSON.stringify(req) !== previewPrint) { changed(); return }
      busy = true
      publish.disabled = run.disabled = true
      try {
        const res = await submit({ api, path: '/platform/models/' + enc(model.id) + '/input-multiplier/revisions',
          body: { ...req, preview_basis: preview.preview_basis }, keys, notice: result, signal,
          onConflict: (e, box) => {
            preview = null
            publish.hidden = true
            box.append(recomputeButton(e))
          } })
        if (res) {
          Object.assign(model, { current_source_rate_key: res.source_rate_key, input_multiplier_ppm: res.input_multiplier_ppm })
          onChanged()
          if (alive()) readback(res.source_rate_key, true)
        }
      } finally { busy = false; publish.disabled = run.disabled = false }
    }
    calc()
  }
  overview()
}
