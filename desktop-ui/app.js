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
let state,busy=false,activeTab='workbench',last='',serial=0,pendingLaunch
const seenNotices=new Set()
const messages={unauthenticated:'登录凭据无效或已过期',forbidden:'没有权限执行此操作',not_found:'对象不存在',conflict:'状态已变化，请刷新后重试',device_already_logged_in:'本机 OneX 已登录。请用同一租户和账号登录，或先用 OneX 命令行退出。',agents_running:'请先关闭已启动的 OneX Agent',history_unavailable:'暂时无法恢复当前账号的本机会话',invalid:'请检查输入内容',seat_limit:'租户人数已达合约上限',balance_exhausted:'橡皮余额不足',lease_expired:'额度租约已过期',agent_not_allowed:'合约不允许该 Agent',model_not_allowed:'合约不允许该模型',rate_limited:'请求过快，请稍后重试',upstream_error:'上游服务出错',update_unavailable:'当前更新已不可用，请稍后重试',update_failed:'Desktop 更新失败，请重试',internal:'服务内部错误'}
Object.assign(messages,{cwd_required:'请选择可访问的工作目录',terminal_unavailable:'无法启动系统终端，请检查 OneX CLI 安装或查看诊断日志',
  tool_bundle_unavailable:'无法下载或校验受管工具制品，见底部诊断日志'})
const errorText=code=>typeof code==='string' && Object.hasOwn(messages,code) ? messages[code] : '操作失败，请稍后重试'
const labels={update_available:'有可用更新',available:'可启动',not_downloaded:'待下载',downloading:'下载中',verifying:'校验中',starting:'启动中',running:'运行中',failed:'启动失败',download_failed:'下载失败',policy_pending:'等待配置同步'}
const agentTones={running:'good',available:'good',update_available:'attention',downloading:'attention',verifying:'attention',starting:'attention',policy_pending:'attention',failed:'error',download_failed:'error'}
const launchBlockLabels={daemon_update_pending:'等待后台更新',launch_in_progress:'等待当前启动完成'}
const agentMarks={claude:'C',codex:'›_',kimi:'K',deepseek:'D',workbuddy:'W'}
const updateLabels={available:'有更新',downloading:'下载更新中',installing:'安装更新中',failed:'重试更新',
  waiting_for_agents:'等待 Agent 退出',updating_components:'正在更新 CLI 和后台服务',components_failed:'组件更新未完成',
  restarting_daemon:'正在切换后台服务',daemon_restart_required:'后台服务待重启'}
const updateButton=$('desktop-update')
const updateDialog=$('desktop-update-dialog')
let confirmedVersion
const metricFormat=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3})
function node(tag,text){const n=document.createElement(tag);if(text!=null)n.textContent=text;return n}
function styled(tag,className,text){const n=node(tag,text);n.className=className;return n}
function button(text,click,primary=false){const b=node('button',text);b.type='button';b.onclick=click;if(primary)b.className='primary';return b}
function field(form,label,type,placeholder){const l=node('label',label),i=node('input');i.type=type;i.placeholder=placeholder||'';l.append(i);form.append(l);return i}
function showNotice(text='',attention=false) {
  const notice=$('notice')
  notice.dataset.tone=attention?'attention':'neutral'
  notice.textContent=text
}
async function act(request,message=''){
  if(!call||busy)return
  if(pendingLaunch){showNotice('请等待当前 Agent 启动完成');return}
  busy=true;serial++; const pane=$('content');pane.inert=true
  try{const r=await call(request);if(!r.ok){showNotice(errorText(r.error?.code),true);return}bindState(r.state);if(request.op==='logout')activeTab='workbench';paint();showNotice(message)}
  catch{showNotice('本机服务暂不可用，请稍后重试',true)}finally{pane.inert=false;busy=false;refreshDiagnostics()}
}

async function launchAgent(agent) {
  if (!call||busy||pendingLaunch) return
  const tenant=state.tenant?.id,user=state.user?.name
  pendingLaunch={id:agent.id,workspaceObserved:false}
  serial++
  paint()
  showNotice(`${agent.name} · ${launchStage(agent)}`)
  try {
    const result=await call({op:'launch',agent_id:agent.id})
    if (state.phase!=='ready'||state.tenant?.id!==tenant||state.user?.name!==user) return
    serial++
    if (!result.ok) {
      const code=result.error?.code
      if (code==='launch_cancelled') showNotice('已取消启动')
      else showNotice(errorText(code),true)
      return
    }
    bindState(result.state)
    showNotice()
  } catch {
    showNotice('本机服务暂不可用，请稍后重试',true)
  } finally {
    pendingLaunch=null
    paint()
    refreshDiagnostics()
  }
}

function launchStage(agent) {
  if (agent.workspace_pending) return '等待选择工作目录'
  if (agent.status==='downloading') return '正在下载 Agent'
  if (agent.status==='verifying') return '正在校验 Agent'
  if (agent.status==='starting') return '等待 Agent 就绪'
  if (agent.runtime_kind==='cli'&&!pendingLaunch.workspaceObserved&&agent.launch_blocked!=='launch_in_progress') return '等待选择工作目录'
  return '正在准备启动'
}

function paintLogin(content) {
  $('title').textContent = '登录 OneX'
  const form = styled('form', 'surface form-surface login-form')
  content.append(form)
  if (demo) form.append(styled('p', 'demo-help', '演示账号 · 租户 demo · 用户名 employee · 密码 Demo-Only-246810'))

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

function paintSettings(content) {
  $('title').textContent='设置'
  const panel=styled('div','surface form-surface')
  const facts=styled('div','settings-facts')
  facts.append(node('p','Desktop 版本：'+(state.version||'未知')),node('p','服务地址：'+state.settings.server_origin))
  const toggle=styled('label','setting-toggle'),checkbox=node('input')
  checkbox.type='checkbox'
  checkbox.checked=state.settings.hide_on_close
  toggle.append(checkbox,'关闭窗口时隐藏到托盘')
  const actions=styled('div','form-actions')
  actions.append(button('保存设置',()=>act({op:'settings',hide_on_close:checkbox.checked},'设置已保存'),true))
  if (state.phase!=='signed_out') {
    const logout=button('退出登录',()=>act({op:'logout'}))
    logout.classList.add('danger')
    actions.append(logout)
  }
  panel.append(facts,toggle,actions)
  content.append(panel)
}

function paint(){
  if (!installedVersion) showVersion(state.version)
  paintUpdate()
  const c=$('content')
  c.replaceChildren()
  const scope=$('scope'),connection=$('connection')
  scope.textContent=[state.tenant?.name,state.user?.name].filter(Boolean).join(' · ')
  scope.hidden=!scope.textContent
  connection.hidden=state.phase!=='ready'
  connection.textContent=({connected:'已连接',connecting:'连接中',backoff:'断线重连中',idle:'未连接'}[state.connection]||'未连接')
  connection.dataset.tone=state.connection==='connected'?'good':state.connection==='connecting'||state.connection==='backoff'?'attention':'neutral'
  $('messages').hidden=state.phase!=='ready'
  const unread=(state.notices??[]).filter(notice=>!seenNotices.has(notice.id)).length
  $('messages-label').textContent=unread?`消息列表（${unread}）`:'消息列表'
  for (const [id,tab] of [['home','workbench'],['messages','messages'],['prefs','settings']]) {
    $(id).setAttribute('aria-current',activeTab===tab?'page':'false')
  }
  if(activeTab==='settings') { paintSettings(c);return }
  if(state.phase==='signed_out'){
    paintLogin(c)
    return
  }
  if(state.phase==='choose_tenant') {
    $('title').textContent='选择租户'
    const list=styled('div','surface form-surface tenant-list')
    for (const tenant of state.tenants) list.append(button(tenant.name,()=>act({op:'select_tenant',tenant_id:tenant.id})))
    if (!state.tenants.length) list.append(node('p','没有可用的租户，请联系管理员。'))
    c.append(list)
    return
  }
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
  updateButton.disabled=!!pendingLaunch||!canInstallUpdate(update)
  updateButton.title={
    components_failed:'重新打开 Desktop 后重试组件切换',
    daemon_restart_required:'现有后台版本需要手动切换，请先结束运行中的 Agent'
  }[update.phase]??`目标版本 ${update.version}`
  updateButton.textContent=updateLabels[update.phase]
  if (update.phase==='downloading'&&update.total_bytes>0&&Number.isFinite(update.downloaded_bytes)) {
    updateButton.textContent+=` ${Math.min(100,Math.floor(100*update.downloaded_bytes/update.total_bytes))}%`
  }
}

function openUpdateDialog() {
  const update=state?.desktop_update
  if (busy||pendingLaunch||!canInstallUpdate(update)||!update.version) return
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
    showNotice(errorText('update_unavailable'),true)
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

function paintUsage(content,usage) {
  const panel=styled('section','usage-panel')
  const heading=styled('h2','section-title','本机本次运行')
  heading.id='usage-heading'
  panel.setAttribute('aria-labelledby',heading.id)
  const totals=styled('dl','workbench-totals')
  for (const [label,value] of [['计量用量（块）',usage.cost_milli/1000],
    ['模型请求时长（秒）',usage.model_duration_ms/1000],['输入及输出 Token',usage.input_tokens+usage.output_tokens]]) {
    const metric=node('div')
    metric.append(node('dt',label),node('dd',metricFormat.format(value)))
    totals.append(metric)
  }
  panel.append(heading,totals)
  content.append(panel)
}

function paintAgent(agent) {
  const row=styled('div','row')
  const requested=pendingLaunch?.id===agent.id
  const starting=requested||agent.status==='starting'
  const launchBlock=Object.hasOwn(launchBlockLabels,agent.launch_blocked)?launchBlockLabels[agent.launch_blocked]:null
  const canLaunch=agent.status!=='update_available'&&!launchBlock&&agent.actions?.includes('launch')
  const family=agent.id.split('-')[0]
  const mark=styled('span','agent-mark',Object.hasOwn(agentMarks,family)?agentMarks[family]:'AI')
  mark.dataset.mark=family
  mark.setAttribute('aria-hidden','true')
  const identity=styled('div','agent-copy'),name=styled('div','agent-name'),meta=styled('div','agent-meta')
  name.append(node('strong',agent.name))
  if (agent.version) name.append(styled('small','agent-version',agent.version))
  const waitingToLaunch=agent.status==='available'&&!canLaunch
  const statusLabel=waitingToLaunch?(launchBlock??'暂不可启动'):Object.hasOwn(labels,agent.status)?labels[agent.status]:'状态未知'
  const status=styled('span','agent-status',statusLabel)
  status.dataset.tone=!waitingToLaunch&&Object.hasOwn(agentTones,agent.status)?agentTones[agent.status]:'neutral'
  meta.append(status)
  if (agent.runtime_kind==='cli'&&agent.instance_count>0) meta.append(styled('span','instance-count','运行实例 '+agent.instance_count))
  if (starting) row.classList.add('agent-launching')
  if (requested) {
    const indicator=styled('span','agent-status launch-feedback',launchStage(agent))
    indicator.dataset.tone='attention'
    indicator.setAttribute('aria-live','polite')
    meta.append(indicator)
  } else if (starting) status.classList.add('launch-feedback')
  const launchBlockId=`agent-launch-block-${agent.id}`
  if (launchBlock) {
    const reason=waitingToLaunch?status:styled('span','agent-status',launchBlock)
    reason.id=launchBlockId
    reason.dataset.tone='attention'
    if (!waitingToLaunch) meta.append(reason)
  }
  identity.append(name,meta)
  row.append(mark,identity)

  const actions=styled('div','agent-actions')
  if (agent.actions?.includes('download')) {
    const download=button(agent.status==='download_failed'?'重试下载':'下载',()=>act({op:'download',agent_id:agent.id}))
    download.disabled=!!pendingLaunch
    actions.append(download)
  }
  if (canLaunch||launchBlock||starting) {
    const launch=button(starting?'启动中…':'启动',canLaunch?()=>launchAgent(agent):null)
    launch.classList.add('launch-button')
    launch.disabled=!!pendingLaunch||!!launchBlock||starting
    if (launchBlock) {
      launch.disabled=true
      launch.setAttribute('aria-describedby',launchBlockId)
    }
    if (!starting) {
      const arrow=styled('span','action-icon','↗')
      arrow.setAttribute('aria-hidden','true')
      launch.append(arrow)
    }
    actions.append(launch)
  }
  if (actions.childElementCount) row.append(actions)

  const transfer=agent.progress
  if (transfer&&transfer.total_bytes>0) {
    const line=styled('div','agent-transfer'),progress=node('progress')
    progress.max=transfer.total_bytes
    progress.value=transfer.downloaded_bytes
    progress.setAttribute('aria-label',agent.name+' 下载进度')
    line.append(progress,node('span',Math.floor(progress.value/progress.max*100)+'%'))
    row.append(line)
  }
  if (agent.status==='failed'||agent.status==='download_failed') row.append(styled('small','agent-hint','请稍后重试或联系管理员'))
  return row
}

function paintWorkbench(content) {
  $('title').textContent='工作台'
  if (state.local_usage) paintUsage(content,state.local_usage)
  if (state.policy_pending) content.append(styled('p','inline-notice','等待设备策略同步，受管启动暂时不可用。'))
  if (state.policy) {
    const details=styled('details','policy-panel'), facts=node('dl')
    details.append(node('summary','能力配置 · v'+state.policy.policy_revision))
    for (const item of state.policy.display??[]) facts.append(node('dt',item.title),node('dd',policyValue(item)))
    details.append(facts)
    content.append(details)
  }
  const launch=styled('section','launch-panel'),heading=node('h2','启动区')
  heading.id='launch-heading'
  launch.setAttribute('aria-labelledby',heading.id)
  launch.append(heading)
  content.append(launch)
  if (!state.agents.length) {
    launch.append(styled('p','empty-state','尚无获准的 Agent。请等待配置同步或联系管理员。'))
    return
  }
  const vendors=new Map()
  for (const agent of state.agents) {
    const vendor=agent.vendor||'其他厂商'
    const group=vendors.get(vendor)??[]
    group.push(agent)
    vendors.set(vendor,group)
  }
  const catalog=styled('div','agent-catalog')
  for (const [vendor,agents] of vendors) {
    const group=styled('div','agent-vendor')
    group.append(node('h3',vendor))
    for (const agent of agents) group.append(paintAgent(agent))
    catalog.append(group)
  }
  launch.append(catalog)
}

function paintMessages(content) {
  $('title').textContent='消息列表'
  if (!state.notices?.length) {
    content.append(styled('p','empty-state','暂无配置变更消息。'))
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

const diagnostics=$('diagnostics')
const diagnosticSources={desktop:'Desktop',daemon:'onexd'}
const diagnosticLevels={info:'信息',warn:'警告',error:'错误'}
const diagnosticEvents={
  launch_requested:'开始准备启动',launch_accepted:'已受理启动',launch_cancelled:'已取消启动',
  launch_rejected:'启动失败',download_accepted:'已受理下载',download_rejected:'下载失败',daemon_started:'后台启动',router_listening:'本地路由就绪',
  ws_connected:'已连接服务',ws_disconnected:'服务连接断开',config_applied:'已应用设备配置',config_rejected:'设备配置被拒绝',
  lease_rejected:'租约被拒绝',upstream_failed:'上游请求失败',agent_artifact_failed:'Agent 制品未就绪',
  tool_bundle_failed:'受管工具下载或校验失败',tool_prepare_failed:'准备受管工具失败',desktop_bundle_rejected:'桌面 Agent 制品被拒绝',
  desktop_profile_rejected:'桌面 Agent 配置被拒绝',desktop_spawn_failed:'无法启动桌面 Agent 进程',agent_prepared:'Agent 启动参数已就绪',
  agent_exited:'Agent 已退出',desktop_exited:'桌面 Agent 已退出',ipc_failed:'本机服务连接失败',daemon_failed:'后台异常退出'
}
const diagnosticCodes={policy_tools_invalid:'受管工具无效或不适用',policy_agents_invalid:'Agent 发行不适用',
  policy_revision_invalid:'策略修订号无效或已回退',policy_identity_invalid:'策略与登录身份不符',
  policy_rates_invalid:'路由与费率不一致',policy_abi_unsupported:'设备策略版本不受支持',
  tool_origin_invalid:'服务地址无效',tool_transport_required:'受管工具要求受信下载地址',tool_descriptor_invalid:'工具发行描述无效',
  tool_request_failed:'工具下载请求失败',tool_http_status:'工具下载返回 HTTP 错误',tool_response_failed:'读取工具文件失败',
  tool_size_mismatch:'工具文件大小不符',tool_digest_mismatch:'工具文件摘要不符',tool_bundle_invalid:'工具包格式无效'}
const diagnosticComponents=new Set(['onex_desktop::bridge','onexd','onexd::ipc','onexd::ws','onexd::router'])
const diagnosticStages=new Set(['origin','descriptor','request','response','integrity','bundle'])
const diagnosticAgents={'claude-code':'Claude Code',codex:'Codex CLI','kimi-code':'Kimi Code','deepseek-desktop':'DeepSeek Desktop',
  workbuddy:'WorkBuddy','codex-desktop':'Codex Desktop','claude-desktop':'Claude Desktop'}
const diagnosticTime=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
const safeVersion=version=>typeof version==='string'&&/^\d[\w.+-]{0,47}$/.test(version)?version:null
const lookup=(dictionary,key)=>typeof key==='string'&&Object.hasOwn(dictionary,key)?dictionary[key]:null
let diagnosticData,diagnosticsTicket=0,diagnosticsPending=false,diagnosticsError=false,diagnosticRows=new Map()

function clearDiagnostics() {
  diagnosticsTicket++
  diagnosticData=null
  diagnosticRows.clear()
  $('diagnostics-events').replaceChildren()
  diagnosticsError=false
  paintDiagnostics()
}

function diagnosticDetails(event, fields) {
  const details=styled('details','diagnostics-details')
  const summary=node('summary','详细')
  summary.setAttribute('aria-label',`${event}的详细信息`)
  const list=styled('dl','diagnostics-fields')
  for (const [name,value] of fields) {
    const item=node('dd')
    item.append(node('code',value))
    list.append(node('dt',name),item)
  }
  details.append(summary,list)
  return details
}

function paintDiagnostics() {
  if (!diagnostics.open) return
  const entries=$('diagnostics-events'),hint=$('diagnostics-hint')
  const desktop=safeVersion(diagnosticData?.desktop_version)??safeVersion(installedVersion??state?.version)??'—'
  const daemon=safeVersion(diagnosticData?.daemon_version)??'—'
  $('diagnostics-versions').textContent=`Desktop ${desktop} · onexd ${daemon} · 本地时间`
  const sourceFilter=$('diagnostics-source').value,levelFilter=$('diagnostics-level').value
  const query=$('diagnostics-query').value.trim().toLowerCase()
  const rows=[],nextRows=new Map(),occurrences=new Map()
  for (const entry of diagnosticData?.entries??[]) {
    const source=lookup(diagnosticSources,entry.source),level=lookup(diagnosticLevels,entry.level),event=lookup(diagnosticEvents,entry.event)
    const time=new Date(entry.at_ms)
    if (!source||!level||!event||!Number.isFinite(time.getTime())) continue
    const agent=lookup(diagnosticAgents,entry.agent),error=lookup(diagnosticCodes,entry.code)??lookup(messages,entry.code)
    const component=diagnosticComponents.has(entry.component)?entry.component:null
    const stage=diagnosticStages.has(entry.stage)?entry.stage:null
    const revision=Number.isSafeInteger(entry.config_revision)&&entry.config_revision>=0?entry.config_revision:null
    const exitCode=Number.isSafeInteger(entry.exit_code)?entry.exit_code:null
    const http=Number.isInteger(entry.http_status)&&entry.http_status>=100&&entry.http_status<=599?entry.http_status:null
    const version=safeVersion(entry.version),timestamp=diagnosticTime.format(time)
    const description=[event,agent,error,revision==null?null:`配置 #${revision}`,exitCode==null?null:`退出码 ${exitCode}`].filter(Boolean).join(' · ')
    const fields=[['UTC 时间',time.toISOString()],['事件',entry.event],['模块',component],['版本',version],['Agent',agent?entry.agent:null],
      ['错误代码',error?entry.code:null],['执行阶段',stage],['HTTP 状态',http],['配置修订号',revision],['退出码',exitCode]]
      .filter(([,value])=>value!=null)
    const fingerprint=JSON.stringify([entry.source,entry.level,description,fields])
    const occurrence=(occurrences.get(fingerprint)??0)+1
    occurrences.set(fingerprint,occurrence)
    const key=`${occurrence}:${fingerprint}`
    let row=diagnosticRows.get(key)
    if (!row) {
      row=styled('li','diagnostics-entry')
      row.dataset.level=entry.level
      const when=node('time',timestamp)
      when.dateTime=time.toISOString()
      row.append(when,styled('span','diagnostics-tag',`${level} · ${source}${version?' '+version:''}`),
        styled('span','diagnostics-description',description),diagnosticDetails(event,fields))
    }
    nextRows.set(key,row)
    if ((sourceFilter&&entry.source!==sourceFilter)||(levelFilter&&entry.level!==levelFilter)) continue
    if (query&&![timestamp,source,level,description,...fields.flat()].join(' ').toLowerCase().includes(query)) continue
    rows.push(row)
  }
  diagnosticRows=nextRows
  const scroll=entries.scrollTop
  const focus=document.activeElement
  const visible=new Set(rows)
  for (const row of [...entries.children]) if (!visible.has(row)) row.remove()
  for (const [index,row] of rows.entries()) {
    if (entries.children[index]!==row) entries.insertBefore(row,entries.children[index]??null)
  }
  if (entries.contains(focus)&&document.activeElement!==focus) focus.focus({preventScroll:true})
  entries.scrollTop=scroll
  hint.textContent=diagnosticsError?'暂时无法读取诊断日志。':!diagnosticData?'正在读取诊断日志…':rows.length?'':query||sourceFilter||levelFilter?'没有匹配的日志。':'当前没有诊断记录。'
  hint.hidden=!hint.textContent
}

async function refreshDiagnostics() {
  if (!call||!diagnostics.open||diagnosticsPending||document.hidden) return
  diagnosticsPending=true
  const ticket=diagnosticsTicket
  try {
    const reply=await call({op:'diagnostics'})
    if (ticket!==diagnosticsTicket) return
    diagnosticsError=!reply.ok||!Array.isArray(reply.diagnostics?.entries)
    if (!diagnosticsError) diagnosticData=reply.diagnostics
  } catch {
    if (ticket===diagnosticsTicket) diagnosticsError=true
  } finally {
    diagnosticsPending=false
    if (ticket!==diagnosticsTicket) refreshDiagnostics()
    else paintDiagnostics()
  }
}

function bindState(next) {
  const changedScope=state?.phase!==next.phase||state?.tenant?.id!==next.tenant?.id||state?.user?.name!==next.user?.name
  state=next
  last=JSON.stringify(next)
  if (pendingLaunch&&!changedScope) {
    const agent=state.agents.find(agent=>agent.id===pendingLaunch.id)
    if (agent) {
      pendingLaunch.workspaceObserved ||= agent.workspace_pending
      showNotice(`${agent.name} · ${launchStage(agent)}`)
    }
  }
  if (changedScope) {
    seenNotices.clear()
    clearDiagnostics()
  }
}

async function refresh() {
  if (!call||busy||document.hidden) return
  const seq=++serial
  try {
    const response=await call({op:'state'})
    if (seq!==serial) return
    if (!response.ok) {
      showNotice(errorText(response.error?.code),true)
      return
    }
    const serialized=JSON.stringify(response.state)
    if (last!==serialized) {
      const previousIds=new Set(state?.notices?.map(notice=>notice.id))
      const latest=response.state.notices?.find(notice=>!previousIds.has(notice.id))
      bindState(response.state)
      if (activeTab==='messages') {
        for (const notice of (response.state.notices??[])) seenNotices.add(notice.id)
      }
      paint()
      if (latest && activeTab!=='messages'&&!pendingLaunch) showNotice(latest.title)
    }
  } catch {
    if (seq===serial&&!pendingLaunch) showNotice('无法读取本机状态，请检查 OneX 服务。',true)
  }
}

function openTab(tab) {
  if (!state||busy) return
  activeTab=tab
  if (!pendingLaunch) showNotice()
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
diagnostics.ontoggle=()=>{if(diagnostics.open){paintDiagnostics();refreshDiagnostics()}}
for (const id of ['diagnostics-source','diagnostics-level','diagnostics-query']) $(id).oninput=paintDiagnostics
if(!call){$('title').textContent='未连接桌面服务';$('content').append(styled('p','empty-state','请从 OneX Desktop 打开；浏览器演示请显式使用 ?mock=1。'))}else{
  $('diagnostics-footer').hidden=false
  await refresh()
  const poll=()=>{refresh();refreshDiagnostics()}
  setInterval(poll,2000)
  document.addEventListener('visibilitychange',poll)
}
