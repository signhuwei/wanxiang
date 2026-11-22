// 签发售价表（contracts/routing-projection.md「管理端」）：平台拟签、平台已签、户主历史三种只读视图。
import { el } from './panel.js'
import { planRateSummary, salesRateHead, salesRateRow } from './routing-format.js'

// 平台签发里 billing.plan 选择区的方案目录：按目录 id（cmp_…）找到方案版本，显示所含型号、倍率和 source_rate_key。
// 只读既有 /platform/commerce/plans；准备新费率沿用商业计费页的 publish 动作。
export function planDirectory(api, signal) {
  let loading = null
  const plans = new Map()
  let canPublish = false
  return {
    load() {
      loading ??= readPages(api, '/platform/commerce/plans', signal).then(({ items, actions }) => {
        for (const plan of items) plans.set(plan.id, plan)
        canPublish = actions.includes('publish')
      }).catch(e => { loading = null; throw e })
      return loading
    },
    // catalogField 的 detail 接口：异步读目录后填写说明，读失败时注明，不影响选择。
    detail(definition) {
      if (definition?.schema?.catalog !== 'commerce_plans') return null
      const self = this
      return {
        describe(ids, node) {
          const text = () => ids.map(id => plans.has(id) ? planRateSummary(plans.get(id)) : '方案 ' + id + ' 不在目录中').join('；')
          node.textContent = ids.length ? '读取方案费率…' : ''
          if (!ids.length) return
          self.load().then(() => { node.textContent = '所含型号：' + text() },
            e => { if (!signal?.aborted) node.textContent = '方案费率读取失败：' + e.message })
        },
        footer() {
          const node = el('p', 'muted')
          self.load().then(() => {
            if (!canPublish) return
            const link = el('a', null, '在商业计费发布引用新费率的方案')
            link.href = '#/platform/commerce'
            node.append('需要新费率时，', link, '，再回到此处选择。')
          }, () => {})
          return node
        }
      }
    }
  }
}
async function readPages(api, endpoint, signal) {
  const items = []
  let cursor, actions = []
  do {
    const page = await api.get(endpoint, { params: { cursor, limit: 200 }, signal })
    items.push(...page.items)
    actions = page.actions ?? actions
    cursor = page.next_cursor
  } while (cursor)
  return { items, actions }
}

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
