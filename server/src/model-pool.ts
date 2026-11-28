import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { hmac, iso } from './credentials';
import { int, platformActor, type ManagementOptions } from './management';
import { readEffective } from './policy-data';
import { boundPage, canonical, conflict, digest, queryValue as query, replay, requirePlatformAdmin as actorPlatform, routeId,
  routeIdPattern, strictObject } from './routing-http';
import type { Store, Transaction } from './store';

type Reader = Pick<Transaction, 'get' | 'all'>;
export type PoolMember = { deployment_id: string; deployment_revision: number; priority: number; approved_match_id: string; evidence_ids: string[] };
type InputCapabilities = { modalities: ['text', 'image']; valid_until?: string };
type LegacyCapabilityRoute = { model_id: string; upstream_model: string; provider_id: string; protocol: string;
  base_url: string; auth: string | null; proxy: string | null };
type Member = PoolMember;
type Routing = { strategy: 'ordered'; max_attempts: number; attempt_timeout_ms: number; total_timeout_ms: number };
type Draft = { expected_pool_revision: number; members: Member[]; routing: Routing; reason: string };
type Issue = { code: string; message: string; deployment_id?: string; field?: string };

const MAX_MEMBERS = 32, MAX_TIMEOUT_MS = 600_000;
export const MAX_ATTEMPTS = 8;
const messages: Record<string, string> = {
  deployment_not_found: '渠道部署不存在',
  deployment_unavailable: '渠道部署、账号、端点或 Provider 已停用',
  deployment_revision_changed: '渠道部署已有更新的修订',
  model_identity_unverified: '渠道没有通过该签约型号的身份审核',
  evidence_expired: '核验证据已过期',
  evidence_superseded: '核验证据已被新的证据替代',
  endpoint_revision_changed: '部署修订引用的端点修订不是端点当前修订',
  evidence_invalid: '核验证据不属于该部署修订或未通过',
  capability_unverified: '渠道没有通过签约型号要求的能力核验',
  no_eligible_deployment: '没有合格的渠道部署',
  no_change: '草稿与当前活动池相同',
  single_fault_domain: '所有成员位于同一故障域',
  max_attempts_exceeds_members: '最大尝试次数超过成员数',
};
const issue = (code: string, extra: Omit<Issue, 'code' | 'message'> = {}): Issue => ({ code, message: messages[code] ?? code, ...extra });
const idPattern = routeIdPattern;
const id = routeId;
const object = strictObject;

/** Stable member order: priority ascending, then deployment_id (binary). Equal priorities stay valid. */
export function orderMembers<T extends { priority: number; deployment_id: string }>(rows: T[]) {
  return [...rows].sort((a, b) => a.priority - b.priority || (a.deployment_id < b.deployment_id ? -1 : a.deployment_id > b.deployment_id ? 1 : 0));
}


export function parseDraft(body: Record<string, unknown>, extraKeys: string[] = []): Draft {
  object(body, 'body', ['expected_pool_revision', 'members', 'routing', 'reason', ...extraKeys]);
  const expected_pool_revision = int(body.expected_pool_revision, 'expected_pool_revision');
  if (!Array.isArray(body.members) || body.members.length === 0 || body.members.length > MAX_MEMBERS) invalid('members');
  const members = body.members.map((raw, i) => {
    const row = object(raw, `members[${i}]`, ['deployment_id', 'deployment_revision', 'priority', 'approved_match_id', 'evidence_ids']);
    const evidence = row.evidence_ids;
    if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 16) invalid(`members[${i}].evidence_ids`);
    const evidence_ids = [...new Set(evidence.map((value, j) => id(value, `members[${i}].evidence_ids[${j}]`)))].sort();
    return {
      deployment_id: id(row.deployment_id, `members[${i}].deployment_id`),
      deployment_revision: int(row.deployment_revision, `members[${i}].deployment_revision`, 1),
      priority: int(row.priority, `members[${i}].priority`, 0, 1_000_000),
      approved_match_id: id(row.approved_match_id, `members[${i}].approved_match_id`), evidence_ids,
    };
  });
  const seen = new Set<string>();
  members.forEach((row, i) => { if (seen.has(row.deployment_id)) invalid(`members[${i}].deployment_id`); seen.add(row.deployment_id); });
  const raw = object(body.routing, 'routing', ['strategy', 'max_attempts', 'attempt_timeout_ms', 'total_timeout_ms']);
  if (raw.strategy !== 'ordered') invalid('routing.strategy');
  const attempt_timeout_ms = int(raw.attempt_timeout_ms, 'routing.attempt_timeout_ms', 1, MAX_TIMEOUT_MS);
  const routing: Routing = { strategy: 'ordered', max_attempts: int(raw.max_attempts, 'routing.max_attempts', 1, MAX_ATTEMPTS), attempt_timeout_ms,
    total_timeout_ms: int(raw.total_timeout_ms, 'routing.total_timeout_ms', attempt_timeout_ms, MAX_TIMEOUT_MS) };
  const reason = field(body.reason, 'reason', 500);
  return { expected_pool_revision, members: orderMembers(members), routing, reason };
}

export function headRevision(sql: Reader, modelId: string) {
  return sql.get<{ pool_revision: number }>('SELECT pool_revision FROM model_pool_heads WHERE model_id = ?', [modelId])?.pool_revision ?? 0;
}
function currentIdentity(sql: Reader, modelId: string) {
  return sql.get<{ identity_revision: number; capability_floor_json: string }>(`SELECT i.identity_revision, i.capability_floor_json
    FROM models m JOIN model_identity_revisions i ON i.model_id = m.id AND i.identity_revision = m.current_identity_revision
    WHERE m.id = ?`, [modelId]) ?? null;
}
function poolMembers(sql: Reader, modelId: string, revision: number): Member[] {
  if (!revision) return [];
  return orderMembers(sql.all<{ deployment_id: string; deployment_revision: number; priority: number; approved_match_id: string; evidence_ids_json: string }>(
    `SELECT deployment_id, deployment_revision, priority, approved_match_id, evidence_ids_json FROM model_pool_deployments
     WHERE model_id = ? AND pool_revision = ?`, [modelId, revision]).map(({ evidence_ids_json, ...row }) =>
    ({ ...row, evidence_ids: JSON.parse(evidence_ids_json) as string[] })));
}

type DeploymentState = {
  deployment_id: string; provider_id: string; account_id: string; endpoint_id: string; display_name: string; status: string;
  current_revision: number; edit_revision: number; provider_status: string; account_status: string; endpoint_status: string;
  endpoint_current_revision: number; revision_endpoint_id: string | null; endpoint_revision: number | null;
  link_state: string | null; fault_domain_id: string | null; protocol: string | null; upstream_model: string | null; capabilities_json: string | null;
  base_url: string | null; auth_adapter: string | null;
};
function deploymentState(sql: Reader, deploymentId: string, revision: number) {
  return sql.get<DeploymentState>(`SELECT d.deployment_id, d.provider_id, d.account_id, d.endpoint_id, d.display_name, d.status,
      d.current_revision, d.edit_revision, p.status AS provider_status, a.status AS account_status, e.status AS endpoint_status,
      e.current_revision AS endpoint_current_revision, r.endpoint_id AS revision_endpoint_id, r.endpoint_revision,
      l.state AS link_state, er.fault_domain_id, er.protocol, er.base_url, er.auth_adapter, r.upstream_model, r.capabilities_json
    FROM model_deployments d JOIN providers p ON p.id = d.provider_id JOIN provider_accounts a ON a.account_id = d.account_id
    JOIN provider_endpoints e ON e.endpoint_id = d.endpoint_id
    LEFT JOIN provider_account_endpoints l ON l.account_id = d.account_id AND l.endpoint_id = d.endpoint_id
    LEFT JOIN model_deployment_revisions r ON r.deployment_id = d.deployment_id AND r.deployment_revision = ?
    LEFT JOIN provider_endpoint_revisions er ON er.endpoint_id = r.endpoint_id AND er.endpoint_revision = r.endpoint_revision
    WHERE d.deployment_id = ?`, [revision, deploymentId]) ?? null;
}
type MatchRow = { candidate_id: string; model_id: string; identity_revision: number; deployment_id: string; deployment_revision: number; status: string; decided_at: string | null };
type EvidenceRow = { evidence_id: string; deployment_id: string; deployment_revision: number; source_kind: string; outcome: string; identity_verified: number;
  capabilities_json: string; key_fields_json: string; valid_until: string | null; observed_at: string };

function capabilityExtension(row: EvidenceRow) {
  if (row.source_kind !== 'manual_review' || row.identity_verified !== 1) return undefined;
  const extension = JSON.parse(row.key_fields_json)?.capability_extension;
  if (typeof extension?.candidate_id === 'string' && Array.isArray(extension.capabilities)) {
    return extension as { candidate_id: string; capabilities: string[] };
  }
}

/**
 * Checks one draft member against the model's current identity. Returns blocking codes and a
 * dependency record; the record feeds preview_basis so the same inputs give the same basis.
 */
function assessMember(sql: Reader, modelId: string, identity: { identity_revision: number; capability_floor_json: string } | null, member: Member, now: string) {
  const codes: string[] = [];
  const deployment = deploymentState(sql, member.deployment_id, member.deployment_revision);
  const match = sql.get<MatchRow>(`SELECT candidate_id, model_id, identity_revision, deployment_id, deployment_revision, status, decided_at
    FROM model_discovery_matches WHERE candidate_id = ?`, [member.approved_match_id]) ?? null;
  const evidence = member.evidence_ids.map((evidenceId) => sql.get<EvidenceRow>(`SELECT evidence_id, deployment_id, deployment_revision, outcome,
    source_kind, identity_verified, capabilities_json, key_fields_json, valid_until, observed_at FROM model_evidence WHERE evidence_id = ?`, [evidenceId]) ?? null);
  if (!deployment || !deployment.upstream_model) codes.push('deployment_not_found');
  else {
    if (deployment.status !== 'active' || deployment.provider_status !== 'active' || deployment.account_status !== 'active'
      || deployment.endpoint_status !== 'active' || deployment.link_state !== 'enabled') codes.push('deployment_unavailable');
    if (deployment.current_revision !== member.deployment_revision) codes.push('deployment_revision_changed');
    if (deployment.revision_endpoint_id !== deployment.endpoint_id || deployment.endpoint_revision !== deployment.endpoint_current_revision) {
      codes.push('endpoint_revision_changed');
    }
  }
  if (!identity || !match || match.status !== 'accepted' || match.model_id !== modelId || match.identity_revision !== identity.identity_revision
    || match.deployment_id !== member.deployment_id || match.deployment_revision !== member.deployment_revision) codes.push('model_identity_unverified');
  const own = evidence.filter((row): row is EvidenceRow => !!row && row.deployment_id === member.deployment_id
    && row.deployment_revision === member.deployment_revision && row.outcome === 'passed'
    && (capabilityExtension(row)?.candidate_id ?? member.approved_match_id) === member.approved_match_id);
  if (own.length !== evidence.length) codes.push('evidence_invalid');
  const superseded = new Set(member.evidence_ids.length ? sql.all<{ supersedes_id: string }>(`SELECT supersedes_id FROM model_evidence
    WHERE supersedes_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(member.evidence_ids)]).map((row) => row.supersedes_id) : []);
  const live = own.filter((row) => !superseded.has(row.evidence_id) && row.observed_at <= now && (row.valid_until === null || row.valid_until > now));
  if (own.some((row) => superseded.has(row.evidence_id))) codes.push('evidence_superseded');
  if (own.some((row) => !superseded.has(row.evidence_id) && !live.includes(row))) codes.push('evidence_expired');
  const evidenceProblem = codes.some((code) => code.startsWith('evidence_'));
  if (!evidenceProblem && !live.some((row) => row.identity_verified === 1) && !codes.includes('model_identity_unverified')) codes.push('model_identity_unverified');
  const verified = new Set<string>();
  const declared = new Set(deployment?.capabilities_json ? JSON.parse(deployment.capabilities_json) as string[] : []);
  for (const row of live) {
    const additions = capabilityExtension(row)?.capabilities ?? [];
    for (const capability of JSON.parse(row.capabilities_json) as string[]) {
      verified.add(capability);
      if (additions.includes(capability)) declared.add(capability);
    }
  }
  const floor = identity ? JSON.parse(identity.capability_floor_json) as string[] : [];
  if (!evidenceProblem && floor.some((capability) => !verified.has(capability) || !declared.has(capability))) codes.push('capability_unverified');
  // A catalogue claim is not evidence that the authenticated route accepts image input.
  let inputCapabilities: InputCapabilities | undefined;
  if (!codes.length && (deployment?.protocol === 'openai_chat' || deployment?.protocol === 'anthropic') && declared.has('images') && live.some(row =>
    (row.source_kind === 'manual_review' || row.source_kind === 'runtime_probe') && (JSON.parse(row.capabilities_json) as string[]).includes('images'))) {
    const expires = live.map(row => row.valid_until).filter((value): value is string => value !== null).sort()[0];
    inputCapabilities = { modalities: ['text', 'image'], ...(expires && { valid_until: expires }) };
  }
  const dependency = {
    deployment: deployment && [deployment.status, deployment.current_revision, deployment.edit_revision, deployment.provider_status,
      deployment.account_status, deployment.endpoint_status, deployment.link_state, deployment.fault_domain_id,
      deployment.endpoint_current_revision, deployment.revision_endpoint_id, deployment.endpoint_revision],
    match: match && [match.status, match.model_id, match.identity_revision, match.deployment_id, match.deployment_revision, match.decided_at],
    evidence: evidence.map((row) => row && [row.evidence_id, row.deployment_id, row.deployment_revision, row.source_kind, row.outcome, row.identity_verified,
      row.capabilities_json, row.observed_at, row.valid_until, superseded.has(row.evidence_id), capabilityExtension(row) ?? null]),
    blocking: [...new Set(codes)].sort(),
  };
  return { codes: [...new Set(codes)], deployment, dependency, inputCapabilities, capabilities: [...declared] };
}

export function legacyInputCapabilities(sql: Reader, route: LegacyCapabilityRoute, now: string) {
  if ((route.protocol !== 'openai_chat' && route.protocol !== 'anthropic') ||
    route.upstream_model.includes('*') || (route.proxy && route.proxy !== 'none')) return undefined;
  const current = headRevision(sql, route.model_id);
  if (!current) return undefined;
  // Legacy inference uses only the default Provider credential. Evidence for a different account is not transferable.
  const origin = sql.get<{ account_id: string; endpoint_id: string }>(
    'SELECT account_id, endpoint_id FROM provider_channel_defaults WHERE provider_id = ?', [route.provider_id]);
  if (!origin) return undefined;
  const identity = currentIdentity(sql, route.model_id);
  const auth = route.auth ?? (route.protocol === 'anthropic' ? 'x_api_key' : 'bearer');
  for (const member of poolMembers(sql, route.model_id, current)) {
    const { deployment, inputCapabilities } = assessMember(sql, route.model_id, identity, member, now);
    if (inputCapabilities && deployment?.provider_id === route.provider_id && deployment.account_id === origin.account_id &&
      deployment.endpoint_id === origin.endpoint_id && deployment.protocol === route.protocol &&
      deployment.base_url === route.base_url && deployment.auth_adapter === auth &&
      deployment.upstream_model === route.upstream_model) return inputCapabilities;
  }
  return undefined;
}

function impact(store: Store, modelId: string) {
  let tenant_count = 0, device_count = 0;
  for (const { id } of store.system.all<{ id: string }>("SELECT id FROM tenants WHERE status = 'active' ORDER BY id")) {
    let db;
    try { db = store.tenant(id); } catch { continue; }
    // Only the current signed tenant policy counts; retired flat contracts are not treated as live grants.
    const effective = readEffective(db, 'tenant', id)?.hot?.allowed_models_json;
    if (!effective || !(JSON.parse(effective) as string[]).includes(modelId)) continue;
    tenant_count++;
    device_count += db.get<{ n: number }>(`SELECT count(*) AS n FROM devices d JOIN members m ON m.user_id = d.user_id
      WHERE d.status = 'active' AND m.status = 'active'`)!.n;
  }
  return { tenant_count, device_count };
}

/** Pure evaluation of a draft. Same actor, draft and persisted dependencies give the same preview_basis. */
export function evaluatePool(sql: Reader, secret: string, actor: string, modelId: string, draft: Draft, now: string) {
  const current = headRevision(sql, modelId);
  const identity = currentIdentity(sql, modelId);
  const blocking: Issue[] = [], warnings: Issue[] = [];
  const dependencies: unknown[] = [];
  const domains = new Set<string>();
  let eligible = 0;
  for (const member of draft.members) {
    const result = assessMember(sql, modelId, identity, member, now);
    dependencies.push([member.deployment_id, result.dependency]);
    for (const code of result.codes) blocking.push(issue(code, { deployment_id: member.deployment_id }));
    if (!result.codes.length) eligible++;
    domains.add(result.deployment?.fault_domain_id ?? result.deployment?.endpoint_id ?? member.deployment_id);
  }
  if (!eligible) blocking.push(issue('no_eligible_deployment', { field: 'members' }));
  const previous = poolMembers(sql, modelId, current);
  const before = new Map(previous.map((row) => [row.deployment_id, row]));
  const after = new Map(draft.members.map((row) => [row.deployment_id, row]));
  const diff = {
    added: draft.members.filter((row) => !before.has(row.deployment_id)).map((row) => row.deployment_id),
    removed: previous.filter((row) => !after.has(row.deployment_id)).map((row) => row.deployment_id),
    updated: draft.members.filter((row) => before.has(row.deployment_id) && digest(before.get(row.deployment_id)) !== digest(row)).map((row) => row.deployment_id),
  };
  const routingRow = current ? sql.get<Routing>(`SELECT strategy, max_attempts, attempt_timeout_ms, total_timeout_ms FROM model_pool_revisions
    WHERE model_id = ? AND pool_revision = ?`, [modelId, current]) : null;
  if (current && !diff.added.length && !diff.removed.length && !diff.updated.length && routingRow && digest(routingRow) === digest(draft.routing)) {
    blocking.push(issue('no_change'));
  }
  if (draft.members.length > 0 && domains.size < 2) warnings.push(issue('single_fault_domain'));
  if (draft.routing.max_attempts > draft.members.length) warnings.push(issue('max_attempts_exceeds_members', { field: 'routing.max_attempts' }));
  const preview_basis = 'pv_' + hmac(secret, ['model_pool_preview', 1, actor, modelId, canonical(draft), current,
    identity && [identity.identity_revision, identity.capability_floor_json], dependencies]);
  return { current, identity, preview_basis, blocking, warnings, diff, publishable: blocking.length === 0 };
}

export function requireModel(sql: Reader, modelId: string) {
  const row = idPattern.test(modelId) ? sql.get<{ status: string }>('SELECT status FROM models WHERE id = ?', [modelId]) : null;
  if (!row) throw new ApiError('not_found');
  return row.status === 'active';
}
/** Disabled models keep their history readable but do not offer drafting or publishing. */
export function requireDraftableModel(sql: Reader, modelId: string) {
  if (!requireModel(sql, modelId)) throw new ApiError('forbidden', { reason: 'model_disabled' });
}
const stale = (reason: string, current_revision: number, changed: string[] = []) => conflict(reason, current_revision, changed);

export { assessMember, currentIdentity, poolMembers };

export function modelPoolRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const P = '/v1/platform';

  app.get(`${P}/providers/:provider_id/deployments`, (c) => {
    const actor = platformActor(store, c, opts.now());
    const providerId = c.req.param('provider_id');
    if (!idPattern.test(providerId) || !store.system.get('SELECT 1 FROM providers WHERE id = ?', [providerId])) throw new ApiError('not_found');
    const q = query(c, 'q') ?? '';
    if (q.length > 200) invalid('q');
    const p = boundPage(c, opts.codeSecret, actor, { providerId, q });
    const where = `FROM model_deployments d JOIN model_deployment_revisions r ON r.deployment_id = d.deployment_id AND r.deployment_revision = d.current_revision
      WHERE d.provider_id = ? AND (instr(lower(d.display_name), lower(?)) > 0 OR instr(r.upstream_model, ?) > 0)`;
    const params = [providerId, q, q];
    const { n } = store.system.get<{ n: number }>(`SELECT count(*) AS n ${where}`, params)!;
    const rows = store.system.all<{ deployment_id: string; edit_revision: number; current_revision: number; display_name: string; upstream_model: string;
      account_id: string; endpoint_id: string; capabilities_json: string; status: string }>(`SELECT d.deployment_id, d.edit_revision, d.current_revision,
      d.display_name, r.upstream_model, d.account_id, d.endpoint_id, r.capabilities_json, d.status ${where}
      ORDER BY d.display_name, d.deployment_id LIMIT ? OFFSET ?`, [...params, p.limit, p.offset]);
    const now = iso(opts.now());
    const items = rows.map((row) => {
      const references = store.system.all<Omit<Member, 'evidence_ids'> & { model_id: string; pool_revision: number; evidence_ids_json: string }>(
        `SELECT h.model_id, h.pool_revision, m.deployment_id, m.deployment_revision, m.approved_match_id, m.priority, m.evidence_ids_json
         FROM model_pool_heads h JOIN model_pool_deployments m ON m.model_id = h.model_id AND m.pool_revision = h.pool_revision
         WHERE m.deployment_id = ? ORDER BY h.model_id`, [row.deployment_id]);
      const capabilities = new Set<string>(JSON.parse(row.capabilities_json));
      for (const { model_id, evidence_ids_json, ...member } of references) {
        if (member.deployment_revision !== row.current_revision) continue;
        const review = assessMember(store.system, model_id, currentIdentity(store.system, model_id),
          { ...member, evidence_ids: JSON.parse(evidence_ids_json) }, now);
        if (!review.codes.length) for (const capability of review.capabilities) capabilities.add(capability);
      }
      return {
        id: row.deployment_id, revision: row.edit_revision, deployment_revision: row.current_revision, display_name: row.display_name,
        raw_model: row.upstream_model, account_id: row.account_id, endpoint_id: row.endpoint_id,
        capabilities: [...capabilities], status: row.status,
        archive_blockers: references.map(({ model_id, pool_revision }) => ({ kind: 'active_pool', model_id, pool_revision })),
        actions: ['read', 'read_quotes'],
      };
    });
    return c.json(p.page(items, n, []));
  });

  app.get(`${P}/deployments`, (c) => {
    const actor = platformActor(store, c, opts.now());
    const modelId = query(c, 'target_model_id');
    if (!modelId) invalid('target_model_id');
    const draftable = requireModel(store.system, modelId);
    const filters = { provider_id: query(c, 'provider_id'), protocol: query(c, 'protocol'), match: query(c, 'match'), q: query(c, 'q') ?? '' };
    if (filters.q.length > 200) invalid('q');
    if (filters.match && !['suggested', 'needs_review', 'accepted', 'rejected'].includes(filters.match)) invalid('match');
    if (filters.protocol && !['anthropic', 'openai_chat', 'openai_responses'].includes(filters.protocol)) invalid('protocol');
    if (filters.provider_id && !idPattern.test(filters.provider_id)) invalid('provider_id');
    const p = boundPage(c, opts.codeSecret, actor, { modelId, ...filters });
    const where = `FROM model_discovery_matches mt JOIN model_deployments d ON d.deployment_id = mt.deployment_id
      JOIN model_deployment_revisions r ON r.deployment_id = mt.deployment_id AND r.deployment_revision = mt.deployment_revision
      JOIN provider_endpoint_revisions er ON er.endpoint_id = r.endpoint_id AND er.endpoint_revision = r.endpoint_revision
      WHERE mt.model_id = ? AND mt.status != 'superseded' AND (? IS NULL OR d.provider_id = ?) AND (? IS NULL OR er.protocol = ?)
      AND (? IS NULL OR mt.status = ?) AND (instr(r.upstream_model, ?) > 0 OR instr(lower(d.display_name), lower(?)) > 0)`;
    const params = [modelId, filters.provider_id ?? null, filters.provider_id ?? null, filters.protocol ?? null, filters.protocol ?? null,
      filters.match ?? null, filters.match ?? null, filters.q, filters.q];
    const { n } = store.system.get<{ n: number }>(`SELECT count(*) AS n ${where}`, params)!;
    const rows = store.system.all<{ candidate_id: string; discovery_id: string | null; catalog_item_id: string | null; deployment_id: string;
      deployment_revision: number; provider_id: string; account_id: string; endpoint_id: string; upstream_model: string; match_rule_id: string | null;
      rule_revision: number | null; match_kind: string; confidence: string; reasons_json: string; status: string }>(
      `SELECT mt.candidate_id, mt.discovery_id, mt.catalog_item_id, mt.deployment_id, mt.deployment_revision, d.provider_id, d.account_id,
        d.endpoint_id, r.upstream_model, mt.match_rule_id, mt.rule_revision, mt.match_kind, mt.confidence, mt.reasons_json, mt.status
        ${where} ORDER BY d.provider_id, r.upstream_model, mt.candidate_id LIMIT ? OFFSET ?`, [...params, p.limit, p.offset]);
    const now = iso(opts.now());
    const identity = currentIdentity(store.system, modelId);
    const items = rows.map((row) => {
      // Prefer currently valid evidence; when none is valid, assess the passed records so the reason names why.
      const passed = store.system.all<{ evidence_id: string; live: number }>(`SELECT evidence_id, (observed_at <= ? AND (valid_until IS NULL OR valid_until > ?)
          AND evidence_id NOT IN (SELECT supersedes_id FROM model_evidence WHERE supersedes_id IS NOT NULL)) AS live
        FROM model_evidence WHERE deployment_id = ? AND deployment_revision = ? AND outcome = 'passed'
        AND coalesce(json_extract(key_fields_json, '$.capability_extension.candidate_id'), ?) = ? ORDER BY evidence_id`,
        [now, now, row.deployment_id, row.deployment_revision, row.candidate_id, row.candidate_id]);
      const valid = passed.filter((e) => e.live === 1).map((e) => e.evidence_id);
      const evidence_ids = valid.length ? valid : passed.map((e) => e.evidence_id);
      const member = { deployment_id: row.deployment_id, deployment_revision: row.deployment_revision, priority: 0,
        approved_match_id: row.candidate_id, evidence_ids };
      const { codes: reasons, capabilities } = assessMember(store.system, modelId, identity, member, now);
      const eligible = reasons.length === 0;
      return {
        candidate_id: row.candidate_id, discovery_id: row.discovery_id, catalog_item_id: row.catalog_item_id,
        deployment_id: row.deployment_id, deployment_revision: row.deployment_revision, provider_id: row.provider_id,
        account_id: row.account_id, endpoint_id: row.endpoint_id, raw_model: row.upstream_model,
        match: { match_rule_id: row.match_rule_id, rule_revision: row.rule_revision, kind: row.match_kind, confidence: row.confidence,
          reason: (JSON.parse(row.reasons_json) as string[])[0] ?? row.match_kind, reasons: JSON.parse(row.reasons_json) as string[], review_status: row.status },
        capabilities, health: { state: 'unknown', reason: 'not_observed' }, quote_ref: null,
        eligible, reason: reasons[0] ?? null, reasons,
        ...(eligible && { approved_match_id: row.candidate_id, evidence_ids }),
        actions: eligible && draftable ? ['read', 'select'] : ['read'],
      };
    });
    return c.json(p.page(items, n, []));
  });

  app.post(`${P}/models/:model_id/pool/preview`, async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const modelId = c.req.param('model_id');
    const draft = parseDraft(body);
    const sql = store.system;
    requireDraftableModel(sql, modelId);
    const result = evaluatePool(sql, opts.codeSecret, actor, modelId, draft, iso(at));
    if (draft.expected_pool_revision !== result.current) throw stale('revision_changed', result.current, ['pool_revision']);
    return c.json({
      model_id: modelId, expected_pool_revision: draft.expected_pool_revision, preview_basis: result.preview_basis,
      publishable: result.publishable, blocking: result.blocking, warnings: result.warnings, diff: result.diff, impact: impact(store, modelId),
      draft: { members: draft.members, routing: draft.routing, reason: draft.reason },
      actions: ['read', ...(result.publishable ? ['publish_pool'] : [])],
    });
  });

  app.post(`${P}/models/:model_id/pool/revisions`, async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const modelId = c.req.param('model_id');
    if (!c.req.header('Idempotency-Key')) invalid('Idempotency-Key');
    const draft = parseDraft(body, ['preview_basis']);
    const basis = field(body.preview_basis, 'preview_basis', 256);
    const op = operation(c, opts.codeSecret, at, actor, { ...draft, preview_basis: basis });
    const result = await store.system.write((sql) => {
      actorPlatform(sql, actor);
      const cached = replay(op, sql);
      if (cached) return { response: cached, changed: false };
      requireDraftableModel(sql, modelId);
      const now = iso(at);
      const result = evaluatePool(sql, opts.codeSecret, actor, modelId, draft, now);
      if (draft.expected_pool_revision !== result.current) throw stale('revision_changed', result.current, ['pool_revision']);
      if (result.preview_basis !== basis || !result.publishable || !result.identity) {
        throw stale('preview_stale', result.current, [...new Set(result.blocking.map((row) => row.deployment_id ?? row.field ?? row.code))]);
      }
      const legacy = sql.get<LegacyCapabilityRoute>(`SELECT m.id AS model_id, m.upstream_name AS upstream_model, m.provider_id,
        p.protocol, p.base_url, p.auth, p.proxy FROM models m JOIN providers p ON p.id = m.provider_id
        WHERE m.id = ? AND p.protocol IN ('openai_chat', 'anthropic') AND p.status = 'active'`, [modelId]);
      const beforeInput = legacy && legacyInputCapabilities(sql, legacy, now);
      const latest = sql.get<{ n: number }>('SELECT coalesce(max(pool_revision), 0) AS n FROM model_pool_revisions WHERE model_id = ?', [modelId])!.n;
      const revision = Math.max(latest, result.current) + 1;
      const content = { model_id: modelId, pool_revision: revision, identity_revision: result.identity.identity_revision,
        members: draft.members, routing: draft.routing };
      const contentDigest = digest(content);
      sql.run(`INSERT INTO model_pool_revisions (model_id, pool_revision, based_on_revision, identity_revision, strategy, max_attempts,
        attempt_timeout_ms, total_timeout_ms, reason, digest, released_by, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [modelId, revision, result.current || null, result.identity.identity_revision, draft.routing.strategy, draft.routing.max_attempts,
          draft.routing.attempt_timeout_ms, draft.routing.total_timeout_ms, draft.reason, contentDigest, actor, now]);
      for (const member of draft.members) {
        sql.run(`INSERT INTO model_pool_deployments (model_id, pool_revision, deployment_id, deployment_revision, approved_match_id, priority,
          evidence_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?)`, [modelId, revision, member.deployment_id, member.deployment_revision,
          member.approved_match_id, member.priority, JSON.stringify(member.evidence_ids)]);
      }
      sql.run(`INSERT INTO model_pool_heads (model_id, pool_revision, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET pool_revision = excluded.pool_revision, updated_at = excluded.updated_at`, [modelId, revision, now]);
      const afterInput = legacy && legacyInputCapabilities(sql, legacy, now);
      const rollout_id = `rol_${ulid()}`;
      sql.run(`INSERT INTO route_release_jobs (job_id, model_id, pool_revision, job_kind, source_digest, status, created_at)
        VALUES (?, ?, ?, 'project', ?, 'pending', ?)`, [rollout_id, modelId, revision, contentDigest, now]);
      sql.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${ulid()}`, actor, 'model_pool.publish', modelId, JSON.stringify({ pool_revision: revision, based_on_revision: result.current,
          digest: contentDigest, reason: draft.reason, diff: result.diff }), now]);
      const response = op.complete(sql, { status: 201, payload: { model_id: modelId, pool_revision: revision, rollout_id, actions: ['read'] } });
      return { response, changed: JSON.stringify(beforeInput) !== JSON.stringify(afterInput) };
    });
    if (result.changed) opts.onConfigChange?.();
    return result.response;
  });

  app.get(`${P}/models/:model_id/pool/revisions`, (c) => {
    const actor = platformActor(store, c, opts.now());
    const modelId = c.req.param('model_id');
    const draftable = requireModel(store.system, modelId);
    const p = boundPage(c, opts.codeSecret, actor, { modelId });
    const current = headRevision(store.system, modelId);
    const { n } = store.system.get<{ n: number }>('SELECT count(*) AS n FROM model_pool_revisions WHERE model_id = ?', [modelId])!;
    const items = store.system.all<{ pool_revision: number; based_on_revision: number | null; reason: string; released_by: string; released_at: string;
      rollback_of: number | null; member_count: number }>(`SELECT r.pool_revision, r.based_on_revision, r.reason, r.released_by, r.released_at, r.rollback_of,
      (SELECT count(*) FROM model_pool_deployments m WHERE m.model_id = r.model_id AND m.pool_revision = r.pool_revision) AS member_count
      FROM model_pool_revisions r WHERE r.model_id = ? ORDER BY r.pool_revision DESC LIMIT ? OFFSET ?`, [modelId, p.limit, p.offset])
      .map((row) => ({ model_id: modelId, ...row, current: row.pool_revision === current, actions: ['read'] }));
    return c.json({ ...p.page(items, n, draftable ? ['preview_pool'] : []), current_pool_revision: current });
  });

  app.get(`${P}/models/:model_id/pool/revisions/:pool_revision`, (c) => {
    platformActor(store, c, opts.now());
    const modelId = c.req.param('model_id');
    const raw = c.req.param('pool_revision');
    if (!/^[1-9]\d{0,15}$/.test(raw)) throw new ApiError('not_found');
    const revision = Number(raw);
    requireModel(store.system, modelId);
    const row = store.system.get<{ identity_revision: number; based_on_revision: number | null; strategy: 'ordered'; max_attempts: number;
      attempt_timeout_ms: number; total_timeout_ms: number; reason: string; digest: string; released_by: string; released_at: string;
      rollback_of: number | null }>(`SELECT identity_revision, based_on_revision, strategy, max_attempts, attempt_timeout_ms, total_timeout_ms, reason,
      digest, released_by, released_at, rollback_of FROM model_pool_revisions WHERE model_id = ? AND pool_revision = ?`, [modelId, revision]);
    if (!row) throw new ApiError('not_found');
    const rollout = store.system.get<{ job_id: string; status: string }>(`SELECT job_id, status FROM route_release_jobs
      WHERE model_id = ? AND pool_revision = ? AND job_kind = 'project'`, [modelId, revision]);
    const members = poolMembers(store.system, modelId, revision).map((member) => {
      const d = store.system.get<{ provider_id: string; account_id: string; endpoint_id: string; upstream_model: string }>(`SELECT d.provider_id,
        d.account_id, d.endpoint_id, r.upstream_model FROM model_deployments d JOIN model_deployment_revisions r ON r.deployment_id = d.deployment_id
        WHERE d.deployment_id = ? AND r.deployment_revision = ?`, [member.deployment_id, member.deployment_revision])!;
      return { ...member, provider_id: d.provider_id, account_id: d.account_id, endpoint_id: d.endpoint_id, raw_model: d.upstream_model };
    });
    return c.json({
      model_id: modelId, pool_revision: revision, current: headRevision(store.system, modelId) === revision, identity_revision: row.identity_revision,
      based_on_revision: row.based_on_revision, rollback_of: row.rollback_of, members,
      routing: { strategy: row.strategy, max_attempts: row.max_attempts, attempt_timeout_ms: row.attempt_timeout_ms, total_timeout_ms: row.total_timeout_ms },
      reason: row.reason, digest: row.digest, released_by: row.released_by, released_at: row.released_at,
      rollout: rollout ? { rollout_id: rollout.job_id, status: rollout.status } : null, actions: ['read'],
    });
  });
}

/** Extra read fields for the legacy platform models ledger. */
export function modelPoolSummary(sql: Reader, modelId: string) {
  const current_pool_revision = headRevision(sql, modelId);
  const channel_count = current_pool_revision ? sql.get<{ n: number }>(`SELECT count(*) AS n FROM model_pool_deployments
    WHERE model_id = ? AND pool_revision = ?`, [modelId, current_pool_revision])!.n : 0;
  return { current_pool_revision, channel_count };
}
