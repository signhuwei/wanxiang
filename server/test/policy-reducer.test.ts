import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ApiError } from '../src/api';
import { hash, iso } from '../src/credentials';
import { policyRoutes } from '../src/policy-routes';
import { ensureUser, seedTenant } from '../src/seed';
import { calculatePolicy, publishProjection, readEffective, readProfile, saveProfile, type Signature } from '../src/policy-data';
import type { Definition } from '../src/policy-types';
import { QueuedDatabase, Store, type Transaction } from '../src/store';

const now=Date.parse('2026-11-21T05:44:00Z');
const definition:Definition={
  id:'models.example',version:1,title:'Model permissions',description:'',category:'access',schema:{kind:'resource_set',catalog:'models'},
  scopes:['tenant','group','member'],merge:'intersection',default_value:[],binding:{adapter:'access.models',abi:1},
};
const ref={id:definition.id,version:definition.version};
function sign(sql:Transaction,revision:number,policyRevision:number,allowed:string[]) {
  const signature:Signature={revision,reason:'test',issued_by:'platform',issued_at:new Date(now).toISOString(),entries:[
    {clause_ref:ref,template_ref:null,base_value:[],adjustment:allowed,signed_value:allowed,definition},
  ]};
  sql.run('INSERT INTO policy_signatures VALUES (?, ?, ?, ?, ?)',[revision,signature.reason,signature.issued_by,signature.issued_at,JSON.stringify(signature.entries)]);
  publishProjection(sql,calculatePolicy(sql,'tenant',signature),{platform_revision:revision,policy_revision:policyRevision},'platform',now);
  return signature;
}

test('upstream withdrawal preserves the surviving restriction across a later grant',async ()=>{
  const db=new QueuedDatabase(':memory:','tenant');
  try {
    const active=await db.write(sql=>{
      sql.run("INSERT INTO groups (id,name) VALUES ('group','Group')");
      sql.run("INSERT INTO members (user_id,role,group_id,status) VALUES ('member','member','group','active')");
      return sign(sql,1,1,['a','b','c']);
    });
    await db.write(sql=>{
      const scoped={scope:'group' as const,subject_id:'group',revision:1,template_ref:null,
        selections:[{clause_ref:ref,value:['a','b']}],revoked:[],retained:{}};
      saveProfile(sql,scoped,1,'owner',now);
      publishProjection(sql,calculatePolicy(sql,'tenant',active,scoped),{platform_revision:1,policy_revision:2},'owner',now);
    });
    const visible=()=>readEffective(db,'member','member')?.entries[0]?.effective_value;
    expect(visible()).toEqual(['a','b']);
    await db.write(sql=>sign(sql,2,3,['a','c']));
    expect(visible()).toEqual(['a']);
    expect(readProfile(db,'group','group').revoked).toEqual(['selection:models.example']);
    await db.write(sql=>sign(sql,3,4,['a','b','c']));
    expect(visible()).toEqual(['a']);
    expect(db.get<{selections_json:string}>("SELECT selections_json FROM policy_configurations WHERE scope='group' AND revision=1")
      ?.selections_json).toEqual(JSON.stringify([{clause_ref:ref,value:['a','b']}]));
  } finally {db.close();}
});


test('scope ledger hides unauthorized organization rows before search and pagination',async ()=>{
  const path=mkdtempSync(join(tmpdir(),'onex-policy-scope-'));
  const store=new Store(path,2);
  try {
    const fakeToken=(name:string)=>name.padEnd(43,'_');
    const {tenantId}=await seedTenant(store,{target:'owner@example.test',now});
    const users=await store.system.write(sql=>{
      const names=['manager','inside','outside'] as const;
      const result=names.map(name=>ensureUser(sql,{kind:'email',value:name+'@example.test'},now));
      for (let i=0;i<names.length;i++) sql.run(
        "INSERT INTO sessions (token_hash,user_id,tenant_id,kind,expires_at) VALUES (?, ?, ?, 'web', ?)",
        [hash(fakeToken(names[i]!)),result[i]!.id,tenantId,iso(now+3600_000)]);
      return result;
    });
    await store.tenant(tenantId).write(sql=>{
      sql.run("INSERT INTO groups (id,name) VALUES ('root','Root'),('outside','Outside')");
      sql.run("INSERT INTO groups (id,name,parent_id) VALUES ('inside','Inside','root')");
      sql.run(`INSERT INTO members (user_id,role,group_id,status) VALUES
        (?, 'group_admin', 'root', 'active'), (?, 'member', 'inside', 'active'),(?, 'member', 'outside', 'active')`,users.map(user=>user.id));
    });
    const app=new Hono();
    app.onError((error,c)=>error instanceof ApiError?c.json({error:error.body()},error.status):c.json({},500));
    policyRoutes(app,store,{now:()=>now,codeSecret:'proof',dataDir:path});
    const list=async(url:string,token:string)=>app.request('/v1/policy/configurations/'+url,
      {headers:{Authorization:'Bearer '+fakeToken(token)}});
    const groups=await (await list('group?limit=1','manager')).json() as {total:number;items:unknown[];next_cursor:string|null};
    expect(groups.total).toBe(2);
    expect(groups.items).toEqual([{id:'inside',name:'Inside',parent_id:'root',actions:['read']}]);
    expect(groups.next_cursor).not.toBeNull();
    expect(await (await list('member?q=outside','manager')).json()).toMatchObject({total:0,items:[]});
    expect(await (await list('member','manager')).json()).toMatchObject({total:2});
    expect(await (await list('member','inside')).json()).toMatchObject({total:1,items:[{id:users[1]!.id,group_id:'inside'}]});
    expect((await list('group','inside')).status).toBe(403);
  } finally {
    store.close();
    rmSync(path,{recursive:true,force:true});
  }
});
