// 用管理端已锁定的浏览器测试依赖；不把测试资源打入 Tauri 窗口。
import { chromium } from '../../server/web/tests/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
const files=new Set(['index.html','app.js','app.css','mock.js'])
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const name=new URL(req.url).pathname.slice(1)||'index.html';return files.has(name)?new Response(Bun.file(new URL('../'+name,import.meta.url))):new Response(null,{status:404})}})
const b=await chromium.launch({channel:'chrome'})
try{
  const p=await b.newPage({viewport:{width:620,height:580}});p.setDefaultTimeout(5000)
  await p.goto(server.url.href);await p.getByText('未连接桌面服务',{exact:true}).waitFor()
  await p.goto(server.url.href+'?mock=1');await p.getByLabel('邮箱或手机号').fill('demo@example.test');await p.getByLabel('邀请码（选填）').fill('DEMO');await p.getByRole('button',{name:'发送验证码'}).click();await p.getByLabel('验证码',{exact:true}).fill('246810');await p.getByRole('button',{name:'登录',exact:true}).click();await p.getByRole('button',{name:'示例实验室'}).click();await p.getByRole('button',{name:'启动',exact:true}).click();await p.getByText('运行中',{exact:true}).waitFor();await p.getByRole('button',{name:'设置',exact:true}).click();await p.getByLabel('关闭窗口时隐藏到托盘').uncheck();await p.getByRole('button',{name:'保存设置'}).click();await p.getByText('设置已保存',{exact:true}).waitFor();assert.equal(await p.getByLabel('关闭窗口时隐藏到托盘').isChecked(),false);await p.getByRole('button',{name:'退出登录'}).click();await p.getByText('登录 OneX',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>localStorage.length),0)
  console.log('Desktop mock：无桥提示、OTP+邀请、选租户、启动、设置、登出通过')
}finally{await b.close();server.stop(true)}
