import { expect,test } from 'bun:test';
import { createHash,generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { ApiError } from '../src/api';
import { allowedAgentReleases } from '../src/agent-catalog';
import { iso,randomToken,hash } from '../src/credentials';
import { configPublisher } from '../src/edge-config';
import { policyRoutes } from '../src/policy-routes';
import { encryptProviderSecret } from '../src/provider-secret';
import { seedTenant } from '../src/seed';
import { Store } from '../src/store';
import { upstreamRoutes } from '../src/tenant-upstreams';

test('signed runtime provisions ordered per-model credentials, denies incapable clients and narrows exact artifacts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'onex-execution-')),store=new Store(dir,1);
  const at=Date.now(), master=Buffer.alloc(32,17);
  const publicKey=generateKeyPairSync('x25519').publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
  try {
    const {tenantId,userId}=await seedTenant(store,{target:'runtime@example.test',platformAdmin:true,now:at});
    const admin=randomToken(),owner=randomToken(),expiry=iso(at+3600_000);
    const digest=createHash('sha256').update('binary').digest('hex');
    mkdirSync(join(dir,'agent-artifacts'),{recursive:true});writeFileSync(join(dir,'agent-artifacts',digest),'binary');
    await store.system.write(sql=>{
      sql.run("INSERT INTO sessions(token_hash,user_id,tenant_id,kind,expires_at) VALUES(?,?,NULL,'web',?),(?,?,?,'web',?)",
        [hash(admin),userId,expiry,hash(owner),userId,tenantId,expiry]);
      for (const id of ['one','two']) {
        sql.run("INSERT INTO providers(id,name,protocol,base_url,secret_ciphertext,status) VALUES(?,?,'anthropic','https://platform.example',?,'active')",
          [id,id,encryptProviderSecret(master,id,id+'-secret')]);
        sql.run("INSERT INTO models(id,provider_id,upstream_name,display_name,status,context_window) VALUES(?,?,?,?,'active',4096)",
          [id,id,id,id]);
        sql.run('INSERT INTO rates(model_id,effective_from,input_milli_per_mtok,output_milli_per_mtok,cache_read_milli_per_mtok,cache_write_milli_per_mtok) VALUES(?,?,1,1,1,1)',[id,iso(at)]);
      }
      for(const id of ['rel_a','rel_b']) sql.run("INSERT INTO agent_releases(id,agent,version,os,arch,url,sha256,size,status) VALUES(?,'codex',?,'darwin','arm64','https://example.test',?,6,'active')",[id,id,digest]);
    });
    const db=store.tenant(tenantId);
    await db.write(sql=>sql.run("INSERT INTO devices(id,user_id,name,os,arch,public_key,token_hash,token_expires_at,status) VALUES('device',?,'Device','darwin','arm64',?,?,?,'active')",[userId,publicKey,hash(randomToken()),expiry]));
    const app=new Hono(),opts={dataDir:dir,now:()=>at,masterKey:master,codeSecret:'fixture'};
    app.onError((error,c)=>{if(error instanceof ApiError)return c.json({error:error.body()},error.status);throw error;});
    policyRoutes(app,store,opts);upstreamRoutes(app,store,opts);
    const post=(path:string,token:string,body:unknown)=>app.request(path,{method:'POST',body:JSON.stringify(body),
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':randomToken()}});
    const terms={'seats.limit':5,'lease.budget':1000,'access.models':['one','two'],'access.agents':['codex'],'access.releases':['rel_a'],
      'network.providers':['one'],'upstream.custom':true,'route.failover':true,'network.public':false,'model.max_output_tokens':55,'rate.member_rpm':5};
    expect((await post('/v1/platform/policy/contracts/'+tenantId+'/signatures',admin,{expected_platform_revision:0,expected_policy_revision:0,
      base_revision:null,reason:'runtime integration',entries:Object.entries(terms).map(([id,adjustment])=>({clause_ref:{id,version:1},template_ref:null,adjustment}))})).status).toBe(201);
    const catalog=async(name:string)=>{
      const response=await app.request('/v1/policy/catalog/'+name,{headers:{Authorization:'Bearer '+owner}});
      expect(response.status).toBe(200);
      return (await response.json() as {items:{id:string}[]}).items.map(row=>row.id);
    };
    expect(await catalog('providers')).toEqual(['one']);
    expect(await catalog('releases')).toEqual(['rel_a']);
    const created=await post('/v1/policy/upstreams',owner,{expected_revision:0,name:'tenant fixture',model_id:'one',base_url:'https://tenant.example',
      upstream_name:'tenant-native',secret:'tenant-secret',priority:2});
    expect(created.status).toBe(201);
    const upstream=await created.json() as {id:string};
    const publisher=configPublisher(store,dir,()=>at,master);
    const config=async(runtime:boolean)=>{
      const frames:Record<string,unknown>[]=[];
      await publisher.connect('device',{tenant:tenantId,agentCache:true,supportsCapabilityContract:true,supportsCapabilityPolicy:true,
        supportsPolicyRuntime:runtime,live:()=>true,send:v=>{frames.push(v)}});
      return frames;
    };
    expect(await config(false)).toMatchObject([{routes:[],agents:[]},{type:'cutoff'}]);
    const [frame]=await config(true);
    expect(frame).toMatchObject({routes:[{model_id:'one',provider_id:upstream.id,upstream_model:'tenant-native'},{model_id:'one',provider_id:'one'}],
      rates:[{model_id:'one'}],agents:[{id:'rel_a'}],policy:{abi:2,runtime:{'network.public':false,'model.max_output_tokens':55,'rate.member_rpm':5,'route.failover':true}}});
    const policy=frame!.policy as {secrets:{provider_id:string}[]};
    expect(policy.secrets.map(row=>row.provider_id).sort()).toEqual(['one',upstream.id].sort());
    expect(JSON.stringify(frame)).not.toContain('tenant-secret');
    const exact={allowed_agents_json:'["codex"]',agent_release_pins_json:'[]',release_ids_json:'[]',lease_budget_milli:1000};
    expect(allowedAgentReleases(store,dir,exact,'darwin','arm64',true)).toEqual([]);
    expect(allowedAgentReleases(store,dir,{...exact,release_ids_json:null},'darwin','arm64',true).map(row=>row.id)).toEqual(['rel_a','rel_b']);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
