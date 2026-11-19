import { createLedger } from './ledger.js'
import { detailPanel, el, button } from './panel.js'
import { formatMilli, formatDateTime } from './format.js'
import { observationFixture } from './mock/observation.js'

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
const names={user_message:'用户',assistant_message:'助手',tool_call:'工具调用',tool_result:'工具结果',session_start:'会话开始',session_end:'会话结束',gap:'采集缺口'}
export async function observePage(host,api,session,signal,mockOnly=false) {
  host.classList.add('page')
  const status=el('div','observe-status'), peopleHost=el('div','page'); host.append(status,peopleHost)
  let source=api, fixture, first, sessions, reading, timer
  try {
    if (mockOnly) throw Object.assign(Error(),{status:404})
    first=await api.get('/observe/people',{params:{limit:50},signal})
  } catch(e) {
    if(signal.aborted) return
    if(e.status!==404) {status.textContent=e.message;return}
    fixture=source=observationFixture()
  }
  if(signal.aborted) return
  const live=el('span', 'muted'); if(fixture) status.append(el('span','mock-badge','监察：假数据'))
  status.append(live)
  const openPerson=detailPanel(peopleHost,()=>people)
  const people=createLedger(peopleHost,{title:'监察人员',rowKey:'user_id',columns:[{key:'name',title:'人员'},{key:'session_count',title:'会话数'},
    {key:'cost_milli',title:'橡皮',render:p=>formatMilli(p.cost_milli)},{key:'last_active_at',title:'最近活动',render:p=>formatDateTime(p.last_active_at)}],
    fetchPage:({q,cursor,limit})=>{if(first&&!q&&!cursor){const data=first;first=null;return data}return source.get('/observe/people',{params:{q,cursor,limit},signal})},
    onOpen:p=>openPerson(p.name,pane=>{
      pane.body.classList.add('child-ledger'); reading=null
      let list
      const open=detailPanel(pane.body,()=>list)
      sessions={host:pane.body,list:list=createLedger(pane.body,{title:'会话',rowKey:'id',columns:[{key:'agent',title:'Agent'},{key:'model',title:'模型'},
        {key:'input_tokens',title:'输入 token'},{key:'output_tokens',title:'输出 token'},{key:'cost_milli',title:'橡皮',render:s=>formatMilli(s.cost_milli)}],
        fetchPage:({q,cursor,limit})=>source.get('/observe/sessions',{params:{user_id:p.user_id,q,cursor,limit},signal}),
        onOpen:s=>open(s.agent+' / '+s.model,view=>{
          const node=view.body;node.classList.add('conversation')
          const summary=el('div','muted',`输入 ${s.input_tokens ?? '—'} · 输出 ${s.output_tokens ?? '—'} token · ${formatMilli(s.cost_milli)} 橡皮`)
          node.append(summary)
          let seq=0,loading=false,pending=false
          const more=button('读取更多',()=>load());view.foot.append(more)
          async function load() {
            if(!node.isConnected||signal.aborted) return
            if(loading){pending=true;return}
            loading=true;more.disabled=true
            try {
              const data=await source.get('/observe/sessions/'+encodeURIComponent(s.id)+'/events',{params:{after_seq:seq,limit:50},signal})
              if(!node.isConnected||signal.aborted)return
              for(const e of data.items) {
                if(e.seq<=seq)continue
                seq=e.seq
                const row=el('article',e.kind==='gap'?'message gap':e.kind==='user_message'?'message user-message':'message')
                const payload=e.payload||{}
                row.append(el('strong',null,names[e.kind]||e.kind),el('small',null,' · '+formatDateTime(e.at)),el('pre',null,
                  e.kind==='gap' ? `${payload.reason || '内容缺失'} · 偏移 ${payload.offset ?? '未知'}` : typeof payload.content==='string' ? payload.content : JSON.stringify(payload,null,2)))
                node.append(row)
              }
              more.hidden=!data.next_cursor && data.items.length<50
            } catch(e){if(!signal.aborted){live.textContent=e.message;more.hidden=false}} finally {loading=false;more.disabled=false;if(pending){pending=false;load()}}
          }
          reading={id:s.id,node,load};load()
        })})}
    })})
  function refresh(summary) {
    if(reading?.node.isConnected && (!summary.session_id || summary.session_id===reading.id)) reading.load()
    clearTimeout(timer);timer=setTimeout(()=>{if(!signal.aborted){people.reload();if(sessions?.host.isConnected)sessions.list.reload()}},200)
  }
  let retry
  async function connect() {
    try {
      const res=fixture ? fixture.stream(signal) : await fetch('/v1/observe/stream',{headers:{Authorization:'Bearer '+session.token,Accept:'text/event-stream'},signal})
      if(!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) throw Error('实时订阅不可用')
      live.textContent='实时更新已连接'; await readStream(res.body, refresh)
    } catch { /* 页面离开时一并取消 */ }
    if(!signal.aborted){live.textContent='实时更新已断开，稍后重连';retry=setTimeout(()=>{refresh({});connect()},3000)}
  }
  signal.addEventListener('abort',()=>{clearTimeout(timer);clearTimeout(retry);reading=null;sessions=null},{once:true});connect()
}
