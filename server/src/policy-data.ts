import { ulid } from 'ulid';
import { iso } from './credentials';
import type { Transaction } from './store';
import { canNarrow, sameRef, type Choice, type EffectiveEntry, type Kind, type PolicyReader,
  type Ref, type Scope, type SignedEntry, type Value } from './policy-types';

export type Head = { platform_revision: number; policy_revision: number };
export type Signature = {revision:number; reason:string; issued_by:string; issued_at:string; entries:SignedEntry[]};
export type Template = Ref & {name:string; description:string; scope:'platform'|'group'|'member'; entries:Choice[]};
type TemplateRow = Omit<Template,'scope'|'entries'> & {scope?:Template['scope'];entries_json:string};
type RecordRow = {
  scope:Scope; subject_id:string; revision:number; template_id:string|null; template_version:number|null;
  selections_json:string; revoked_json:string; retained_json:string;
};
export type Profile = {scope:Scope;subject_id:string;template_ref:Ref|null;revision:number;selections:Choice[];revoked:string[];retained:Record<string,Value>};
type Group = {id:string;parent_id:string|null};
type Member = {user_id:string;group_id:string|null;role:string;status:string};
type ReferenceSource = {id:string;revision:number};
type HotPolicy = {
  seat_limit:number; allowed_models_json:string; allowed_agents_json:string; agent_release_pins_json:string;
  tool_release_ids_json:string; discount_ppm:number;
  low_balance_warn_milli:number; low_balance_restrict_milli:number; low_balance_models_json:string;
  lease_budget_milli:number; lease_minutes:number; quota_distribution:number; quota_milli:number|null;
  visibility_json:string; commerce_plan_id:string|null; runtime_rules_json:string; release_ids_json:string|null; provider_ids_json:string|null;
};
export type Effective = {
  scope:Scope; subject_id:string; revision:number; template_ref:Ref|null; selections:Choice[]; revoked:string[]; retained:Record<string,Value>;
  entries:EffectiveEntry[]; hot:HotPolicy; tenant_revision:number|null; groups:ReferenceSource[]; member:ReferenceSource|null;
};
export type PolicyNotice = {id:string;kind:'policy_changed';title:string;at:string;policy_revision:number};

export const noPolicy = { platform_revision: 0, policy_revision: 0 };
export function readHead(sql:Pick<PolicyReader,'get'>): Head | null {
  return sql.get<Head>('SELECT platform_revision, policy_revision FROM policy_head WHERE id = 1');
}
export function readSignature(sql:Pick<PolicyReader,'get'>, revision:number): Signature | null {
  const row=sql.get<Omit<Signature,'entries'> & {entries_json:string}>('SELECT * FROM policy_signatures WHERE revision = ?', [revision]);
  if (!row) return null;
  const {entries_json,...rest}=row;
  return {...rest,entries:JSON.parse(entries_json)};
}
export function readTemplate(sql:Pick<PolicyReader,'get'>, ref:Ref, platform:boolean): Template | null {
  const table=platform?'policy_templates':'policy_configuration_templates';
  const row=sql.get<TemplateRow>(`SELECT * FROM ${table} WHERE id = ? AND version = ?`,[ref.id,ref.version]);
  if (!row) return null;
  const {entries_json,scope,...rest}=row;
  return {...rest,scope:scope??'platform',entries:JSON.parse(entries_json)};
}
function profileFrom(row:RecordRow):Profile {
  const {scope,subject_id,revision,template_id,template_version}=row;
  return {scope,subject_id,revision,template_ref:template_id&&template_version?{id:template_id,version:template_version}:null,
    selections:JSON.parse(row.selections_json),revoked:JSON.parse(row.revoked_json),retained:JSON.parse(row.retained_json)};
}
export function historicalProfile(sql:PolicyReader, scope:Scope, subjectId:string, revision:number) {
  const row=sql.get<RecordRow>('SELECT * FROM policy_configurations WHERE scope=? AND subject_id=? AND revision=?',[scope,subjectId,revision]);
  return row?profileFrom(row):null;
}
export function readProfile(sql:Pick<PolicyReader,'get'>,scope:Scope,subjectId:string):Profile {
  const row=sql.get<RecordRow>(`SELECT * FROM policy_configurations WHERE scope = ? AND subject_id = ? ORDER BY revision DESC LIMIT 1`,[scope,subjectId]);
  return row?profileFrom(row):{scope,subject_id:subjectId,template_ref:null,revision:0,selections:[],revoked:[],retained:{}};
}
export function readEffective(sql:Pick<PolicyReader,'get'>, scope:Scope, subjectId:string): Effective|null {
  const row=sql.get<{document_json:string}>('SELECT document_json FROM policy_effective WHERE scope = ? AND subject_id = ?',[scope,subjectId]);
  return row?JSON.parse(row.document_json):null;
}
function hotPolicy(entries:EffectiveEntry[]):HotPolicy {
  const values=new Map(entries.flatMap(({definition,effective_value})=>definition.binding?[[definition.binding.adapter,effective_value] as const]:[]));
  const number=(key:string,fallback:number)=>Number(values.get(key)??fallback);
  return {
    commerce_plan_id:(values.get('billing.plan') as string[]|undefined)?.[0]??null,
    seat_limit:number('seats.limit',0),
    allowed_models_json:JSON.stringify(values.get('access.models')??[]),
    allowed_agents_json:JSON.stringify(values.get('access.agents')??[]),
    tool_release_ids_json:JSON.stringify(values.get('access.tools')??[]),
    agent_release_pins_json:'[]',
    release_ids_json:values.has('access.releases')?JSON.stringify(values.get('access.releases')):null,
    provider_ids_json:values.has('network.providers')?JSON.stringify(values.get('network.providers')):null,
    runtime_rules_json:JSON.stringify(Object.fromEntries([...values].filter(([key])=>
      /^(model|rate|route|network|upstream|session)\./.test(key)))),
    lease_budget_milli:number('lease.budget',0),lease_minutes:number('lease.minutes',10),
    quota_distribution:Number(values.get('quota.distribution')===true),
    quota_milli:values.get('quota.monthly') as number|undefined ?? null,
    discount_ppm:number('billing.discount',1_000_000),
    low_balance_warn_milli:number('balance.warn',0),
    low_balance_restrict_milli:number('balance.restrict',0),
    low_balance_models_json:JSON.stringify(values.get('balance.fallback_models')??[]),
    visibility_json:JSON.stringify({
      admin: {summary: values.get('observation.admin.summary')===true, content:values.get('observation.admin.content')===true},
      group_admin:{summary:values.get('observation.group_admin.summary')===true,content:values.get('observation.group_admin.content')===true},
    }),
  };
}
const defaultHot=hotPolicy([]);
export function readPolicyHot(sql:Pick<PolicyReader,'get'>,userId:string) {
  const head=readHead(sql);
  return head?{...head,...defaultHot,...readEffective(sql,'member',userId)?.hot}:null;
}
const devicePrefixes=['access.','lease.','quota.','balance.','model.','rate.','route.','network.','session.'];
export function readPolicyDevice(sql:PolicyReader,userId:string) {
  const head=readHead(sql);
  if (!head) return null;
  const effective=readEffective(sql,'member',userId);
  const notices=sql.all<PolicyNotice>(`SELECT id, kind, title, at, policy_revision FROM policy_notices
    WHERE EXISTS (SELECT 1 FROM json_each(user_ids_json) j WHERE j.value = ?)
    ORDER BY policy_revision DESC LIMIT 20`,[userId]).reverse();
  const display=(effective?.entries??[]).flatMap(({definition,effective_value}):{id:string;title:string;kind:Kind;value:Value}[]=>
    (definition.schema?.kind&&definition.binding?.adapter&&devicePrefixes.some(prefix=>definition.binding!.adapter.startsWith(prefix)))?
      [{id:definition.id,title:definition.title,kind:definition.schema.kind,value:effective_value}]:[]);
  return {...head,...defaultHot,...effective?.hot,tenant_revision:effective?.tenant_revision??null,groups:effective?.groups??[],
    member:effective?.member??null,display,notices};
}

function profileKey(scope:Scope,id:string) { return scope+':'+id; }
function conservativeValue(entry:EffectiveEntry):Value {
  switch (entry.definition.merge) {
    case 'min': return entry.definition.schema?.min??0;
    case 'max': return entry.definition.schema?.max??Number.MAX_SAFE_INTEGER;
    case 'and': return false;
    case 'intersection': return [];
    case 'fixed': return entry.effective_value;
  }
}

function constrain(entry:EffectiveEntry,requested:Value):Value {
  const parent=entry.effective_value;
  switch (entry.definition.merge) {
    case 'min': return Math.min(requested as number,parent as number);
    case 'max': return Math.max(requested as number,parent as number);
    case 'and': return !!requested&&!!parent;
    case 'intersection': return (requested as string[]).filter(id=>(parent as string[]).includes(id));
    case 'fixed': return parent;
  }
}

function setFor(sql:PolicyReader,profile:Profile,parent:EffectiveEntry[],distribute:boolean) {
  const template=profile.template_ref?readTemplate(sql,profile.template_ref,false):null;
  const revoked=new Set(profile.revoked);
  const retained={...profile.retained};
  const byId=new Map(parent.map(entry=>[entry.clause_ref.id,entry]));
  const choices=new Map<string,Choice>();
  for (const [origin,source] of [['template',template?.entries??[]],['selection',profile.selections]] as const) {
    for (const choice of source) {
      const id=choice.clause_ref.id;
      const key=origin+':'+id;
      const upper=byId.get(id);
      if (!upper || !upper.definition.scopes.includes(profile.scope) || upper.definition.merge==='fixed' ||
          (!distribute && profile.scope!=='tenant' && upper.definition.binding?.adapter==='quota.monthly')) {
        revoked.add(key);
        delete retained[key];
        continue;
      }
      if (!sameRef(choice.clause_ref,upper.clause_ref)) {
        revoked.add(key);
        retained[key]=conservativeValue(upper);
      }
      const requested=retained[key]??(revoked.has(key)?conservativeValue(upper):choice.value);
      const value=constrain(upper,requested);
      if (revoked.has(key) || !canNarrow(upper.definition,upper.effective_value,requested)) {
        revoked.add(key);
        retained[key]=value;
      }
      choices.set(id,{clause_ref:upper.clause_ref,value});
    }
  }
  const entries=parent.map((upper):EffectiveEntry=>{
    const selected=choices.get(upper.clause_ref.id);
    return {...upper,parent_value:upper.effective_value,
      ...(selected && {effective_value:selected.value,source:{scope:profile.scope,subject_id:profile.subject_id,revision:profile.revision}})};
  });
  return {entries,retained,revoked:[...revoked].sort()};
}

export function calculatePolicy(sql:PolicyReader,tenantId:string,signature:Signature,replacement?:Profile) {
  const groups=sql.all<Group>('SELECT id, parent_id FROM groups');
  const members=sql.all<Member>('SELECT user_id, group_id, role, status FROM members');
  const latest=sql.all<RecordRow>(`SELECT * FROM policy_configurations p WHERE revision =
    (SELECT max(x.revision) FROM policy_configurations x WHERE x.scope = p.scope AND x.subject_id = p.subject_id)`);
  const profiles=new Map(latest.map(row=>[profileKey(row.scope,row.subject_id),profileFrom(row)]));
  if (replacement) profiles.set(profileKey(replacement.scope,replacement.subject_id),replacement);
  const get=(scope:Scope,subjectId:string) => profiles.get(profileKey(scope,subjectId)) ??
    {scope,subject_id:subjectId,revision:0,template_ref:null,selections:[],revoked:[],retained:{}};
  const materialized = new Map<string, Effective>();
  const revised:Profile[]=[];
  const signed=signature.entries.map((entry):EffectiveEntry=>({
    clause_ref:entry.clause_ref,definition:entry.definition,parent_value:entry.signed_value,effective_value:entry.signed_value,
    ...(entry.display && {display:entry.display}),
    source:{scope:'platform',subject_id:tenantId,revision:signature.revision},
  }));

  function apply(profile:Profile, parent:EffectiveEntry[], distribute:boolean, lineage:Pick<Effective,'tenant_revision'|'groups'|'member'>) {
    let selected=setFor(sql,profile,parent,distribute);
    if (profile.revision>0 && (selected.revoked.length!==profile.revoked.length ||
      JSON.stringify(selected.retained)!==JSON.stringify(profile.retained))) {
      profile={...profile,revision:profile.revision+1,revoked:selected.revoked,retained:selected.retained};
      revised.push(profile);
      selected=setFor(sql,profile,parent,distribute);
    }
    const effective:Effective={...profile,...selected, ...lineage, hot:hotPolicy(selected.entries)};
    if (profile.scope==='tenant') effective.tenant_revision=profile.revision||null;
    if (profile.scope==='group'&&profile.revision) effective.groups=[...lineage.groups,{id:profile.subject_id,revision:profile.revision}];
    if (profile.scope==='member'&&profile.revision) effective.member={id:profile.subject_id,revision:profile.revision};
    materialized.set(profileKey(profile.scope,profile.subject_id),effective);
    return effective;
  }
  const tenant=apply(get('tenant',tenantId),signed,true,{tenant_revision:null,groups:[],member:null});
  const distribution=tenant.hot.quota_distribution===1;
  const relations=new Map(groups.map(g=>[g.id,g.parent_id]));
  function groupPolicy(id:string, visiting=new Set<string>()):Effective {
    const existing=materialized.get(profileKey('group',id));
    if (existing) return existing;
    if (!relations.has(id) || visiting.has(id)) throw new Error('Invalid policy group ancestry');
    visiting.add(id);
    const parentId=relations.get(id);
    const parent=parentId?groupPolicy(parentId,visiting):tenant;
    return apply(get('group',id),parent.entries,distribution,{tenant_revision:tenant.tenant_revision,groups:parent.groups,member:null});
  }
  for (const {id} of groups) groupPolicy(id);
  for (const {user_id,group_id} of members) {
    const parent=group_id?groupPolicy(group_id):tenant;
    apply(get('member',user_id),parent.entries,distribution,{tenant_revision:tenant.tenant_revision,groups:parent.groups,member:null});
  }
  return {materialized,revised,tenant,members};
}

export function saveProfile(sql:Transaction,profile:Profile,platformRevision:number,actor:string,at:number) {
  sql.run(`INSERT INTO policy_configurations (scope, subject_id, revision, platform_revision, template_id, template_version,
    selections_json, revoked_json, retained_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [profile.scope,profile.subject_id,profile.revision,platformRevision,profile.template_ref?.id??null,profile.template_ref?.version??null,
    JSON.stringify(profile.selections),JSON.stringify(profile.revoked),JSON.stringify(profile.retained),actor,iso(at)]);
}

export function publishProjection(sql:Transaction, projection:ReturnType<typeof calculatePolicy>, head:Head, actor:string, at:number) {
  for (const profile of projection.revised) saveProfile(sql,profile,head.platform_revision,actor,at);
  const previous = new Map(sql.all<{subject_id:string;document_json:string}>(
    "SELECT subject_id, document_json FROM policy_effective WHERE scope = 'member'").map(row=>[row.subject_id,row.document_json]));
  // Each queue job is a transaction. Readers can only observe the prior snapshot or the complete replacement.
  sql.run('DELETE FROM policy_effective');
  for (const policy of projection.materialized.values()) {
    sql.run('INSERT INTO policy_effective (scope, subject_id, document_json) VALUES (?, ?, ?)',
      [policy.scope,policy.subject_id,JSON.stringify(policy)]);
  }
  sql.run(`INSERT INTO policy_head (id, platform_revision, policy_revision) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET platform_revision = excluded.platform_revision, policy_revision = excluded.policy_revision`,
  [head.platform_revision,head.policy_revision]);
  const hot=projection.tenant.hot;
  const time=iso(at);
  const revision=sql.get<{revision:number}>('SELECT coalesce(max(revision),0)+1 AS revision FROM contract')!.revision;
  sql.run(`INSERT INTO contract (revision, seat_limit, allowed_agents_json, allowed_models_json, agent_release_pins_json,
    lease_minutes, lease_budget_milli, visibility_json, updated_by, updated_at, platform_revision, tenant_revision, quota_distribution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,[revision,hot.seat_limit,hot.allowed_agents_json,hot.allowed_models_json,hot.agent_release_pins_json,
    hot.lease_minutes,hot.lease_budget_milli,hot.visibility_json,actor,time,head.platform_revision,projection.tenant.tenant_revision??0,hot.quota_distribution]);
  const users=projection.members.filter(m=>m.status==='active' &&
    previous.get(m.user_id)!==JSON.stringify(projection.materialized.get(profileKey('member',m.user_id)))).map(m=>m.user_id);
  if (users.length) sql.run('INSERT INTO policy_notices (id, policy_revision, kind, title, at, user_ids_json) VALUES (?, ?, ?, ?, ?, ?)',
    [`pch_${ulid()}`,head.policy_revision,'policy_changed','能力配置已变更',time,JSON.stringify(users)]);
}
export function refreshPolicyForOrganization(sql:Transaction, tenantId:string, actor:string, at:number) {
  const head=readHead(sql);
  const signature=head&&readSignature(sql,head.platform_revision);
  if (!signature || !head) return false;
  publishProjection(sql,calculatePolicy(sql,tenantId,signature),
    {...head,policy_revision:head.policy_revision+1},actor,at);
  return true;
}
