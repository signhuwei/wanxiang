// 首批真实联验：Chrome 直接使用 Server 的路由 API 和持久化模型池。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../../src/server.ts'
import { seedTenant } from '../../src/seed.ts'
import { MemoryPresence } from '../../src/presence.ts'
import fixture from '../../../tests/fixtures/routing/p0-ab.json'

const scratch = await mkdtemp(join(tmpdir(), 'onex-routing-linked-'))
const target = 'routing-qa@example.test'
const copy = value => JSON.parse(JSON.stringify(value))
const { draft } = fixture.http
const modelId = fixture.model.id
const now = Date.now()
const at = new Date(now).toISOString()
const expires = new Date(now + 3600000).toISOString()
let loginCode
let browser
let app
const errors = []

function seedCatalog(sql, userId) {
  const [first, second] = fixture.wire.config.routes
  const [memberA, memberB] = draft.members
  for (const [route, tail, account] of [[first,'a','acct_a'], [second,'b','acct_b']]) {
    const { provider_id: provider } = route
    const endpoint = 'endpoint_' + tail
    sql.run('INSERT INTO providers (id,name,protocol,base_url,secret_ciphertext,status) VALUES (?,?,?,?,?,?)',
      [provider, '供应渠道 ' + tail.toUpperCase(), route.protocol, route.base_url, new Uint8Array([0]), 'active'])
    sql.run('INSERT INTO provider_accounts (account_id,provider_id,name,status,created_at) VALUES (?,?,?,?,?)',
      [account, provider, '联验账户 ' + tail.toUpperCase(), 'active', at])
    sql.run('INSERT INTO provider_endpoints (endpoint_id,provider_id,status,current_revision,created_at) VALUES (?,?,?,?,?)',
      [endpoint, provider, 'active', 1, at])
    sql.run(`INSERT INTO provider_endpoint_revisions
      (endpoint_id,endpoint_revision,protocol,base_url,auth_adapter,created_at) VALUES (?,?,?,?,?,?)`,
      [endpoint, 1, route.protocol, route.base_url, 'bearer', at])
    sql.run('INSERT INTO provider_account_endpoints (provider_id,account_id,endpoint_id,state) VALUES (?,?,?,?)',
      [provider, account, endpoint, 'enabled'])
  }

  sql.run(`INSERT INTO models (id,provider_id,upstream_name,display_name,context_window,status)
    VALUES (?,?,?,?,?,?)`,
    [modelId, first.provider_id, first.upstream_model, fixture.wire.config.rates[0].model_display_name, 128000, 'active'])
  sql.run(`INSERT INTO model_identity_revisions (model_id,identity_revision,maker_id,model_family,model_variant,identity_mode,
    model_snapshot,capability_floor_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [modelId, 1, 'test-maker', 'model-m', 'standard', 'pinned_snapshot', 'model-m@1', JSON.stringify(['text']), userId, at])
  sql.run('UPDATE models SET current_identity_revision=? WHERE id=?',[fixture.model.identity_revision,modelId])
  sql.run(`INSERT INTO rates (model_id,input_milli_per_mtok,output_milli_per_mtok,cache_read_milli_per_mtok,
    cache_write_milli_per_mtok,effective_from) VALUES (?,?,?,?,?,?)`,
    [modelId, 4000, 12000, 1000, 5000, at])

  for (const [route, member, tail, account, accepted] of [
    [first, memberA, 'a', 'acct_a', true],
    [second, memberB, 'b', 'acct_b', true],
    [{ ...second, upstream_model: 'vendor-b/m-int4', features: ['text'] },
      { ...memberB, deployment_id: 'dep_quant', deployment_revision: 1, approved_match_id: 'mt_quant', evidence_ids: ['ev_quant'] },
      'b', 'acct_b', false],
  ]) {
    const id = member.deployment_id
    const revision = member.deployment_revision
    const endpoint = 'endpoint_' + tail
    const capabilities = JSON.stringify(route.features)
    sql.run(`INSERT INTO model_deployments (deployment_id,provider_id,account_id,endpoint_id,catalog_item_id,display_name,
      status,current_revision,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, route.provider_id, account, endpoint, 'cat_' + id, route.upstream_model, 'active', revision, at])
    sql.run(`INSERT INTO model_deployment_revisions (deployment_id,deployment_revision,endpoint_id,endpoint_revision,
      upstream_model,capabilities_json,context_tokens,max_output_tokens,maker_claim,snapshot_claim,quantization_claim,
      created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, revision, endpoint, 1, route.upstream_model, capabilities, 128000, 16000, 'test-maker',
        accepted ? 'model-m@1' : null, accepted ? null : 'int4', userId, at])
    sql.run(`INSERT INTO model_evidence (evidence_id,deployment_id,deployment_revision,source_kind,outcome,identity_verified,
      capabilities_json,observed_at,valid_until,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [member.evidence_ids[0], id, revision, 'manual_review', accepted ? 'passed' : 'unknown', Number(accepted), capabilities,
        at, expires, userId])
    sql.run(`INSERT INTO model_discovery_matches (candidate_id,model_id,identity_revision,deployment_id,deployment_revision,
      catalog_item_id,discovery_id,match_rule_id,rule_revision,match_kind,normalized_key,confidence,reasons_json,
      status,decided_by,decided_at,decision_reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [member.approved_match_id, modelId, 1, id, revision, 'cat_' + id, 'discovery_' + tail, 'rule_fixture', 1,
        accepted ? 'exact' : 'normalized', 'model-m', accepted ? 'high' : 'low',
        JSON.stringify([accepted ? 'catalog_exact' : 'model_identity_unverified']), accepted ? 'accepted' : 'needs_review',
        accepted ? userId : null, accepted ? at : null, accepted ? '已明确核对原始快照' : null, at])
  }

  const initial = fixture.model.initial_pool_revision
  sql.run(`INSERT INTO model_pool_revisions (model_id,pool_revision,identity_revision,strategy,max_attempts,attempt_timeout_ms,
    total_timeout_ms,reason,digest,released_by,released_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [modelId, initial, 1, 'ordered', draft.routing.max_attempts, draft.routing.attempt_timeout_ms,
      draft.routing.total_timeout_ms, '原来只有 A 渠道', 'fixture-pool-six', userId, at])
  sql.run(`INSERT INTO model_pool_deployments (model_id,pool_revision,deployment_id,deployment_revision,approved_match_id,priority,
    evidence_ids_json) VALUES (?,?,?,?,?,?,?)`,
    [modelId, initial, memberA.deployment_id, memberA.deployment_revision, memberA.approved_match_id, memberA.priority,
      JSON.stringify(memberA.evidence_ids)])
  sql.run('INSERT INTO model_pool_heads (model_id,pool_revision,updated_at) VALUES (?,?,?)',[modelId,initial,at])
}

function seedExistingEntitlements(sql, tenantId, userId) {
  const deviceId = 'dev_routing_qa'
  const leaseId = 'lse_routing_qa'
  sql.run('INSERT INTO policy_signatures (revision,reason,issued_by,issued_at,entries_json) VALUES (1,?,?,?,?)',
    ['联验已有签发', userId, at, '[]'])
  sql.run('INSERT INTO policy_head (id,platform_revision,policy_revision) VALUES (1,1,1)')
  sql.run("INSERT INTO policy_effective (scope,subject_id,document_json) VALUES ('tenant',?,?)",
    [tenantId, JSON.stringify({ hot:{ allowed_models_json:JSON.stringify([modelId]) } })])
  sql.run(`INSERT INTO devices (id,user_id,name,os,arch,public_key,token_hash,token_expires_at,status)
    VALUES (?,?,'联验设备','darwin','arm64','test-only','test-only-no-login',?,'active')`, [deviceId,userId,expires])
  sql.run('INSERT INTO policy_device_applications (device_id,config_revision,policy_revision,applied_at) VALUES (?,1,1,?)',
    [deviceId, at])
  sql.run(`INSERT INTO leases (id,device_id,user_id,budget_milli,used_milli,expires_at,status)
    VALUES (?,?,?,1000,10,?,'active')`, [leaseId,deviceId,userId,expires])
  sql.run(`INSERT INTO ledger (id,kind,amount_milli,user_id,lease_id,at) VALUES
    ('ldg_routing_topup','topup',12345,?,NULL,?),
    ('ldg_routing_reserve','reserve',-1000,?,?,?)`,
    [userId,at,userId,leaseId,at])
}

try {
  app = await createServer({ dataDir: scratch, hostname: '127.0.0.1', port: 0, heartbeatMs: 15000, tenantCacheSize: 2,
    presence: new MemoryPresence(), commit: 'test', codeSecret: crypto.randomUUID(), masterKey: crypto.getRandomValues(new Uint8Array(32)),
    now: () => now, deliverCode: (_, value) => { loginCode = value } })
  const { tenantId, userId } = await seedTenant(app.store, { target, name: '路由联验租户', platformAdmin: true, now })
  await app.store.system.write(sql => seedCatalog(sql, userId))
  const tenant = app.store.tenant(tenantId)
  await tenant.write(sql => seedExistingEntitlements(sql, tenantId, userId))
  const snapshot = () => ({
    modelRate: app.store.system.all('SELECT * FROM rates WHERE model_id=?', [modelId]),
    contracts: tenant.all('SELECT * FROM contract ORDER BY revision'),
    policyHead: tenant.get('SELECT * FROM policy_head'),
    signatures: tenant.all('SELECT * FROM policy_signatures ORDER BY revision'),
    effective: tenant.all('SELECT * FROM policy_effective ORDER BY scope,subject_id'),
    applications: tenant.all('SELECT * FROM policy_device_applications ORDER BY device_id'),
    leases: tenant.all('SELECT * FROM leases ORDER BY id'),
    ledger: tenant.all('SELECT * FROM ledger ORDER BY id'),
  })
  const before = snapshot()
  browser = await chromium.launch({ channel:'chrome', args:['--disable-gpu','--no-proxy-server'] })
  const page = await browser.newPage({ baseURL:app.server.url.href, viewport:{width:1280,height:720} })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400 && ['document', 'script', 'stylesheet'].includes(response.request().resourceType())) {
      errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
    }
  })
  if (process.env.ONEX_ROUTING_DEBUG === '1') {
    page.on('response', response => {
      if (new URL(response.url()).pathname.includes('/pool/')) console.log(response.status(), new URL(response.url()).pathname)
    })
  }

  const button = name => page.getByRole('button', { name, exact:true })
  const link = name => page.getByRole('link', { name, exact:true })
  const document = await page.goto('/')
  assert.equal(document?.status(), 200, 'Server must serve the real WebUI at /')
  await page.getByPlaceholder('邮箱或手机号').fill(target)
  await button('发送验证码').click()
  await page.getByText('验证码已发送，请查收').waitFor()
  await page.getByPlaceholder('6 位验证码').fill(loginCode)
  await button('登录').click()
  await page.waitForURL(/#\/platform$/)
  await link('能力管理').click()
  await link('签约型号').click()
  const row = page.locator('tr.clickable', { hasText: fixture.wire.config.rates[0].model_display_name })
  await row.getByText('v6').waitFor()
  await row.click()
  await button('起草新版本').click()

  const boxB = page.getByLabel('选择 dep_b vendor-b/m', { exact:true })
  await boxB.check()
  assert.equal(await page.getByLabel(/选择 dep_quant /).isDisabled(), true)
  await page.getByLabel('发布原因').fill(draft.reason)
  const preview = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/pool/preview'))
  await button('预览').click()
  const pre = await preview
  assert.equal(pre.status(), 200)
  assert.deepEqual(pre.request().postDataJSON(), copy(draft))
  const proposal = await pre.json()
  assert.equal(proposal.publishable, true)
  assert.deepEqual(proposal.diff.added, ['dep_b'])
  assert.deepEqual(proposal.impact, { tenant_count:1, device_count:1 })
  assert.equal(app.store.system.get('SELECT pool_revision FROM model_pool_heads WHERE model_id=?',[modelId]).pool_revision, 6)
  assert.deepEqual(snapshot(),before)

  const observedPublish = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith('/pool/revisions'))
  await button('发布').click()
  const publishedResponse = await observedPublish
  assert.equal(publishedResponse.status(), 201)
  assert(publishedResponse.request().headers()['idempotency-key'])
  const published = await publishedResponse.json()
  assert.equal(published.pool_revision, 7)
  await page.getByText(/已发布模型池 v7/).waitFor()
  await page.getByRole('table', { name:'池成员' }).getByText('dep_b').waitFor()
  assert.deepEqual(app.store.system.all('SELECT deployment_id FROM model_pool_deployments WHERE model_id=? AND pool_revision=7 ORDER BY deployment_id',[modelId]),
    [{ deployment_id:'dep_a' },{ deployment_id:'dep_b' }])
  assert.equal(app.store.system.get('SELECT COUNT(*) AS n FROM route_release_jobs WHERE model_id=? AND pool_revision=7',[modelId]).n, 1)
  assert.deepEqual(snapshot(),before)
  assert.deepEqual(errors,[])
  console.log('routing-server-check ok: real Chrome, platform HTTP, SQLite pool v6→v7, readback, no tenant-side writes')
} catch (error) {
  if (errors.length) console.error('WebUI failed to load:', errors)
  throw error
} finally {
  await browser?.close()
  await app?.close()
  await rm(scratch,{recursive:true,force:true})
}
