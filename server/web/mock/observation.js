// 仅用于尚未交付的监察接口。正文均为手写示例，不保存真实会话。
export function observationFixture() {
  const now = new Date().toISOString()
  const person = {user_id:'demo_observer',name:'示例成员',session_count:1,cost_milli:27,last_active_at:now,actions:['read']}
  const session = {id:'demo_session',user_id:person.user_id,agent:'claude-code',model:'示例模型',started_at:now,input_tokens:120,output_tokens:45,cost_milli:27,actions:['read']}
  const events = [['user_message',{content:'请汇总本次联调结果。'}],['gap',{reason:'源文件截短',offset:128}],['assistant_message',{content:'已完成登录和账本核对。缺口期间的内容不可还原。'}]].map(([kind,payload],i)=>({seq:i+1,at:now,kind,payload}))
  return {
    async get(path,{params={}}={}) {
      let items = path.endsWith('/people') ? [person] : path.endsWith('/sessions') && params.user_id === person.user_id ? [session] : path.endsWith('/events') ? events.filter(e=>e.seq>(params.after_seq||0)) : []
      if (params.q) items=items.filter(i=>[i.name,i.agent,i.model].some(v=>v?.includes(params.q)))
      return {items,next_cursor:null,total:items.length}
    },
    stream(signal) {
      return new Response(new ReadableStream({ start(c) {
        const timer=setTimeout(()=>{
          const seq=events.length+1
          events.push({seq,kind:'session_end',at:new Date().toISOString(),payload:{reason:'示例任务结束'}})
          c.enqueue(new TextEncoder().encode('event: summary\ndata: '+JSON.stringify({user_id:person.user_id,session_id:session.id,seq})+'\n\n'))
        },3000)
        signal.addEventListener('abort',()=>{clearTimeout(timer);c.close()},{once:true})
      } }), {headers:{'Content-Type':'text/event-stream'}})
    }
  }
}
