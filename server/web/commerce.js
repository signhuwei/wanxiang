import { createLedger } from './ledger.js'
import { button, detailPanel, editForm, el } from './panel.js'
import { renderForm } from './form.js'
import { eraserMilli, readPages } from './contract-controls.js'
import { formatDateTime, formatMilli } from './format.js'
import { idempotencyKey } from './idempotency.js'

const base = '/platform/commerce'
const prices = ['input', 'output', 'cache_read', 'cache_write']
const labels = ['输入', '输出', '缓存读', '缓存写']
const tierNames = { floor: '兜底', standard: '标准', pro: '专业', advanced: '高级', top: '顶级' }
const blocks = (value) => formatMilli(value) + ' 块'
const select = (key, label, options) => ({ key, label, type: 'select', options, allowEmpty: false })
const amount = (key, label) => ({ key, label, placeholder: '0.000' })
const ratio = { key: 'ratio', label: '折扣系数（0 至 1）', placeholder: '0.90' }

function decimal(value, places, label) {
  const raw = String(value ?? '')
  if (!new RegExp('^\\d+(?:\\.\\d{1,' + places + '})?$').test(raw)) throw new Error(label + '最多支持 ' + places + ' 位小数')
  const [whole, part = ''] = raw.split('.')
  const n = Number(whole + part.padEnd(places, '0'))
  if (!Number.isSafeInteger(n)) throw new Error(label + '超出数值范围')
  return n
}
function coefficient(value) {
  const n = decimal(value, 6, '折扣系数')
  if (n > 1000000) throw new Error('折扣系数须介于 0 和 1 之间')
  return n
}
function repeated(host, title, fields, initial) {
  const outer = el('fieldset', 'contract-choices'), list = el('div')
  outer.append(el('legend', null, title), list)
  const forms = new Map()
  function add(value = {}) {
    const row = el('div', 'section'), body = el('div')
    const form = renderForm(body, { sections: [{ fields }], values: value, mode: 'edit' })
    row.append(body, button('移除', () => { forms.delete(row); row.remove() }, 'link'))
    list.append(row)
    forms.set(row, form)
  }
  initial.forEach(add)
  outer.append(button('添加' + title, () => add(), 'link'))
  host.append(outer)
  return () => [...forms.values()].map(f => f.collect())
}
function saver(pane, label, submit) {
  let key = idempotencyKey(), previous
  const notice = el('p', 'notice')
  const save = button(label, async () => {
    save.disabled = true
    try {
      const { body, send } = submit()
      const signature = JSON.stringify(body)
      if (signature !== previous) key = idempotencyKey()
      previous = signature
      await send(body, key)
      pane.changed()
      pane.close()
    } catch (e) { notice.className = 'notice error'; notice.textContent = e.message; save.disabled = false }
  }, 'primary')
  pane.body.append(notice)
  pane.foot.append(save)
}
async function planEditor(pane, api, signal, plan) {
  const [models, tools] = await Promise.all([readPages(api, '/platform/models', signal), readPages(api, '/platform/tool-releases', signal)])
  const options = models.map(r => ({ value: r.id, label: r.display_name + ' · ' + r.id }))
  const m = select('model_id', '模型', options)
  const t = plan?.terms ?? {}
  const section = el('div')
  pane.body.append(section)
  const form = renderForm(section, { mode: 'edit', sections: [{ fields: [
    { key: 'name', label: '方案名称' },
    ...(plan ? [select('publication', '发布到', [{ value: 'version', label: '原方案的新版本' }, { value: 'copy', label: '独立方案（可单独签发给租户）' }])] : []),
    amount('grant', '每月发放（块）'), amount('fee', '月费（元）'),
    amount('commitment', '承诺额度（块）'), { ...ratio, key: 'commit_ratio', label: '承诺额度内折扣系数' },
  ] }], values: { name: plan?.name, publication: 'version', grant: formatMilli(t.monthly_grant_milli ?? 0), fee: (t.monthly_fee_fen ?? 0) / 100,
    commitment: t.commitment ? formatMilli(t.commitment.up_to_milli) : '', commit_ratio: t.commitment ? t.commitment.ratio_ppm / 1000000 : '' } })
  const levels = repeated(pane.body, '阶梯', [amount('from', '起始用量（块）'), ratio],
    (t.tiers ?? []).map(r => ({ from: formatMilli(r.from_milli), ratio: r.ratio_ppm / 1000000 })))
  const rates = repeated(pane.body, '模型协议价', [m, ...prices.map((key, i) => amount(key, labels[i] + '（块 / 百万 Token）'))],
    (t.model_prices ?? []).map(r => ({ model_id: r.model_id, ...Object.fromEntries(prices.map(k => [k, formatMilli(r[k + '_milli_per_mtok'])])) })))
  const budgets = repeated(pane.body, '单模型月预算', [m, amount('monthly', '每月额度（块）')],
    (t.model_budgets ?? []).map(r => ({ model_id: r.model_id, monthly: formatMilli(r.monthly_milli) })))
  const fees = repeated(pane.body, '工具调用费', [
    select('release_id', 'MCP 发行', tools.filter(r => r.kind === 'mcp' && r.status === 'published')
      .map(r => ({ value: r.id, label: r.name + ' · ' + r.version + ' · ' + r.os + '/' + r.arch }))), amount('price', '每次费用（块）'),
  ], (t.tool_prices ?? []).map(r => ({ release_id: r.release_id, price: formatMilli(r.per_call_milli) })))
  saver(pane, '发布方案', () => {
    const f = form.collect()
    if (!!f.commitment !== !!f.commit_ratio && (f.commitment != null || f.commit_ratio != null)) throw new Error('承诺额度及其系数须同时填写')
    const terms = { monthly_grant_milli: eraserMilli(f.grant, '月包'), monthly_fee_fen: decimal(f.fee, 2, '月费'),
      commitment: f.commitment == null ? null : { up_to_milli: eraserMilli(f.commitment, '承诺额度'), ratio_ppm: coefficient(f.commit_ratio) },
      tiers: levels().map(r => ({ from_milli: eraserMilli(r.from, '阶梯起点'), ratio_ppm: coefficient(r.ratio) })),
      model_prices: rates().map(r => ({ model_id: r.model_id, ...Object.fromEntries(prices.map(k => [k + '_milli_per_mtok', eraserMilli(r[k], '模型费率')])) })),
      model_budgets: budgets().map(r => ({ model_id: r.model_id, monthly_milli: eraserMilli(r.monthly, '模型预算') })),
      tool_prices: fees().map(r => ({ release_id: r.release_id, per_call_milli: eraserMilli(r.price, '调用费') })) }
    const update = plan && f.publication === 'version'
    return { body: { ...(update && { plan_id: plan.plan_id }), expected_version: update ? plan.version : 0, name: f.name, terms },
      send: (b, key) => api.post(base + '/plans', b, { signal, idempotencyKey: key }) }
  })
}
async function tierEditor(pane, api, signal) {
  const [cfg, models] = await Promise.all([api.get(base + '/model-tiers', { signal }), readPages(api, '/platform/models', signal)])
  const options = models.map(m => ({ value: m.id, label: m.display_name + ' · ' + m.id }))
  const root = el('div')
  pane.body.append(root)
  const form = renderForm(root, { mode: 'edit', values: cfg, sections: [{ fields: [select('floor_model_id', '倍率基准模型', options)] }] })
  const list = repeated(pane.body, '模型档位', [select('model_id', '模型', options),
    select('tier', '档位', Object.entries(tierNames).map(([value, label]) => ({ value, label })))], cfg.models)
  table(pane.body, '当前输出倍率', ['模型', '档位', '倍率'], cfg.models.map(r => [r.model_id, tierNames[r.tier], r.display_multiplier == null ? '暂无费率' : r.display_multiplier + '×']))
  saver(pane, '保存档位', () => ({ body: { expected_revision: cfg.revision, ...form.collect(), models: list() },
    send: (body, key) => api.put(base + '/model-tiers', body, { signal, idempotencyKey: key }) }))
}
export function commercePage(host, api, signal) {
  let list
  const open = detailPanel(host, () => list)
  list = createLedger(host, { title: '商业计费方案', signal, createLabel: '发布方案', createAction: 'publish',
    onCreate: () => open('发布计费方案', p => planEditor(p, api, signal, null)),
    onOpen: r => open(r.name + ' · v' + r.version, p => planEditor(p, api, signal, r)),
    columns: [{ key: 'name', title: '方案' }, { key: 'version', title: '版本' }, { title: '每月发放', render: r => blocks(r.terms.monthly_grant_milli) },
      { title: '月费', render: r => (r.terms.monthly_fee_fen / 100).toFixed(2) + ' 元' }, { title: '发布时间', render: r => formatDateTime(r.created_at) }],
    fetchPage: ({ q, limit, cursor, signal }) => api.get(base + '/plans', { params: { q, limit, cursor }, signal }) })
  host.querySelector('.toolbar')?.append(button('模型档位', () => open('模型价格档位', p => tierEditor(p, api, signal))))
}
function table(host, title, headers, rows) {
  host.append(el('h3', null, title))
  if (!rows.length) { host.append(el('p', 'muted', '暂无记录')); return }
  const t = el('table'), head = el('tr'), body = el('tbody')
  for (const label of headers) head.append(el('th', null, label))
  const thead = el('thead'); thead.append(head)
  for (const row of rows) { const tr = el('tr'); for (const v of row) tr.append(el('td', null, v)); body.append(tr) }
  t.append(thead, body); host.append(t)
}
export async function commerceAccountPanel(pane, api, tenantId, signal) {
  const host = pane.body ?? pane
  const r = await api.get(tenantId ? base + '/tenants/' + encodeURIComponent(tenantId) : '/commerce/account', { signal })
  host.replaceChildren()
  const fields = ['计费方案', '当前月份', '月包可用', '永久余额可用', '已预留', '本月已扣月包', '本月已扣永久余额']
  const values = [r.plan ? r.plan.name + ' v' + r.plan.version : '按平台基础费率', r.month, blocks(r.package_available_milli), blocks(r.permanent_available_milli), blocks(r.reserved_milli),
    blocks(r.monthly_sources.package_used_milli), blocks(r.monthly_sources.permanent_used_milli)]
  editForm({ body: host, foot: el('div') }, { mode: 'view', fields: fields.map((label, i) => ({ label, key: String(i) })), values })
  table(host, '月包记录', ['月份', '发放额度', '已用', '预留', '到期未用', '月费'], r.packages.map(v => [v.month, blocks(v.grant_milli), blocks(v.used_milli), blocks(v.reserved_milli), blocks(v.expired_milli), (v.fee_fen / 100).toFixed(2) + ' 元']))
  table(host, '模型月预算', ['模型', '预算', '已用', '预留'], r.model_budgets.map(v => [v.model_id, blocks(v.monthly_milli), blocks(v.used), blocks(v.reserved)]))
  table(host, '模型档位', ['模型', '档位', '输出倍率'], r.tiers.models.map(v => [v.model_id, tierNames[v.tier], v.display_multiplier == null ? '暂无费率' : v.display_multiplier + '×']))
  const statuses = { charged: '已扣费', awaiting_result: '等待结果', failed: '调用失败', pending_funds: '待补足余额' }
  table(host, '工具调用记录', ['发行', '调用编号', '费用', '状态', '时间'], r.tool_calls.map(v => [v.release_id, v.native_id, blocks(v.fee_milli), statuses[v.status], formatDateTime(v.called_at)]))
}
export function commerceAccountPage(host, api, signal) { return commerceAccountPanel(host, api, null, signal) }
