const tenant={id:'ten_demo',name:'示例研发部'}
const fail=(code,message)=>({ok:false,error:{code,message}})
export function makeMock(){
  let issued=false,start=0
  const state={version:'0.1.0-demo',phase:'signed_out',user:null,tenant:null,tenants:[],connection:'idle',agents:[],settings:{server_origin:'https://onex.example.invalid',hide_on_close:true}}
  function enterTenant(tenant) {
    Object.assign(state, { phase: 'ready', tenant, tenants: [], connection: 'connected', agents: [
      { id: 'claude-code', name: 'Claude Code', version: '演示版', status: 'available', actions: ['launch'] },
      { id: 'demo-preview', name: '示例预览 Agent', version: '演示版', status: 'update_available', actions: [] },
    ] })
  }
  return async r=>{
    switch(r.op){
      case 'state':
        if(start && Date.now()-start>=650 && state.agents.length){state.agents[0].status='running';start=0}break
      case 'diagnostics':
        return {ok:true,diagnostics:{desktop_version:state.version,daemon_version:null,entries:[]}}
      case 'send_code':
        if(r.target!=='demo@example.test')return fail('invalid','演示仅接受 demo@example.test'); issued=true;break
      case 'login':
        if(!issued||r.target!=='demo@example.test'||r.code!=='246810')return fail('unauthenticated','请发送并输入演示验证码 246810')
        if(r.invite_code && r.invite_code!=='DEMO')return fail('invalid','演示邀请码为 DEMO')
        issued=false;state.user={name:'示例员工'};state.phase='choose_tenant';state.tenants=[tenant,...(r.invite_code?[{id:'ten_lab',name:'示例实验室'}]:[])];break
      case 'password_login':
        if (!['demo', tenant.id].includes(r.tenant) || r.username !== 'employee' || r.password !== 'Demo-Only-246810') {
          return fail('unauthenticated', '演示凭据无效')
        }
        state.user = { name: '示例员工' }
        enterTenant(tenant)
        break
      case 'select_tenant':{
        const t=state.tenants.find(t=>t.id===r.tenant_id)
        if(state.phase!=='choose_tenant'||!t)return fail('forbidden','无权进入此租户')
        enterTenant(t);break
      }
      case 'launch':{
        const a=state.agents.find(a=>a.id===r.agent_id)
        if(!a?.actions.includes('launch'))return fail('agent_not_allowed','该 Agent 不可启动')
        a.actions=[];a.status='starting';start=Date.now();break
      }
      case 'settings':if(typeof r.hide_on_close!=='boolean')return fail('invalid','偏好无效');state.settings.hide_on_close=r.hide_on_close;break
      case 'reconnect':
        if(r.force!==undefined&&typeof r.force!=='boolean')return fail('invalid','重连选项无效')
        if(state.agents.some(agent=>['starting','running'].includes(agent.status))){
          if(!r.force)return fail('reconnect_busy','当前还有 Agent 或后台任务')
          start=0;enterTenant(state.tenant)
        }
        break
      case 'logout':issued=false;start=0;Object.assign(state,{phase:'signed_out',tenant:null,user:null,tenants:[],connection:'idle',agents:[]});break
      default:return fail('invalid','未知操作')
    }
    return {ok:true,state:structuredClone(state)}
  }
}
