import {test,expect} from 'bun:test'
import {makeMock} from '../mock.js'
const target='demo@example.test'
test('invitation cannot replace OTP and tenant selection precedes launch',async()=>{
  const call=makeMock()
  expect((await call({op:'login',target,invite_code:'DEMO'})).ok).toBe(false)
  expect((await call({op:'launch',agent_id:'claude-code'})).ok).toBe(false)
  await call({op:'send_code',target})
  const {state}=await call({op:'login',target,code:'246810',invite_code:'DEMO'})
  expect(state.phase).toBe('choose_tenant')
  expect((await call({op:'select_tenant',tenant_id:'unknown'})).ok).toBe(false)
  expect((await call({op:'select_tenant',tenant_id:state.tenants[1].id})).state.tenant.id).toBe(state.tenants[1].id)
  expect((await call({op:'launch',agent_id:'unlisted'})).ok).toBe(false)
  expect((await call({op:'launch',agent_id:'claude-code'})).state.agents[0].status).toBe('starting')
  expect((await call({op:'launch',agent_id:'claude-code'})).ok).toBe(false)
  await call({op:'settings',hide_on_close:false})
  const out=await call({op:'logout'})
  expect(out.state.phase).toBe('signed_out');expect(out.state.agents).toEqual([])
  expect(out.state.settings.hide_on_close).toBe(false)
})
