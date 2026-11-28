import { createLedger } from './ledger.js'
import { button, detailPanel, editForm, el } from './panel.js'
import { formatDateTime, formatMilli } from './format.js'
import { eraserMilli } from './contract-controls.js'
import { createPager } from './pager.js'
import { hasAction, inputField } from './policy-controls.js'

const path = '/platform/model-test-quotas'
const states = { running: '实测中', succeeded: '通过', failed: '失败', pending_reconciliation: '待核对' }
const cost = value => value == null ? '—' : formatMilli(value)

function historyTable(rows) {
  const wrap = el('div', 'routing-table')
  const table = el('table')
  table.setAttribute('aria-label', '管理员模型实测流水')
  const head = el('thead'), titles = el('tr'), body = el('tbody')
  titles.append(...['时间', '渠道原始型号', '状态', '输入 / 输出 Token', '已扣（粒）', '预留（粒）'].map(name => el('th', null, name)))
  head.append(titles)
  for (const record of rows) {
    const tr = el('tr')
    const model = el('td', null, record.raw_model)
    model.title = record.provider_id
    const usage = record.usage
    const tokens = usage ? (usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens) + ' / ' + usage.output_tokens : '—'
    const held = record.status === 'running' || record.status === 'pending_reconciliation'
    const status = record.reconciliation ? '已核对费用' : states[record.status] ?? record.status
    tr.append(el('td', null, formatDateTime(record.created_at)), model, el('td', null, status),
      el('td', null, tokens), el('td', 'num', cost(record.charged_milli)),
      el('td', 'num', held ? cost(record.reserved_milli) : '—'))
    body.append(tr)
  }
  table.append(head, body)
  wrap.append(table)
  return wrap
}

function quotaDetail(pane, api, row, signal) {
  const entry = path + '/' + encodeURIComponent(row.user_id)
  const lifetime = AbortSignal.any([pane.signal, signal])
  let history, period = row.period

  function showHistory(message = '') {
    history?.abort()
    history = new AbortController()
    const active = AbortSignal.any([lifetime, history.signal])
    pane.setTitle(row.name + ' / 测试额度与流水')
    pane.headActions.replaceChildren()
    if (hasAction(row, 'allocate')) pane.headActions.append(button('分配测试额度', showForm))
    pane.foot.replaceChildren()
    const summary = el('p', 'muted', row.period + ' · 额度 ' + cost(row.limit_milli) + ' 粒 · 可用 ' + cost(row.available_milli) +
      ' 粒 · 已扣 ' + cost(row.spent_milli) + ' 粒 · 预留 ' + cost(row.reserved_milli) + ' 粒')
    const notice = el('p', 'notice', message)
    notice.setAttribute('role', 'status')
    const selected = el('input')
    selected.type = 'month'
    selected.value = period
    selected.max = row.period
    const entries = el('div')
    const paging = el('div', 'card-pager')
    const prev = button('上一页流水', () => { if (pager.prev()) load() })
    const next = button('下一页流水', () => { if (pager.next()) load() })
    paging.append(prev, next)
    pane.body.replaceChildren(notice, summary, inputField('流水月份', selected), entries, paging)
    let pager = createPager(), request

    selected.addEventListener('change', () => {
      if (!selected.value) selected.value = row.period
      period = selected.value
      pager = createPager()
      load()
    })

    async function load() {
      request?.abort()
      request = new AbortController()
      const requestSignal = AbortSignal.any([active, request.signal])
      prev.disabled = next.disabled = true
      entries.replaceChildren(el('p', 'muted', '正在读取实测流水…'))
      try {
        const data = await api.get(entry + '/tests', { params: { period, cursor: pager.cursor(), limit: 20 }, signal: requestSignal })
        if (requestSignal.aborted) return
        pager.applyResult(data.next_cursor)
        entries.replaceChildren(data.items.length ? historyTable(data.items) : el('p', 'muted', '该月暂无实测流水'))
        prev.disabled = !pager.canPrev()
        next.disabled = !pager.canNext()
      } catch (error) {
        if (!requestSignal.aborted) entries.replaceChildren(el('p', 'error-row', error.message))
      }
    }
    load()
  }

  function showForm() {
    history?.abort()
    pane.setTitle(row.name + ' / ' + row.period + ' 测试额度')
    pane.headActions.replaceChildren(button('返回实测流水', () => showHistory()))
    editForm(pane, {
      mode: 'edit', label: '保存测试额度',
      values: { limit: formatMilli(row.limit_milli), reason: '' },
      fields: [
        { key: 'limit', label: '当月测试额度（粒）', hint: '填当月总额度，可精确到 0.001 粒。' },
        { key: 'reason', label: '分配原因' }
      ],
      submit(values, options) {
        const reason = values.reason?.trim()
        if (!reason) throw new Error('请填写分配原因')
        return api.post(entry, { expected_revision: row.revision, limit_milli: eraserMilli(values.limit, '测试额度'), reason },
          { ...options, signal: lifetime })
      },
      done(updated) {
        if (lifetime.aborted) return
        row = { ...row, ...updated }
        showHistory('已保存当月测试额度。')
      }
    })
  }

  showHistory()
}

export function modelTestQuotaPage(host, api, signal) {
  let table
  const open = detailPanel(host, () => table)
  table = createLedger(host, {
    title: '管理员测试额度', searchLabel: '查询平台管理员', signal, rowKey: 'user_id',
    columns: [
      { key: 'name', title: '平台管理员' }, { key: 'period', title: '月份' },
      { title: '额度（粒）', render: row => formatMilli(row.limit_milli) },
      { title: '可用（粒）', render: row => formatMilli(row.available_milli) },
      { title: '已扣（粒）', render: row => formatMilli(row.spent_milli) },
      { title: '预留（粒）', render: row => formatMilli(row.reserved_milli) }
    ],
    fetchPage: opts => api.get(path, { params: { q: opts.q, cursor: opts.cursor, limit: opts.limit }, signal: opts.signal }),
    onOpen: row => open(row.name + ' / ' + row.period, pane => quotaDetail(pane, api, row, signal))
  })
}
