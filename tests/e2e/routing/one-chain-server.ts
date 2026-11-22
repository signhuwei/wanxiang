import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../../server/src/server';
import { MemoryPresence } from '../../../server/src/presence';
import { hash, iso, randomToken } from '../../../server/src/credentials';
import { seedTenant } from '../../../server/src/seed';
import { decryptProviderSecret } from '../../../server/src/provider-secret';
import { x25519PublicKey } from '../../../server/src/route-secret';
import { readSignedPools } from '../../../server/src/signed-routing-pools';
import type { RoutingProjectionInputs } from '../../../server/src/route-projection';
import { startFakeUpstream } from '../fake-upstream';

const deviceKey = Buffer.alloc(32, 7);
type Json = Record<string, any>;

async function channel(letter: string) {
  const upstream = await startFakeUpstream({ port: 0, usage: { input: 10_000, output: 2_000 } });
  const secret = `fixture-channel-${letter}`;
  const raw = `vendor-${letter}/flash-20261121`;
  const hits = { catalogue: 0, inference: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${secret}`) return Response.json({}, {status:401});
    const path = new URL(request.url).pathname;
    if (path === '/v1/models' && request.method === 'GET') {
      hits.catalogue++;
      return Response.json({ data: [{ id: raw, context_window: 128_000, capabilities: ['text','stream'], model_snapshot: '20261121' },
        { id: `vendor-${letter}/unselected`, context_window: 8192 }], has_more: false });
    }
    if (path !== '/v1/responses' || request.method !== 'POST') return new Response(null, {status:404});
    const call = await request.json() as Json;
    if (call.model !== raw) return Response.json({}, {status:422});
    hits.inference++;
    return fetch(new URL(path, upstream.url), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(call) });
  }});
  const url = server.url.origin + '/v1';
  let stopped = false;
  async function stopListening() {
    if (stopped) return;
    stopped = true;
    await server.stop(true);
  }
  return { secret, raw, hits, url, stopListening, async close() { await stopListening(); await upstream.stop(); } };
}

export async function startOneChain(directory?: string, primaryOffline = false) {
  const clock = Date.now();
  const dataDir = directory ?? mkdtempSync(join(tmpdir(), 'onex-one-chain-'));
  const [a,b] = await Promise.all([channel('a'),channel('b')]);
  const masterKey = randomBytes(32);
  let service: Awaited<ReturnType<typeof createServer>>;
  let fixtureTenant = '', fixtureDevice = '', release = '';
  const inputs: RoutingProjectionInputs = {
    leaseGate: true, executionTest: true,
    selectRoutePool: (tenant, device) => tenant === fixtureTenant && device === fixtureDevice,
    grants(tenant) {
      if (tenant !== fixtureTenant || !release) return [];
      const db=service.store.tenant(tenant);
      const current=db.get<{platform_revision:number}>('SELECT platform_revision FROM policy_head')?.platform_revision;
      if (!current) return [];
      return readSignedPools(db,current).map(pool=>({binding_id:`bnd_${pool.model_id}`,binding_revision:1,agent_release_id:release,
        model_id:pool.model_id,ingress_protocol:'openai_responses',aliases:[pool.model_id],platform_revision:current,
        pool:pool.mode==='pinned' ? {mode:'pinned',pool_revision:pool.pool_revision} : {mode:'follow'}}));
    },
    credentialRef(deployment, revision) {
      const row=service.store.system.get<{id:string;revision:number}>(`SELECT p.id,p.revision FROM model_deployments d JOIN providers p ON p.id=d.provider_id
        WHERE d.deployment_id=? AND d.current_revision=? AND p.status='active'`,[deployment,revision]);
      return row ? {credential_id:row.id,credential_version:row.revision} : null;
    },
    credentialMaterial(id, revision) {
      const row=service.store.system.get<{secret_ciphertext:Uint8Array}>('SELECT secret_ciphertext FROM providers WHERE id=? AND revision=?',[id,revision]);
      return row ? {purpose:'inference',material_class:'inference',plaintext:Buffer.from(decryptProviderSecret(masterKey,id,row.secret_ciphertext))} : null;
    },
  };
  const close = async () => {
    if (service) await service.close();
    await Promise.all([a.close(),b.close()]);
    if (!directory) rmSync(dataDir,{recursive:true,force:true});
  };
  try {
    service=await createServer({dataDir,hostname:'127.0.0.1',port:0,tenantCacheSize:2,heartbeatMs:15_000,commit:'one-chain-test',
      codeSecret:'one-chain-fixture-only',masterKey,presence:new MemoryPresence(),now:Date.now,routingProjection:inputs,
      providerChannelFetch: (url,headers,signal) => fetch(url,{headers,signal}) });
    const earlier=iso(clock-60_000), expires=iso(clock+86_400_000);
    const tenant=await seedTenant(service.store,{target:'owner@one-chain.test',name:'One chain',platformAdmin:true,now:clock});
    const platform=randomToken(), owner=randomToken();
    fixtureTenant=tenant.tenantId;
    await service.store.system.write(sql=>{
      for(const [token,scope] of [[platform,null],[owner,fixtureTenant]] as const) sql.run(`INSERT INTO sessions
        (token_hash,user_id,tenant_id,kind,expires_at) VALUES (?,?,?,'web',?)`,[hash(token),tenant.userId,scope,expires]);
    });
    const url=service.server.url.origin;
    let command=0;
    const api=async(path:string,payload?:object,key?:string,token=platform) => {
      const response=await fetch(url+'/v1'+path,{method:payload?'POST':'GET',headers:{authorization:`Bearer ${token}`,
        ...(payload&&{'content-type':'application/json','idempotency-key':key??`one-chain-${++command}`})},body:payload?JSON.stringify(payload):undefined});
      const data=await response.json() as Json;
      if(!response.ok) throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(data.error)}`);
      return data;
    };
    const supplies=[];
    for(const [index, source] of [a,b].entries()) {
      const provider=await api('/platform/providers',{name:`测试渠道 ${index+1}`,protocol:'openai_responses',base_url:source.url,secret:source.secret,auth:'bearer'});
      const path=`/platform/providers/${provider.id}`;
      const probe=await api(path+'/probes',{kind:'connectivity',revision:provider.revision});
      const discovery=await api(path+'/discoveries',{revision:provider.revision});
      const found=await api(`/platform/probe-jobs/${discovery.id}/results`);
      if(probe.status!=='succeeded'||discovery.status!=='succeeded'||found.total!==2) throw new Error('Channel probe or unrestricted catalogue failed');
      const picked=found.items.find((row:Json)=>row.raw_model===source.raw);
      if(!picked) throw new Error('Raw model missing from catalogue');
      const account=(await api(path+'/channel')).accounts[0];
      const wallet=path+'/channel-ledger';
      const required={account_id:account.account_id,currency:index?'USD':'CNY',note:'测试上游账单'};
      await api(wallet+'/observations',{...required,balance_micro:2_000_000,reference:'statement-opening'});
      await api(wallet+'/recharges',{...required,amount_micro:1_250_000,reference:'supplier-recharge'},`supplier-${index}`);
      const state=await api(wallet);
      if(state.accounts[0].balance_micro!==3_250_000) throw new Error('Channel funding did not reach the statement');
      supplies.push({provider,probe,discovery,picked,account,wallet});
    }
    const logical=await api('/platform/models',{provider_id:supplies[0]!.provider.id,upstream_name:a.raw,display_name:'联验签约型号 M',context_window:128_000});
    const modelPath=`/platform/models/${logical.id}`;
    const identity=await api(modelPath+'/identity',{revision:logical.revision,maker_id:'fixture',model_family:'M',model_variant:'flash',
      identity_mode:'pinned_snapshot',model_snapshot:'20261121',capability_floor:['text','stream']});
    await api(modelPath+'/pool/candidates/review',{expected_identity_revision:identity.identity.identity_revision,reason:'分别核实两个本地测试渠道为同一测试快照',
      decisions:supplies.map(({picked})=>({discovery_id:picked.discovery_id,catalog_item_id:picked.catalog_item_id,decision:'accept',capabilities:['text','stream']}))});
    const candidates=(await api(`/platform/deployments?target_model_id=${logical.id}`)).items as Json[];
    const members=supplies.map(({provider},index)=>{
      const row=candidates.find(candidate=>candidate.provider_id===provider.id && candidate.actions.includes('select'));
      if(!row) throw new Error('Reviewed channel cannot be selected');
      return {deployment_id:row.deployment_id,deployment_revision:row.deployment_revision,approved_match_id:row.approved_match_id,
        evidence_ids:row.evidence_ids,priority:(index+1)*10};
    });
    const draft={expected_pool_revision:0,members,routing:{strategy:'ordered',max_attempts:2,attempt_timeout_ms:5000,total_timeout_ms:10000},reason:'同一签约型号配置 A 和 B'};
    const checked=await api(modelPath+'/pool/preview',draft);
    if(!checked.publishable) throw new Error(`Pool review blocked ${JSON.stringify(checked.blocking)}`);
    const released=await api(modelPath+'/pool/revisions',{...draft,preview_basis:checked.preview_basis});
    const pool=Number(released.pool_revision);
    if(pool!==1) throw new Error('Expected the first published pool');
    const source={kind:'manual',reference:'测试渠道报价单'};
    for(const [index,member] of members.entries()) await api(`/platform/deployments/${member.deployment_id}/quotes`,{
      deployment_revision:member.deployment_revision,expected_quote_revision:0,currency:index?'USD':'CNY',tariff_scope:{kind:'deployment'},
      valid_from:earlier,valid_until:null,source,reason:'联验采购价',items:[
        {dimension:'input',rate_micro:index?'400000':'2000000',quantity_basis:1_000_000,unit:'token'},
        {dimension:'output',rate_micro:index?'1333333':'15000000',quantity_basis:1_000_000,unit:'token'},
      ]});
    await api('/platform/procurement/fx-rates',{base_currency:'USD',quote_currency:'CNY',expected_fx_revision:0,rate_numerator:'15',
      rate_denominator:'2',observed_at:earlier,valid_from:earlier,valid_until:expires,source,reason:'联验汇率'});
    await api('/platform/rates',{model_id:logical.id,input_milli_per_mtok:3500,output_milli_per_mtok:12000,
      cache_read_milli_per_mtok:1000,cache_write_milli_per_mtok:5000,effective_from:earlier});
    const prices={expected_pool_revision:pool,expected_source_rate_key:null,manual_input_multiplier_ppm:4_000_000,reason:'合同销售口径 4×'};
    const multiplier=await api(modelPath+'/input-multiplier/preview',prices);
    if(multiplier.recommended_input_multiplier_ppm!==3_000_000) throw new Error('The A/B purchase prices did not give 3×');
    const rate=await api(modelPath+'/input-multiplier/revisions',{...prices,pricing_at:multiplier.pricing_at,preview_basis:multiplier.preview_basis});
    const plan=await api('/platform/commerce/plans',{name:'联验计费方案',expected_version:0,terms:{model_prices:[{model_id:logical.id,source_rate_key:rate.source_rate_key}]}});
    release=(await api('/platform/agent-releases',{agent:'codex',version:'0.0.1',os:'darwin',arch:'arm64',url:'https://fixture.test/codex',sha256:'a'.repeat(64),size:8})).id;
    const contract=`/platform/policy/contracts/${fixtureTenant}`;
    const entries=[['access.models',[logical.id]],['access.agents',['codex']],['access.releases',[release]],['billing.plan',[plan.id]],['lease.budget',100_000]]
      .map(([id,adjustment])=>({template_ref:null,clause_ref:{id,version:1},adjustment}));
    const sign={expected_platform_revision:0,expected_policy_revision:0,base_revision:null,reason:'首次签发双渠道型号',entries,
      route_pools:[{model_id:logical.id,pool_revision:pool,mode:'pinned'}]};
    const signPreview=await api(contract+'/preview',sign);
    if(signPreview.route_pools[0]?.member_count!==2) throw new Error('Signing does not show both channels');
    const signed=await api(contract+'/signatures',sign,'sign-1');
    const tenantSigned=await api(`/policy/signatures/${signed.revision}`,undefined,undefined,owner);
    if(tenantSigned.route_pools[0]?.member_count!==2 || tenantSigned.sales_rate_snapshots[0]?.input_multiplier_ppm!==4_000_000) {
      throw new Error('Tenant cannot read its signed two-channel model and frozen rate');
    }
    const topup=await api(contract+'/recharges',{amount_milli:20_375,note:'测试租户充值'},'tenant-pay-1');
    const ownerReceipt=await api('/policy/recharges',undefined,undefined,owner);
    if(ownerReceipt.items[0]?.amount_milli!==20_375 || ownerReceipt.items[0]?.ledger_id!==topup.ledger_id) {
      throw new Error('Tenant cannot read the same fractional recharge receipt');
    }
    const device=await api('/devices',{name:'one-chain-fixture',os:'darwin',arch:'arm64',public_key:x25519PublicKey(deviceKey)},undefined,owner);
    fixtureDevice=device.device_id;
    const projected=await service.projection!.project(fixtureTenant,fixtureDevice,Date.now());
    if (primaryOffline) await a.stopListening();
    return {close,service,api,info:{data_dir:dataDir,http_url:url,ws_url:url.replace(/^http/,'ws')+'/v1/edge/ws',tenant_id:fixtureTenant,user_id:tenant.userId,
      device_id:fixtureDevice,device_token:device.device_token,device_private_key_hex:deviceKey.toString('hex'),model_id:logical.id,
      config_revision:projected.config_revision,projection_id:projected.projection_id,signed_pool:signed.route_pools[0],
      signed_rate:signed.sales_rate_snapshots[0],origin_channel:supplies[0]!.wallet,backup_channel:supplies[1]!.wallet,
      primary_deployment_id:members[0]!.deployment_id,backup_deployment_id:members[1]!.deployment_id,
      platform_session:platform,owner_session:owner},hits:[a.hits,b.hits]};
  } catch(error) { await close(); throw error; }
}

if(import.meta.main) {
  const index=process.argv.indexOf('--data-dir');
  const fixture=await startOneChain(index===-1 ? undefined : process.argv[index+1],process.argv.includes('--primary-offline'));
  console.log(JSON.stringify(fixture.info));
  for(const signal of ['SIGTERM','SIGINT'] as const) process.once(signal,async()=>{await fixture.close();process.exit(0);});
}
