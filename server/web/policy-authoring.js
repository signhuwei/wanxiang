import { createLedger } from './ledger.js'
import { button, detailPanel, el } from './panel.js'
import { idempotencyKey } from './idempotency.js'
import { encode, fetchPolicyPage, hasAction, inputField, optionSelect, policyValue, refKey, refText, schemaOptions, scopeLabel, valueField, parsePolicyValue } from './policy-controls.js'

function textInput(value, multiline = false) {
  const input = el(multiline ? 'textarea' : 'input')
  input.value = value ?? ''
  return input
}

function readInput(input, name) {
  const value = input.value.trim()
  if (!value) throw new Error('请填写' + name)
  return value
}

export function versionPicker(title, api, endpoint, onPick, { signal, params, accept = () => true } = {}) {
  const wrapper = el('details', 'policy-picker')
  wrapper.append(el('summary', null, title))
  wrapper.addEventListener('toggle', () => {
    if (!wrapper.open || wrapper.children.length > 1) return
    const host = el('div', 'policy-picker-ledger')
    wrapper.append(host)
    const fetchPage = fetchPolicyPage(api, endpoint, params)
    createLedger(host, {
      title, rowKey: 'key', signal, pageSize: 10,
      columns: [{ title: '名称', render: row => row.title || row.name || row.id }, { title: '版本', render: row => 'v' + row.version }],
      fetchPage: async args => {
        const page = await fetchPage(args)
        return { ...page, items: page.items.map(row => ({ ...row, key: refKey(row), actions: accept(row) ? row.actions : [] })) }
      },
      onOpen: row => {
        wrapper.open = false
        onPick(row)
      }
    })
  })
  return wrapper
}

export async function loadVersion(api, endpoint, ref, signal) {
  return api.get(endpoint + '/' + encode(ref.id) + '/' + encode(ref.version), { signal })
}

function changed(node) {
  node.dispatchEvent(new Event('change', { bubbles: true }))
}

export function versionEntries(api, prefix, initial, {
  signal, definitionsEndpoint = prefix + '/definitions', definitions, allowTemplates = false, signed = false, catalogDetail
} = {}) {
  const node = el('div', 'policy-entries')
  const entries = el('div', 'policy-entry-list')
  const status = el('p', 'notice')
  status.setAttribute('role', 'status')
  const rows = new Map()

  function insert(entry) {
    const { clause_ref: ref, definition } = entry
    if (rows.has(ref.id)) {
      status.textContent = '「' + definition.title + '」已加入，可先移除现有条目。'
      return false
    }
    let draftValue = signed ? (entry.adjustment ?? entry.base_value ?? definition.default_value) : entry.value
    const row = el('section', 'policy-entry')
    const head = el('div', 'policy-entry-head')
    head.append(el('strong', null, definition.title), el('small', 'muted', refText(ref)))
    const source = el('p', 'muted', signed && entry.template_ref ? '引用模板 ' + refText(entry.template_ref) : definition.description)
    const editor = el('div')
    const mode = signed ? optionSelect([['inherit', '继承引用基准'], ['adjust', '单独调整']],
      Object.hasOwn(entry, 'adjustment') ? 'adjust' : 'inherit') : null
    const baseValue = entry.base_value ?? definition.default_value
    const baseline = signed ? el('small', 'muted', '基准 ' + policyValue(definition, baseValue, entry.display)) : null
    // 目录条目（如 billing.plan）可附加只读说明，便于辨认所选资源的内容。
    const detail = catalogDetail?.(definition)
    const baseDetail = detail && signed ? el('small', 'muted policy-catalog-detail') : null
    if (baseDetail) detail.describe(baseValue, baseDetail)
    let field
    function refresh() {
      if (mode?.value === 'inherit') {
        editor.replaceChildren()
        field = null
        if (baseDetail) baseDetail.hidden = false
      } else {
        field = valueField(api, prefix, definition, draftValue, { display: entry.display, signal, detail })
        editor.replaceChildren(field.node)
        if (baseDetail) baseDetail.hidden = true
      }
    }
    mode?.addEventListener('change', () => {
      try { if (field) draftValue = field.collect() } catch { /* 未完成的输入仍可选择继承 */ }
      refresh()
    })
    row.append(head)
    if (source.textContent) row.append(source)
    if (mode) row.append(inputField('调节方式', mode), baseline)
    if (baseDetail) row.append(baseDetail)
    if (detail?.footer) row.append(detail.footer())
    row.append(editor, button('移除', () => {
      rows.delete(ref.id)
      row.remove()
      changed(node)
    }, 'link'))
    refresh()
    rows.set(ref.id, { collect() {
      const base = { clause_ref: { id: ref.id, version: ref.version } }
      if (!signed) return { ...base, value: field.collect() }
      return { ...base, template_ref: entry.template_ref ?? null, ...(field ? { adjustment: field.collect() } : {}) }
    } })
    entries.append(row)
    return true
  }
  for (const entry of initial) insert(entry)
  async function fromLibrary(row) {
    try {
      const definition = await loadVersion(api, definitionsEndpoint, row, signal)
      if (signal?.aborted) return
      const clause_ref = { id: definition.id, version: definition.version }
      if (insert({ clause_ref, definition, base_value: definition.default_value, value: definition.default_value })) changed(node)
    } catch (error) {
      if (!signal?.aborted) status.textContent = error.message
    }
  }

  if (definitions) {
    const select = optionSelect([['', '选择可用条目'], ...definitions.map(row => [refKey(row.clause_ref), row.definition.title])])
    node.append(inputField('可用条目', select), button('添加条目', () => {
      const item = definitions.find(row => refKey(row.clause_ref) === select.value)
      if (item && insert({ ...item, value: item.effective_value })) changed(node)
    }))
  } else node.append(versionPicker('从条目库添加', api, definitionsEndpoint, fromLibrary, { signal }))

  if (allowTemplates) node.append(versionPicker('添加模板条目', api, prefix + '/templates', async row => {
    try {
      const template = await loadVersion(api, prefix + '/templates', row, signal)
      if (signal?.aborted) return
      let added = false
      for (const item of template.entries) {
        const entry = { ...item, template_ref: { id: template.id, version: template.version }, base_value: item.value }
        if (insert(entry)) added = true
      }
      if (added) changed(node)
    } catch (error) {
      if (!signal?.aborted) status.textContent = error.message
    }
  }, { signal }))
  node.append(status, entries)
  return { node, collect: () => Array.from(rows.values(), row => row.collect()) }
}

export function policyVersionView(body, data, template) {
  body.replaceChildren()
  const title = template ? data.name : data.title
  body.append(el('p', 'muted', title + ' · ' + refText(data)))
  if (data.description) body.append(el('p', null, data.description))
  const facts = el('dl', 'policy-facts')
  function fact(name, value) {
    const row = el('div')
    row.append(el('dt', null, name), el('dd', null, value))
    facts.append(row)
  }
  if (!template) {
    fact('类型', schemaLabels[data.schema.kind] ?? data.schema.kind)
    fact('分类', data.category)
    fact('上级约束', mergeLabels[data.merge] ?? data.merge)
    fact('作用域', (data.scopes ?? []).map(scope => scopeLabel[scope] ?? scope).join('、'))
    fact('默认值', policyValue(data, data.default_value))
    if (data.binding) fact('执行适配器', data.binding.adapter + ' · ABI ' + data.binding.abi)
  } else {
    fact('配置作用域', scopeLabel[data.scope] ?? data.scope)
    for (const row of data.entries) {
      fact(row.definition.title + ' · ' + refText(row.clause_ref), policyValue(row.definition, row.value, row.display))
    }
  }
  body.append(facts)
}

const schemaLabels = {
  boolean: '开关', integer: '整数', money_milli: '橡皮金额', ratio_ppm: '倍率', enum: '枚举', resource_set: '目录集合', text: '说明文字'
}
const mergeLabels = { fixed: '固定', min: '取更低上限', max: '取更高下限', intersection: '允许范围取交集', and: '开关逐级收窄' }

function definitionEditor(record, adapterRows, api, prefix, signal) {
  const node = el('div', 'policy-editor')
  const id = textInput(record?.id)
  id.disabled = Boolean(record)
  const title = textInput(record?.title)
  const description = textInput(record?.description, true)
  const category = textInput(record?.category)
  const schemaKind = optionSelect(Object.entries(schemaLabels), record?.schema.kind ?? 'text')
  const merge = optionSelect(Object.entries(mergeLabels), record?.merge ?? 'fixed')
  schemaKind.disabled = merge.disabled = true
  const scopeInputs = Object.keys(scopeLabel).filter(scope => scope !== 'platform').map(scope => {
    const checkbox = el('input')
    checkbox.type = 'checkbox'
    checkbox.checked = record ? record.scopes.includes(scope) : scope === 'tenant'
    return [scope, checkbox]
  })
  const scopes = el('fieldset', 'contract-choices')
  scopes.append(el('legend', null, '开放配置作用域'))
  for (const [scope, checkbox] of scopeInputs) {
    const label = el('label', 'contract-choice')
    label.append(checkbox, el('span', null, scopeLabel[scope]))
    scopes.append(label)
  }
  const adapter = optionSelect([['', '说明条目（无执行动作）'], ...adapterRows.map(row => [
    row.id, row.id + ' · ' + (schemaLabels[row.kind] ?? row.kind) + ' · ABI ' + row.abi
  ])], record?.binding?.adapter ?? '')
  const binding = () => adapterRows.find(row => row.id === adapter.value)
  const scopeFields = el('div', 'policy-entry-list')
  let schemaControls, initialValue
  function drawSchema() {
    const kind = schemaKind.value
    const metadata = binding()
    const stored = kind === record?.schema.kind && record?.binding?.adapter === metadata?.id ? record.schema : metadata ?? {}
    const min = textInput(stored.min)
    const max = textInput(stored.max)
    const options = textInput(schemaOptions(stored).map(([key, label]) => key + ' | ' + label).join('\n'), true)
    const catalog = textInput(stored.catalog)
    catalog.disabled = true
    const schemaFields = []
    if (['integer', 'money_milli', 'ratio_ppm'].includes(kind)) schemaFields.push(
      inputField('存储单位下限（选填）', min), inputField('存储单位上限（选填）', max))
    if (kind === 'resource_set') schemaFields.push(inputField('目录标识', catalog))
    if (kind === 'enum') {
      options.placeholder = '每行一个选项，格式：标识 | 名称'
      schemaFields.push(inputField('枚举选项', options))
    }
    const defaultInput = textInput(kind === record?.schema.kind ?
      kind === 'resource_set' ? record.default_value.join(',') : policyValue(record, record.default_value).replace(/ (粒|倍)$/, '') : '')
    if (kind === 'boolean') {
      const select = optionSelect([['false', '关闭'], ['true', '开启']], record?.schema.kind === kind ? String(record.default_value) : 'false')
      schemaFields.push(inputField('默认值', select))
      initialValue = () => select.value === 'true'
    } else if (kind === 'resource_set') {
      const field = valueField(api, prefix, { title: '默认值', schema: { kind, catalog: catalog.value } },
        kind === record?.schema.kind ? record.default_value : [], { signal })
      schemaFields.push(field.node)
      initialValue = () => field.collect()
    } else {
      if (kind === 'enum' && record?.schema.kind === kind) defaultInput.value = record.default_value
      schemaFields.push(inputField('默认值', defaultInput))
      initialValue = schema => parsePolicyValue({ title: title.value, schema }, defaultInput.value.trim())
    }
    schemaControls = { kind, min, max, options, catalog }
    scopeFields.replaceChildren(...schemaFields)
  }
  function chooseBinding(initial) {
    const row = binding()
    schemaKind.value = row?.kind ?? 'text'
    merge.value = row?.merge ?? 'fixed'
    const supported = row?.scopes ?? ['tenant']
    for (const [scope, checkbox] of scopeInputs) {
      checkbox.disabled = !supported.includes(scope)
      if (checkbox.disabled) checkbox.checked = false
      else if (!initial) checkbox.checked = true
    }
    drawSchema()
  }
  adapter.addEventListener('change', () => chooseBinding(false))
  chooseBinding(true)
  node.append(inputField('稳定标识', id), inputField('名称', title), inputField('分类', category),
    inputField('说明', description), inputField('执行适配器', adapter), inputField('数据类型', schemaKind),
    inputField('上级约束', merge), scopes, scopeFields)

  function integerBound(input, label) {
    if (input.value.trim() === '') return undefined
    const parsed = Number(input.value)
    if (!/^-?\d+$/.test(input.value.trim()) || !Number.isSafeInteger(parsed)) throw new Error(label + '必须是安全整数')
    return parsed
  }
  return { node, collect() {
    const { kind, min, max, options, catalog } = schemaControls
    const schema = { kind }
    if (['integer', 'money_milli', 'ratio_ppm'].includes(kind)) {
      const lower = integerBound(min, '下限'), upper = integerBound(max, '上限')
      if (lower !== undefined) schema.min = lower
      if (upper !== undefined) schema.max = upper
      if (lower > upper) throw new Error('下限不能大于上限')
    }
    if (kind === 'resource_set') schema.catalog = readInput(catalog, '目录标识')
    if (kind === 'enum') {
      schema.options = readInput(options, '枚举选项').split('\n').filter(line => line.trim()).map(line => {
        const [value, label] = line.split('|').map(part => part.trim())
        if (!label || !value) throw new Error('枚举选项格式为：标识 | 名称')
        return { id: value, label }
      })
    }
    const metadata = binding()
    return {
      id: readInput(id, '稳定标识'), expected_version: record?.version ?? 0,
      title: readInput(title, '名称'), description: description.value.trim(), category: readInput(category, '分类'),
      schema, merge: merge.value, scopes: scopeInputs.filter(([, input]) => input.checked).map(([scope]) => scope),
      default_value: initialValue(schema), binding: metadata ? { adapter: metadata.id, abi: metadata.abi } : null
    }
  } }
}

function templateEditor(record, api, prefix, { signal, scopes, definitions }) {
  const node = el('div', 'policy-editor')
  const id = textInput(record?.id)
  id.disabled = Boolean(record)
  const name = textInput(record?.name)
  const desc = textInput(record?.description, true)
  const scope = optionSelect(scopes.map(value => [value, scopeLabel[value]]), record?.scope ?? scopes[0])
  scope.disabled = Boolean(record || scopes.length < 2)
  const versions = () => definitions?.filter(item => item.definition.scopes.includes(scope.value) && item.definition.merge !== 'fixed')
  let entries = versionEntries(api, prefix, record?.entries ?? [], { signal, definitions: versions() })
  scope.addEventListener('change', () => {
    const next = versionEntries(api, prefix, [], { signal, definitions: versions() })
    entries.node.replaceWith(next.node)
    entries = next
  })
  node.append(inputField('稳定标识', id), inputField('名称', name), inputField('作用域', scope), inputField('说明', desc), entries.node)
  return { node, collect: () => ({
    id: readInput(id, '稳定标识'), expected_version: record?.version ?? 0,
    name: readInput(name, '名称'), description: desc.value.trim(), scope: scope.value, entries: entries.collect()
  }) }
}

export function policyVersionsPage(host, api, prefix, {
  signal, resource = 'templates', title, scopes = ['platform'], loadDefinitions
} = {}) {
  const template = resource !== 'definitions'
  const endpoint = prefix + '/' + resource
  let ledger
  const drill = detailPanel(host, () => ledger)
  function open(row) {
    drill(row ? row.name || row.title : '新增' + title, async pane => {
      const record = row ? await loadVersion(api, endpoint, row, signal) : undefined
      if (signal?.aborted) return
      function draw() {
        policyVersionView(pane.body, record, template)
        pane.headActions.replaceChildren()
        pane.foot.replaceChildren()
        if (hasAction(record, 'publish')) pane.headActions.append(button('发布新版本', edit, 'primary'))
      }
      async function edit() {
        pane.body.replaceChildren(el('p', 'muted', '正在准备表单…'))
        pane.headActions.replaceChildren()
        try {
          const [definitions, adapters] = await Promise.all([
            loadDefinitions?.(), template ? null : api.get(prefix + '/adapters', { signal })
          ])
          if (signal?.aborted) return
          const editor = template ? templateEditor(record, api, prefix, { signal, scopes, definitions }) : definitionEditor(record, adapters.items, api, prefix, signal)
          const notice = el('p', 'notice')
          notice.setAttribute('role', 'alert')
          pane.body.replaceChildren(editor.node, notice)
          let key, previous
          const cancel = button('取消', () => record ? draw() : pane.close(), 'link')
          const publish = button('发布版本', async () => {
            try {
              const payload = editor.collect()
              const body = JSON.stringify(payload)
              if (body !== previous) key = idempotencyKey()
              previous = body
              publish.disabled = cancel.disabled = true
              const saved = await api.post(endpoint, payload, { signal, idempotencyKey: key })
              if (signal?.aborted) return
              pane.changed()
              pane.setTitle(saved.title || saved.name || payload.title || payload.name)
              policyVersionView(pane.body, saved, template)
              pane.foot.replaceChildren()
              pane.headActions.replaceChildren(button('返回台账', pane.close, 'link'))
            } catch (error) {
              if (!signal?.aborted) notice.textContent = error.status === 409 ? '已有更新版本，请返回台账重新选择最新版本。' : error.message
            } finally {
              publish.disabled = cancel.disabled = false
            }
          }, 'primary')
          pane.foot.replaceChildren(cancel, publish)
        } catch (error) {
          if (!signal?.aborted) pane.body.replaceChildren(el('p', 'error-row', error.message), button('重试', edit))
        }
      }
      if (record) draw()
      else await edit()
    })
  }
  ledger = createLedger(host, {
    title, signal, rowKey: 'key', createAction: 'create', createLabel: '新增',
    columns: [
      { title: '名称', render: row => row.actions?.includes('read') ? el('button', 'link policy-row-link', row.name || row.title) : row.name || row.title },
      { key: 'id', title: '标识' }, { key: 'version', title: '版本' },
      { title: template ? '作用域' : '分类', render: row => template ? scopeLabel[row.scope] ?? row.scope : row.category }
    ],
    fetchPage: async args => {
      const page = await fetchPolicyPage(api, endpoint)(args)
      return { ...page, items: page.items.map(row => ({ ...row, key: refKey(row) })) }
    },
    onOpen: open, onCreate: () => open()
  })
}
