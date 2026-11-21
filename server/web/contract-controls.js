import { button, el } from './panel.js'
import { agentLabel, formatMilli, parseEraserMilli } from './format.js'
import { idempotencyKey } from './idempotency.js'

export const visibilityFields = [
  ['admin', 'summary', '管理员查看摘要'],
  ['admin', 'content', '管理员查看正文'],
  ['group_admin', 'summary', '组管查看摘要'],
  ['group_admin', 'content', '组管查看正文']
]

export async function readPages(api, endpoint, signal) {
  const items = []
  let cursor
  do {
    const page = await api.get(endpoint, { params: { cursor, limit: 200 }, signal })
    items.push(...page.items)
    cursor = page.next_cursor
  } while (cursor)
  return items
}

export function hasAction(object, action) {
  return object?.actions?.includes(action)
}

export function eraserMilli(value, label) {
  const parsed = parseEraserMilli(value)
  if (parsed === null) throw new Error(label + '须为不小于 0 的块数，精确到 0.001 块')
  return parsed
}

const yesNo = value => value ? '允许' : '关闭'
const itemList = (value, format = item => item) => value.length ? value.map(format).join('、') : '无'
const summaryRows = [
  ['签约席位', data => data.seat_limit, '平台签发'],
  ['Agent', data => data.allowed_agents, null, value => itemList(value, agentLabel)],
  ['模型', data => data.allowed_models, null, itemList],
  ['租约时长（分钟）', data => data.lease_minutes],
  ['租约额度（块）', data => data.lease_budget_milli, null, formatMilli],
  ['固定发行', data => data.agent_release_ids, null, itemList],
  ['组及成员配额', data => data.quota_distribution, '平台签发', yesNo],
  ...visibilityFields.map(([role, field, label]) => [label, data => data.visibility?.[role]?.[field], null, yesNo])
]

export function comparison(columns, { showPins = true } = {}) {
  const scroll = el('div', 'contract-comparison')
  const table = el('table')
  const head = el('thead')
  const header = el('tr')
  for (const title of ['条款', ...columns.map(column => column.title)]) {
    const cell = el('th', null, title)
    cell.scope = 'col'
    header.append(cell)
  }
  head.append(header)
  const rows = el('tbody')
  for (const [label, lookup, fixed, format = String] of summaryRows) {
    if (!showPins && label === '固定发行') continue
    const row = el('tr')
    const cell = el('th', null, label)
    cell.scope = 'row'
    row.append(cell)
    for (const column of columns) {
      const value = column.values && lookup(column.values)
      let display = value === null || value === undefined ? '—' : format(value)
      if (column.configuration) {
        if (fixed) display = fixed
        else if (value == null) display = label === '固定发行' ? '跟随发行目录' : '继承平台'
      }
      row.append(el('td', null, display))
    }
    rows.append(row)
  }
  table.append(head, rows)
  scroll.append(table)
  return scroll
}

export function seatsSummary(seats) {
  if (!seats) return null
  const info = el('div', 'kv')
  for (const [label, key] of [['签约席位', 'limit'], ['已占用', 'active'], ['可用', 'available'], ['超额', 'over_limit']]) {
    if (seats[key] === undefined) continue
    const item = el('div')
    item.append(el('span', null, label), el('strong', null, seats[key]))
    info.append(item)
  }
  return info
}

export function previewPublisher({ body, foot, editor, preview, publish, onCancel, onPublished, reload, renderPreview }) {
  const notice = el('p', 'notice')
  notice.setAttribute('role', 'status')
  const result = el('section')
  body.append(notice, editor.node, result)
  let accepted, key, pending = false
  const showNotice = (text, error = false) => {
    notice.textContent = text
    notice.className = error ? 'notice error' : 'notice'
  }
  function invalidate() {
    accepted = undefined
    key = undefined
    submit.disabled = true
    result.replaceChildren()
  }
  function onError(error) {
    if (error.status === 409) {
      invalidate()
      if (reload) {
        const refresh = button('读取最新修订', async () => {
          refresh.disabled = true
          try {
            await reload(editor.collect())
          } catch (failure) {
            showNotice(writeError(failure), true)
            refresh.disabled = false
          }
        })
        result.append(refresh)
      }
    }
    showNotice(writeError(error), true)
  }
  const check = button('预览变更', async () => {
    try {
      const payload = editor.collect()
      const signature = JSON.stringify(payload)
      invalidate()
      check.disabled = true
      pending = true
      const data = await preview(payload)
      if (signature !== JSON.stringify(editor.collect())) return
      accepted = signature
      key = idempotencyKey()
      result.append(el('h3', null, '发布预览'))
      const seats = seatsSummary(data.seats)
      if (seats) result.append(seats)
      if (data.revoked?.length) result.append(el('p', 'notice warn', '此次发布将收回 ' + data.revoked.length + ' 个对象的超界配置。'))
      result.append(renderPreview ? renderPreview(data) : comparison([
        { title: '当前生效', values: data.previous_effective }, { title: '发布后生效', values: data.effective }
      ]))
      showNotice('')
      submit.disabled = false
    } catch (error) {
      onError(error)
    } finally {
      pending = false
      check.disabled = false
    }
  })
  const submit = button('发布', async () => {
    if (pending) return
    try {
      const payload = editor.collect()
      if (JSON.stringify(payload) !== accepted) {
        invalidate()
        showNotice('配置已修改，请重新预览。', true)
        return
      }
      submit.disabled = check.disabled = true
      pending = true
      const saved = await publish(payload, key)
      onPublished(saved)
    } catch (error) {
      if (error.status !== 409 && accepted) submit.disabled = false
      onError(error)
    } finally {
      pending = false
      check.disabled = false
    }
  }, 'primary')
  submit.disabled = true
  editor.node.addEventListener('input', invalidate)
  editor.node.addEventListener('change', invalidate)
  const cancel = button('取消', () => { if (!pending) onCancel() }, 'link')
  foot.replaceChildren(cancel, check, submit)
}

function writeError(error) {
  if (error.status === 409) return '合约修订已变更，请读取最新修订后再调整。'
  const fields = Array.isArray(error.detail?.fields) ? error.detail.fields : Object.keys(error.detail?.fields ?? {})
  const clauses = Array.isArray(error.detail?.clauses) ? error.detail.clauses.map(item => {
    const ref = item.clause_ref
    return ref.id + ' v' + ref.version + '：' + item.code
  }) : []
  const details = [...fields, ...clauses]
  return details.length ? error.message + '（' + details.join('、') + '）' : error.message
}
