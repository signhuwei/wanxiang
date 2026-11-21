import { commerceCatalog } from './commerce-data';
import { ApiError, invalid } from './api';
import { managedAgents } from './agent-catalog';
import { int } from './management';
import type { Transaction } from './store';
import { validateToolSet } from './tool-releases';

export type PolicyReader = Pick<Transaction, 'get' | 'all'>;
export type Scope = 'tenant' | 'group' | 'member';
export const policyCatalogs = ['agents', 'models', 'tools', 'releases', 'providers', 'commerce_plans'] as const;
export type Catalog = typeof policyCatalogs[number];
export type Ref = { id: string; version: number };
export type Value = boolean | number | string | string[];
export type Kind = 'boolean' | 'integer' | 'money_milli' | 'ratio_ppm' | 'enum' | 'resource_set' | 'text';
export type Merge = 'fixed' | 'min' | 'max' | 'intersection' | 'and';
export type Schema = { kind: Kind; min?: number; max?: number; catalog?: Catalog; options?: { id: string; label: string }[] };
export type Definition = Ref & {
  title: string; description: string; category: string; schema: Schema; scopes: Scope[]; merge: Merge; default_value: Value;
  binding: { adapter: string; abi: 1 } | null;
};
export type Choice = { clause_ref: Ref; value: Value };
export type SignedEntry = { clause_ref: Ref; template_ref: Ref | null; base_value: Value; adjustment?: Value; signed_value: Value; definition: Definition; display?: Record<string,string> };
export type Source = { scope: Scope | 'platform'; subject_id: string; revision: number };
export type EffectiveEntry = { clause_ref: Ref; definition: Definition; parent_value: Value; effective_value: Value; source: Source; display?: Record<string,string> };

const scopes: readonly Scope[] = ['tenant', 'group', 'member'];
const kinds: readonly Kind[] = ['boolean', 'integer', 'money_milli', 'ratio_ppm', 'enum', 'resource_set', 'text'];
const merges: Record<Kind, readonly Merge[]> = {
  boolean: ['fixed','and'], integer: ['fixed','min','max'], money_milli: ['fixed','min','max'], ratio_ppm: ['fixed','min','max'],
  enum: ['fixed'], resource_set: ['fixed','intersection'], text: ['fixed'],
};
const tenant = ['tenant'] as const;
const limit = { kind: 'money_milli', merge: 'min', scopes } as const;
const visibility = { kind: 'boolean', merge: 'and', scopes: tenant } as const;
const adapters: Record<string,{ kind:Kind; merge:Merge; scopes:readonly Scope[]; catalog?:Catalog; min?:number; max?:number }> = {
  'seats.limit': {kind:'integer', merge:'fixed', scopes:tenant, min:0},
  'access.agents': {kind:'resource_set', merge:'intersection', scopes, catalog:'agents'},
  'access.models': {kind:'resource_set', merge:'intersection', scopes, catalog:'models'},
  'access.tools': {kind:'resource_set', merge:'intersection', scopes, catalog:'tools'},
  'access.releases': {kind:'resource_set',merge:'intersection',scopes,catalog:'releases'},
  'network.providers': {kind:'resource_set',merge:'intersection',scopes,catalog:'providers'},
  'upstream.custom': {kind:'boolean',merge:'and',scopes:tenant},
  'route.failover': {kind:'boolean',merge:'and',scopes},
  'network.public': {kind:'boolean',merge:'and',scopes},
  'session.export': {kind:'boolean',merge:'and',scopes},
  'session.share': {kind:'boolean',merge:'and',scopes},
  'session.retention_days': {kind:'integer',merge:'max',scopes,min:1,max:36500},
  ...Object.fromEntries(['model.max_output_tokens','rate.member_rpm','rate.member_tpm','rate.member_concurrent','rate.key_concurrent']
    .map(id=>[id,{kind:'integer',merge:'min',scopes,min:1} as const])),
  'lease.minutes': {kind:'integer', merge:'min', scopes, min:1, max:1440},
  'lease.budget': limit,
  'quota.monthly': limit,
  'quota.distribution': {kind:'boolean', merge:'fixed', scopes:tenant},
  'balance.warn': {...limit, scopes:tenant},
  'balance.restrict': {...limit, scopes:tenant},
  'balance.fallback_models': {kind:'resource_set', merge:'intersection', scopes:tenant, catalog:'models'},
  'billing.plan': {kind:'resource_set',merge:'fixed',scopes:tenant,catalog:'commerce_plans'},
  'billing.discount': {kind:'ratio_ppm', merge:'fixed', scopes:tenant, min:0, max:1_000_000},
  'observation.admin.summary': visibility, 'observation.admin.content': visibility,
  'observation.group_admin.summary': visibility, 'observation.group_admin.content': visibility,
};
export const policyAdapters = () => Object.entries(adapters).map(([id, schema])=>({id,abi:1,...schema}));

export function object(value: unknown, at: string, allowed?: readonly string[]): Record<string,unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(at);
  const row = value as Record<string,unknown>;
  if (allowed) for (const key of Object.keys(row)) if (!allowed.includes(key)) invalid(`${at}.${key}`);
  return row;
}
export function choice<const T extends string>(value: unknown, list: readonly T[], at: string): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid(at);
  return value as T;
}
export function string(value: unknown, at: string, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) invalid(at);
  return value.trim();
}
export function stableId(value: unknown, at = 'id') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) invalid(at);
  return value;
}
export function reference(value: unknown, at: string): Ref {
  const row = object(value, at, ['id','version']);
  return { id: stableId(row.id, `${at}.id`), version: int(row.version, `${at}.version`, 1) };
}
export function pathVersion(value: string | undefined, at = 'version') {
  if (!value || !/^\d+$/.test(value)) invalid(at);
  return int(Number(value), at, 1);
}
export function array(value: unknown, at: string, max = 128): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(at);
  return value;
}
export function clauseError(at: string, ref: Ref, code: string): never {
  throw new ApiError('invalid',{fields:[at],clauses:[{clause_ref:ref,code}]});
}
export const sameRef = (a:Ref,b:Ref) => a.id === b.id && a.version === b.version;
export function catalogRows(sql: PolicyReader, catalog: Catalog, active = true): {id:string;label:string}[] {
  if (catalog === 'commerce_plans') return commerceCatalog(sql);
  if (catalog === 'agents') return managedAgents.map(id => ({ id, label: ({
    'claude-code':'Claude Code',codex:'Codex','kimi-code':'Kimi Code','claude-desktop':'Claude Desktop','codex-desktop':'Codex Desktop',workbuddy:'WorkBuddy','deepseek-desktop':'DeepSeek Harness',
  })[id] }));
  if (catalog === 'providers') return sql.all(`SELECT id, name AS label FROM providers ${active ? "WHERE status = 'active'" : ''} ORDER BY name, id`);
  if (catalog === 'releases') return sql.all(`SELECT id, agent || ' · ' || version || ' · ' || os || '/' || arch AS label
    FROM agent_releases ${active ? "WHERE status = 'active'" : ''} ORDER BY agent, version, os, arch, id`);
  if (catalog === 'tools') return sql.all(`SELECT id, name || ' · ' || version || ' · ' || kind || coalesce(' · ' || os || '/' || arch, '')
    || ' · ' || (SELECT group_concat(value, ', ') FROM json_each(agents_json)) AS label
    FROM tool_releases ${active ? "WHERE status = 'published'" : ''} ORDER BY name, version, id`);
  return sql.all(`SELECT m.id, m.display_name AS label FROM models m JOIN providers p ON p.id = m.provider_id
    ${active ? "WHERE m.status = 'active' AND p.status = 'active'" : ''} ORDER BY m.id`);
}
export function resourceDisplay(sql:PolicyReader,def:Definition,...values:Value[]) {
  if (def.schema.kind!=='resource_set') return undefined;
  const ids=new Set(values.flatMap(value=>Array.isArray(value)?value:[]));
  const names=catalogRows(sql,def.schema.catalog!,false).filter(row=>ids.has(row.id));
  return Object.fromEntries(names.map(({id,label})=>[id,label]));
}
export function valueFor(schema: Schema, value: unknown, at: string, system?: PolicyReader): Value {
  if (schema.kind === 'boolean') {
    if (typeof value !== 'boolean') invalid(at);
    return value;
  }
  if (schema.kind === 'text') return string(value, at, 1200, true);
  if (schema.kind === 'enum') return choice(value, schema.options!.map(o => o.id), at);
  if (schema.kind === 'resource_set') {
    const list = array(value, at, schema.catalog === 'commerce_plans' ? 1 : schema.catalog === 'tools' ? 64 : 512);
    if (list.some(id => typeof id !== 'string' || !id.length || id.length > 128) || new Set(list).size !== list.length) invalid(at);
    if (system && schema.catalog === 'tools') validateToolSet(system, list as string[], at);
    else if (system) {
      const ids = new Set(catalogRows(system, schema.catalog!).map(row => row.id));
      if (list.some(id => !ids.has(id as string))) invalid(at);
    }
    return (list as string[]).toSorted();
  }
  return int(value, at, schema.min ?? 0, schema.max ?? Number.MAX_SAFE_INTEGER);
}

export function parseDefinition(body: Record<string,unknown>, version: number, system: PolicyReader): Definition {
  object(body, 'body', ['id','expected_version','title','description','category','schema','scopes','merge','default_value','binding']);
  const id = stableId(body.id);
  const raw = object(body.schema, 'schema', ['kind','min','max','catalog','options']);
  const kind = choice(raw.kind, kinds, 'schema.kind');
  const schema: Schema = { kind };
  if (kind === 'resource_set') schema.catalog = choice(raw.catalog, policyCatalogs, 'schema.catalog');
  if (kind === 'enum') {
    schema.options = array(raw.options,'schema.options').map((option,index) => {
      const at = `schema.options.${index}`;
      const row = object(option,at,['id','label']);
      return { id:stableId(row.id,`${at}.id`), label:string(row.label,`${at}.label`,128) };
    });
    if (!schema.options.length || new Set(schema.options.map(o=>o.id)).size !== schema.options.length) invalid('schema.options');
  }
  const numeric = kind === 'integer' || kind === 'money_milli' || kind === 'ratio_ppm';
  if (numeric) {
    if (raw.min !== undefined) schema.min = int(raw.min,'schema.min');
    if (raw.max !== undefined) schema.max = int(raw.max,'schema.max',schema.min ?? 0);
  }
  if ((!numeric && (raw.min !== undefined || raw.max !== undefined)) ||
      (kind !== 'resource_set' && raw.catalog !== undefined) || (kind !== 'enum' && raw.options !== undefined)) invalid('schema');
  const merge = choice(body.merge,merges[kind],'merge');
  const selected = array(body.scopes,'scopes',3).map(scope=>choice(scope,scopes,'scopes'));
  if (!selected.length || new Set(selected).size !== selected.length || (merge === 'fixed' && selected.some(scope=>scope !== 'tenant'))) invalid('scopes');
  let binding: Definition['binding'] = null;
  if (body.binding !== null && body.binding !== undefined) {
    const row = object(body.binding,'binding',['adapter','abi']);
    const adapter = stableId(row.adapter,'binding.adapter');
    const supported = Object.hasOwn(adapters,adapter) ? adapters[adapter] : undefined;
    if (!supported || row.abi !== 1 || supported.kind !== kind || supported.merge !== merge || supported.catalog !== schema.catalog ||
        selected.some(scope=>!supported.scopes.includes(scope)) ||
        (supported.min !== undefined && (schema.min ?? 0) < supported.min) ||
        (supported.max !== undefined && (schema.max ?? Number.MAX_SAFE_INTEGER) > supported.max)) invalid('binding');
    binding = { adapter, abi:1 };
  } else if (kind !== 'text') invalid('binding');
  return { id, version, title:string(body.title,'title',128), description:string(body.description??'','description',1000,true),
    category:string(body.category,'category',64), schema, scopes:selected, merge, default_value:valueFor(schema,body.default_value,'default_value',system), binding };
}

export function canNarrow(definition: Definition, parent: Value, next: Value) {
  switch (definition.merge) {
    case 'min': return (next as number) <= (parent as number);
    case 'max': return (next as number) >= (parent as number);
    case 'intersection': return (next as string[]).every(id => (parent as string[]).includes(id));
    case 'and': return !next || !!parent;
    case 'fixed': return false;
  }
}
