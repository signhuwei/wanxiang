import { el, button } from './panel.js'
import { renderForm } from './form.js'
import { AGENT_LABELS } from './format.js'
import { idempotencyKey } from './idempotency.js'

const visibilityRoles = [['admin','管理员'], ['group_admin','组管（本组及子组）']]
const visibilityFields = visibilityRoles.flatMap(([role,label]) => [
  [role+'_summary',label+' · 台账与费用','visibility'], [role+'_content',label+' · 对话正文','visibility']
])
const targetOf = row => [row.agent, row.os, row.arch].join(' / ')
const lines = value => (value || '').split('\n').map(s => s.trim()).filter(Boolean)
const visibilityOptions = [{value:'true',label:'可见'},{value:'false',label:'不可见'}]
const tabs = [ ['人数',[['seat_limit','人数上限','number']]], ['Agent',[['allowed_agents','准许的 Agent（每行一个）','textarea']]],
  ['模型',[['allowed_models','准许的模型 ID（每行一个）','textarea']]], ['租约',[['lease_minutes','有效分钟','number'],['lease_budget_milli','额度（毫橡皮）','number']]], ['可见范围',visibilityFields] ]
export async function contractPage(host, api) {
  host.classList.add('page')
  const bar = el('div','toolbar'), body = el('div','inline-body'), foot = el('div','inline-foot')
  host.append(bar,body,foot)
  try {
    let contract = await api.get('/contract'), tab, draft, editing, form
    let choices
    let target = 'darwin/arm64'
    const targets = [['darwin/arm64','macOS · Apple Silicon'], ['darwin/x64','macOS · Intel'], ['win32/x64','Windows · x64'], ['linux/x64','Linux · x64'], ['linux/arm64','Linux · ARM64']]
    function effective(section, kind) {
      const heading = el('label', 'field', '设备系统和架构')
      const systems = el('select')
      systems.setAttribute('aria-label', '设备系统和架构')
      for (const [value, text] of targets) {
        const item = el('option', null, text)
        item.value = value
        systems.append(item)
      }
      systems.value = target
      heading.append(systems)
      const list = el('div')
      section.append(heading, list)
      let serial = 0
      async function load() {
        const request = ++serial
        target = systems.value
        const [os, arch] = target.split('/')
        list.textContent = '正在核对实际可用配置…'
        try {
          const result = await api.get('/contract/effective', { params:{os,arch} })
          if (!list.isConnected || serial !== request) return
          const rows = kind === 'agents' ? result.agents.map(row => {
            const label = AGENT_LABELS[row.agent] || row.agent
            const value = row.status === 'available' ? row.releases.map(release => release.version).join('、')
              : row.status === 'qualification_required' ? '待原生运行验证' : '当前设备无可用发行'
            return label + ' · ' + value
          }) : result.models.map(row => {
            const {input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok, cache_write_milli_per_mtok} = row.rate
            return row.name + ' · ' + row.model + ' · ' + row.protocol + ' · 输入 ' + input_milli_per_mtok + ' / 输出 '
              + output_milli_per_mtok + ' / 缓存读 ' + cache_read_milli_per_mtok + ' / 缓存写 ' + cache_write_milli_per_mtok + ' 毫橡皮/百万 token'
          })
          list.replaceChildren(...(rows.length ? rows.map(text => el('p', null, text)) : [el('p', 'muted', '当前没有可用配置')]))
        } catch (error) {
          if (serial === request) list.replaceChildren(el('p', 'error-row', error.message))
        }
      }
      systems.addEventListener('change', load)
      void load()
    }
    async function availableReleases() {
      const items = []; let cursor
      do {
        const page = await api.get('/contract/agent-releases', { params:{cursor,limit:200} })
        items.push(...page.items); cursor = page.next_cursor
      } while (cursor)
      return items
    }
    function reset(edit) {
      editing = edit; tab = 0
      draft = {...contract, pins: new Map((contract.agent_releases || []).map(row => [targetOf(row), row])), allowed_agents:contract.allowed_agents.join('\n'), allowed_models:contract.allowed_models.join('\n')}
      for (const [role] of visibilityRoles) {
        const saved = contract.visibility?.[role]
        draft[role+'_summary'] = String(saved?.summary ?? true)
        draft[role+'_content'] = String(saved?.content ?? false)
      }
      paint()
    }
    function paintPins(section, available) {
      section.replaceChildren(el('h3', null, '按平台固定发行'))
      if (!editing) {
        const rows = [...draft.pins.values()]
        for (const row of rows) section.append(el('p', null,
          targetOf(row) + ' · ' + row.version + (row.available ? '' : ' · 暂不可用')))
        if (!rows.length) section.append(el('p', 'muted', '跟随平台已启用的缓存版本'))
        return
      }
      section.append(el('p', 'muted', '固定发行后，对应系统和架构的设备需使用支持 Server 制品的 Edge。'))
      const allowed = new Set(lines(body.querySelector('[name="allowed_agents"]')?.value))
      const groups = new Map()
      for (const row of [...available, ...[...draft.pins.values()].filter(row => !available.some(item => item.id === row.id))]) {
        if (!allowed.has(row.agent)) continue
        const key = targetOf(row)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(row)
      }
      if (!groups.size) section.append(el('p', 'muted', '当前 Agent 暂无已缓存的发行可选'))
      for (const [key, rows] of groups) {
        const label = el('label', 'field', key)
        const select = el('select')
        select.append(el('option', null, '跟随平台缓存版本'))
        select.firstChild.value = ''
        for (const row of rows) {
          const item = el('option', null, row.version + (row.available === false ? '（暂不可用）' : ''))
          item.value = row.id
          select.append(item)
        }
        select.value = draft.pins.get(key)?.id || ''
        select.addEventListener('change', () => {
          const row = rows.find(item => item.id === select.value)
          if (row) draft.pins.set(key, row)
          else draft.pins.delete(key)
        })
        label.append(select)
        section.append(label)
      }
    }
    function paint() {
      bar.replaceChildren(el('h1',null,'租户合约'))
      tabs.forEach(([label],i) => bar.append(button(label, () => {
        if (editing) Object.assign(draft,form.collect())
        tab=i; paint()
      }, i===tab ? 'active' : '')))
      const fields = tabs[tab][1].map(([key,label,type]) => type === 'visibility'
        ? {key,label,type:'select',options:visibilityOptions,allowEmpty:false} : {key,label,type})
      form = renderForm(body,{ sections:[{fields}], values:draft,mode:editing?'edit':'view' })
      if (tab === 1) {
        const section = el('div', 'form-grid')
        body.append(section)
        if (!editing) paintPins(section, [])
        else {
          section.textContent = '正在读取已缓存发行…'
          choices ??= availableReleases().catch(error => { choices = null; throw error })
          choices.then(items => {
            if (!section.isConnected) return
            paintPins(section, items)
            body.querySelector('[name="allowed_agents"]')?.addEventListener('input', () => paintPins(section, items))
          }).catch(error => { section.textContent = error.message })
        }
      }
      if (!editing && (tab === 1 || tab === 2)) {
        const section = el('div', 'form-grid')
        section.append(el('h3', null, tab === 1 ? '设备实际可用版本' : '已生效的模型与倍率'))
        body.append(section)
        effective(section, tab === 1 ? 'agents' : 'models')
      }
      foot.replaceChildren()
      if (!editing) {
        if (contract.actions.includes('update')) foot.append(button('编辑',()=>reset(true),'primary'))
        return
      }
      const save = button('保存',async () => {
        Object.assign(draft,form.collect()); save.disabled=true
        const {seat_limit,lease_minutes,lease_budget_milli,revision} = draft
        const visibility = Object.fromEntries(visibilityRoles.map(([role]) => [role, {
          summary:draft[role+'_summary'] === 'true', content:draft[role+'_content'] === 'true'
        }]))
        try {
          const allowed_agents = lines(draft.allowed_agents)
          const agent_release_ids = [...draft.pins.values()].filter(row => allowed_agents.includes(row.agent)).map(row => row.id)
          contract = await api.put('/contract',{seat_limit,lease_minutes,lease_budget_milli,revision,visibility,
            allowed_agents,agent_release_ids,allowed_models:lines(draft.allowed_models)},{idempotencyKey:idempotencyKey()})
          reset(false)
        } catch(e) { form.setNotice(e.message,'error'); save.disabled=false }
      },'primary')
      foot.append(button('取消',()=>reset(false)),save)
    }
    reset(false)
  } catch(e) { body.replaceChildren(el('p','error-row',e.message)) }
}
