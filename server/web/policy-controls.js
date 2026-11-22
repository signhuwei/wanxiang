import { button, el } from './panel.js'
import { formatMilli, parseEraserMilli } from './format.js'
import { createPager } from './pager.js'

export const platformPolicy = '/platform/policy'
export const tenantPolicy = '/policy'
export const refKey = ref => ref.id + '@' + ref.version
export const refText = ref => ref ? ref.id + ' v' + ref.version : '—'
export const hasAction = (data, action) => data?.actions?.includes(action) === true
export const encode = encodeURIComponent
export const scopeLabel = { tenant: '租户', platform: '平台', group: '分组', member: '成员' }
export const fetchPolicyPage = (api, endpoint, fixed = {}) =>
  ({ q, filters, cursor, limit, signal }) => api.get(endpoint, { params: { ...fixed, ...filters, q, cursor, limit }, signal })

export function optionSelect(options, value) {
  const input = el('select')
  for (const [key, label] of options) {
    const option = el('option', null, label)
    option.value = key
    input.append(option)
  }
  input.value = value ?? ''
  return input
}

export function inputField(label, control, wide = false) {
  const row = el('label', 'field' + (wide ? ' wide' : ''))
  control.setAttribute('aria-label', label)
  row.append(el('span', null, label), control)
  return row
}

function asScaledInteger(raw, scale) {
  const parts = /^(\d+)(?:\.(\d+))?$/.exec(raw)
  if (!parts || (parts[2]?.replace(/0+$/, '').length ?? 0) > scale) return null
  const value = Number(parts[1] + (parts[2] ?? '').slice(0, scale).padEnd(scale, '0'))
  return Number.isSafeInteger(value) ? value : null
}

function formatRatio(value) {
  const digits = String(value).padStart(7, '0')
  const fraction = digits.slice(-6).replace(/0+$/, '')
  return digits.slice(0, -6) + (fraction ? '.' + fraction : '')
}

export function schemaOptions(schema) {
  return (schema.options ?? []).map(option => [String(option.id), option.label])
}

export function parsePolicyValue(definition, raw) {
  const schema = definition.schema
  const invalid = () => { throw new Error(definition.title + '的值不符合类型或范围') }
  let value
  switch (schema.kind) {
    case 'boolean':
      if (raw !== 'true' && raw !== 'false') return invalid()
      return raw === 'true'
    case 'enum':
      if (!schemaOptions(schema).some(([key]) => key === raw)) return invalid()
      return raw
    case 'text':
      if (raw.length > (schema.max_length ?? Infinity)) return invalid()
      return raw
    case 'integer':
      value = /^-?\d+$/.test(raw) ? Number(raw) : null
      break
    case 'money_milli':
      value = parseEraserMilli(raw)
      break
    case 'ratio_ppm':
      value = asScaledInteger(raw, 6)
      break
    default: return invalid()
  }
  if (!Number.isSafeInteger(value) || value < (schema.min ?? -Infinity) || value > (schema.max ?? Infinity)) return invalid()
  return value
}

export function policyValue(definition, value, display) {
  if (value == null) return '—'
  const schema = definition.schema
  switch (schema.kind) {
    case 'boolean': return value ? '开启' : '关闭'
    case 'money_milli': return formatMilli(value) + ' 块'
    case 'ratio_ppm': return formatRatio(value) + ' 倍'
    case 'resource_set':
      return value.length ? value.map(id => display?.[id] ?? id).join('、') : '无'
    case 'enum': return schemaOptions(schema).find(([id]) => id === value)?.[1] ?? String(value)
    default: return String(value)
  }
}

// detail（可选）：{ describe(ids, node) } 为已选与候选项附加只读说明，不改变提交值。
function catalogField(api, prefix, definition, original, display, signal, detail) {
  const { catalog } = definition.schema
  const selected = new Set(original ?? [])
  const labels = new Map(Object.entries(display ?? {}))
  const details = el('details', 'policy-picker')
  details.append(el('summary', null, '选择' + definition.title))
  const saved = el('div', 'actions policy-picked')
  const status = el('p', 'muted')
  const search = el('input')
  search.type = 'search'
  search.placeholder = '搜索选项'
  search.setAttribute('aria-label', '搜索' + definition.title)
  const choices = el('div', 'policy-choice-list')
  const pager = createPager()
  let entered = ''
  let request = 0
  let rows = []
  function draw() {
    saved.replaceChildren()
    if (!selected.size) saved.append(el('span', 'muted', '当前未选'))
    for (const id of selected) {
      const remove = button('移除 ' + (labels.get(id) ?? id), () => choose(id, false), 'link')
      saved.append(remove)
    }
    choices.replaceChildren(...rows.map(row => {
      const label = el('label', 'contract-choice')
      const checkbox = el('input')
      checkbox.type = 'checkbox'
      checkbox.checked = selected.has(row.id)
      checkbox.addEventListener('change', event => {
        event.stopPropagation()
        choose(row.id, checkbox.checked)
      })
      label.append(checkbox, el('span', null, row.label))
      if (detail) {
        const note = el('small', 'muted policy-catalog-detail')
        detail.describe([row.id], note)
        label.append(note)
      }
      return label
    }))
    if (detail) detail.describe([...selected], pickedDetail)
  }
  const pickedDetail = el('p', 'muted policy-catalog-detail')
  function choose(id, enabled) {
    if (enabled && catalog==='commerce_plans') selected.clear()
    if (enabled) selected.add(id)
    else selected.delete(id)
    draw()
    details.dispatchEvent(new Event('change', { bubbles: true }))
  }
  function query() {
    entered = search.value.trim()
    pager.reset()
    void load()
  }
  const previous = button('上一页', () => { if (pager.prev()) void load() })
  const next = button('下一页', () => { if (pager.next()) void load() })
  previous.disabled = next.disabled = true
  const lookup = prefix + '/catalog/' + encode(catalog)
  async function load() {
    const current = ++request
    status.textContent = '读取中…'
    previous.disabled = next.disabled = true
    try {
      const page = await api.get(lookup, { signal, params: { q: entered, cursor: pager.cursor(), limit: 20 } })
      if (signal?.aborted || current !== request) return
      rows = page.items
      for (const option of rows) labels.set(option.id, option.label)
      pager.applyResult(page.next_cursor)
      status.textContent = rows.length ? '' : '暂无可选项'
      draw()
    } catch (error) {
      if (!signal?.aborted && current === request) status.textContent = error.message
    } finally {
      if (current === request) {
        previous.disabled = !pager.canPrev()
        next.disabled = !pager.canNext()
      }
    }
  }
  details.addEventListener('toggle', () => { if (details.open && !request) void load() })
  search.addEventListener('keydown', event => { if (event.key === 'Enter') query() })
  details.append(saved, ...(detail ? [pickedDetail] : []), search, button('查询', query), status, choices, previous, next)
  draw()
  const missing = [...selected].filter(id => !labels.has(id))
  if (missing.length) {
    // Keep fixed historical IDs visible even if they are no longer selectable.
    void Promise.allSettled(Array.from({ length: Math.ceil(missing.length / 20) }, (_, index) =>
      api.get(lookup, { signal, params: { ids: missing.slice(index * 20, (index + 1) * 20).join(',') } })))
      .then(results => {
        if (signal?.aborted) return
        for (const result of results) if (result.status === 'fulfilled') {
          for (const option of result.value.items) labels.set(option.id, option.label)
        }
        draw()
      })
  }
  return { node: details, collect: () => [...selected] }
}

export function valueField(api, prefix, definition, value, { display, signal, detail } = {}) {
  const { schema } = definition
  if (schema.kind === 'resource_set') return catalogField(api, prefix, definition, value, display, signal, detail)
  const initial = value == null ? '' :
    schema.kind === 'money_milli' ? formatMilli(value) :
    schema.kind === 'ratio_ppm' ? formatRatio(value) : String(value)
  let input
  if (schema.kind === 'boolean' || schema.kind === 'enum') {
    const options = schema.kind === 'boolean' ? [['true', '开启'], ['false', '关闭']] : schemaOptions(schema)
    input = optionSelect([['', '选择值'], ...options], initial)
  } else {
    input = el(schema.kind === 'text' ? 'textarea' : 'input')
    if (['integer', 'money_milli', 'ratio_ppm'].includes(schema.kind)) {
      input.inputMode = schema.kind === 'integer' ? 'numeric' : 'decimal'
    }
    input.value = initial
  }
  const unit = schema.kind === 'money_milli' ? '（块）' : schema.kind === 'ratio_ppm' ? '（倍）' : ''
  return { node: inputField(definition.title + unit, input, true), collect: () => parsePolicyValue(definition, input.value.trim()) }
}

export function previewEntries(data, field) {
  const before = new Map((data.previous_entries ?? []).map(row => [refKey(row.clause_ref), row]))
  const after = new Map((data.entries ?? []).map(row => [refKey(row.clause_ref), row]))
  const table = el('table')
  const row = (...values) => {
    const tr = el('tr')
    tr.append(...values)
    return tr
  }
  const head = el('thead'), rows = el('tbody')
  head.append(row(...['条目', '当前生效', '拟生效'].map(text => el('th', null, text))))
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key), proposed = after.get(key)
    const value = item => item ? policyValue(item.definition, item[field], item.display) : '—'
    rows.append(row(el('th', null, (proposed ?? old).definition.title), el('td', null, value(old)), el('td', null, value(proposed))))
  }
  table.append(head, rows)
  const scroll = el('div', 'policy-preview')
  scroll.append(table)
  return scroll
}

export function mountTabs(host, tabs, signal) {
  const nav = el('nav', 'policy-tabs')
  const panel = el('div', 'policy-tab-content')
  host.append(nav, panel)
  let active, controller
  signal?.addEventListener('abort', () => controller?.abort(), { once: true })
  const controls = tabs.map(([id, title]) => {
    const control = button(title, () => select(id))
    nav.append(control)
    return [id, control]
  })
  function select(id) {
    if (id === active || signal?.aborted) return
    controller?.abort()
    controller = new AbortController()
    active = id
    for (const [key, control] of controls) {
      if (key === id) control.setAttribute('aria-current', 'page')
      else control.removeAttribute('aria-current')
    }
    const content = el('div', 'policy-tab-content')
    panel.replaceChildren(content)
    tabs.find(([key]) => key === id)[2](content, controller.signal)
  }
  select(tabs[0][0])
  return { select }
}
