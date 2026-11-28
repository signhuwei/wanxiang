import { createLedger } from './ledger.js'
import { detailPanel, el, button } from './panel.js'
import { formatMilli, formatDateTime, agentLabel, AGENT_OPTIONS, quotaUsageLevel, formatQuotaUsage } from './format.js'

export async function readStream(body, receive) {
  const reader=body.pipeThrough(new TextDecoderStream()).getReader()
  let buf='', lines=[]
  try {
    for (;;) {
      const {value,done}=await reader.read(); if(done) break
      buf+=value
      let i
      while ((i=buf.indexOf('\n'))!==-1) {
        const line=buf.slice(0,i).replace(/\r$/,''); buf=buf.slice(i+1)
        if (!line) {
          if (lines.length) { try {receive(JSON.parse(lines.join('\n')))} catch {} }
          lines=[]
        } else if(line.startsWith('data:')) lines.push(line.slice(5).trimStart())
      }
    }
  } finally {reader.releaseLock()}
}
const names={user_message:'用户',assistant_message:'助手',system_message:'系统',tool_call:'工具调用',tool_result:'工具结果',session_start:'会话开始',session_resume:'恢复会话',session_end:'会话结束',gap:'采集缺口',compact:'上下文摘要'}
function contentText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n')
  if (value?.type === 'text' && typeof value.text === 'string') return value.text
  if (value?.type === 'image') return `[图片 · ${value.media_type || '未知格式'}${Number.isInteger(value.bytes) ? ` · ${value.bytes} 字节` : ''}]`
  return ''
}
export function eventText(e) {
  const p=e.payload || {}
  switch(e.kind) {
    case 'session_start': return `${[agentLabel(p.agent),p.agent_version].filter(Boolean).join(' ')} · 模型 ${p.model || '未知'}`
    case 'user_message': case 'assistant_message': case 'system_message': return contentText(p.content) || '无可展示的正文'
    case 'tool_call': return p.tool || '未命名工具'
    case 'tool_result': return (contentText(p.output) || '无可展示的输出') + (p.truncated ? '\n（结果已截断）' : '')
    case 'compact': return p.summary == null ? '上下文已压缩' : (contentText(p.summary) || '上下文已压缩')
    case 'session_resume': return '已继续原会话'
    case 'session_end':
      if (p.reason === 'desktop_process_exited') return '桌面进程已退出'
      if (p.reason === 'daemon_restart') return 'Edge 重启后补记结束'
      return p.reason || '会话已结束'
    case 'gap': return `采集缺口：${p.reason || '原因未知'}`
    default: return '不支持展示此事件'
  }
}
function eventRow(e) {
  const row=el('article',e.kind==='gap'?'message gap':e.kind==='user_message'?'message user-message':'message')
  const header=el('header','message-meta')
  const time=el('time',null,formatDateTime(e.at))
  time.dateTime=e.at
  header.append(el('strong',null,names[e.kind] || '其他事件'),time)
  row.append(header,el(e.kind==='tool_result'?'pre':'div','message-body',eventText(e)))
  if(e.kind==='tool_call' && e.payload?.input != null) {
    const details=el('details');details.append(el('summary',null,'查看工具输入'),el('pre',null,JSON.stringify(e.payload.input,null,2)));row.append(details)
  }
  return row
}
function compactCell(title,stats) {
  const cell=el('div','observe-identity');cell.append(el('span',null,title),el('small','observe-stats',stats));return cell
}
function updateCompactCell(current, next) {
  for (let i = 0; i < next.children.length; i++) {
    if (current.children[i].textContent !== next.children[i].textContent) {
      current.children[i].textContent = next.children[i].textContent
    }
  }
}
const monthCost=p=>p.month_cost_milli == null ? '未提供' : formatMilli(p.month_cost_milli)+' 粒橡皮'
const turns=s=>s.turn_count == null ? '轮数未提供' : s.turn_count+' 轮'
function usageText(s) {
  return `输入 ${s.input_tokens} · 输出 ${s.output_tokens} · 缓存读取 ${s.cache_read_tokens} · 缓存写入 ${s.cache_write_tokens} token · ${formatMilli(s.cost_milli)} 粒橡皮` +
    (s.pending_usage_count ? ` · ${s.pending_usage_count} 笔待结算` : '')
}
function sessionActions(view,api,session,signal) {
  const endpoint='/observe/sessions/'+encodeURIComponent(session.id)
  const message=el('p','muted')
  if(session.actions?.includes('export')) view.foot.append(button('导出会话', async event=>{
    const action=event.currentTarget
    action.disabled=true
    try {
      const events=[]
      let cursor
      do {
        const data=await api.get(endpoint+'/export',{params:{cursor,limit:200},signal})
        events.push(...data.items);cursor=data.next_cursor
      } while(cursor&&!signal.aborted)
      if(signal.aborted) return
      const url=URL.createObjectURL(new Blob([JSON.stringify({session_id:session.id,events},null,2)],{type:'application/json'}))
      const link=el('a');link.href=url;link.download='session-'+session.id+'.json';link.click()
      setTimeout(()=>URL.revokeObjectURL(url),1000)
    } catch(error){if(!signal.aborted)message.textContent=error.message}
    finally{action.disabled=false}
  }))
  if(session.actions?.includes('share')) {
    const open=detailPanel(view.body)
    view.foot.append(button('管理分享',()=>open('会话分享',async pane=>{
      const list=el('ul'),recipient=el('input'),notice=el('p','error-row')
      recipient.setAttribute('aria-label','接收成员 ID')
      const update=async operation=>{
        try {const data=await operation;paint(data.items);notice.textContent=''}
        catch(error){if(!signal.aborted)notice.textContent=error.message}
      }
      function paint(items) {
        list.replaceChildren(...items.map(item=>{
          const li=el('li',null,item.recipient+' ')
          li.append(button('撤销',()=>update(api.request(endpoint+'/shares/'+encodeURIComponent(item.recipient),{method:'DELETE',signal}))))
          return li
        }))
      }
      const label=el('label',null,'接收成员 ID');label.append(recipient)
      pane.body.append(list,label,notice)
      pane.foot.append(button('分享',()=>update(api.post(endpoint+'/shares',{recipient:recipient.value.trim()},{signal})),'primary'))
      await update(api.get(endpoint+'/shares',{signal}))
    })))
  }
  view.body.append(message)
}
export function sharedSessions(host,api,signal) {
  let list
  const open=detailPanel(host,()=>list)
  list=createLedger(host,{title:'分享给我的会话',rowKey:'id',signal,searchable:false,
    columns:[{key:'agent',title:'Agent'},{key:'user_id',title:'分享人'},{title:'分享时间',render:item=>formatDateTime(item.created_at)}],
    fetchPage:async({cursor,limit})=>{
      const data=await api.get('/observe/shared',{params:{cursor,limit},signal})
      return {...data,items:data.items.map(item=>({...item,actions:['read']}))}
    },
    onOpen:s=>open(s.agent,pane=>{
      pane.body.classList.add('conversation')
      let seq=0
      const more=button('读取更多',async()=>{
        more.disabled=true
        try {
          const data=await api.get('/observe/sessions/'+encodeURIComponent(s.id)+'/events',{params:{after_seq:seq,limit:100},signal})
          for(const item of data.items){pane.body.append(eventRow(item));seq=item.seq}
          more.hidden=!data.next_cursor
        } catch(error){if(!signal.aborted)pane.body.textContent=error.message}
        finally{more.disabled=false}
      })
      pane.foot.append(more);more.click()
    })})
}
export async function observePage(host,api,session,signal) {
  host.classList.add('page')
  const status=el('div','observe-status'), peopleHost=el('div','page'); host.append(status,peopleHost)
  let first, sessions, reading, timer
  let refreshAll = false
  const affectedUsers = new Set()
  try { first=await api.get('/observe/people',{params:{limit:50},signal}) }
  catch(e) {if(!signal.aborted)status.textContent=e.message;return}
  if(signal.aborted) return
  const live=el('span','muted')
  status.append(live)
  const openPerson=detailPanel(peopleHost,()=>people,{live:true})
  function quotaCell(p) {
    if (p.quota_milli===undefined || p.month_used_milli===undefined) return null
    const level=quotaUsageLevel(p.month_used_milli,p.quota_milli)
    if (level!=='error') return null
    return el('span','status error',formatQuotaUsage(p.month_used_milli,p.quota_milli)+' · 已达配额')
  }
  const people=createLedger(peopleHost,{title:'监察人员',rowKey:'user_id',columns:[{key:'name',title:'人员',render:p=>compactCell(p.name+' · '+formatDateTime(p.last_active_at),`${p.session_count} 个会话 · 本月 ${monthCost(p)}`),update:updateCompactCell},
    {key:'last_agent',title:'Agent',render:p=>p.last_agent ? agentLabel(p.last_agent) : '—'},{key:'session_count',title:'会话数'},
    {key:'month_cost_milli',title:'本月费用',render:monthCost},{key:'quota',title:'配额',render:p=>quotaCell(p) || '—',update:(current,next)=>{if(current.textContent!==next.textContent)current.textContent=next.textContent}},
    {key:'last_active_at',title:'最近活动',render:p=>formatDateTime(p.last_active_at)}],
    fetchPage:({q,cursor,limit})=>{if(first&&!q&&!cursor){const data=first;first=null;return data}return api.get('/observe/people',{params:{q,cursor,limit},signal})},
    onOpen:p=>openPerson(p.name,pane=>{
      pane.body.classList.add('child-ledger'); reading=null
      let list
      const open=detailPanel(pane.body,()=>list,{live:true})
      sessions={host:pane.body,userId:p.user_id,list:list=createLedger(pane.body,{title:'会话',rowKey:'id',signal:pane.signal,openAction:'read_content',noOpenText:'无正文查看权限，可请户主开放',
        filters:[{key:'agent',label:'Agent',options:[{value:'',label:'全部 Agent'},...AGENT_OPTIONS]}],
        columns:[{key:'agent',title:'Agent',render:s=>agentLabel(s.agent)},{key:'started_at',title:'开始时间 ↓',render:s=>compactCell(formatDateTime(s.started_at),`${turns(s)} · ${formatMilli(s.cost_milli)} 粒橡皮`),update:updateCompactCell},{key:'model',title:'模型'},
        {key:'turn_count',title:'轮数',render:turns},{key:'input_tokens',title:'输入 token'},{key:'output_tokens',title:'输出 token'},{key:'cost_milli',title:'橡皮',render:s=>formatMilli(s.cost_milli)}],
        fetchPage:async ({q,filters,cursor,limit,signal:listSignal})=>{
          const data=await api.get('/observe/sessions',{params:{user_id:p.user_id,agent:filters.agent,q,cursor,limit},signal:listSignal})
          if (!listSignal.aborted && reading?.node.isConnected) {
            const row=data.items.find(s=>s.id===reading.id)
            if (row && reading.summary.textContent !== usageText(row)) reading.summary.textContent=usageText(row)
          }
          return data
        },
        onOpen:s=>open(s.agent+' / '+s.model,view=>{
          const node=view.body;node.classList.add('conversation')
          const summary=el('div','muted',usageText(s))
          node.append(summary)
          sessionActions(view,api,s,signal)
          let seq=0,loading=false,pending=false
          const more=button('读取更多',()=>load());view.foot.append(more)
          async function load() {
            if(!node.isConnected||signal.aborted) return
            if(loading){pending=true;return}
            loading=true;more.disabled=true
            try {
              const data=await api.get('/observe/sessions/'+encodeURIComponent(s.id)+'/events',{params:{after_seq:seq,limit:50},signal})
              if(!node.isConnected||signal.aborted)return
              for(const e of data.items) {
                if(e.seq<=seq)continue
                seq=e.seq
                node.append(eventRow(e))
              }
              more.hidden=!data.next_cursor && data.items.length<50
            } catch(e){if(!signal.aborted){live.textContent=e.message;more.hidden=false}} finally {loading=false;more.disabled=false;if(pending){pending=false;load()}}
          }
          reading={id:s.id,node,load,summary};load()
        })})}
    })})
  function refresh(summary) {
    if(reading?.node.isConnected && (!summary.session_id || summary.session_id===reading.id)) reading.load()
    if (summary.user_id) affectedUsers.add(summary.user_id)
    else refreshAll = true
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (signal.aborted) return
      people.reloadInBackground()
      if (sessions?.host.isConnected && (refreshAll || affectedUsers.has(sessions.userId))) {
        sessions.list.reloadInBackground()
      }
      affectedUsers.clear()
      refreshAll = false
    }, 200)
  }
  let retry
  async function connect() {
    try {
      const res=await fetch('/v1/observe/stream',{headers:{Authorization:'Bearer '+session.token,Accept:'text/event-stream'},signal})
      if(!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) throw Error('实时订阅不可用')
      live.textContent='实时更新已连接'; refresh({}); await readStream(res.body, refresh)
    } catch { /* 页面离开时一并取消 */ }
    if(!signal.aborted){live.textContent='实时更新已断开，稍后重连';retry=setTimeout(()=>{refresh({});connect()},3000)}
  }
  signal.addEventListener('abort',()=>{clearTimeout(timer);clearTimeout(retry);reading=null;sessions=null},{once:true});connect()
}
