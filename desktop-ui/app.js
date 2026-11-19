const $=id=>document.getElementById(id)
const mock=new URL(location.href).searchParams.get('mock')==='1'
// 原生窗口只接受宿主桥，不使用 URL 参数切换到模拟账户。
const invoke=window.__TAURI__?.core?.invoke
const demo=mock&&!invoke
const call=invoke ? request=>invoke('desktop_call',{request}) : demo ? (await import('./mock.js')).makeMock() : null
$('badge').hidden=!demo
let state,busy=false,prefs=false,last='',serial=0
const messages={unauthenticated:'登录凭据无效或已过期',forbidden:'没有权限执行此操作',not_found:'对象不存在',conflict:'状态已变化，请刷新后重试',invalid:'请检查输入内容',seat_limit:'租户人数已达合约上限',balance_exhausted:'橡皮余额不足',lease_expired:'额度租约已过期',agent_not_allowed:'合约不允许该 Agent',model_not_allowed:'合约不允许该模型',rate_limited:'请求过快，请稍后重试',upstream_error:'上游服务出错',internal:'服务内部错误'}
const errorText=code=>typeof code==='string' && Object.hasOwn(messages,code) ? messages[code] : '操作失败，请稍后重试'
const labels={update_available:'有可用更新',available:'可启动',downloading:'下载中',verifying:'校验中',starting:'启动中',running:'运行中',failed:'启动失败'}
function node(tag,text){const n=document.createElement(tag);if(text!=null)n.textContent=text;return n}
function button(text,click,primary=false){const b=node('button',text);b.type='button';b.onclick=click;if(primary)b.className='primary';return b}
function field(form,label,type,placeholder){const l=node('label',label),i=node('input');i.type=type;i.placeholder=placeholder||'';l.append(i);form.append(l);return i}
async function act(request,message=''){
  if(!call||busy)return
  busy=true;serial++; const pane=$('content');pane.inert=true
  try{const r=await call(request);if(!r.ok){$('notice').textContent=errorText(r.error?.code);return}state=r.state;last=JSON.stringify(state);if(request.op==='logout')prefs=false;paint();$('notice').textContent=message}
  catch{$('notice').textContent='本机服务暂不可用，请稍后重试'}finally{pane.inert=false;busy=false}
}
function paint(){
  const c=$('content');c.replaceChildren();$('notice').textContent='';$('scope').textContent=state.tenant ? `${state.tenant.name} · ${state.user?.name||''} · `+({connected:'已连接',connecting:'连接中',backoff:'断线重连中',idle:'未连接'}[state.connection]||state.connection) : '员工工作区'
  $('home').setAttribute('aria-current',prefs?'false':'page');$('prefs').setAttribute('aria-current',prefs?'page':'false')
  if(prefs){$('title').textContent='设置';c.append(node('p','Desktop 版本：'+(state.version || '未知')),node('p','服务地址：'+state.settings.server_origin));const l=node('label'),i=node('input');i.type='checkbox';i.checked=state.settings.hide_on_close;l.append(i,' 关闭窗口时隐藏到托盘');c.append(l,button('保存设置',()=>act({op:'settings',hide_on_close:i.checked},'设置已保存'),true));if(state.phase!=='signed_out')c.append(button('退出登录',()=>act({op:'logout'})));return}
  if(state.phase==='signed_out'){
    $('title').textContent='登录 OneX';const form=node('form');c.append(form)
    if(demo)form.append(node('p','仅供演示：demo@example.test · 验证码 246810 · 可选邀请码 DEMO。不要输入真实凭据。'))
    const target=field(form,'邮箱或手机号','text'), code=field(form,'验证码','text'), invite=field(form,'邀请码（选填）','text');code.autocomplete='one-time-code';target.autocomplete='username';target.required=code.required=true
    const send=button('发送验证码',async()=>{
      const account=target.value,inv=invite.value
      await act({op:'send_code',target:account.trim()},demo?'演示验证码：246810':'请查收验证码')
      const inputs=c.querySelectorAll('input');if(inputs.length===3){inputs[0].value=account;inputs[2].value=inv;inputs[1].focus()}
    });form.append(send);const submit=node('button','登录');submit.className='primary';form.append(submit);form.onsubmit=e=>{e.preventDefault();act({op:'login',target:target.value.trim(),code:code.value.trim(),...(invite.value.trim()?{invite_code:invite.value.trim()}:{})})};return
  }
  if(state.phase==='choose_tenant'){$('title').textContent='选择租户';for(const t of state.tenants)c.append(button(t.name,()=>act({op:'select_tenant',tenant_id:t.id})));if(!state.tenants.length)c.append(node('p','没有可用的租户，请联系管理员。'));return}
  $('title').textContent='可用 Agent';if(!state.agents.length)c.append(node('p','尚无获准的 Agent。请等待配置同步或联系管理员。'))
  for(const a of state.agents){const row=node('div');row.className='row';row.append(node('strong',a.name),node('small',a.version),node('span',Object.hasOwn(labels,a.status)?labels[a.status]:'状态未知'));if(a.status!=='update_available' && a.actions?.includes('launch'))row.append(button('启动',()=>act({op:'launch',agent_id:a.id}),true));if(a.status==='failed' && a.message)row.append(node('span','请稍后重试或联系管理员'));c.append(row)}
}
async function refresh(){if(!call||busy||document.hidden)return;const seq=++serial;try{const r=await call({op:'state'});if(seq!==serial)return;if(!r.ok){$('notice').textContent=errorText(r.error?.code);return}const json=JSON.stringify(r.state);if(last!==json){last=json;state=r.state;paint()}}catch{if(seq===serial)$('notice').textContent='无法读取本机状态，请检查 OneX 服务。'}}
$('home').onclick=()=>{if(state&&!busy){prefs=false;paint()}};$('prefs').onclick=()=>{if(state&&!busy){prefs=true;paint()}}
if(!call){$('title').textContent='未连接桌面服务';$('content').textContent='请从 OneX Desktop 打开；浏览器演示请显式使用 ?mock=1。'}else{await refresh();setInterval(refresh,2000);document.addEventListener('visibilitychange',refresh)}
