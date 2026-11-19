import { createLedger } from './ledger.js'
import { detailPanel, el, button } from './panel.js'
import { formatDateTime } from './format.js'
import { deviceFixture } from './mock/devices.js'

export function downloadUrl(value,base) {
  if (typeof value !== 'string' || !value.trim()) return null
  try { const u=new URL(value,base);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password ? u.href : null } catch { return null }
}
const statuses={queued:'排队中',pending:'等待设备',running:'采集中',completed:'已完成',succeeded:'已完成',failed:'失败',expired:'已过期'}
const online=d=>d.online===true?'在线':d.online===false?'离线':d.status||'未知'
export async function devicesPage(host,api,signal,mockOnly=false) {
  let source=api,first,fixture
  host.classList.add('page')
  try {
    if(mockOnly)throw Object.assign(Error(),{status:404})
    first=await api.get('/devices',{params:{limit:50},signal})
  } catch(e){
    if(signal.aborted)return
    if(e.status!==404){host.append(el('p','error-row',e.message));return}
    fixture=source=deviceFixture()
  }
  if(signal.aborted)return
  if(fixture){const notice=el('div','observe-status');notice.append(el('span','mock-badge','设备与诊断：假数据'));host.append(notice)}
  const table=el('div','page');host.append(table)
  let list
  const open=detailPanel(table,()=>list)
  list=createLedger(table,{title:'设备',columns:[{key:'name',title:'设备名'},{key:'online',title:'在线状态',render:online},
    {key:'edge_version',title:'Edge 版本'},{key:'os',title:'系统'},{key:'last_seen_at',title:'最近活动',render:d=>formatDateTime(d.last_seen_at)}],
    fetchPage:({q,cursor,limit,signal})=>{if(first&&!q&&!cursor){const data=first;first=null;return data}return source.get('/devices',{params:{q,cursor,limit},signal})},
    onOpen:item=>open(item.name,async pane=>{
      const d=await source.get('/devices/'+encodeURIComponent(item.id),{signal})
      pane.body.append(el('p',null,`${online(d)} · ${d.os} ${d.arch} · Edge ${d.edge_version}`),el('p','muted','最近活动：'+formatDateTime(d.last_seen_at)))
      if(!d.actions?.includes('diag'))return
      const result=el('div','notice');pane.body.append(result)
      const launch=button('拉取日志',async()=>{
        launch.disabled=true;result.textContent='正在请求设备…'
        try {
          const {diag_id}=await source.post('/devices/'+encodeURIComponent(item.id)+'/diag',{kind:'logs'},{signal,idempotencyKey:crypto.randomUUID()})
          if(!diag_id)throw Error('服务未返回诊断任务 ID')
          const poll=async()=>{
            if(signal.aborted||!result.isConnected)return
            try {
              const job=await source.get('/diag/'+encodeURIComponent(diag_id),{signal})
              if(signal.aborted||!result.isConnected)return
              result.textContent='诊断状态：'+(statuses[job.status]||job.status||'未知')
              const href=downloadUrl(job.download_url,location.href)
              if(href && ['completed','succeeded'].includes(job.status)){const link=el('a',null,'下载日志包');link.href=href;link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';result.append(' · ',link)}
              if(!href && ['queued','pending','running'].includes(job.status)){setTimeout(poll,1000);return}
              launch.disabled=false
            } catch(e){result.textContent=e.message;launch.disabled=false}
          };poll()
        } catch(e){result.textContent=e.message;launch.disabled=false}
      },'primary');pane.foot.append(launch)
    })})
}
