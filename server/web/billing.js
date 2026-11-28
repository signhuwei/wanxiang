import { createLedger } from './ledger.js'
import { detailPanel, el } from './panel.js'
import { formatMilli, formatDateTime, parseEraserMilli } from './format.js'

export function topupMilli(value) {
  const n = parseEraserMilli(value)
  if (n === null || n <= 0) throw new Error('请输入大于 0 的粒数，精确到 0.001 粒')
  return n
}
export const kinds = {subscription_grant:'月度橡皮包',topup:'充值',reserve:'预留',settle:'结算',release:'释放',adjust:'调整',overage_pending:'超租约差额待核对'}

function discountDetail(pane, data) {
  const facts = el('dl', 'policy-facts')
  for (const [label, value] of [
    ['原扣款', formatMilli(data.gross_milli) + ' 粒'], ['折后扣款', formatMilli(data.net_milli) + ' 粒'],
    ['折扣总额', formatMilli(data.discount_milli) + ' 粒'], ['返还永久余额', formatMilli(data.cash_credit_milli ?? data.discount_milli) + ' 粒'],
    ['到期月包抵免', formatMilli(data.expired_package_credit_milli ?? 0) + ' 粒'], ['结算时间', formatDateTime(data.closed_at)]
  ]) {
    const row = el('div')
    row.append(el('dt', null, label), el('dd', null, value))
    facts.append(row)
  }
  const breakdown = el('table')
  const head = breakdown.createTHead().insertRow()
  for (const heading of ['签发版本', '结算比例', '原扣款（粒）', '折后扣款（粒）', '返还（粒）']) head.append(el('th', null, heading))
  const rows = breakdown.createTBody()
  for (const bucket of data.buckets) {
    const row = rows.insertRow()
    for (const value of ['v' + bucket.platform_revision, bucket.ratio_ppm / 10000 + '%',
      formatMilli(bucket.gross_milli), formatMilli(bucket.net_milli), formatMilli(bucket.discount_milli)]) row.append(el('td', null, value))
  }
  pane.body.replaceChildren(facts, breakdown)
}

export function billingPage(host, api, signal) {
  const summary = el('section','balance-summary'), table = el('div','page')
  host.classList.add('page'); host.append(summary,table)
  async function refresh() {
    try {
      const balance = await api.get('/balance', { signal })
      summary.replaceChildren(...[['balance_milli','可用余额'],['reserved_milli','已预留'],['month_used_milli','本月消耗']].map(([k,label]) => {
        const tile = el('div'); tile.append(el('small',null,label+'（粒）'),el('strong','num',balance[k] == null ? '—' : formatMilli(balance[k]))); return tile
      }))
    } catch(e) { if (!signal?.aborted) summary.replaceChildren(el('span','error-row',e.message)) }
  }
  let ledger
  const drill = detailPanel(table, () => ledger)
  ledger = createLedger(table,{title:'橡皮流水', signal, openAction:'read_discount',
    columns:[{key:'at',title:'时间',render:i=>formatDateTime(i.at)},{key:'kind',title:'类型',render:i=>
      i.kind==='adjust'&&i.request_ref?.startsWith('policy-discount:')?'月结折扣返还':kinds[i.kind]||i.kind},
      {key:'amount_milli',title:'金额（粒）',render:i=>formatMilli(i.amount_milli)}, {key:'by',title:'操作人'}, {key:'request_ref',title:'业务参考'}],
    fetchPage:({q,cursor,limit,signal})=>api.get('/ledger',{params:{q,cursor,limit},signal}),
    onOpen: row => drill(row.discount_month + ' 月结折扣', async pane => {
      pane.body.append(el('p', 'muted', '正在读取月结…'))
      discountDetail(pane, await api.get('/policy/discounts/' + encodeURIComponent(row.discount_month), { signal }))
    })
  })
  refresh()
}
