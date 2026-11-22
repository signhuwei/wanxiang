import { refreshCommerce } from './commerce';
import { insertSalesRateSnapshots, readSalesRateSnapshots, signatureSalesRates } from './sales-rate-snapshots';
import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, invalid, json, operation } from './api';
import { isTenantId } from './auth';
import { appendLedgerEntry, balance } from './billing';
import { hash, hmac, iso } from './credentials';
import { int, pagination, platformActor, tenantActor, type ManagementOptions } from './management';
import { signatureImpact,targetPolicy,visibleTarget } from './policy-impact';
import { balanceThresholdOrderInvalid } from './policy-balance';
import { calculatePolicy, historicalProfile, noPolicy, publishProjection, readEffective, readHead, readProfile, readSignature,
  readTemplate, saveProfile, type Effective, type Head, type Profile, type Signature, type Template } from './policy-data';
import { array, canNarrow, catalogRows, choice, clauseError, object, parseDefinition, pathVersion, policyAdapters, policyCatalogs, reference, resourceDisplay, sameRef,
  stableId, string, valueFor, type Choice, type Definition, type PolicyReader, type Ref, type Scope, type SignedEntry } from './policy-types';
import type { Store, Transaction } from './store';

const platform = '/v1/platform/policy';
const tenant = '/v1/policy';
type Actor = ReturnType<typeof tenantActor>;
type Lookup = {tenant_id:string;name:string};
type Recharge = {
  ledger_id:string;platform_revision:number|null;amount_milli:number;balance_before_milli:number;balance_after_milli:number;
  by:string;at:string;note:string|null;command_fingerprint:string;
};
const rechargeFields = `SELECT r.ledger_id,r.platform_revision,r.balance_before_milli,r.balance_after_milli,r.command_fingerprint,
  l.amount_milli,l."by",l.at,l.note FROM policy_recharges r JOIN ledger l ON l.id = r.ledger_id AND l.kind = 'topup'`;

function audit(sql:Transaction, actor:string, action:string, target:string, detail:Record<string,unknown>, at:number, system=false) {
  const table=system?'platform_audit':'audit';
  sql.run(`INSERT INTO ${table} (id,actor,action,target,detail_json,at) VALUES (?, ?, ?, ?, ?, ?)`,
    [`aud_${ulid()}`,actor,action,target,JSON.stringify(detail),iso(at)]);
}
function opFor(c:Context,opts:ManagementOptions,at:number,actor:string,body:unknown) {
  const op=operation(c,opts.codeSecret,at,actor,body);
  if (!op.key) invalid('Idempotency-Key');
  return op;
}
function expectHead(body:Record<string,unknown>,head:Head) {
  const platformRevision=int(body.expected_platform_revision,'expected_platform_revision');
  const policyRevision=int(body.expected_policy_revision,'expected_policy_revision');
  if (platformRevision!==head.platform_revision||policyRevision!==head.policy_revision) throw new ApiError('conflict',head);
}
function expectVersion(value:unknown,version:number) {
  if (int(value,'expected_version')!==version) throw new ApiError('conflict',{version});
}
function definition(sql:PolicyReader,ref:Ref): Definition|null {
  const row=sql.get<{definition_json:string}>('SELECT definition_json FROM policy_definitions WHERE id = ? AND version = ?',[ref.id,ref.version]);
  return row?JSON.parse(row.definition_json):null;
}
function requireDefinition(sql:PolicyReader,ref:Ref,at:string) {
  return definition(sql,ref)??clauseError(at,ref,'definition_not_found');
}
function valueChecked(def:Definition,value:unknown,at:string,system?:PolicyReader) {
  try {return valueFor(def.schema,value,at,system);}
  catch (error) {
    if (error instanceof ApiError) clauseError(at,{id:def.id,version:def.version},'invalid_value');
    throw error;
  }
}
function definitionView(def:Definition) { return {...def,actions:['read','publish']}; }
function templateView(system:PolicyReader,row:Template) {
  return {...row,entries:row.entries.map(entry=>{
    const definition=requireDefinition(system,entry.clause_ref,'entries');
    return {...entry,definition,display:resourceDisplay(system,definition,entry.value)};
  }),actions:['read','publish']};
}
function requireTenantRole(actor:Actor,allowed:string[]) {
  if (!allowed.includes(actor.role)) throw new ApiError('forbidden');
}
function actorInside(actor:Actor, sql:PolicyReader, store:Store) {
  const member=sql.get<{role:string;group_id:string|null}>("SELECT role, group_id FROM members WHERE user_id = ? AND status = 'active'",[actor.userId]);
  if (!member || !store.system.get("SELECT id FROM tenants WHERE id=? AND status='active'",[actor.id])) throw new ApiError('forbidden');
  return {...actor,role:member.role,group_id:member.group_id};
}

export function policyRoutes(app:Hono, store:Store, opts:ManagementOptions) {
  const system=store.system;
  function platformTenant(c:Context,at:number) {
    const actor=platformActor(store,c,at);
    const id=c.req.param('tenant_id');
    if (!isTenantId(id)) throw new ApiError('not_found');
    const row=system.get<Lookup & { short_name: string | null }>('SELECT id AS tenant_id, name, short_name FROM tenants WHERE id = ?',[id]);
    if (!row) throw new ApiError('not_found');
    return {actor, id, db:store.tenant(id), row};
  }
  function platformCheck(actor:string) {
    if (!system.get('SELECT user_id FROM platform_admins WHERE user_id=?',[actor])) throw new ApiError('forbidden');
  }
  function parseChoices(value:unknown,upper?:Effective['entries'],scope?:Scope) {
    const byId=new Map((upper??[]).map(entry=>[entry.clause_ref.id,entry]));
    const seen=new Set<string>();
    return array(value,'entries').map((item,index):Choice=>{
      const at=`entries.${index}`;
      const row=object(item,at,['clause_ref','value']);
      const ref=reference(row.clause_ref,`${at}.clause_ref`);
      const def=requireDefinition(system,ref,`${at}.clause_ref`);
      if (seen.has(ref.id)) clauseError(at,ref,'duplicate_clause');
      seen.add(ref.id);
      const selected=valueChecked(def,row.value,`${at}.value`,system);
      if (scope) {
        const ceiling=byId.get(ref.id);
        if (!ceiling || !sameRef(ceiling.clause_ref,ref) || !def.scopes.includes(scope) ||
          !canNarrow(def,ceiling.effective_value,selected)) clauseError(at,ref,'exceeds_parent');
      }
      return {clause_ref:ref,value:selected};
    });
  }
  function signatureView(sql:PolicyReader,tenantId:string,row:Signature) {
    const head=readHead(sql)??noPolicy;
    return {...head,...row,tenant_id:tenantId,current:row.revision===head.platform_revision,
      sales_rate_snapshots:readSalesRateSnapshots(sql,row.revision),actions:['read','sign']};
  }
  function signingDraft(sql:PolicyReader, body:Record<string,unknown>) {
    object(body,'body',['expected_policy_revision','expected_platform_revision','base_revision','entries','reason']);
    const head=readHead(sql)??noPolicy;
    expectHead(body,head);
    const base=body.base_revision===null?null:int(body.base_revision,'base_revision',1);
    if (base!==null && !readSignature(sql,base)) invalid('base_revision');
    const keys=new Set<string>();
    const adapters=new Set<string>();
    const entries=array(body.entries,'entries').map((input,index):SignedEntry=>{
      const at=`entries.${index}`;
      const row=object(input,at,['clause_ref','template_ref','adjustment']);
      const ref=reference(row.clause_ref,`${at}.clause_ref`);
      const def=requireDefinition(system,ref,`${at}.clause_ref`);
      if (keys.has(ref.id)) clauseError(at,ref,'duplicate_clause');
      if (def.binding && adapters.has(def.binding.adapter)) clauseError(at,ref,'duplicate_binding');
      keys.add(ref.id);
      if (def.binding) adapters.add(def.binding.adapter);
      const templateRef=row.template_ref===null?null:reference(row.template_ref,`${at}.template_ref`);
      const template=templateRef?readTemplate(system,templateRef,true):null;
      const item=template?.entries.find(entry=>sameRef(entry.clause_ref,ref));
      if (templateRef && !item) clauseError(at,ref,'template_clause_not_found');
      const base_value=item?.value??def.default_value;
      const adjusted=Object.hasOwn(row,'adjustment');
      const chosen=valueChecked(def,adjusted?row.adjustment:base_value,`${at}.${adjusted?'adjustment':'base_value'}`,system);
      return {clause_ref:ref,template_ref:templateRef,base_value,...(adjusted && {adjustment:chosen}),signed_value:chosen,definition:def,
        display:resourceDisplay(system,def,base_value,chosen)};
    });
    const warn=entries.find(entry=>entry.definition.binding?.adapter==='balance.warn');
    const restrict=entries.find(entry=>entry.definition.binding?.adapter==='balance.restrict');
    if (warn && restrict && balanceThresholdOrderInvalid(warn.signed_value,restrict.signed_value)) {
      const entry=warn.adjustment===undefined&&restrict.adjustment!==undefined?restrict:warn;
      clauseError(`entries.${entries.indexOf(entry)}.${entry.adjustment===undefined?'base_value':'adjustment'}`,
        entry.clause_ref,'balance_warn_below_restrict');
    }
    return {head,entries,reason:string(body.reason,'reason',500)};
  }

  app.get(`${platform}/adapters`,c=>{
    platformActor(store,c,opts.now());
    const items=policyAdapters();
    return c.json({items,total:items.length,next_cursor:null,actions:[]});
  });

  app.get(`${platform}/definitions`,c=>{
    platformActor(store,c,opts.now());
    const p=pagination(c);
    const where="WHERE instr(lower(id || ' ' || json_extract(definition_json,'$.title')), lower(?)) > 0";
    const {n}=system.get<{n:number}>(`SELECT count(*) AS n FROM policy_definitions ${where}`,[p.query])!;
    const rows=system.all<{definition_json:string}>(`SELECT definition_json FROM policy_definitions ${where} ORDER BY id,version DESC LIMIT ? OFFSET ?`,
      [p.query,p.limit,p.offset]);
    return c.json(p.page(rows.map(r=>definitionView(JSON.parse(r.definition_json))),n,['create']));
  });
  app.get(`${platform}/definitions/:id/:version`,c=>{
    platformActor(store,c,opts.now());
    const row=definition(system,{id:stableId(c.req.param('id')),version:pathVersion(c.req.param('version'))});
    if (!row) throw new ApiError('not_found');
    return c.json(definitionView(row));
  });
  app.post(`${platform}/definitions`,async c=>{
    const at=opts.now(), actor=platformActor(store,c,at), body=await json(c), op=opFor(c,opts,at,actor,body);
    return system.write(sql=>{
      platformCheck(actor);
      const cached=op.read(sql);
      if (cached) return cached;
      const id=stableId(body.id);
      const {version}=sql.get<{version:number}>('SELECT coalesce(max(version),0) AS version FROM policy_definitions WHERE id=?',[id])!;
      expectVersion(body.expected_version,version);
      const parsed=parseDefinition(body,version+1,sql);
      sql.run('INSERT INTO policy_definitions (id,version,definition_json) VALUES (?, ?, ?)',[id,parsed.version,JSON.stringify(parsed)]);
      audit(sql,actor,'policy.definition.publish',id,{version:parsed.version},at,true);
      return op.complete(sql,{status:201,payload:definitionView(parsed)});
    });
  });

  function templateContract(c:Context,isPlatform:boolean) {
    const at=opts.now();
    if (isPlatform) return {at, userId:platformActor(store,c,at), db:system, tenantId:null, canPublish:true};
    const actor=tenantActor(store,c,at);
    requireTenantRole(actor,['owner','admin','group_admin']);
    return {at,userId:actor.userId,db:actor.db,tenantId:actor.id,canPublish:actor.role==='owner'};
  }
  function templateAccess(template:ReturnType<typeof templateView>, canPublish:boolean) {
    return {...template,actions:canPublish?template.actions:['read']};
  }
  for (const isPlatform of [true,false]) {
    const path=isPlatform?`${platform}/templates`:`${tenant}/configuration-templates`;
    const table=isPlatform?'policy_templates':'policy_configuration_templates';
    app.get(path,c=>{
      const {db,canPublish}=templateContract(c,isPlatform);
      const p=pagination(c);
      const requested=c.req.query('scope');
      const scope=requested===undefined?null:choice(requested,isPlatform?['platform']:['group','member'],'scope');
      const scoped=!isPlatform && scope!==null;
      const where="WHERE instr(lower(id || ' ' || name || ' ' || description), lower(?)) > 0"+(scoped?' AND scope = ?':'');
      const params=scoped?[p.query,scope]:[p.query];
      const {n}=db.get<{n:number}>(`SELECT count(*) AS n FROM ${table} ${where}`,params)!;
      const rows=db.all<Ref>(`SELECT id,version FROM ${table} ${where} ORDER BY id,version DESC LIMIT ? OFFSET ?`,[...params,p.limit,p.offset]);
      return c.json(p.page(rows.map(ref=>templateAccess(templateView(system,readTemplate(db,ref,isPlatform)!),canPublish)),n,canPublish?['create']:[]));
    });
    app.get(`${path}/:id/:version`,c=>{
      const {db,canPublish}=templateContract(c,isPlatform);
      const row=readTemplate(db,{id:stableId(c.req.param('id')),version:pathVersion(c.req.param('version'))},isPlatform);
      if (!row) throw new ApiError('not_found');
      return c.json(templateAccess(templateView(system,row),canPublish));
    });
    app.post(path,async c=>{
      const {at,userId,db,tenantId,canPublish}=templateContract(c,isPlatform);
      if (!canPublish) throw new ApiError('forbidden');
      const body=await json(c), op=opFor(c,opts,at,userId,body);
      return db.write(sql=>{
        if (isPlatform) platformCheck(userId);
        else if (!sql.get("SELECT user_id FROM members WHERE user_id=? AND status='active' AND role='owner'",[userId])||
          !system.get("SELECT id FROM tenants WHERE id=? AND status='active'",[tenantId])) throw new ApiError('forbidden');
        const cached=op.read(sql);
        if (cached) return cached;
        object(body,'body',['id','expected_version','name','description','scope','entries']);
        const id=stableId(body.id);
        const {version}=sql.get<{version:number}>(`SELECT coalesce(max(version),0) AS version FROM ${table} WHERE id=?`,[id])!;
        expectVersion(body.expected_version,version);
        const scope=choice(body.scope,isPlatform?['platform']:['group','member'],'scope') as Template['scope'];
        const upper=isPlatform?null:readEffective(sql,'tenant',tenantId!);
        if (!isPlatform && !upper) throw new ApiError('conflict',{reason:'platform_contract_required'});
        const entries=parseChoices(body.entries,upper?.entries, scope==='platform'?undefined:scope);
        const row:Template={id,version:version+1,name:string(body.name,'name',128),description:string(body.description??'','description',1000,true),scope,entries};
        if (isPlatform) sql.run('INSERT INTO policy_templates (id,version,name,description,entries_json) VALUES (?, ?, ?, ?, ?)',
          [id,row.version,row.name,row.description,JSON.stringify(entries)]);
        else sql.run('INSERT INTO policy_configuration_templates (id,version,name,description,scope,entries_json) VALUES (?, ?, ?, ?, ?, ?)',
          [id,row.version,row.name,row.description,scope,JSON.stringify(entries)]);
        audit(sql,userId,'policy.template.publish',id,{version:row.version,scope},at,isPlatform);
        return op.complete(sql,{status:201,payload:templateView(system,row)});
      });
    });
  }
  for (const isPlatform of [true,false]) {
    const path=isPlatform?platform:tenant;
    app.get(`${path}/catalog/:catalog`,c=>{
      const at=opts.now();
      const name=choice(c.req.param('catalog'),policyCatalogs,'catalog');
      let allowed:Set<string>|undefined;
      if (isPlatform) platformActor(store,c,at);
      else {
        const actor=tenantActor(store,c,at);
        const profile=actor.role==='owner'||actor.role==='admin'?readEffective(actor.db,'tenant',actor.id):
          readEffective(actor.db,'member',actor.userId);
        const field={agents:'allowed_agents_json',models:'allowed_models_json',tools:'tool_release_ids_json',
          releases:'release_ids_json',providers:'provider_ids_json'} as const;
        if (name==='commerce_plans' || !profile) allowed=new Set<string>();
        else {
          const ids=profile.hot[field[name]];
          const selected:Set<string>|null=ids==null?null:new Set(JSON.parse(ids));
          if (name==='releases' || name==='providers') {
            const resources=name==='releases'
              ? system.all<{id:string}>(`SELECT id FROM agent_releases WHERE agent IN (SELECT value FROM json_each(?))`,[profile.hot.allowed_agents_json])
              : system.all<{id:string}>(`SELECT DISTINCT provider_id AS id FROM models WHERE id IN (SELECT value FROM json_each(?))`,[profile.hot.allowed_models_json]);
            allowed=new Set(resources.filter(row=>!selected||selected.has(row.id)).map(row=>row.id));
          } else allowed=selected??new Set<string>();
        }
      }
      const p=pagination(c);
      const selector=c.req.query('ids');
      const ids=selector===undefined?null:selector.split(',');
      if (ids&&(ids.length>128||ids.some(id=>!id.length||id.length>128))) invalid('ids');
      const search=p.query.toLowerCase();
      const matches=catalogRows(system,name).filter(row=>(!allowed||allowed.has(row.id))&&
        (ids?ids.includes(row.id):`${row.id} ${row.label}`.toLowerCase().includes(search)));
      return c.json(p.page(matches.slice(p.offset,p.offset+p.limit),matches.length));
    });
  }

  const contracts=`${platform}/contracts`;
  app.get(contracts,c=>{
    platformActor(store,c,opts.now());
    const p=pagination(c);
    const where="WHERE instr(lower(name || ' ' || id || ' ' || coalesce(short_name, '')), lower(?)) > 0";
    const {n}=system.get<{n:number}>(`SELECT count(*) AS n FROM tenants ${where}`,[p.query])!;
    const rows=system.all<Lookup & { short_name: string | null }>(
      `SELECT id AS tenant_id, name, short_name FROM tenants ${where} ORDER BY id LIMIT ? OFFSET ?`,[p.query,p.limit,p.offset]);
    return c.json(p.page(rows.map(row=>({...row,...(readHead(store.tenant(row.tenant_id))??noPolicy),actions:['read']})),n));
  });
  app.get(`${contracts}/:tenant_id`,c=>{
    const at=opts.now(),{db,row}=platformTenant(c,at);
    const head=readHead(db);
    return c.json({...row,...(head??noPolicy),balance:balance(db,at),actions:['read','sign',...(head?['topup']:[])]});
  });
  function signatureList(c:Context,db:PolicyReader,id:string,canSign:boolean,canReadRates=false) {
    const p=pagination(c),head=readHead(db)??noPolicy;
    const where="WHERE instr(lower(CAST(revision AS TEXT) || ' ' || reason || ' ' || issued_by),lower(?)) > 0";
    const {n}=db.get<{n:number}>(`SELECT count(*) AS n FROM policy_signatures ${where}`,[p.query])!;
    const rows=db.all<Omit<Signature,'entries'>>(`SELECT revision,reason,issued_by,issued_at FROM policy_signatures ${where}
      ORDER BY revision DESC LIMIT ? OFFSET ?`,[p.query,p.limit,p.offset]);
    const actions=canReadRates?['read','read_rates']:['read'];
    return c.json(p.page(rows.map(row=>({...row,...head,tenant_id:id,current:row.revision===head.platform_revision,actions})),n,canSign?['sign']:[]));
  }
  app.get(`${contracts}/:tenant_id/signatures`,c=>{
    const {db,id}=platformTenant(c,opts.now());
    return signatureList(c,db,id,true);
  });
  app.get(`${tenant}/signatures`,c=>{
    const actor=tenantActor(store,c,opts.now());
    requireTenantRole(actor,['owner','admin']);
    return signatureList(c,actor.db,actor.id,false,actor.role==='owner');
  });
  app.get(`${tenant}/signatures/:revision`,c=>{
    const actor=tenantActor(store,c,opts.now());
    requireTenantRole(actor,['owner']);
    const revision=pathVersion(c.req.param('revision'),'revision');
    const signature=actor.db.get<{issued_at:string}>('SELECT issued_at FROM policy_signatures WHERE revision = ?', [revision]);
    if (!signature) throw new ApiError('not_found');
    const sales_rate_snapshots=readSalesRateSnapshots(actor.db,revision).map((rate)=>({
      rate_version_id:rate.rate_version_id,model_id:rate.model_id,input_multiplier_basis:rate.input_multiplier_basis,
      input_multiplier_ppm:rate.input_multiplier_ppm,valid_from:rate.valid_from,valid_until:rate.valid_until,
      input_milli_per_mtok:rate.input_milli_per_mtok,output_milli_per_mtok:rate.output_milli_per_mtok,
      cache_read_milli_per_mtok:rate.cache_read_milli_per_mtok,cache_write_milli_per_mtok:rate.cache_write_milli_per_mtok,
    }));
    return c.json({revision,issued_at:signature.issued_at,sales_rate_snapshots,actions:['read']});
  });
  app.get(`${contracts}/:tenant_id/signatures/:revision`,c=>{
    const {db,id}=platformTenant(c,opts.now());
    const row=readSignature(db,pathVersion(c.req.param('revision'),'revision'));
    if (!row) throw new ApiError('not_found');
    return c.json(signatureView(db,id,row));
  });
  app.post(`${contracts}/:tenant_id/preview`,async c=>{
    const at=opts.now(),{db,id}=platformTenant(c,at),body=await json(c);
    const {head,entries,reason}=signingDraft(db,body);
    const revision=head.platform_revision+1;
    const prospective={revision,entries,reason,issued_at:iso(at),issued_by:''};
    const current=db.get<{n:number}>("SELECT count(*) AS n FROM members WHERE status='active'")!.n;
    const affected=calculatePolicy(db,id,prospective);
    return c.json({...head,tenant_id:id,previous_entries:readSignature(db,head.platform_revision)?.entries??[],entries,
      sales_rate_snapshots:signatureSalesRates(store,entries),
      impact:signatureImpact(store,db,affected,opts.dataDir,at,{devices:pagination(c),members:pagination(c,'member_cursor')}),
      seats:{limit:affected.tenant.hot.seat_limit,active:current,over_limit:Math.max(0,current-affected.tenant.hot.seat_limit)},
      revoked:affected.revised.map(({scope,subject_id,revoked})=>({scope,subject_id,revoked})),actions:['sign']});
  });
  app.post(`${contracts}/:tenant_id/signatures`,async c=>{
    const at=opts.now(),{db,id,actor}=platformTenant(c,at),body=await json(c),op=opFor(c,opts,at,actor,body);
    const result=await db.write(sql=>{
      platformCheck(actor);
      const cached=op.read(sql);
      if (cached) return {response:cached,changed:false};
      const {head,entries,reason}=signingDraft(sql,body);
      const signature:Signature={revision:head.platform_revision+1,entries,reason,issued_by:actor,issued_at:iso(at)};
      const projection=calculatePolicy(sql,id,signature);
      sql.run('INSERT INTO policy_signatures (revision,reason,issued_by,issued_at,entries_json) VALUES (?, ?, ?, ?, ?)',
        [signature.revision,reason,actor,signature.issued_at,JSON.stringify(entries)]);
      insertSalesRateSnapshots(sql,signature.revision,signature.issued_at,signatureSalesRates(store,entries));
      const next={platform_revision:signature.revision,policy_revision:head.policy_revision+1};
      publishProjection(sql,projection,next,actor,at);
      refreshCommerce(store,id,sql,at);
      audit(sql,actor,'policy.signature.publish',id,{...next,reason,base_revision:body.base_revision},at);
      return {response:op.complete(sql,{status:201,payload:signatureView(sql,id,signature)}),changed:true};
    });
    if (result.changed) opts.onConfigChange?.(id);
    return result.response;
  });

  function configAccess(sql:PolicyReader,actor:Actor,scope:Scope,subjectId:string) {
    if (scope==='tenant') {
      if (subjectId!==actor.id) throw new ApiError('not_found');
      if (actor.role!=='owner'&&actor.role!=='admin') throw new ApiError('forbidden');
      return actor.role==='owner';
    }
    const subject=scope==='group'?sql.get<{group_id:string;role:string|null}>("SELECT id AS group_id,NULL AS role FROM groups WHERE id=?",[subjectId]):
      sql.get<{group_id:string|null;role:string}>('SELECT group_id,role FROM members WHERE user_id=?',[subjectId]);
    if (!subject) throw new ApiError('not_found');
    if (actor.role==='owner') return true;
    if (actor.role==='admin') return scope==='group'||subject.role==='member';
    if (actor.role==='member'&&scope==='member'&&actor.userId===subjectId) return false;
    if (actor.role!=='group_admin'||!actor.group_id||!subject.group_id || !sql.get(`WITH RECURSIVE ancestry(id) AS
      (VALUES (?) UNION SELECT g.parent_id FROM groups g JOIN ancestry a ON a.id=g.id WHERE g.parent_id IS NOT NULL)
      SELECT id FROM ancestry WHERE id=?`,[subject.group_id,actor.group_id])) throw new ApiError('not_found');
    return scope==='group'||subject.role==='member';
  }
  function configView(sql:PolicyReader,actor:Actor, scope:Scope,subjectId:string,canWrite:boolean,effective=readEffective(sql,scope,subjectId)) {
    const head=readHead(sql)??noPolicy;
    const profile=effective??readProfile(sql,scope,subjectId);
    const visible = effective?.entries.filter(({definition})=>actor.role==='owner'||
      (definition.schema.kind!=='text'&&!definition.binding?.adapter.startsWith('billing.')))??[];
    return {...head,tenant_id:actor.id,scope,subject_id:subjectId,revision:profile.revision,
      template_ref:profile.template_ref,selections:profile.selections.flatMap(selection=>{
        const key='selection:'+selection.clause_ref.id;
        if (!profile.revoked.includes(key)) return [selection];
        const retained=profile.retained[key];
        const entry=visible.find(entry=>sameRef(entry.clause_ref,selection.clause_ref));
        return retained===undefined||!entry?[]:[{...selection,value:retained}];
      }),
      revoked:profile.revoked,entries:visible,actions:canWrite&&head.platform_revision?['read','update']:['read']};
  }
  function configDraft(sql:PolicyReader,actor:Actor,scope:Scope,subjectId:string,body:Record<string,unknown>) {
    object(body,'body',['expected_policy_revision','expected_platform_revision','template_ref','selections','restore_revision']);
    if (!configAccess(sql,actor,scope,subjectId)) throw new ApiError('forbidden');
    const head=readHead(sql);
    const signed=head&&readSignature(sql,head.platform_revision);
    if (!head||!signed) throw new ApiError('conflict',{reason:'platform_contract_required'});
    expectHead(body,head);
    const existing=readEffective(sql,scope,subjectId);
    if (!existing) throw new ApiError('conflict',{reason:'policy_projection_pending'});
    if (body.restore_revision!==undefined) {
      if (Object.hasOwn(body,'selections') || Object.hasOwn(body,'template_ref')) invalid('restore_revision');
      const historical=historicalProfile(sql,scope,subjectId,int(body.restore_revision,'restore_revision',1));
      if (!historical) throw new ApiError('not_found');
      if (historical.revoked.some(key=>key.startsWith('template:'))) {
        throw new ApiError('conflict',{reason:'historical_template_contains_revoked_entries'});
      }
      body={...body,template_ref:historical.template_ref,selections:historical.selections.flatMap(selection=>{
        const key='selection:'+selection.clause_ref.id;
        if (!historical.revoked.includes(key)) return [selection];
        return Object.hasOwn(historical.retained,key)?[{...selection,value:historical.retained[key]}]:[];
      })};
    }
    const template_ref=body.template_ref===null?null:reference(body.template_ref,'template_ref');
    if (template_ref && readTemplate(sql,template_ref,false)?.scope!==scope) invalid('template_ref');
    const upper=existing.entries.map(entry=>({...entry,effective_value:entry.parent_value}));
    const selections=parseChoices(body.selections,upper,scope);
    const profile:Profile={scope,subject_id:subjectId,revision:existing.revision+1,template_ref,selections,revoked:[],retained:{}};
    const projection=calculatePolicy(sql,actor.id,signed,profile);
    const effective=projection.materialized.get(scope+':'+subjectId)!;
    const invalidProfile=projection.revised.find(row=>row.scope===scope&&row.subject_id===subjectId);
    if (invalidProfile) {
      const clauseId=invalidProfile.revoked[0]!.split(':').at(-1)!;
      const ref=upper.find(entry=>entry.clause_ref.id===clauseId)?.clause_ref??{id:clauseId,version:1};
      clauseError('selections',ref,'exceeds_parent');
    }
    if (scope==='tenant'&&balanceThresholdOrderInvalid(effective.hot.low_balance_warn_milli,effective.hot.low_balance_restrict_milli)) {
      const warn=effective.entries.find(entry=>entry.definition.binding?.adapter==='balance.warn')!;
      const index=selections.findIndex(selection=>sameRef(selection.clause_ref,warn.clause_ref));
      clauseError(index>=0?`selections.${index}.value`:'selections',warn.clause_ref,'balance_warn_below_restrict');
    }
    return {head,profile,projection,effective};
  }
  app.get(`${tenant}/configurations/:scope`,c=>{
    const actor=tenantActor(store,c,opts.now()),scope=choice(c.req.param('scope'),['group','member'],'scope');
    const p=pagination(c);
    const group=scope==='group';
    if (group&&actor.role==='member') throw new ApiError('forbidden');
    const predicates:string[]=[];
    const params:string[]=[];
    const id=group?'id':'user_id';
    const table=group?'groups':'members';
    if (actor.role==='group_admin') {
      if (!actor.group_id) throw new ApiError('forbidden');
      predicates.push(`${group?'id':'group_id'} IN (WITH RECURSIVE subtree(id) AS
        (VALUES (?) UNION SELECT g.id FROM groups g JOIN subtree s ON g.parent_id=s.id) SELECT id FROM subtree)`);
      params.push(actor.group_id);
    } else if (actor.role==='member') {
      predicates.push('user_id = ?');
      params.push(actor.userId);
    }
    if (p.query) {
      if (group) {
        predicates.push("instr(lower(name || ' ' || id),lower(?)) > 0");
        params.push(p.query);
      } else {
        const ids=system.all<{id:string}>("SELECT id FROM platform_users WHERE instr(lower(name || ' ' || id),lower(?)) > 0",[p.query]);
        predicates.push('user_id IN (SELECT value FROM json_each(?))');
        params.push(JSON.stringify(ids.map(row=>row.id)));
      }
    }
    const where=predicates.length?'WHERE '+predicates.join(' AND '):'';
    const {n}=actor.db.get<{n:number}>(`SELECT count(*) AS n FROM ${table} ${where}`,params)!;
    const columns=group?'id,name,parent_id':'user_id AS id,group_id,role';
    const rows=actor.db.all<{id:string;name?:string;parent_id?:string|null;group_id?:string|null;role?:string}>(
      `SELECT ${columns} FROM ${table} ${where} ORDER BY ${id} LIMIT ? OFFSET ?`,[...params,p.limit,p.offset]);
    return c.json(p.page(rows.map(row=>({...row,name:row.name??system.get<{name:string}>('SELECT name FROM platform_users WHERE id=?',[row.id])?.name??row.id,
      actions:['read']})),n));
  });
  const configurations=`${tenant}/configurations/:scope/:subject_id`;
  app.get(`${configurations}/history`,c=>{
    const actor=tenantActor(store,c,opts.now()),scope=choice(c.req.param('scope'),['tenant','group','member'],'scope');
    const id=c.req.param('subject_id'),canWrite=configAccess(actor.db,actor,scope,id);
    const p=pagination(c);
    const params=[scope,id];
    const where='WHERE scope=? AND subject_id=?';
    const total=actor.db.get<{n:number}>(`SELECT count(*) AS n FROM policy_configurations ${where}`,params)!.n;
    const items=actor.db.all(`SELECT revision,platform_revision,updated_by,updated_at,restored_from_revision
      FROM policy_configurations ${where} ORDER BY revision DESC LIMIT ? OFFSET ?`,[...params,p.limit,p.offset]);
    return c.json(p.page(items,total,canWrite?['restore']:[]));
  });
  app.get(contracts+'/:tenant_id/targets',c=>{
    const {db}=platformTenant(c,opts.now()),p=pagination(c);
    const matches=system.all<{id:string}>("SELECT id FROM platform_users WHERE instr(lower(id||' '||name),lower(?))>0",[p.query]);
    const params=[JSON.stringify(matches.map(row=>row.id))];
    const where="WHERE status='active' AND user_id IN (SELECT value FROM json_each(?))";
    const n=db.get<{n:number}>(`SELECT count(*) AS n FROM members ${where}`,params)!.n;
    const items=db.all<{user_id:string}>(`SELECT user_id FROM members ${where} ORDER BY user_id LIMIT ? OFFSET ?`,[...params,p.limit,p.offset]);
    return c.json(p.page(items.map(row=>({...row,name:system.get<{name:string}>('SELECT name FROM platform_users WHERE id=?',[row.user_id])?.name,actions:['read']})),n));
  });
  for(const platformView of [true,false]) {
    const endpoint=(platformView?contracts+'/:tenant_id':tenant)+'/targets/:user_id';
    app.get(endpoint,c=>{
      const at=opts.now(),actor=platformView?platformTenant(c,at):tenantActor(store,c,at);
      const userId=string(c.req.param('user_id'),'user_id',128);
      if ('role' in actor) configAccess(actor.db,actor,'member',userId);
      const doc=readEffective(actor.db,'member',userId);
      if (!doc||!actor.db.get("SELECT 1 FROM members WHERE user_id=? AND status='active'",[userId])) throw new ApiError('not_found');
      const os=choice(c.req.query('os'),['darwin','win32','linux'],'os');
      const arch=choice(c.req.query('arch'),['arm64','x64'],'arch');
      const upper=readEffective(actor.db,'tenant',actor.id);
      const signed=upper?.entries.map(entry=>({...entry,effective_value:entry.parent_value}));
      const result=targetPolicy(store,actor.db,doc,opts.dataDir,at,{os,arch,has_key:1},platformView||('role' in actor&&actor.role==='owner')?signed:undefined);
      return c.json({...readHead(actor.db),user_id:userId,...visibleTarget(result,platformView||('role' in actor&&actor.role==='owner'))});
    });
  }
  app.get(configurations,c=>{
    const actor=tenantActor(store,c,opts.now()),scope=choice(c.req.param('scope'),['tenant','group','member'],'scope');
    const id=c.req.param('subject_id');
    return c.json(configView(actor.db,actor,scope,id,configAccess(actor.db,actor,scope,id)));
  });
  app.post(`${configurations}/preview`,async c=>{
    const actor=tenantActor(store,c,opts.now()),scope=choice(c.req.param('scope'),['tenant','group','member'],'scope');
    const id=c.req.param('subject_id'),body=await json(c);
    const result=configDraft(actor.db,actor,scope,id,body);
    return c.json({...configView(actor.db,actor,scope,id,true,result.effective),
      previous_entries:configView(actor.db,actor,scope,id,true).entries,actions:['update']});
  });
  app.put(configurations,async c=>{
    const at=opts.now(),actor=tenantActor(store,c,at),scope=choice(c.req.param('scope'),['tenant','group','member'],'scope');
    const id=c.req.param('subject_id'),body=await json(c),op=opFor(c,opts,at,actor.userId,body);
    const result=await actor.db.write(sql=>{
      const active=actorInside(actor,sql,store);
      if (!configAccess(sql,active,scope,id)) throw new ApiError('forbidden');
      const cached=op.read(sql);
      if (cached) return {response:cached,changed:false};
      const draft=configDraft(sql,active,scope,id,body);
      const next={...draft.head,policy_revision:draft.head.policy_revision+1};
      saveProfile(sql,draft.profile,next.platform_revision,active.userId,at);
      if (body.restore_revision!==undefined) sql.run('UPDATE policy_configurations SET restored_from_revision=? WHERE scope=? AND subject_id=? AND revision=?',
        [Number(body.restore_revision),scope,id,draft.profile.revision]);
      publishProjection(sql,draft.projection,next,active.userId,at);
      audit(sql,active.userId,'policy.configuration.publish',id,{...next,scope,revision:draft.profile.revision,restored_from_revision:body.restore_revision??null},at);
      return {response:op.complete(sql,{status:200,payload:configView(sql,active,scope,id,true)}),changed:true};
    });
    if (result.changed) opts.onConfigChange?.(actor.id);
    return result.response;
  });

  function rechargeView(row:Recharge,tenantId:string) {
    const {command_fingerprint,...receipt}=row;
    return {...receipt,platform_revision:receipt.platform_revision??0,tenant_id:tenantId,actions:['read']};
  }
  for (const isPlatform of [true,false]) {
    const path=isPlatform?`${contracts}/:tenant_id/recharges`:`${tenant}/recharges`;
    function access(c:Context,at:number) {
      if (isPlatform) return platformTenant(c,at);
      const actor=tenantActor(store,c,at);
      requireTenantRole(actor,['owner','admin']);
      return actor;
    }
    app.get(path,c=>{
      const at=opts.now(),{id,db}=access(c,at),p=pagination(c);
      const where="WHERE instr(lower(r.ledger_id || ' ' || coalesce(l.note,'')),lower(?)) > 0";
      const {n}=db.get<{n:number}>(`SELECT count(*) AS n FROM policy_recharges r JOIN ledger l ON l.id=r.ledger_id ${where}`,[p.query])!;
      const rows=db.all<Recharge>(`${rechargeFields} ${where} ORDER BY l.at DESC,r.ledger_id DESC LIMIT ? OFFSET ?`,[p.query,p.limit,p.offset]);
      return c.json({...p.page(rows.map(row=>rechargeView(row,id)),n,isPlatform&&readHead(db)?['topup']:[]),balance:balance(db,at)});
    });
    app.get(`${path}/:ledger_id`,c=>{
      const {id,db}=access(c,opts.now());
      const row=db.get<Recharge>(`${rechargeFields} WHERE r.ledger_id=?`,[c.req.param('ledger_id')]);
      if (!row) throw new ApiError('not_found');
      return c.json(rechargeView(row,id));
    });
  }
  app.post(`${contracts}/:tenant_id/recharges`,async c=>{
    const at=opts.now(),{db,id,actor}=platformTenant(c,at),body=await json(c),op=opFor(c,opts,at,actor,body);
    object(body,'body',['amount_milli','note']);
    const amount=int(body.amount_milli,'amount_milli',1);
    const note=body.note===undefined?null:string(body.note,'note',500);
    const key=hash(op.scope+':'+op.key);
    const fingerprint=hmac(opts.codeSecret,['policy-topup',id,actor,amount,note]);
    const result=await db.write(sql=>{
      platformCheck(actor);
      const cached=sql.get<Recharge>(`${rechargeFields} WHERE r.command_key=?`,[key]);
      if (cached) {
        if (cached.command_fingerprint!==fingerprint) throw new ApiError('conflict');
        return {response:c.json(rechargeView(cached,id),201),changed:false};
      }
      const head=readHead(sql);
      if (!head) throw new ApiError('conflict',{reason:'platform_contract_required'});
      const before=balance(sql,at).balance_milli;
      const {total}=sql.get<{total:number}>("SELECT coalesce(sum(amount_milli),0) AS total FROM ledger WHERE kind IN ('topup','adjust') AND amount_milli>0")!;
      if (!Number.isSafeInteger(before+amount)||!Number.isSafeInteger(total+amount)) invalid('amount_milli');
      const row=appendLedgerEntry(sql,'topup',amount,at,{actor,note:note??undefined});
      sql.run(`INSERT INTO policy_recharges (ledger_id,platform_revision,balance_before_milli,balance_after_milli,command_key,command_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?)`,[row.id,head.platform_revision,before,before+amount,key,fingerprint]);
      audit(sql,actor,'ledger.topup',row.id,{platform_revision:head.platform_revision,amount_milli:amount,note},at);
      return {response:c.json(rechargeView(sql.get<Recharge>(`${rechargeFields} WHERE r.ledger_id=?`,[row.id])!,id),201),changed:true};
    });
    if (result.changed) opts.onBalanceChange?.(id);
    return result.response;
  });
}
