// stream and ingest are real; only the Edge device and conversation are test data.
import assert from 'node:assert/strict'
import { day, hash, iso, randomToken } from '../../src/credentials.ts'
import { indexDevice } from '../../src/store.ts'

export async function checkLiveObservation({app, seed, page, target, capture}) {
  const { tenantId, userId } = seed
  const device = 'dev_'+crypto.randomUUID(), session = 'ses_'+crypto.randomUUID(), token = randomToken()
  const db = app.store.tenant(tenantId)
  await db.write(sql=>sql.run(`INSERT INTO devices (id,user_id,name,os,arch,public_key,token_hash,token_expires_at,status)
    VALUES (?,?,'Integration Edge','darwin','arm64','',?,?,'active')`, [device,userId,hash(token),iso(Date.now()+day)]))
  await app.store.system.write(sql=>indexDevice(sql,tenantId,{id:device,token_hash:hash(token)}))
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/v1/edge/ws`,{headers:{Authorization:'Bearer '+token,'OneX-Edge-Version':'0.1.0','OneX-Protocol':'0'}})
  const ready = Promise.withResolvers(), ack = Promise.withResolvers()
  const send = obj=>ws.send(JSON.stringify(obj))
  const event = (seq,kind,payload)=>({seq,session_id:session,at:iso(Date.now()),kind,payload})
  ws.onopen=()=>send({type:'hello',id:'hello',edge_version:'0.1.0',os:'darwin',arch:'arm64',config_revision:0,outbox_last_seq:0})
  ws.onmessage=({data})=>{
    const msg=JSON.parse(data)
    if(msg.type==='welcome')ready.resolve()
    if(msg.type==='ping')send({type:'pong',re:msg.id})
    if(msg.type==='events_ack' && msg.ack_seq>=2)ack.resolve()
  }
  async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Edge handshake/ack timeout')),5000)})])}finally{clearTimeout(timer)}}
  try {
    await bounded(ready.promise)
    send({type:'events',id:'initial',batch:[event(1,'session_start',{agent:'claude-code',model:'integration-model'}),event(2,'gap',{reason:'测试源截短',offset:128})]})
    await bounded(ack.promise)
    await page.getByRole('link',{name:'监察',exact:true}).click()
    await page.getByText('实时更新已连接',{exact:true}).waitFor()
    await page.locator('tr.clickable').filter({hasText:target}).click()
    await page.getByText('integration-model',{exact:true}).click()
    await page.getByText('采集缺口',{exact:true}).waitFor()
    const marker='回流联调 · '+crypto.randomUUID().slice(0,8)
    const start=performance.now()
    send({type:'events',id:'live',batch:[event(3,'assistant_message',{content:marker})]})
    const message=page.locator('.conversation pre').getByText(marker,{exact:true})
    await message.waitFor({state:'visible',timeout:5000})
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const elapsed=performance.now()-start
    assert(elapsed<=5000,`Edge send → visible + paint: ${elapsed} ms`)
    console.log(`管理员 / Edge WS seq=3 → 页面正文可见（含两次 rAF）：${elapsed.toFixed(1)} ms；Chrome ${page.context().browser().version()}`)
    send({type:'usage',id:'meter',batch:[{seq:4,request_id:'integration',session_id:session,provider_id:'test',model:'integration-model',input_tokens:23,output_tokens:7,cache_read_tokens:11,cache_write_tokens:13,cost_milli:42,status:'ok',complete:false,at:iso(Date.now())}]})
    await page.locator('.conversation').getByText(/缓存读取 11.*缓存写入 13.*0\.042 橡皮.*待结算/).waitFor()
    assert.equal(await message.count(),1)
    assert(db.get("SELECT count(*) AS n FROM audit WHERE action='observe.events.read' AND target=? AND actor!=?",[session,userId]).n>0)
    await capture('observe-real')
  } finally {ws.close()}
}
