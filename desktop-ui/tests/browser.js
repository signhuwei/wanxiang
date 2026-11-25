// 用管理端已锁定的浏览器测试依赖；不把测试资源打入 Tauri 窗口。
import { chromium } from '../../server/web/tests/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
const files=new Set(['index.html','app.js','app.css','mock.js'])
const sharedFiles=new Set(['theme.css','logo.png'])
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
  const name=new URL(req.url).pathname.slice(1)||'index.html'
  if(sharedFiles.has(name)) return new Response(Bun.file(new URL('../../server/web/'+name,import.meta.url)))
  return files.has(name)?new Response(Bun.file(new URL('../'+name,import.meta.url))):new Response(null,{status:404})
}})
const b=await chromium.launch({channel:'chrome'})
try{
  const p=await b.newPage({viewport:{width:620,height:580}});p.setDefaultTimeout(5000)
  await p.goto(server.url.href);await p.getByText('未连接桌面服务',{exact:true}).waitFor()
  await p.goto(server.url.href + '?mock=1')
  await p.getByText('版本 0.1.0-demo',{exact:true}).waitFor()
  assert(await p.locator('header .brand-mark').evaluate(mark=>mark.complete&&mark.naturalWidth>0))
  assert.equal(await p.locator('html').evaluate(html=>getComputedStyle(html).backgroundColor),'rgb(246, 248, 246)')
  await p.getByLabel('租户 ID 或简称').fill('demo')
  await p.getByLabel('用户名').fill('employee')
  const password = p.getByLabel('密码', {exact:true})
  assert.equal(await password.getAttribute('type'), 'password')
  await password.fill('bad-password')
  await p.getByRole('button', {name:'登录',exact:true}).click()
  await p.getByText('登录凭据无效或已过期', {exact:true}).waitFor()
  assert.equal(await password.inputValue(), '')
  await password.fill('Demo-Only-246810')
  await p.getByRole('button', {name:'登录',exact:true}).click()
  const update = p.locator('.row').filter({hasText:'有可用更新'})
  await update.waitFor()
  assert.equal(await update.getByRole('button').count(), 0)
  await p.getByRole('button', {name:'启动',exact:true}).click()
  await p.getByText('运行中', {exact:true}).waitFor()
  await p.getByRole('button', {name:'设置',exact:true}).click()
  await p.getByText('Desktop 版本：0.1.0-demo', {exact:true}).waitFor()
  await p.getByLabel('关闭窗口时隐藏到托盘').uncheck()
  await p.getByRole('button', {name:'保存设置'}).click()
  await p.getByText('设置已保存', {exact:true}).waitFor()
  assert.equal(await p.getByLabel('关闭窗口时隐藏到托盘').isChecked(), false)
  await p.getByRole('button', {name:'退出登录'}).click()
  await p.getByText('登录 OneX', {exact:true}).waitFor()
  assert.equal(await p.evaluate(() => localStorage.length), 0)
  const bridge=await b.newPage();bridge.setDefaultTimeout(3000)
  await bridge.addInitScript(()=>{
    let attempts=0
    window.__ONEX_DESKTOP_VERSION__='0.1.0-rc99'
    const pendingState=new Promise(resolve=>{window.resumeDesktopState=resolve})
    window.__TAURI__={core:{invoke:async (_, {request})=>{
      if(request.op==='state'){
        await pendingState
        return {ok:true,state:{version:'0.1.0-rc99',phase:'ready',tenant:null,connection:'idle',settings:{server_origin:'https://example.invalid',hide_on_close:true},agents:[{id:'test',name:'测试 Agent',status:'failed',message:'TEST-ONLY-RAW-TEXT',actions:['launch']}]}}
      }
      if(++attempts===1)return {ok:false,error:{code:'forbidden',message:'TEST-ONLY-RAW-TEXT'}}
      if(attempts===2)return {ok:false,error:{code:'toString',message:'TEST-ONLY-RAW-TEXT'}}
      throw Error('TEST-ONLY-RAW-TEXT')
    }}}
  })
  await bridge.goto(server.url.href)
  const version=bridge.locator('header').getByText('版本 0.1.0-rc99',{exact:true})
  await version.waitFor()
  await bridge.getByText('正在连接本机服务',{exact:true}).waitFor()
  const brandBox=await bridge.locator('header .brand b').boundingBox()
  const versionBox=await version.boundingBox()
  assert(versionBox.y>=brandBox.y+brandBox.height)
  await bridge.evaluate(()=>window.resumeDesktopState())
  await bridge.getByText('测试 Agent',{exact:true}).waitFor()
  assert(!await bridge.locator('body').innerText().then(text=>text.includes('TEST-ONLY-RAW-TEXT')))
  for(const safe of ['没有权限执行此操作','操作失败，请稍后重试','本机服务暂不可用，请稍后重试']){
    await bridge.getByRole('button',{name:'启动',exact:true}).click()
    await bridge.getByRole('status').getByText(safe,{exact:true}).waitFor()
  }
  const workbench=await b.newPage({viewport:{width:360,height:620}})
  await workbench.addInitScript(()=>{
    window.desktopInstallRequests=[]
    window.desktopLaunchRequests=[]
    window.desktopDaemonUpgrading=true
    window.__TAURI__={core:{invoke:async (_, {request})=>{
      if(request.op==='download') window.downloadRequested=request.agent_id
      if(request.op==='launch') window.desktopLaunchRequests.push(request)
      if(request.op==='install_update'){
        window.desktopInstallRequests.push(request)
        window.desktopUpdate={version:request.version,phase:'downloading',downloaded_bytes:25,total_bytes:100}
      }
      const downloading=!!window.downloadRequested
      return {ok:true,state:{
        version:'test',phase:'ready',tenant:{id:'ten_demo',name:'示例租户'},connection:'connected',
        settings:{server_origin:'https://example.invalid',hide_on_close:true},
        local_usage:{cost_milli:2125,model_duration_ms:2000,input_tokens:12,output_tokens:34},
        policy:{policy_revision:7,display:[{id:'lease.budget',title:'租约额度',kind:'money_milli',value:2125}]},
        desktop_update:window.desktopUpdate,
        notices:[{id:'pch_test',title:'能力配置已变更',at:'2026-11-21T05:44:00Z',policy_revision:7}],
        agents:[
          {id:'claude-code',vendor:'Anthropic',name:'Claude Code',status:downloading?'downloading':'not_downloaded',
            actions:downloading?[]:['download'],progress:downloading?{downloaded_bytes:15,total_bytes:30}:null},
          {id:'codex',vendor:'OpenAI',name:'Codex',status:'running',runtime_kind:'cli',instance_count:2,
            actions:window.desktopDaemonUpgrading?[]:['launch'],
            launch_blocked:window.desktopDaemonUpgrading?'daemon_update_pending':null},
          {id:'deepseek-desktop',vendor:'DeepSeek',name:'DeepSeek Harness',status:'available',runtime_kind:'gui',
            actions:window.desktopDaemonUpgrading?[]:['launch'],
            launch_blocked:window.desktopDaemonUpgrading?'daemon_update_pending':null},
        ],
      }}
    }}}
  })
  await workbench.goto(server.url.href)
  const deepseek=workbench.locator('.row').filter({hasText:'DeepSeek Harness'})
  const deepseekLaunch=deepseek.getByRole('button',{name:'启动',exact:true})
  await deepseekLaunch.waitFor()
  assert(await deepseekLaunch.isDisabled())
  assert.equal(await deepseek.getByText('可启动',{exact:true}).count(),0)
  const reasonId=await deepseekLaunch.getAttribute('aria-describedby')
  assert.equal(await deepseek.locator(`#${reasonId}`).innerText(),'等待后台更新')
  const codex=workbench.locator('.row').filter({hasText:'Codex'})
  assert(await codex.getByText('运行实例 2',{exact:true}).isVisible())
  assert(await codex.getByRole('button',{name:'启动',exact:true}).isDisabled())
  await workbench.evaluate(()=>{
    window.desktopDaemonUpgrading=false
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await deepseek.getByText('可启动',{exact:true}).waitFor()
  assert(await deepseekLaunch.isEnabled())
  await deepseekLaunch.click()
  assert.deepEqual(await workbench.evaluate(()=>window.desktopLaunchRequests),[{op:'launch',agent_id:'deepseek-desktop'}])
  await workbench.getByText('运行实例 2').waitFor()
  await workbench.getByText('2.125',{exact:true}).waitFor()
  await workbench.getByText('能力配置 · v7').click()
  await workbench.getByText('2.125 块',{exact:true}).waitFor()
  await workbench.getByRole('button',{name:'下载',exact:true}).click()
  const progress=workbench.getByRole('progressbar',{name:'Claude Code 下载进度'})
  assert.equal(await progress.getAttribute('value'),'15')
  assert.equal(await progress.getAttribute('max'),'30')
  await workbench.getByRole('button',{name:'消息列表（1）'}).click()
  await workbench.getByText('能力配置已变更',{exact:true}).first().waitFor()
  await workbench.getByRole('button',{name:'消息列表',exact:true}).waitFor()
  const updateButton=workbench.locator('header #desktop-update')
  assert.equal(await updateButton.isVisible(),false)
  await workbench.evaluate(()=>{
    window.desktopUpdate={version:'0.1.0-rc21',phase:'available'}
  })
  await updateButton.waitFor()
  assert.equal(await updateButton.innerText(),'有更新')
  assert.equal(await workbench.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await workbench.getByText('版本 test',{exact:true}).waitFor()
  await updateButton.click()
  const updateDialog=workbench.getByRole('dialog',{name:'重启更新 OneX Desktop'})
  await updateDialog.getByText('0.1.0-rc21',{exact:true}).waitFor()
  await updateDialog.getByText(/已启动的 Agent 会继续运行，重启后仍可在工作台管理/).waitFor()
  assert.deepEqual(await workbench.evaluate(()=>window.desktopInstallRequests),[])
  await workbench.keyboard.press('Escape')
  await updateDialog.waitFor({state:'hidden'})
  await updateButton.click()
  await updateDialog.getByRole('button',{name:'取消',exact:true}).click()
  assert.deepEqual(await workbench.evaluate(()=>window.desktopInstallRequests),[])
  await updateButton.click()
  await workbench.evaluate(()=>{
    window.desktopUpdate={version:'0.1.0-rc22',phase:'available'}
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await workbench.waitForFunction(()=>document.getElementById('desktop-update').title==='目标版本 0.1.0-rc22')
  await updateDialog.getByRole('button',{name:'重启更新',exact:true}).click()
  await workbench.getByRole('status').getByText('当前更新已不可用，请稍后重试',{exact:true}).waitFor()
  assert.deepEqual(await workbench.evaluate(()=>window.desktopInstallRequests),[])
  await updateButton.click()
  await updateDialog.getByText('0.1.0-rc22',{exact:true}).waitFor()
  await updateDialog.getByRole('button',{name:'重启更新',exact:true}).click()
  await workbench.getByRole('button',{name:'下载更新中 25%',exact:true}).waitFor()
  assert(await updateButton.isDisabled())
  assert.deepEqual(await workbench.evaluate(()=>window.desktopInstallRequests),[{op:'install_update',version:'0.1.0-rc22'}])
  await workbench.evaluate(()=>{
    window.desktopUpdate={version:'0.1.0-rc22',phase:'failed'}
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await workbench.getByRole('button',{name:'重试更新',exact:true}).waitFor()
  assert.equal(await updateButton.isEnabled(),true)
  for(const [phase,label] of [
    ['waiting_for_agents','等待 Agent 退出'],
    ['updating_components','正在更新 CLI 和后台服务'],
    ['components_failed','组件更新未完成'],
    ['restarting_daemon','正在切换后台服务'],
    ['daemon_restart_required','后台服务待重启']
  ]){
    await workbench.evaluate(phase=>{
      window.desktopUpdate={version:'0.1.0-rc22',phase}
      document.dispatchEvent(new Event('visibilitychange'))
    },phase)
    await workbench.getByRole('button',{name:label,exact:true}).waitFor()
    assert(await updateButton.isDisabled())
    assert.equal(await workbench.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  }
  console.log('Desktop：登录、设置、桥错误、配置消息、实例计数、下载进度及更新确认通过')
}finally{await b.close();server.stop(true)}
