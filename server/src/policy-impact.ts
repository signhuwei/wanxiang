import { allDesktopCapabilities, allowedAgentReleases, hasDesktopRuntime, requiresDesktopQualification } from './agent-catalog';
import { effectiveModelConfig } from './edge-config';
import { balancePolicyEnabled, readBalanceMode, balanceFallbackModels } from './policy-balance';
import { iso } from './credentials';
import type { pagination } from './management';
import { readEffective, type calculatePolicy, type Effective } from './policy-data';
import type { PolicyReader } from './policy-types';
import type { Store } from './store';
import { platformUpstreamPriority, upstreamOrder } from './tenant-upstreams';
import { allowedToolReleases } from './tool-releases';

type Reason = { resource_id: string; reason: string };
function effectiveValues(document: Effective | null) {
  return new Map(document?.entries.map(entry => [entry.clause_ref.id, JSON.stringify(entry.effective_value)]));
}

export function targetPolicy(store: Store, db: PolicyReader, document: Effective, dataDir: string, at: number,
  device: { os: string; arch: string; has_key: number }, signed?: Effective['entries']) {
  const { hot } = document;
  const problems: Reason[] = [];
  const missing = (resource_id: string, reason: string) => problems.push({ resource_id, reason });
  const authorizedProviders = hot.provider_ids_json && new Set<string>(JSON.parse(hot.provider_ids_json));
  for (const id of JSON.parse(hot.allowed_models_json) as string[]) {
    const model = store.system.get<{ provider_id: string; model_status: string; provider_status: string; protocol: string; has_rate: number }>(
      `SELECT m.provider_id,m.status AS model_status,p.status AS provider_status,p.protocol,EXISTS
       (SELECT 1 FROM rates r WHERE r.model_id=m.id AND r.effective_from<=?) AS has_rate
       FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?`, [iso(at), id]);
    if (!model || model.model_status !== 'active') missing(id, 'model_inactive');
    else if (model.provider_status !== 'active') missing(id, 'provider_inactive');
    else if (!model.has_rate) missing(id, 'rate_missing');
    else if (authorizedProviders && !authorizedProviders.has(model.provider_id)) missing(id, 'provider_denied');
    else if (!device.has_key) missing(id, 'device_key_missing');
    else if (!['anthropic', 'openai_chat', 'openai_responses'].includes(model.protocol)) missing(id, 'protocol_unsupported');
  }
  if (!hot.lease_budget_milli) missing('lease.budget', 'lease_budget_zero');
  const releases = allowedAgentReleases(store, dataDir, hot, device.os, device.arch, true, allDesktopCapabilities);
  const agents = new Set(releases.map(row => row.agent));
  for (const id of JSON.parse(hot.allowed_agents_json) as string[]) if (!agents.has(id)) {
    const unqualified = requiresDesktopQualification(id) && !hasDesktopRuntime(id, device.os, device.arch);
    missing(id, unqualified ? 'desktop_release_unqualified' : 'agent_release_unavailable');
  }
  const allowedIds = new Set(releases.map(row => row.id));
  for (const id of JSON.parse(hot.release_ids_json ?? '[]') as string[]) {
    if (allowedIds.has(id)) continue;
    const release = store.system.get<{ os: string; arch: string; status: string; agent: string }>('SELECT os,arch,status,agent FROM agent_releases WHERE id=?', [id]);
    if (release?.os !== device.os || release.arch !== device.arch) continue;
    if (!(JSON.parse(hot.allowed_agents_json) as string[]).includes(release.agent)) missing(id, 'scope_denied');
    else missing(id, release.status !== 'active' ? 'release_disabled' : 'release_unavailable');
  }
  const toolReleases = allowedToolReleases(store, dataDir, hot, device.os, device.arch, missing);
  const mode = balancePolicyEnabled(hot) ? readBalanceMode(db) : null;
  const fallback = new Set(balanceFallbackModels(hot));
  const models = effectiveModelConfig(store, hot, at).models.filter(model => {
    if (mode === 'stopped' || (mode === 'restricted' && !fallback.has(model.model_id))) missing(model.model_id, 'balance_restricted');
    return !problems.some(problem => problem.resource_id === model.model_id);
  });
  for (const adapter of ['access.agents', 'access.models', 'access.tools', 'access.releases']) {
    const granted = signed?.find(entry => entry.definition.binding?.adapter === adapter)?.effective_value;
    const effective = document.entries.find(entry => entry.definition.binding?.adapter === adapter)?.effective_value;
    if (Array.isArray(granted) && Array.isArray(effective)) for (const id of granted) {
      if (!effective.includes(id)) missing(id, 'scope_denied');
    }
  }
  const custom = JSON.parse(hot.runtime_rules_json ?? '{}')['upstream.custom'] === true;
  const routes = models.map(model => {
    const platform = { provider_id:model.provider_id, priority:platformUpstreamPriority, source:'platform' };
    const privateTargets = custom ? db.all<{provider_id:string;priority:number;source:string}>(
      "SELECT id AS provider_id,priority,'tenant' AS source FROM tenant_upstreams WHERE model_id=? AND protocol=? AND status='active' ORDER BY priority,id",
      [model.model_id,model.protocol]) : [];
    return {model_id:model.model_id, candidates:[platform,...privateTargets].sort(upstreamOrder)};
  });
  return {
    os: device.os, arch: device.arch, models, routes, releases: releases.map(({ agent, version, os, arch, id }) => ({ agent, version, os, arch, id })),
    tools: toolReleases.map(({ id, name, kind, version }) => ({ id, name, kind, version })), unavailable: problems
  };
}

export function visibleTarget(target: ReturnType<typeof targetPolicy>, commercial: boolean) {
  if (commercial) return target;
  return { ...target, models: target.models.map(({ rate, ...model }) => model) };
}

export function signatureImpact(store: Store, db: PolicyReader, projection: ReturnType<typeof calculatePolicy>,
  dataDir: string, at: number, page: ReturnType<typeof pagination>) {
  const changes = new Map<string, string[]>();
  for (const member of projection.members) {
    if (member.status !== 'active') continue;
    const id = member.user_id;
    const before = effectiveValues(readEffective(db, 'member', id));
    const after = effectiveValues(projection.materialized.get('member:' + id)!);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key)).sort();
    if (changed.length) changes.set(id, changed);
  }
  const devices = db.all<{ id: string; user_id: string; os: string; arch: string; has_key: number; policy_revision: number | null }>(
    `SELECT d.id,d.user_id,d.os,d.arch,length(d.public_key)>0 AS has_key,a.policy_revision
     FROM devices d LEFT JOIN policy_device_applications a ON a.device_id=d.id
     WHERE d.status='active' AND d.token_expires_at>? ORDER BY d.id`, [iso(at)]);
  const affected = devices.filter(device => changes.has(device.user_id));
  const items = affected.slice(page.offset, page.offset + page.limit).map(device => {
    const target = targetPolicy(store, db, projection.materialized.get('member:' + device.user_id)!, dataDir, at, device);
    return {
      device_id: device.id, user_id: device.user_id, os: device.os, arch: device.arch, applied_policy_revision: device.policy_revision,
      changed_clauses: changes.get(device.user_id), unavailable: target.unavailable
    };
  });
  return { member_count: changes.size, device_count: affected.length, devices: page.page(items, affected.length) };
}
