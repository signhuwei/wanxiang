import { button, editForm, el } from './panel.js'
import { createPager } from './pager.js'
import { formatDateTime } from './format.js'
import { hasAction, inputField, optionSelect } from './policy-controls.js'
import { formatMicro, parseMicro } from './routing-format.js'

const recordTypes = {
  recharge: { path: 'recharges', action: 'recharge', label: '渠道充值', entryLabel: '登记渠道充值' },
  balance_observation: { path: 'observations', action: 'record_balance', label: '余额核对', entryLabel: '核对渠道余额' },
  expense: { path: 'expenses', action: 'record_expense', label: '采购扣费', entryLabel: '登记渠道扣费' }
}

function amount(input, field, allowZero) {
  const parsed = parseMicro(input, field)
  const value = Number(parsed)
  if (parsed === null || !Number.isSafeInteger(value) || (!allowZero && value === 0)) {
    throw new Error(field + (allowZero ? '须在可登记范围内' : '须为正数且在可登记范围内'))
  }
  return value
}

function table(head, rows) {
  const wrap = el('div', 'routing-table')
  const table = el('table')
  table.setAttribute('aria-label', '渠道资金流水')
  const thead = el('thead'), titles = el('tr'), tbody = el('tbody')
  titles.append(...head.map(name => el('th', null, name)))
  thead.append(titles)
  for (const values of rows) {
    const row = el('tr')
    row.append(...values.map(value => el('td', null, value ?? '—')))
    tbody.append(row)
  }
  table.append(thead, tbody)
  wrap.append(table)
  return wrap
}

function editMovement(pane, api, path, account, kind, signal, back, done) {
  const spec = recordTypes[kind]
  const observation = kind === 'balance_observation'
  const field = observation ? '核对余额' : kind === 'recharge' ? '充值金额' : '扣费金额'
  pane.setTitle(account.label + ' / ' + spec.entryLabel)
  pane.foot.replaceChildren()
  editForm(pane, {
    mode: 'create', label: '保存登记', values: { account: account.label, currency: account.currency ?? 'CNY' },
    fields: [
      { key: 'account', label: '渠道账户', readonly: true },
      { key: 'currency', label: '币种', readonly: Boolean(account.currency), hint: '使用三位原币代码' },
      { key: 'amount', label: field, hint: '按原币输入，最多 6 位小数' },
      { key: 'reference', label: '账单或交易凭证' },
      { key: 'note', label: '备注', type: 'textarea', wide: true }
    ],
    submit(values, options) {
      const currency = String(values.currency ?? '').trim().toUpperCase()
      const reference = String(values.reference ?? '').trim()
      const note = String(values.note ?? '').trim()
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('请填写三位币种代码')
      if (!reference) throw new Error('请填写账单或交易凭证')
      if (!note) throw new Error('请填写备注')
      const payload = { account_id: account.account_id, currency, reference, note }
      payload[observation ? 'balance_micro' : 'amount_micro'] = amount(values.amount, field, observation)
      return api.post(path + '/' + spec.path, payload, { ...options, signal })
    }, done: () => { if (!signal.aborted) done('已保存' + spec.label) }
  })
  pane.foot.prepend(button('取消登记', back))
}

const fundingPath = provider => '/platform/providers/' + encodeURIComponent(provider.id) + '/channel-ledger'

export async function fundingOverview(host, api, provider, signal, open) {
  const section = el('section', 'deployment-section')
  const facts = el('dl', 'policy-facts')
  host.append(section)
  section.append(el('h3', null, '渠道资金'), facts)
  try {
    const data = await api.get(fundingPath(provider), { params: { limit: 1 }, signal })
    if (signal.aborted || !section.isConnected) return
    if (!data.accounts?.length) facts.append(el('p', 'muted', '暂无渠道账户'))
    const wallets = new Set()
    for (const account of data.accounts ?? []) {
      if (wallets.has(account.funding_id)) continue
      wallets.add(account.funding_id)
      const row = el('div')
      const value = key => formatMicro(account[key], account.currency)
      row.append(el('dt', null, account.label), el('dd', null,
        '账面余额 ' + value('balance_micro') + ' · 累计充值 ' + value('credited_micro') + ' · 累计采购扣费 ' + value('spent_micro')))
      facts.append(row)
    }
    if (hasAction(data, 'read')) section.append(button('查看资金流水', open, 'link'))
  } catch (error) {
    if (!signal.aborted && section.isConnected) facts.append(el('p', 'muted', '资金摘要读取失败。' + error.message))
  }
}

export function channelFunding(pane, api, provider, signal, back, initial = {}) {
  const base = fundingPath(provider)
  pane.setTitle(provider.name + ' / 渠道资金')
  pane.headActions.replaceChildren(button('返回渠道', back))
  pane.foot.replaceChildren()
  const notice = el('p', 'notice', initial.message)
  notice.setAttribute('role', 'status')
  const accountsHost = el('div')
  const summary = el('dl', 'policy-facts')
  const rowsHost = el('div')
  const navigation = el('div', 'card-pager')
  const prev = button('上一页流水', () => { if (pager.prev()) load() })
  const next = button('下一页流水', () => { if (pager.next()) load() })
  navigation.append(prev, next)
  pane.body.replaceChildren(notice, accountsHost, summary, el('h3', null, '渠道资金流水'), rowsHost, navigation)
  let pager = createPager(), accountId = initial.accountId, controller

  function select(id) {
    if (id === accountId) return
    accountId = id
    pager = createPager()
    load()
  }

  function draw(data) {
    const accounts = data.accounts ?? []
    const account = accounts.find(row => row.account_id === accountId)
    if (!accountId && accounts.length) { select(accounts[0].account_id); return }
    accountsHost.replaceChildren()
    pane.foot.replaceChildren()
    if (accounts.length) {
      const selector = optionSelect(accounts.map(row => [row.account_id, row.label]), accountId)
      selector.addEventListener('change', () => select(selector.value))
      accountsHost.append(inputField('渠道账户', selector))
    }
    summary.replaceChildren()
    if (account) {
      const money = key => formatMicro(account[key], account.currency)
      for (const [label, value] of [['账面余额', money('balance_micro')], ['最近核对余额', money('observed_balance_micro')],
        ['余额核对时间', account.observed_at ? formatDateTime(account.observed_at) : '—'],
        ['累计渠道充值', money('credited_micro')], ['累计采购扣费', money('spent_micro')]]) {
        const row = el('div')
        row.append(el('dt', null, label), el('dd', null, value))
        summary.append(row)
      }
      for (const [kind, spec] of Object.entries(recordTypes)) {
        if (!hasAction(data, spec.action) || (account.actions && !hasAction(account, spec.action))) continue
        const resume = message => channelFunding(pane, api, provider, signal, back, { accountId, message })
        pane.foot.append(button(spec.entryLabel, () => editMovement(pane, api, base, account, kind, signal, () => resume(), resume), 'primary'))
      }
    }
    const items = data.items ?? []
    rowsHost.replaceChildren(items.length ? table(['登记时间', '类型', '原币金额', '账户资金范围', '凭证', '备注'], items.map(row => [
      formatDateTime(row.recorded_at), recordTypes[row.kind]?.label ?? row.kind, formatMicro(row.amount_micro, row.currency),
      row.funding_id, row.reference || '—', row.note || '—'
    ])) : el('p', 'muted', accounts.length ? '暂无渠道资金记录' : '该 Provider 暂无渠道账户'))
  }

  async function load() {
    controller?.abort()
    const current = controller = new AbortController()
    const requestSignal = AbortSignal.any([current.signal, signal])
    prev.disabled = next.disabled = true
    rowsHost.replaceChildren(el('p', 'muted', '正在读取渠道资金…'))
    try {
      const data = await api.get(base, { params: { account_id: accountId, cursor: pager.cursor(), limit: 20 }, signal: requestSignal })
      if (requestSignal.aborted || !rowsHost.isConnected) return
      pager.applyResult(data.next_cursor ?? null)
      draw(data)
    } catch (error) {
      if (!requestSignal.aborted && rowsHost.isConnected) {
        rowsHost.replaceChildren(el('p', 'error-row', '渠道资金读取失败。' + error.message), button('重新读取', load))
      }
    } finally {
      if (controller === current) { prev.disabled = !pager.canPrev(); next.disabled = !pager.canNext() }
    }
  }
  load()
}
