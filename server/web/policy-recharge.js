import { createLedger } from './ledger.js'
import { el, detailPanel, editForm, button } from './panel.js'
import { formatDateTime, formatMilli } from './format.js'
import { topupMilli } from './billing.js'
import { encode, fetchPolicyPage } from './policy-controls.js'

const amount = value => Number.isSafeInteger(value) ? formatMilli(value) + ' 块' : '—'
const revision = value => value ? 'v' + value : '未签发'

function fields(body, values) {
  const list = el('dl', 'policy-facts')
  for (const [label, value] of values) {
    const row = el('div')
    row.append(el('dt', null, label), el('dd', null, value ?? '—'))
    list.append(row)
  }
  body.append(list)
}

function receipt(pane, row) {
  pane.setTitle('充值凭证 · ' + row.ledger_id)
  pane.body.replaceChildren()
  pane.foot.replaceChildren()
  fields(pane.body, [
    ['流水号', row.ledger_id], ['充值橡皮', amount(row.amount_milli)], ['到账时间', formatDateTime(row.at)],
    ['到账前可用余额', amount(row.balance_before_milli)], ['到账后可用余额', amount(row.balance_after_milli)],
    ['关联签发', revision(row.platform_revision)], ['备注', row.note || '—'], ['经办人', row.by]
  ])
}

export function rechargePage(host, { api, endpoint, tenantName, balance, getBalance, onChange, account, signal, openRecord }) {
  host.classList.add('policy-recharges')
  const summary = el('section', 'balance-summary')
  const list = el('div')
  host.append(summary, list)
  function drawBalance(value) {
    if (!value) return
    const nodes = [['可用余额', 'balance_milli'], ['已预留', 'reserved_milli'], ['本月消耗', 'month_used_milli']].map(([label, key]) => {
      const tile = el('div')
      tile.append(el('small', null, label), el('strong', 'num', amount(value[key])))
      return tile
    })
    summary.replaceChildren(...nodes)
  }
  async function refreshBalance() {
    if (!getBalance) return
    try {
      const data = await getBalance()
      if (!signal?.aborted) drawBalance(data)
    } catch (error) {
      if (!signal?.aborted) summary.replaceChildren(el('p', 'error-row', error.message))
    }
  }
  drawBalance(balance)
  if (!balance) void refreshBalance()
  let ledger
  const drill = openRecord ? (title, draw) => openRecord(title, draw, ledger) : detailPanel(list, () => ledger)
  if(account) host.insertBefore(button('查看商业计费',()=>drill('商业计费',account),'policy-commercial-account'),list)
  ledger = createLedger(list, {
    title: '充值记录', searchLabel: '流水号或备注', signal, rowKey: 'ledger_id', createAction: 'topup', createLabel: '充值',
    columns: [
      { title: '流水号', render: row => row.actions?.includes('read') ? el('button', 'link policy-row-link', row.ledger_id) : row.ledger_id },
      { title: '到账时间', render: row => formatDateTime(row.at) },
      { title: '充值橡皮', render: row => amount(row.amount_milli) },
      { title: '到账后可用余额', render: row => amount(row.balance_after_milli) },
      { key: 'by', title: '经办人' },
      { title: '关联签发', render: row => revision(row.platform_revision) }
    ],
    fetchPage: fetchPolicyPage(api, endpoint),
    onOpen: row => drill('充值凭证', async pane => {
      pane.body.append(el('p', 'muted', '正在读取凭证…'))
      receipt(pane, await api.get(endpoint + '/' + encode(row.ledger_id), { signal }))
    }),
    onCreate: () => drill('充值 · ' + tenantName, pane => {
      editForm(pane, {
        mode: 'create', label: '确认充值',
        fields: [
          { key: 'amount', label: '充值橡皮（块）', placeholder: '如 2.075' },
          { key: 'note', label: '备注', type: 'textarea', wide: true }
        ],
        submit: (value, options) => api.post(endpoint, {
          amount_milli: topupMilli(value.amount), ...(value.note?.trim() && { note: value.note.trim() })
        }, { ...options, signal }),
        done: data => {
          receipt(pane, data)
          ledger.setSelected(data.ledger_id)
          ledger.refresh()
          onChange?.()
          void refreshBalance()
        }
      })
    })
  })
  return () => {
    ledger.refresh()
    void refreshBalance()
  }
}
