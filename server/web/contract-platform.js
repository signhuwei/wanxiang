import { createLedger } from './ledger.js'
import { button, detailPanel, editForm, el } from './panel.js'
import { renderForm } from './form.js'
import { AGENT_OPTIONS, formatDateTime, formatMilli } from './format.js'
import { comparison, eraserMilli, hasAction, previewPublisher, readPages, seatsSummary, visibilityFields } from './contract-controls.js'

const contracts = '/platform/capability-contracts'
const templates = '/platform/contract-templates'
const toggleOptions = [{ value: 'true', label: '允许' }, { value: 'false', label: '关闭' }]
const toggle = (key, label) => ({ key, label, type: 'select', allowEmpty: false, options: toggleOptions })
const valuesKey = (role, field) => role + '_' + field
const entitlementFields = [
  { key: 'seat_limit', label: '签约席位', type: 'number' },
  { key: 'lease_minutes', label: '租约时长（分钟）', type: 'number' },
  { key: 'lease_blocks', label: '租约额度（粒）', placeholder: '如 2.5' },
  toggle('quota_distribution', '组及成员配额'),
  ...visibilityFields.map(([role, field, label]) => toggle(valuesKey(role, field), label))
]

function entitlementValues(entitlements) {
  return {
    seat_limit: entitlements?.seat_limit ?? '',
    lease_minutes: entitlements?.lease_minutes ?? '',
    lease_blocks: entitlements ? formatMilli(entitlements.lease_budget_milli) : '',
    quota_distribution: String(entitlements?.quota_distribution ?? true),
    ...Object.fromEntries(visibilityFields.map(([role, field]) => [
      valuesKey(role, field), String(entitlements?.visibility?.[role]?.[field] ?? field === 'summary')
    ]))
  }
}

function selection(title, items, selected) {
  const node = el('fieldset', 'contract-choices')
  const options = el('div', 'contract-choice-list')
  node.append(el('legend', null, title), options)
  const inputs = items.map(({ value, label }) => {
    const control = el('input')
    control.type = 'checkbox'
    control.value = value
    control.checked = selected?.includes(value) ?? false
    const labelNode = el('label', 'contract-choice')
    labelNode.append(control, el('span', null, label))
    options.append(labelNode)
    return control
  })
  if (!inputs.length) options.append(el('p', 'muted', '平台目录暂无可选项'))
  return { node, collect: () => inputs.filter(input => input.checked).map(input => input.value) }
}

function entitlementEditor(modelOptions, values) {
  const node = el('div', 'contract-editor')
  const fieldsRoot = el('div')
  const form = renderForm(fieldsRoot, {
    sections: [{ fields: entitlementFields }], values: entitlementValues(values), mode: 'edit'
  })
  const agentOptions = AGENT_OPTIONS.concat((values?.allowed_agents ?? [])
    .filter(id => !AGENT_OPTIONS.some(option => option.value === id)).map(id => ({ value: id, label: id })))
  const models = modelOptions.concat((values?.allowed_models ?? [])
    .filter(id => !modelOptions.some(option => option.value === id)).map(id => ({ value: id, label: id + ' · 目录未提供' })))
  const agents = selection('授权 Agent', agentOptions, values?.allowed_agents)
  const modelsSelection = selection('授权模型', models, values?.allowed_models)
  node.append(fieldsRoot, agents.node, modelsSelection.node)
  return {
    node,
    collect() {
      const fields = form.collect()
      if (!Number.isSafeInteger(fields.seat_limit) || fields.seat_limit < 0) throw new Error('签约席位须为不小于 0 的整数')
      if (!Number.isInteger(fields.lease_minutes) || fields.lease_minutes < 1 || fields.lease_minutes > 1440) {
        throw new Error('租约时长须为 1 到 1440 分钟的整数')
      }
      const visibility = {}
      for (const [role, field] of visibilityFields) {
        visibility[role] ??= {}
        visibility[role][field] = fields[valuesKey(role, field)] === 'true'
      }
      return {
        seat_limit: fields.seat_limit, lease_minutes: fields.lease_minutes,
        lease_budget_milli: eraserMilli(fields.lease_blocks, '租约额度'),
        quota_distribution: fields.quota_distribution === 'true',
        allowed_agents: agents.collect(), allowed_models: modelsSelection.collect(), visibility
      }
    }
  }
}

async function modelChoices(api, signal) {
  const models = await readPages(api, '/platform/models', signal)
  return models.map(model => ({ value: model.id, label: model.display_name + ' · ' + model.id + (model.status === 'active' ? '' : '（已停用）') }))
}

const pageFetcher = (api, endpoint) => ({ q, cursor, limit, signal }) => api.get(endpoint, { params: { q, cursor, limit }, signal })

function contractInfo(body, contract, current, comparisonTitle = '平台授权') {
  if (contract) {
    body.append(el('p', 'muted', '第 ' + contract.revision + ' 版 · 模板 ' + contract.template_id + ' v' + contract.template_version +
      ' · 生效时间 ' + formatDateTime(contract.effective_at)), el('p', null, '签发原因 · ' + contract.reason))
  }
  const columns = []
  if (contract) columns.push({ title: comparisonTitle, values: contract.entitlements })
  if (current) columns.push({ title: contract ? '当前生效' : '待核对的现行配置', values: current })
  if (columns.length) body.append(comparison(columns, { showPins: Boolean(current) }))
}

function showHistory(pane, api, endpoint, signal, render) {
  pane.body.replaceChildren()
  const container = el('div')
  pane.body.append(container)
  pane.foot.replaceChildren(button('返回当前合约', render, 'link'))
  let ledger
  const drill = detailPanel(container, () => ledger)
  ledger = createLedger(container, {
    title: '平台合约历史', searchable: false, signal, rowKey: 'key',
    columns: [
      { key: 'revision', title: '修订' },
      { title: '模板', render: row => row.template_id + ' v' + row.template_version },
      { title: '生效时间', render: row => formatDateTime(row.effective_at) },
      { key: 'reason', title: '签发原因' }
    ],
    async fetchPage(args) {
      const page = await pageFetcher(api, endpoint + '/history')(args)
      return { ...page, items: page.items.map(row => ({ ...row, key: String(row.revision) })) }
    },
    onOpen: row => drill('平台合约第 ' + row.revision + ' 版', detail => contractInfo(detail.body, row))
  })
}

function signingEditor(record, versions, models, draft) {
  const node = el('div', 'contract-editor')
  const templateList = el('select')
  const templateLabel = el('label', 'field wide')
  templateLabel.append(el('span', null, '模板版本'), templateList)
  const reason = el('textarea')
  reason.value = draft?.reason ?? ''
  const reasonLabel = el('label', 'field wide')
  reasonLabel.append(el('span', null, '签发原因'), reason)
  const editorRoot = el('div')
  const contract = record.platform_contract
  let editor
  const idOf = row => row.id + '/' + row.version
  const currentId = contract?.template_id + '/' + contract?.template_version
  for (const template of versions) {
    const option = el('option', null, template.name + ' · ' + template.id + ' v' + template.version)
    option.value = idOf(template)
    templateList.append(option)
  }
  const draftId = draft && draft.template_id + '/' + draft.template_version
  const selected = versions.find(template => idOf(template) === (draftId ?? currentId)) ?? versions[0]
  templateList.value = idOf(selected)
  const template = () => versions.find(row => idOf(row) === templateList.value)
  function choose(preserveDraft = false) {
    const chosen = template()
    const values = preserveDraft && draft ? draft.entitlements
      : idOf(chosen) === currentId ? contract.entitlements : chosen.entitlements
    editor = entitlementEditor(models, values)
    editorRoot.replaceChildren(editor.node)
  }
  templateList.addEventListener('change', () => choose())
  choose(true)
  node.append(templateLabel, editorRoot, reasonLabel)
  return {
    node,
    collect() {
      const chosen = template()
      const explanation = reason.value.trim()
      if (!explanation) throw new Error('请填写签发原因')
      return {
        revision: record.revision, tenant_revision: record.tenant_revision,
        template_id: chosen.id, template_version: chosen.version, entitlements: editor.collect(), reason: explanation
      }
    }
  }
}

export function platformContractsPage(host, api, signal) {
  let ledger
  const open = detailPanel(host, () => ledger)
  function openTenant(row) {
    open(row.name, async pane => {
      const endpoint = contracts + '/' + encodeURIComponent(row.tenant_id)
      let record
      async function load() {
        pane.body.replaceChildren(el('p', 'empty', '正在读取平台合约…'))
        pane.foot.replaceChildren()
        record = await api.get(endpoint, { signal })
        render()
      }
      function render() {
        if (signal?.aborted) return
        pane.body.replaceChildren()
        pane.foot.replaceChildren()
        if (!record.platform_contract) pane.body.append(el('p', 'notice warn', '此租户尚未签发平台合约。请核对存量配置及购买依据。'))
        const seats = seatsSummary(record.seats)
        if (seats) pane.body.append(seats)
        contractInfo(pane.body, record.platform_contract, record.effective)
        if (hasAction(record, 'read_history')) pane.foot.append(button('签发历史', () => showHistory(pane, api, endpoint, signal, render)))
        if (hasAction(record, 'publish')) {
          const sign = button(record.platform_contract ? '变更合约' : '签发合约', async () => {
            sign.disabled = true
            try {
              const [versions, models] = await Promise.all([readPages(api, templates, signal), modelChoices(api, signal)])
              if (signal?.aborted) return
              if (!versions.length) throw new Error('请前往「合约模板」发布至少一个版本')
              function drawEditor(draft) {
                pane.body.replaceChildren()
                if (draft) pane.body.append(el('p', 'notice', '已读取最新合约修订，草稿已保留。请重新预览。'))
                previewPublisher({
                  body: pane.body, foot: pane.foot, editor: signingEditor(record, versions, models, draft),
                  preview: payload => api.post(endpoint + '/preview', payload, { signal }),
                  publish: (payload, key) => api.put(endpoint, payload, { idempotencyKey: key, signal }),
                  onCancel: render,
                  reload: async values => {
                    record = await api.get(endpoint, { signal })
                    if (hasAction(record, 'publish')) drawEditor(values)
                    else render()
                  },
                  onPublished: saved => { record = saved; pane.changed(); render() }
                })
              }
              drawEditor()
            } catch (error) {
              if (!signal?.aborted) pane.body.prepend(el('p', 'notice error', error.message))
            } finally {
              sign.disabled = false
            }
          }, 'primary')
          pane.foot.append(sign)
        }
      }
      await load()
    })
  }
  ledger = createLedger(host, {
    title: '平台合约', rowKey: 'tenant_id', signal, searchLabel: '查询租户',
    columns: [{ key: 'name', title: '租户' }, { key: 'tenant_id', title: '租户 ID' }],
    onOpen: openTenant, fetchPage: pageFetcher(api, contracts)
  })
}

export function contractTemplatesPage(host, api, signal) {
  let ledger
  const open = detailPanel(host, () => ledger)
  function show(row) {
    open(row ? row.name + ' · v' + row.version : '发布合约模板', pane => {
      function render(record) {
        pane.body.replaceChildren(el('p', 'muted', record.id + ' · v' + record.version + ' · ' + formatDateTime(record.published_at)),
          comparison([{ title: '模板权益', values: record.entitlements }], { showPins: false }))
        pane.foot.replaceChildren()
        if (hasAction(record, 'publish')) pane.foot.append(button('发布新版本', () => edit(record).catch(error => {
          pane.body.prepend(el('p', 'notice error', error.message))
        }), 'primary'))
      }
      async function edit(record) {
        const models = await modelChoices(api, signal)
        if (signal?.aborted) return
        const fields = [
          { key: 'id', label: '模板 ID', readonly: Boolean(record) },
          { key: 'name', label: '模板名称' }
        ]
        const editor = entitlementEditor(models, record?.entitlements)
        editForm(pane, {
          mode: record ? 'edit' : 'create', label: '发布模板', values: record ?? {}, fields,
          submit: (value, opts) => {
            const id = value.id?.trim()
            const name = value.name?.trim()
            if (!id || !name) throw new Error('请填写模板 ID 和名称')
            return api.post(templates, { id, name, revision: record?.version ?? 0, entitlements: editor.collect() }, { ...opts, signal })
          },
          done: saved => { pane.setTitle(saved.name + ' · v' + saved.version); render(saved) }
        })
        const fieldsNode = el('div')
        pane.body.append(fieldsNode)
        fieldsNode.append(editor.node)
        pane.foot.prepend(button('取消', record ? () => render(record) : pane.close, 'link'))
      }
      if (row) render(row)
      else return edit(null)
    })
  }
  ledger = createLedger(host, {
    title: '合约模板', signal, rowKey: 'key', searchLabel: '查询模板',
    columns: [{ key: 'name', title: '名称' }, { key: 'id', title: '模板 ID' }, { key: 'version', title: '版本' }],
    onOpen: show, onCreate: () => show(null), createLabel: '发布新模板', createAction: 'create_contract_template',
    async fetchPage(args) {
      const page = await pageFetcher(api, templates)(args)
      return { ...page, items: page.items.map(row => ({ ...row, key: row.id + '/' + row.version })) }
    }
  })
}
