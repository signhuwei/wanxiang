import { createLedger } from './ledger.js'
import { detailPanel, el, button } from './panel.js'
import { formatMilli, formatDateTime } from './format.js'

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
const names={user_message:'用户',assistant_message:'助手',tool_call:'工具调用',tool_result:'工具结果',session_start:'会话开始',session_end:'会话结束',gap:'采集缺口',compact:'上下文摘要'}
const agentName = agent => agent === 'claude-code' ? 'Claude Code' : agent || '未知 Agent'
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
    case 'session_start': return `${[agentName(p.agent),p.agent_version].filter(Boolean).join(' ')} · 模型 ${p.model || '未知'} · 开始于 ${formatDateTime(e.at)}`
    case 'user_message': case 'assistant_message': return contentText(p.content) || '无可展示的正文'
    case 'tool_call': return p.tool || '未命名工具'
    case 'tool_result': return (contentText(p.output) || '无可展示的输出') + (p.truncated ? '\n（结果已截断）' : '')
    case 'compact': return contentText(p.summary) || '无摘要'
    case 'session_end': return p.reason || '会话已结束'
    case 'gap': return `${p.reason || '内容缺失'} · 偏移 ${p.offset ?? '未知'}`
    default: return '不支持展示此事件'
  }
}
function eventRow(e) {
  const row=el('article',e.kind==='gap'?'message gap':e.kind==='user_message'?'message user-message':'message')
  if(e.kind==='session_start') { row.append(el('span',null,eventText(e))); return row }
  row.append(el('strong',null,names[e.kind] || '其他事件'),el('small',null,' · '+formatDateTime(e.at)),el('pre',null,eventText(e)))
  if(e.kind==='tool_call' && e.payload?.input != null) {
    const details=el('details');details.append(el('summary',null,'查看工具输入'),el('pre',null,JSON.stringify(e.payload.input,null,2)));row.append(details)
  }
  return row
}
function compactCell(title,stats) {
  const cell=el('div','observe-identity');cell.append(el('span',null,title),el('small','observe-stats',stats));return cell
}
const monthCost=p=>p.month_cost_milli == null ? '未提供' : formatMilli(p.month_cost_milli)+' 橡皮'
const turns=s=>s.turn_count == null ? '轮数未提供' : s.turn_count+' 轮'
function usageText(s) {
  return `输入 ${s.input_tokens} · 输出 ${s.output_tokens} · 缓存读取 ${s.cache_read_tokens} · 缓存写入 ${s.cache_write_tokens} token · ${formatMilli(s.cost_milli)} 橡皮` +
    (s.pending_usage_count ? ` · ${s.pending_usage_count} 笔待结算` : '')
}
export async function observePage(host,api,session,signal) {
  host.classList.add('page')
  const status=el('div','observe-status'), peopleHost=el('div','page'); host.append(status,peopleHost)
  let first, sessions, reading, timer
  try { first=await api.get('/observe/people',{params:{limit:50},signal}) }
  catch(e) {if(!signal.aborted)status.textContent=e.message;return}
  if(signal.aborted) return
  const live=el('span','muted')
  status.append(live)
  const openPerson=detailPanel(peopleHost,()=>people)
  const people=createLedger(peopleHost,{title:'监察人员',rowKey:'user_id',columns:[{key:'name',title:'人员',render:p=>compactCell(p.name+' · '+formatDateTime(p.last_active_at),`${p.session_count} 个会话 · 本月 ${monthCost(p)}`)},{key:'session_count',title:'会话数'},
    {key:'month_cost_milli',title:'本月费用',render:monthCost},{key:'last_active_at',title:'最近活动',render:p=>formatDateTime(p.last_active_at)}],
    fetchPage:({q,cursor,limit})=>{if(first&&!q&&!cursor){const data=first;first=null;return data}return api.get('/observe/people',{params:{q,cursor,limit},signal})},
    onOpen:p=>openPerson(p.name,pane=>{
      pane.body.classList.add('child-ledger'); reading=null
      let list
      const open=detailPanel(pane.body,()=>list)
      sessions={host:pane.body,list:list=createLedger(pane.body,{title:'会话',rowKey:'id',openAction:'read_content',noOpenText:'无正文查看权限，可请户主开放',columns:[{key:'agent',title:'会话',render:s=>compactCell(agentName(s.agent)+' · '+formatDateTime(s.started_at),`${turns(s)} · ${formatMilli(s.cost_milli)} 橡皮`)},{key:'model',title:'模型'},
        {key:'started_at',title:'开始时间 ↓',render:s=>formatDateTime(s.started_at)},{key:'turn_count',title:'轮数',render:turns},{key:'input_tokens',title:'输入 token'},{key:'output_tokens',title:'输出 token'},{key:'cost_milli',title:'橡皮',render:s=>formatMilli(s.cost_milli)}],
        fetchPage:async ({q,cursor,limit,signal:listSignal})=>{
          const data=await api.get('/observe/sessions',{params:{user_id:p.user_id,q,cursor,limit},signal:listSignal})
          if (!listSignal.aborted && reading?.node.isConnected) {
            const row=data.items.find(s=>s.id===reading.id)
            if (row) reading.summary.textContent=usageText(row)
          }
          return data
        },
        onOpen:s=>open(s.agent+' / '+s.model,view=>{
          const node=view.body;node.classList.add('conversation')
          const summary=el('div','muted',usageText(s))
          node.append(summary)
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
    if (!timer) timer=setTimeout(()=>{timer=null;if(!signal.aborted){people.reload();if(sessions?.host.isConnected)sessions.list.reload()}},200)
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
