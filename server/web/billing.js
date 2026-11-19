import { createLedger } from './ledger.js'
import { el, detailPanel, editForm } from './panel.js'
import { formatMilli, formatDateTime } from './format.js'

export function topupMilli(value) {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(value))
  const n = match && Number(match[1] + (match[2] || '').padEnd(3, '0'))
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('请输入正数，最多保留三位小数')
  return n
}
const kinds = {topup:'充值',reserve:'预留',settle:'结算',release:'释放',adjust:'调整'}
export function billingPage(host, api, platformApi, session) {
  const summary = el('section','balance-summary'), table = el('div','page')
  host.classList.add('page'); host.append(summary,table)
  async function refresh() {
    try {
      const balance = await api.get('/balance')
      summary.replaceChildren(...[['balance_milli','可用余额'],['reserved_milli','已预留'],['month_used_milli','本月消耗']].map(([k,label]) => {
        const tile = el('div'); tile.append(el('small',null,label+' · 橡皮'),el('strong','num',balance[k] == null ? '—' : formatMilli(balance[k]))); return tile
      }))
    } catch(e) { summary.replaceChildren(el('span','error-row',e.message)) }
  }
  let list
  const open = detailPanel(table,()=>list)
  function topup() {
    open('充值 · '+session.tenant.name,pane=>editForm(pane,{mode:'create',label:'确认充值',fields:[
      {key:'amount',label:'充值橡皮',placeholder:'如 2.075'}, {key:'note',label:'备注'}],
      submit:(v,opts)=>platformApi.post('/platform/ledger/topup',{ tenant_id:session.tenant.id, amount_milli:topupMilli(v.amount), ...(v.note ? {note:v.note} : {}) },opts),
      done:()=>{pane.close();refresh()} }))
  }
  list = createLedger(table,{title:'橡皮流水',createLabel:'充值',onCreate:session.globalActions?.includes('topup') ? topup : null,
    columns:[{key:'at',title:'时间',render:i=>formatDateTime(i.at)},{key:'kind',title:'类型',render:i=>kinds[i.kind]||i.kind},
      {key:'amount_milli',title:'金额（橡皮）',render:i=>formatMilli(i.amount_milli)}, {key:'by',title:'操作人'}, {key:'request_ref',title:'业务参考'}],
    fetchPage:({q,cursor,limit,signal})=>api.get('/ledger',{params:{q,cursor,limit},signal}) })
  refresh()
}
