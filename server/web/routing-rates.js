// 签发售价表（contracts/routing-projection.md「管理端」）：平台拟签、平台已签、户主历史三种只读视图。
import { el } from './panel.js'
import { salesRateHead, salesRateRow } from './routing-format.js'

export function salesRateTable(rates, { title, label, tenant = false, frozen = true, empty }) {
  const node = el('section', 'sales-rates')
  node.append(el('h3', null, title))
  if (!Array.isArray(rates) || !rates.length) {
    node.append(el('p', 'empty', empty))
    return node
  }
  node.append(el('p', 'muted', '输入倍率以 1× = 1 块／百万输入 Token 为基准；四项单位为块／百万 Token。'))
  const wrap = el('div', 'routing-table')
  const table = el('table')
  table.setAttribute('aria-label', label)
  const head = el('tr')
  for (const text of salesRateHead({ tenant, frozen })) head.append(el('th', null, text))
  const thead = el('thead'), tbody = el('tbody')
  thead.append(head)
  for (const rate of rates) {
    const tr = el('tr')
    for (const cell of salesRateRow(rate, { tenant, frozen })) tr.append(el('td', null, cell))
    tbody.append(tr)
  }
  table.append(thead, tbody)
  wrap.append(table)
  node.append(wrap)
  return node
}
