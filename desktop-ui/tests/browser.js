// 用管理端已锁定的浏览器测试依赖；不把测试资源打入 Tauri 窗口。
import { chromium } from '../../server/web/tests/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
const files=new Set(['index.html','app.js','app.css','mock.js'])
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const name=new URL(req.url).pathname.slice(1)||'index.html';return files.has(name)?new Response(Bun.file(new URL('../'+name,import.meta.url))):new Response(null,{status:404})}})
const b=await chromium.launch({channel:'chrome'})
try{
  const p=await b.newPage({viewport:{width:620,height:580}});p.setDefaultTimeout(5000)
  await p.goto(server.url.href);await p.getByText('未连接桌面服务',{exact:true}).waitFor()
  await p.goto(server.url.href+'?mock=1');await p.getByLabel('邮箱或手机号').fill('demo@example.test');await p.getByLabel('邀请码（选填）').fill('DEMO');await p.getByRole('button',{name:'发送验证码'}).click();await p.getByLabel('验证码',{exact:true}).fill('246810');await p.getByRole('button',{name:'登录',exact:true}).click();await p.getByRole('button',{name:'示例实验室'}).click();const update=p.locator('.row').filter({hasText:'有可用更新'});await update.waitFor();assert.equal(await update.getByRole('button').count(),0);await p.getByRole('button',{name:'启动',exact:true}).click();await p.getByText('运行中',{exact:true}).waitFor();await p.getByRole('button',{name:'设置',exact:true}).click();await p.getByText('Desktop 版本：0.1.0-demo',{exact:true}).waitFor();await p.getByLabel('关闭窗口时隐藏到托盘').uncheck();await p.getByRole('button',{name:'保存设置'}).click();await p.getByText('设置已保存',{exact:true}).waitFor();assert.equal(await p.getByLabel('关闭窗口时隐藏到托盘').isChecked(),false);await p.getByRole('button',{name:'退出登录'}).click();await p.getByText('登录 OneX',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>localStorage.length),0)
  const bridge=await b.newPage();bridge.setDefaultTimeout(3000)
  await bridge.addInitScript(()=>{
    let attempts=0
    window.__TAURI__={core:{invoke:async (_, {request})=>{
      if(request.op==='state')return {ok:true,state:{version:'test',phase:'ready',tenant:null,connection:'idle',settings:{server_origin:'https://example.invalid',hide_on_close:true},agents:[{id:'test',name:'测试 Agent',status:'failed',message:'TEST-ONLY-RAW-TEXT',actions:['launch']}]}}
      if(++attempts===1)return {ok:false,error:{code:'forbidden',message:'TEST-ONLY-RAW-TEXT'}}
      if(attempts===2)return {ok:false,error:{code:'toString',message:'TEST-ONLY-RAW-TEXT'}}
      throw Error('TEST-ONLY-RAW-TEXT')
    }}}
  })
  await bridge.goto(server.url.href)
  await bridge.getByText('测试 Agent',{exact:true}).waitFor()
  assert(!await bridge.locator('body').innerText().then(text=>text.includes('TEST-ONLY-RAW-TEXT')))
  for(const safe of ['没有权限执行此操作','操作失败，请稍后重试','本机服务暂不可用，请稍后重试']){
    await bridge.getByRole('button',{name:'启动',exact:true}).click()
    await bridge.getByRole('status').getByText(safe,{exact:true}).waitFor()
  }
  const workbench=await b.newPage({viewport:{width:360,height:620}})
  await workbench.addInitScript(()=>{
    window.__TAURI__={core:{invoke:async (_, {request})=>{
      if(request.op==='download') window.downloadRequested=request.agent_id
      const downloading=!!window.downloadRequested
      return {ok:true,state:{
        version:'test',phase:'ready',tenant:{id:'ten_demo',name:'示例租户'},connection:'connected',
        settings:{server_origin:'https://example.invalid',hide_on_close:true},
        local_usage:{cost_milli:2125,model_duration_ms:2000,input_tokens:12,output_tokens:34},
        policy:{policy_revision:7,display:[{id:'lease.budget',title:'租约额度',kind:'money_milli',value:2125}]},
        notices:[{id:'pch_test',title:'能力配置已变更',at:'2026-11-21T05:44:00Z',policy_revision:7}],
        agents:[
          {id:'claude-code',vendor:'Anthropic',name:'Claude Code',status:downloading?'downloading':'not_downloaded',
            actions:downloading?[]:['download'],progress:downloading?{downloaded_bytes:15,total_bytes:30}:null},
          {id:'codex',vendor:'OpenAI',name:'Codex',status:'running',runtime_kind:'cli',instance_count:2,actions:['launch']},
        ],
      }}
    }}}
  })
  await workbench.goto(server.url.href)
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
  console.log('Desktop：登录、设置、桥错误、配置消息、实例计数及下载进度通过')
}finally{await b.close();server.stop(true)}
