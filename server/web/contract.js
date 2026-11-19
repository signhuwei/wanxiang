import { el, button } from './panel.js'
import { renderForm } from './form.js'
import { idempotencyKey } from './idempotency.js'

const visibilityRoles = [['admin','管理员'], ['group_admin','组管（本组及子组）']]
const visibilityFields = visibilityRoles.flatMap(([role,label]) => [
  [role+'_summary',label+' · 台账与费用','visibility'], [role+'_content',label+' · 对话正文','visibility']
])
const visibilityOptions = [{value:'true',label:'可见'},{value:'false',label:'不可见'}]
const tabs = [ ['人数',[['seat_limit','人数上限','number']]], ['Agent',[['allowed_agents','准许的 Agent（每行一个）','textarea']]],
  ['模型',[['allowed_models','准许的模型 ID（每行一个）','textarea']]], ['租约',[['lease_minutes','有效分钟','number'],['lease_budget_milli','额度（毫橡皮）','number']]], ['可见范围',visibilityFields] ]
export async function contractPage(host, api) {
  host.classList.add('page')
  const bar = el('div','toolbar'), body = el('div','inline-body'), foot = el('div','inline-foot')
  host.append(bar,body,foot)
  try {
    let contract = await api.get('/contract'), tab, draft, editing, form
    function reset(edit) {
      editing = edit; tab = 0
      draft = {...contract, allowed_agents:contract.allowed_agents.join('\n'), allowed_models:contract.allowed_models.join('\n')}
      for (const [role] of visibilityRoles) {
        const saved = contract.visibility?.[role]
        draft[role+'_summary'] = String(saved?.summary ?? true)
        draft[role+'_content'] = String(saved?.content ?? false)
      }
      paint()
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
      foot.replaceChildren()
      if (!editing) {
        if (contract.actions.includes('update')) foot.append(button('编辑',()=>reset(true),'primary'))
        return
      }
      const save = button('保存',async () => {
        Object.assign(draft,form.collect()); save.disabled=true
        const lines = v => (v||'').split('\n').map(s=>s.trim()).filter(Boolean)
        const {seat_limit,lease_minutes,lease_budget_milli,revision} = draft
        const visibility = Object.fromEntries(visibilityRoles.map(([role]) => [role, {
          summary:draft[role+'_summary'] === 'true', content:draft[role+'_content'] === 'true'
        }]))
        try {
          contract = await api.put('/contract',{seat_limit,lease_minutes,lease_budget_milli,revision,visibility,allowed_agents:lines(draft.allowed_agents),allowed_models:lines(draft.allowed_models)},{idempotencyKey:idempotencyKey()})
          reset(false)
        } catch(e) { form.setNotice(e.message,'error'); save.disabled=false }
      },'primary')
      foot.append(button('取消',()=>reset(false)),save)
    }
    reset(false)
  } catch(e) { body.replaceChildren(el('p','error-row',e.message)) }
}
