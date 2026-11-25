const $=id=>document.getElementById(id)
const mock=new URL(location.href).searchParams.get('mock')==='1'
// 原生窗口只接受宿主桥，不使用 URL 参数切换到模拟账户。
const invoke=window.__TAURI__?.core?.invoke
const installedVersion=window.__ONEX_DESKTOP_VERSION__
const versionLabel=$('desktop-version')
function showVersion(version) {
  if (!version) return
  versionLabel.textContent='版本 '+version
  versionLabel.hidden=false
}
showVersion(installedVersion)
const demo=mock&&!invoke
const call=invoke ? request=>invoke('desktop_call',{request}) : demo ? (await import('./mock.js')).makeMock() : null
$('badge').hidden=!demo
let state,busy=false,activeTab='workbench',last='',serial=0
const seenNotices=new Set()
const messages={unauthenticated:'登录凭据无效或已过期',forbidden:'没有权限执行此操作',not_found:'对象不存在',conflict:'状态已变化，请刷新后重试',device_already_logged_in:'本机 OneX 已登录。请用同一租户和账号登录，或先用 OneX 命令行退出。',agents_running:'请先关闭已启动的 OneX Agent',history_unavailable:'暂时无法恢复当前账号的本机会话',invalid:'请检查输入内容',seat_limit:'租户人数已达合约上限',balance_exhausted:'橡皮余额不足',lease_expired:'额度租约已过期',agent_not_allowed:'合约不允许该 Agent',model_not_allowed:'合约不允许该模型',rate_limited:'请求过快，请稍后重试',upstream_error:'上游服务出错',update_unavailable:'当前更新已不可用，请稍后重试',update_failed:'Desktop 更新失败，请重试',internal:'服务内部错误'}
const errorText=code=>typeof code==='string' && Object.hasOwn(messages,code) ? messages[code] : '操作失败，请稍后重试'
const labels={update_available:'有可用更新',available:'可启动',not_downloaded:'待下载',downloading:'下载中',verifying:'校验中',starting:'启动中',running:'运行中',failed:'启动失败',download_failed:'下载失败',policy_pending:'等待配置同步'}
const updateLabels={available:'有更新',downloading:'下载更新中',installing:'安装更新中',failed:'重试更新'}
const updateButton=$('desktop-update')
const updateDialog=$('desktop-update-dialog')
let confirmedVersion
const metricFormat=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3})
function node(tag,text){const n=document.createElement(tag);if(text!=null)n.textContent=text;return n}
function button(text,click,primary=false){const b=node('button',text);b.type='button';b.onclick=click;if(primary)b.className='primary';return b}
function field(form,label,type,placeholder){const l=node('label',label),i=node('input');i.type=type;i.placeholder=placeholder||'';l.append(i);form.append(l);return i}
async function act(request,message=''){
  if(!call||busy)return
  busy=true;serial++; const pane=$('content');pane.inert=true
  try{const r=await call(request);if(!r.ok){$('notice').textContent=errorText(r.error?.code);return}state=r.state;last=JSON.stringify(state);if(request.op==='logout'){activeTab='workbench';seenNotices.clear()};paint();$('notice').textContent=message}
  catch{$('notice').textContent='本机服务暂不可用，请稍后重试'}finally{pane.inert=false;busy=false}
}

function paintLogin(content) {
  $('title').textContent = '登录 OneX'
  const form = node('form')
  content.append(form)
  if (demo) form.append(node('p', '演示账号 · 租户 demo · 用户名 employee · 密码 Demo-Only-246810'))

  const tenant = field(form, '租户 ID 或简称', 'text')
  const username = field(form, '用户名', 'text')
  const password = field(form, '密码', 'password')
  tenant.required = username.required = password.required = true
  tenant.autocomplete = 'organization'
  username.autocomplete = 'username'
  password.autocomplete = 'current-password'
  tenant.spellcheck = username.spellcheck = false

  const submit = node('button', '登录')
  submit.type = 'submit'
  submit.className = 'primary'
  form.append(submit)
  form.onsubmit = event => {
    event.preventDefault()
    if (busy) return
    const request = { op: 'password_login', tenant: tenant.value.trim(), username: username.value.trim(),
      password: password.value }
    password.value = ''
    void act(request)
  }
}

function paint(){
  if (!installedVersion) showVersion(state.version)
  paintUpdate()
  const c=$('content');c.replaceChildren();$('notice').textContent='';$('scope').textContent=state.tenant ? `${state.tenant.name} · ${state.user?.name||''} · `+({connected:'已连接',connecting:'连接中',backoff:'断线重连中',idle:'未连接'}[state.connection]||state.connection) : '员工工作区'
  $('messages').hidden=state.phase!=='ready'
  const unread=(state.notices??[]).filter(notice=>!seenNotices.has(notice.id)).length
  $('messages').textContent=unread?`消息列表（${unread}）`:'消息列表'
  for (const [id,tab] of [['home','workbench'],['messages','messages'],['prefs','settings']]) {
    $(id).setAttribute('aria-current',activeTab===tab?'page':'false')
  }
  if(activeTab==='settings'){$('title').textContent='设置';c.append(node('p','Desktop 版本：'+(state.version || '未知')),node('p','服务地址：'+state.settings.server_origin));const l=node('label'),i=node('input');i.type='checkbox';i.checked=state.settings.hide_on_close;l.append(i,' 关闭窗口时隐藏到托盘');c.append(l,button('保存设置',()=>act({op:'settings',hide_on_close:i.checked},'设置已保存'),true));if(state.phase!=='signed_out')c.append(button('退出登录',()=>act({op:'logout'})));return}
  if(state.phase==='signed_out'){
    paintLogin(c)
    return
  }
  if(state.phase==='choose_tenant'){$('title').textContent='选择租户';for(const t of state.tenants)c.append(button(t.name,()=>act({op:'select_tenant',tenant_id:t.id})));if(!state.tenants.length)c.append(node('p','没有可用的租户，请联系管理员。'));return}
  if (activeTab==='messages') {
    paintMessages(c)
  } else {
    paintWorkbench(c)
  }
}

function canInstallUpdate(update) {
  return update?.phase==='available'||update?.phase==='failed'
}

function paintUpdate() {
  const update=state?.desktop_update
  updateButton.hidden=!update?.version||!Object.hasOwn(updateLabels,update.phase)
  if (updateButton.hidden) return
  updateButton.disabled=!canInstallUpdate(update)
  updateButton.title=`目标版本 ${update.version}`
  updateButton.textContent=updateLabels[update.phase]
  if (update.phase==='downloading'&&update.total_bytes>0&&Number.isFinite(update.downloaded_bytes)) {
    updateButton.textContent+=` ${Math.min(100,Math.floor(100*update.downloaded_bytes/update.total_bytes))}%`
  }
}

function openUpdateDialog() {
  const update=state?.desktop_update
  if (busy||!canInstallUpdate(update)||!update.version) return
  confirmedVersion=update.version
  $('desktop-update-version').textContent=confirmedVersion
  if (typeof updateDialog.showModal==='function') updateDialog.showModal()
  else {
    updateDialog.classList.add('dialog-fallback')
    updateDialog.setAttribute('open','')
  }
  $('cancel-desktop-update').focus()
}

function closeUpdateDialog() {
  confirmedVersion=undefined
  if (typeof updateDialog.close==='function') updateDialog.close()
  else updateDialog.removeAttribute('open')
  updateButton.focus()
}

async function installUpdate() {
  const version=confirmedVersion
  closeUpdateDialog()
  const update=state?.desktop_update
  if (!version||busy) return
  if (update?.version!==version||!canInstallUpdate(update)) {
    $('notice').textContent=errorText('update_unavailable')
    return
  }
  updateButton.disabled=true
  try {
    await act({op:'install_update',version})
  } finally {
    paintUpdate()
  }
}

function policyValue(item) {
  const value=item.value
  if (item.kind==='money_milli') return metricFormat.format(value/1000)+' 块'
  if (item.kind==='ratio_ppm') return metricFormat.format(value/1000000)+' 倍'
  if (item.kind==='boolean') return value?'开启':'关闭'
  if (Array.isArray(value)) return value.join('、')||'无授权'
  return String(value)
}

function paintWorkbench(content) {
  $('title').textContent='工作台'
  if (state.local_usage) {
    const usage=state.local_usage
    const heading=node('h2','本机本次运行')
    const totals=node('dl')
    totals.className='workbench-totals'
    for (const [label,value] of [['计量用量（块）',usage.cost_milli/1000],
      ['模型请求时长（秒）',usage.model_duration_ms/1000],['输入及输出 Token',usage.input_tokens+usage.output_tokens]]) {
      const metric=node('div')
      metric.append(node('dt',label),node('dd',metricFormat.format(value)))
      totals.append(metric)
    }
    content.append(heading,totals)
  }
  if (state.policy_pending) content.append(node('p','等待设备策略同步，受管启动暂时不可用。'))
  if (state.policy) {
    const details=node('details'), facts=node('dl')
    details.append(node('summary','能力配置 · v'+state.policy.policy_revision))
    for (const item of state.policy.display??[]) facts.append(node('dt',item.title),node('dd',policyValue(item)))
    details.append(facts)
    content.append(details)
  }
  content.append(node('h2','启动区'))
  if (!state.agents.length) {
    content.append(node('p','尚无获准的 Agent。请等待配置同步或联系管理员。'))
    return
  }
  const vendors=new Map()
  for (const agent of state.agents) {
    const vendor=agent.vendor||'其他厂商'
    const group=vendors.get(vendor)??[]
    group.push(agent)
    vendors.set(vendor,group)
  }
  for (const [vendor,agents] of vendors) {
    const group=node('div')
    group.className='agent-vendor'
    group.append(node('h3',vendor))
    for (const agent of agents) {
      const row=node('div')
      row.className='row'
      row.append(node('strong',agent.name),node('small',agent.version),node('span',Object.hasOwn(labels,agent.status)?labels[agent.status]:'状态未知'))
      if (agent.runtime_kind==='cli'&&agent.instance_count>0) row.append(node('span','运行实例 '+agent.instance_count))
      const transfer=agent.progress
      if (transfer&&transfer.total_bytes>0) {
        const progress=node('progress')
        progress.max=transfer.total_bytes
        progress.value=transfer.downloaded_bytes
        progress.setAttribute('aria-label',agent.name+' 下载进度')
        row.append(progress,node('small',Math.floor(progress.value/progress.max*100)+'%'))
      }
      if (agent.actions?.includes('download')) {
        row.append(button(agent.status==='download_failed'?'重试下载':'下载',()=>act({op:'download',agent_id:agent.id})))
      }
      if (agent.status!=='update_available'&&agent.actions?.includes('launch')) {
        row.append(button('启动',()=>act({op:'launch',agent_id:agent.id}),true))
      }
      if (agent.status==='failed'||agent.status==='download_failed') row.append(node('small','请稍后重试或联系管理员'))
      group.append(row)
    }
    content.append(group)
  }
}

function paintMessages(content) {
  $('title').textContent='消息列表'
  if (!state.notices?.length) {
    content.append(node('p','暂无配置变更消息。'))
    return
  }
  const list=node('ul')
  list.className='notice-list'
  for (const notice of state.notices) {
    const entry=node('li')
    const date=new Date(notice.at)
    const timestamp=Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN')
    entry.append(node('strong',notice.title),node('small',timestamp+' · 配置 v'+notice.policy_revision))
    list.append(entry)
  }
  content.append(list)
}

async function refresh() {
  if (!call||busy||document.hidden) return
  const seq=++serial
  try {
    const response=await call({op:'state'})
    if (seq!==serial) return
    if (!response.ok) {
      $('notice').textContent=errorText(response.error?.code)
      return
    }
    const serialized=JSON.stringify(response.state)
    if (last!==serialized) {
      const previousIds=new Set(state?.notices?.map(notice=>notice.id))
      if (state?.tenant?.id!==response.state.tenant?.id) seenNotices.clear()
      const latest=response.state.notices?.find(notice=>!previousIds.has(notice.id))
      if (activeTab==='messages') {
        for (const notice of (response.state.notices??[])) seenNotices.add(notice.id)
      }
      last=serialized
      state=response.state
      paint()
      if (latest && activeTab!=='messages') $('notice').textContent=latest.title
    }
  } catch {
    if (seq===serial) $('notice').textContent='无法读取本机状态，请检查 OneX 服务。'
  }
}

function openTab(tab) {
  if (!state||busy) return
  activeTab=tab
  if (tab==='messages') {
    for (const notice of (state.notices??[])) seenNotices.add(notice.id)
  }
  paint()
}

$('home').onclick=()=>openTab('workbench')
$('messages').onclick=()=>openTab('messages')
$('prefs').onclick=()=>openTab('settings')
updateButton.onclick=openUpdateDialog
$('cancel-desktop-update').onclick=closeUpdateDialog
$('confirm-desktop-update').onclick=installUpdate
updateDialog.onkeydown=event=>{
  if (event.key==='Escape') {
    event.preventDefault()
    closeUpdateDialog()
  }
}
if(!call){$('title').textContent='未连接桌面服务';$('content').textContent='请从 OneX Desktop 打开；浏览器演示请显式使用 ?mock=1。'}else{await refresh();setInterval(refresh,2000);document.addEventListener('visibilitychange',refresh)}
