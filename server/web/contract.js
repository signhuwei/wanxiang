import { el, button } from './panel.js'
import { renderForm } from './form.js'

const tabs = [ ['人数',[['seat_limit','人数上限','number']]], ['Agent',[['allowed_agents','准许的 Agent（每行一个）','textarea']]],
  ['模型',[['allowed_models','准许的模型 ID（每行一个）','textarea']]], ['租约',[['lease_minutes','有效分钟','number'],['lease_budget_milli','额度（毫橡皮）','number']]] ]
export async function contractPage(host, api) {
  host.classList.add('page')
  const bar = el('div','toolbar'), body = el('div','inline-body'), foot = el('div','inline-foot')
  host.append(bar,body,foot)
  try {
    let contract = await api.get('/contract'), tab, draft, editing, form
    function reset(edit) {
      editing = edit; tab = 0
      draft = {...contract, allowed_agents:contract.allowed_agents.join('\n'), allowed_models:contract.allowed_models.join('\n')}
      paint()
    }
    function paint() {
      bar.replaceChildren(el('h1',null,'租户合约'))
      tabs.forEach(([label],i) => bar.append(button(label, () => {
        if (editing) Object.assign(draft,form.collect())
        tab=i; paint()
      }, i===tab ? 'active' : '')))
      form = renderForm(body,{ sections:[{fields:tabs[tab][1].map(([key,label,type])=>({key,label,type}))}], values:draft,mode:editing?'edit':'view' })
      foot.replaceChildren()
      if (!editing) {
        if (contract.actions.includes('update')) foot.append(button('编辑',()=>reset(true),'primary'))
        return
      }
      const save = button('保存',async () => {
        Object.assign(draft,form.collect()); save.disabled=true
        const lines = v => (v||'').split('\n').map(s=>s.trim()).filter(Boolean)
        const {seat_limit,lease_minutes,lease_budget_milli,revision,visibility} = draft
        try {
          contract = await api.put('/contract',{seat_limit,lease_minutes,lease_budget_milli,revision,visibility,allowed_agents:lines(draft.allowed_agents),allowed_models:lines(draft.allowed_models)},{idempotencyKey:crypto.randomUUID()})
          reset(false)
        } catch(e) { form.setNotice(e.message,'error'); save.disabled=false }
      },'primary')
      foot.append(button('取消',()=>reset(false)),save)
    }
    reset(false)
  } catch(e) { body.replaceChildren(el('p','error-row',e.message)) }
}
