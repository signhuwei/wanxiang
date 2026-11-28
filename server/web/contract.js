import { el, button } from './panel.js'
import { agentLabel, formatMilli } from './format.js'
import { comparison, eraserMilli, hasAction, previewPublisher, readPages, seatsSummary, visibilityFields } from './contract-controls.js'

const path = '/contract/configuration'
const targets = [
  ['darwin/arm64', 'macOS · Apple Silicon'], ['darwin/x64', 'macOS · Intel'],
  ['win32/x64', 'Windows · x64'], ['linux/x64', 'Linux · x64'], ['linux/arm64', 'Linux · ARM64']
]

function field(label, control) {
  const wrap = el('label', 'field wide')
  wrap.append(el('span', null, label), control)
  return wrap
}

function select(options, value) {
  const control = el('select')
  for (const [key, label] of options) {
    const option = el('option', null, label)
    option.value = key
    control.append(option)
  }
  control.value = value
  return control
}

function effectiveByDevice(api, signal) {
  const section = el('section', 'contract-devices')
  const systems = select(targets, targets[0][0])
  const current = el('div')
  section.append(el('h3', null, '设备可用能力'), field('系统和架构', systems), current)
  let request = 0
  async function load() {
    const serial = ++request
    const [os, arch] = systems.value.split('/')
    current.textContent = '正在读取设备配置…'
    try {
      const result = await api.get('/contract/effective', { params: { os, arch }, signal })
      if (serial !== request || signal?.aborted) return
      const agents = result.agents.map(row => {
        const status = row.status === 'available' ? row.releases.map(release => release.version).join('、')
          : row.status === 'qualification_required' ? '待原生运行验证' : '当前设备无可用发行'
        return el('li', null, agentLabel(row.agent) + ' · ' + status)
      })
      const modelRows = result.models.map(row => {
        const rate = row.rate
        const prices = ['input', 'output', 'cache_read', 'cache_write'].map(key => formatMilli(rate[key + '_milli_per_mtok']))
        return el('li', null, row.name + ' · ' + row.model + ' · ' + row.protocol + ' · ' + prices.join(' / '))
      })
      current.replaceChildren()
      for (const [title, rows] of [['Agent 发行', agents], ['模型费率（粒/百万 token，依次为输入、输出、缓存读、缓存写）', modelRows]]) {
        const list = el('ul')
        list.append(...rows)
        current.append(el('h4', null, title), rows.length ? list : el('p', 'muted', '当前设备无可用项'))
      }
    } catch (error) {
      if (serial === request && !signal?.aborted) current.replaceChildren(el('p', 'error-row', error.message))
    }
  }
  systems.addEventListener('change', load)
  void load()
  return section
}

function choiceList(label, options, saved) {
  const group = el('fieldset', 'contract-choices')
  group.append(el('legend', null, label))
  const mode = select([['inherit', '继承平台'], ['select', '指定启用项']], saved == null ? 'inherit' : 'select')
  mode.setAttribute('aria-label', label + '配置方式')
  const items = el('div', 'contract-choice-list')
  const removed = (saved ?? []).filter(id => !options.some(([value]) => value === id))
  const inputs = options.concat(removed.map(id => [id, id + '（平台已收回）'])).map(([id, title]) => {
    const wrap = el('label', 'contract-choice')
    const input = el('input')
    input.type = 'checkbox'
    input.value = id
    input.checked = saved == null || saved.includes(id)
    wrap.append(input, el('span', null, title))
    items.append(wrap)
    return input
  })
  if (!options.length) items.append(el('p', 'muted', '平台暂未授权任何选项'))
  mode.addEventListener('change', () => { items.hidden = mode.value === 'inherit' })
  items.hidden = mode.value === 'inherit'
  group.append(mode, items)
  return {
    node: group,
    value() { return mode.value === 'inherit' ? undefined : inputs.filter(input => input.checked).map(input => input.value) }
  }
}

function leaseLimit(label, saved, inherited) {
  const input = el('input')
  input.inputMode = 'decimal'
  input.placeholder = '继承平台 ' + inherited
  input.value = saved ?? ''
  return { node: field(label, input), value: () => input.value.trim() || undefined }
}

function releasePicker(allowed, available, selected, existing) {
  const box = el('fieldset', 'contract-choices')
  const selects = el('div', 'form-grid')
  const pins = new Map()
  const groups = new Map()
  const byId = new Map(available.map(row => [row.id, row]))
  for (const row of existing) if (!byId.has(row.id)) byId.set(row.id, row)
  for (const row of byId.values()) {
    const key = [row.agent, row.os, row.arch].join('/')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
    if (selected?.includes(row.id)) pins.set(key, row.id)
  }
  function refresh() {
    selects.replaceChildren()
    for (const [key, rows] of groups) {
      const sample = rows[0]
      if (!allowed().includes(sample.agent)) continue
      const label = agentLabel(sample.agent) + ' · ' + sample.os + '/' + sample.arch
      const control = select([['', '跟随平台版本'], ...rows.map(row => [row.id,
        row.version + (row.available === false ? '（暂不可用）' : '')])], pins.get(key) ?? '')
      control.addEventListener('change', () => {
        if (control.value) pins.set(key, control.value)
        else pins.delete(key)
      })
      selects.append(field(label, control))
    }
    if (!selects.childElementCount) selects.append(el('p', 'muted', '已启用 Agent 暂无可固定的发行'))
  }
  box.append(el('legend', null, '按设备固定 Agent 发行'), selects)
  refresh()
  return {
    node: box, refresh,
    value: () => [...pins.values()].filter(id => allowed().includes(byId.get(id).agent))
  }
}

function configurationEditor(record, releases, existing, draft) {
  const platform = record.entitlements
  const choice = draft ?? record.configuration ?? {}
  const agents = choiceList('Agent', platform.allowed_agents.map(id => [id, agentLabel(id)]), choice.allowed_agents)
  const models = choiceList('模型', platform.allowed_models.map(id => [id, id]), choice.allowed_models)
  const minutes = leaseLimit('租约时长（分钟）', choice.lease_minutes, platform.lease_minutes)
  minutes.node.querySelector('input').inputMode = 'numeric'
  const budget = leaseLimit('租约额度（粒）', choice.lease_budget_milli == null ? null : formatMilli(choice.lease_budget_milli),
    formatMilli(platform.lease_budget_milli))
  const release = releasePicker(() => agents.value() ?? platform.allowed_agents, releases, choice.agent_release_ids, existing)
  agents.node.addEventListener('change', release.refresh)
  const lease = el('fieldset', 'contract-choices')
  lease.append(el('legend', null, '租约'), minutes.node, budget.node)
  const governance = el('fieldset', 'contract-choices')
  governance.append(el('legend', null, '监察可见范围'))
  const controls = visibilityFields.map(([role, key, label]) => {
    const permitted = platform.visibility?.[role]?.[key]
    const saved = choice.visibility?.[role]?.[key]
    const options = [['', permitted ? '继承平台（允许）' : '继承平台（关闭）'], ['false', '关闭']]
    if (permitted || saved === true) options.push(['true', permitted ? '允许' : '允许（平台已收回）'])
    const control = select(options, saved == null ? '' : String(saved))
    governance.append(field(label, control))
    return { role, key, control }
  })
  const node = el('div', 'contract-editor')
  node.append(agents.node, models.node, release.node, lease, governance)
  return {
    node,
    collect() {
      const leaseMinutes = minutes.value()
      if (leaseMinutes !== undefined && (!/^\d+$/.test(leaseMinutes) || Number(leaseMinutes) < 1 || Number(leaseMinutes) > platform.lease_minutes)) {
        throw new Error('租约时长须为 1 到 ' + platform.lease_minutes + ' 分钟的整数')
      }
      const leaseBudget = budget.value()
      const budgetMilli = leaseBudget === undefined ? undefined : eraserMilli(leaseBudget, '租约额度')
      if (budgetMilli > platform.lease_budget_milli) throw new Error('租约额度不能超过 ' + formatMilli(platform.lease_budget_milli) + ' 粒')
      const visibility = {}
      for (const { role, key, control } of controls) {
        if (control.value === '') continue
        visibility[role] ??= {}
        visibility[role][key] = control.value === 'true'
      }
      return {
        platform_revision: record.platform_revision,
        revision: record.revision,
        configuration: {
          allowed_agents: agents.value(), allowed_models: models.value(),
          agent_release_ids: release.value(),
          lease_minutes: leaseMinutes === undefined ? undefined : Number(leaseMinutes),
          lease_budget_milli: budgetMilli,
          ...(Object.keys(visibility).length && { visibility })
        }
      }
    }
  }
}

export async function contractPage(host, api, signal) {
  host.classList.add('page')
  const bar = el('div', 'toolbar'), body = el('div', 'inline-body'), foot = el('div', 'inline-foot')
  bar.append(el('h1', null, '能力合约'))
  host.append(bar, body, foot)
  let record
  async function load() {
    foot.replaceChildren()
    body.replaceChildren(el('p', 'empty', '正在读取能力合约…'))
    try {
      record = await api.get(path, { signal })
      render()
    } catch (error) {
      if (signal?.aborted) return
      if ([403, 404].includes(error.status)) {
        body.replaceChildren(effectiveByDevice(api, signal))
      } else {
        body.replaceChildren(el('p', 'error-row', error.message), button('重试', load))
      }
    }
  }
  function render() {
    if (signal?.aborted) return
    body.replaceChildren()
    foot.replaceChildren()
    if (!record.entitlements) body.append(el('p', 'notice warn', '等待平台确认签约权益。现有有效配置供查看。'))
    else body.append(el('p', 'muted', '平台合约第 ' + record.platform_revision + ' 版 · 租户配置第 ' + record.revision + ' 版'))
    const seats = seatsSummary(record.seats)
    if (seats) body.append(seats)
    body.append(comparison(record.entitlements ? [
      { title: '平台授权', values: record.entitlements },
      { title: '租户配置', values: record.configuration, configuration: true },
      { title: '当前生效', values: record.effective }
    ] : [{ title: '当前生效', values: record.effective }]), effectiveByDevice(api, signal))
    if (hasAction(record, 'update')) {
      const edit = button('编辑租户配置', async () => {
        edit.disabled = true
        try {
          const [releases, current] = await Promise.all([
            readPages(api, '/contract/agent-releases', signal),
            api.get('/contract', { signal })
          ])
          if (signal?.aborted) return
          function drawEditor(draft) {
            body.replaceChildren()
            if (draft) body.append(el('p', 'notice', '已读取最新合约修订，草稿已保留。请核对授权范围后重新预览。'))
            previewPublisher({
              body, foot, editor: configurationEditor(record, releases, current.agent_releases ?? [], draft),
              preview: payload => api.post(path + '/preview', payload, { signal }),
              publish: (payload, key) => api.put(path, payload, { idempotencyKey: key, signal }),
              onCancel: render,
              onPublished: saved => { record = saved; render() },
              reload: async values => {
                record = await api.get(path, { signal })
                if (hasAction(record, 'update')) drawEditor(values.configuration)
                else render()
              }
            })
          }
          drawEditor()
        } catch (error) {
          if (!signal?.aborted) body.prepend(el('p', 'notice error', error.message))
        } finally {
          edit.disabled = false
        }
      }, 'primary')
      foot.append(edit)
    }
  }
  await load()
}
