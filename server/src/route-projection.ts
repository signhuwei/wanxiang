import { ulid } from 'ulid';
import { artifactDownloadPath } from './agent-catalog';
import { balance, leaseBudget, quotaBinding } from './billing';
import { iso } from './credentials';
import { deviceRuntime } from './edge-config';
import { assessMember, currentIdentity, headRevision, poolMembers } from './model-pool';
import { balanceFallbackModels, balancePolicyEnabled, balancePolicyMode, readBalanceMode } from './policy-balance';
import { readPolicyDevice, readPolicyHot } from './policy-data';
import { routeProjectionDigest, type RouteSecretMaterial } from './route-secret';
import { digest } from './routing-http';
import { readSalesRateSnapshots } from './sales-rate-snapshots';
import type { QueuedDatabase, Store, Transaction } from './store';

/**
 * Persistent device targets for route_pool.v1 (contracts/routing-projection.md).
 * Binding and credential sources are supplied by the activation cohort or the protocol fixtures.
 */
export type RouteGrant = {
  binding_id: string; binding_revision: number; agent_release_id: string; model_id: string;
  ingress_protocol: string; aliases: string[];
  pool: { mode: 'pinned'; pool_revision: number } | { mode: 'follow' };
  /** Signature that authorized the binding; must be the tenant's current one. */
  platform_revision: number;
  /** Absent means every member covered by the signature. */
  user_ids?: string[];
};
export type CredentialRef = { credential_id: string; credential_version: number };
export type RoutingProjectionInputs = {
  grants(tenantId: string): RouteGrant[];
  credentialRef(deploymentId: string, deploymentRevision: number): CredentialRef | null;
  credentialMaterial(credentialId: string, credentialVersion: number): RouteSecretMaterial | null;
  /** Whether this device is included in the configured route pool scope. */
  selectRoutePool(tenantId: string, deviceId: string): boolean;
  revocationRevision?(tenantId: string, deviceId: string): number;
  projectionId?(): string;
  ttlMs?: number;
  /** Isolated lease gate (contracts/routing-lease-gate.md). Off by default: sessions keep route_pool_lease_pending. */
  leaseGate?: boolean;
  /** Loopback fixture only. Billable routing requires a validated usage watermark. */
  executionTest?: boolean;
  productionExecution?: boolean;
  productionCandidate?(deploymentId: string, deploymentRevision: number, sourceRateKey: string | null): boolean;
};

export function meteredRouteExecution(inputs: RoutingProjectionInputs | undefined) {
  return inputs?.productionExecution === true || inputs?.executionTest === true;
}

function credentialAvailable(inputs: RoutingProjectionInputs, ref: CredentialRef) {
  const material = inputs.credentialMaterial(ref.credential_id, ref.credential_version);
  material?.dispose?.();
  return !!material;
}

export class ProjectionFailure extends Error {
  constructor(readonly reason: string, readonly detail: Record<string, unknown> = {}) { super(reason); }
}

type Reader = Pick<Transaction, 'get' | 'all'>;
type Recipient = { id: string; user_id: string; os: string; arch: string };
export type ProjectionTarget = { config_revision: number; projection_id: string; reused: boolean };
export type RoutePoolConfig = Record<string, any> & {
  type: 'config'; revision: number; policy: Record<string, any>; routes: Record<string, any>[];
  route_pool: Record<string, any> & { projection_id: string; revocation_revision: number; secrets: never[] };
};

const DEFAULT_TTL_MS = 10 * 60_000;
const maxPolicyScopeRefs = 64;
const recipientQuery = `SELECT d.id, d.user_id, d.os, d.arch FROM devices d JOIN members m ON m.user_id = d.user_id
  WHERE d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`;

const covers = (grant: RouteGrant, user: string) => !grant.user_ids || grant.user_ids.includes(user);
const minTime = (...values: (string | null | undefined)[]) => values.filter((v): v is string => !!v).sort()[0]!;
type Authorization = { allowed_models_json: string; allowed_agents_json: string; release_ids_json: string | null };

/**
 * A grant reaches a member only inside the member's effective policy: model, Agent and (when narrowed) exact release
 * all intersect, so group or member narrowing never delivers a disabled release.
 */
function authorized(store: Store, policy: Authorization, grant: RouteGrant) {
  if (!(JSON.parse(policy.allowed_models_json) as string[]).includes(grant.model_id)) return false;
  const release = store.system.get<{ agent: string }>('SELECT agent FROM agent_releases WHERE id = ?', [grant.agent_release_id]);
  if (!release || !(JSON.parse(policy.allowed_agents_json) as string[]).includes(release.agent)) return false;
  return policy.release_ids_json == null || (JSON.parse(policy.release_ids_json) as string[]).includes(grant.agent_release_id);
}

type Built = { source_token: string; valid_until: string; user_id: string; platform_revision: number; policy_revision: number;
  revocation_revision: number; render(revision: number, projection_id: string): RoutePoolConfig };

/**
 * Computes the complete device configuration from the current signature, effective policy, device and injected grants.
 * Throws ProjectionFailure when a prerequisite is missing; nothing is persisted then.
 */
export function buildProjection(store: Store, db: Reader, inputs: RoutingProjectionInputs, tenantId: string, deviceId: string, at: number): Built {
  const now = iso(at);
  const system = store.system;
  if (!system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [tenantId])) throw new ProjectionFailure('device_unavailable');
  const device = db.get<Recipient>(`${recipientQuery} AND d.id = ?`, [now, deviceId]);
  if (!device) throw new ProjectionFailure('device_unavailable');
  const policy = readPolicyDevice(db as Transaction, device.user_id);
  if (!policy) throw new ProjectionFailure('policy_missing');
  const grants = inputs.grants(tenantId).filter(grant => covers(grant, device.user_id));
  const stale = grants.find(grant => grant.platform_revision !== policy.platform_revision);
  if (stale) throw new ProjectionFailure('signature_changed', { binding_id: stale.binding_id });
  const providers: Set<string> | null = policy.provider_ids_json == null ? null : new Set(JSON.parse(policy.provider_ids_json));
  let mode = balancePolicyEnabled(policy) ? readBalanceMode(db) : null;
  if (mode !== null && inputs.productionExecution) {
    const wallet = balance(db, at);
    const quota = quotaBinding(db, device.user_id, at);
    const reserve = leaseBudget(wallet.balance_milli, policy.lease_budget_milli, quota?.remaining_milli);
    mode = balancePolicyMode(policy, wallet);
    // Project the fallback set before issuing a reservation that could cross the configured threshold.
    if ((mode === 'normal' || mode === 'warn') && reserve > 0 && balancePolicyMode(policy, {
      balance_milli: wallet.balance_milli - reserve, reserved_milli: wallet.reserved_milli + reserve,
    }) === 'restricted') mode = 'restricted';
  }
  const runtime = deviceRuntime(policy);
  const unavailableRuntime = inputs.productionExecution && (runtime['network.public'] === false || [
    'rate.member_rpm', 'rate.member_tpm', 'rate.member_concurrent', 'rate.key_concurrent',
  ].some(key => Object.hasOwn(runtime, key)));
  const fallback = mode === 'restricted' ? new Set(balanceFallbackModels(policy)) : null;
  const active = policy.lease_budget_milli <= 0 || mode === 'stopped' || unavailableRuntime ? [] : grants.filter(grant =>
    authorized(store, policy, grant) && (!fallback || fallback.has(grant.model_id)));

  const salesRates = new Map(readSalesRateSnapshots(db as Transaction, policy.platform_revision).map(rate => [rate.model_id, rate]));
  const pools = new Map<string, Record<string, unknown>>();
  const routes = new Map<string, Record<string, any>>();
  const rates = new Map<string, Record<string, unknown>>();
  const agents = new Map<string, Record<string, unknown>>();
  const bindings: Record<string, unknown>[] = [];
  let validUntil = iso(at + (inputs.ttlMs ?? DEFAULT_TTL_MS));

  for (const grant of [...active].sort((a, b) => a.binding_id < b.binding_id ? -1 : a.binding_id > b.binding_id ? 1 : a.binding_revision - b.binding_revision)) {
    const poolRevision = grant.pool.mode === 'pinned' ? grant.pool.pool_revision : headRevision(system, grant.model_id);
    const pool = system.get<{ strategy: string; max_attempts: number; attempt_timeout_ms: number; total_timeout_ms: number }>(
      `SELECT strategy, max_attempts, attempt_timeout_ms, total_timeout_ms FROM model_pool_revisions WHERE model_id = ? AND pool_revision = ?`,
      [grant.model_id, poolRevision]);
    if (!pool) throw new ProjectionFailure(grant.pool.mode === 'pinned' ? 'pool_revision_missing' : 'no_active_pool', { model_id: grant.model_id });
    const poolKey = `${grant.model_id}@${poolRevision}`;
    const existingPool = [...pools.values()].find(row => row.model_id === grant.model_id);
    if (existingPool && existingPool.pool_revision !== poolRevision) throw new ProjectionFailure('pool_revision_conflict', { model_id: grant.model_id });

    const rate = salesRates.get(grant.model_id);
    if (!rate) throw new ProjectionFailure('missing_sales_rate', { model_id: grant.model_id });
    if (rate.valid_from > now || (rate.valid_until && rate.valid_until <= now)) throw new ProjectionFailure('sales_rate_outside_window', { model_id: grant.model_id });
    const release = system.get<{ id: string; agent: string; version: string; os: string; arch: string; sha256: string; size: number }>(
      `SELECT id, agent, version, os, arch, sha256, size FROM agent_releases WHERE id = ? AND status = 'active' AND os = ? AND arch = ?`,
      [grant.agent_release_id, device.os, device.arch]);
    if (!release && inputs.productionExecution) continue;
    if (!release) throw new ProjectionFailure('agent_release_unavailable', { agent_release_id: grant.agent_release_id });

    const identity = currentIdentity(system, grant.model_id);
    const deploymentIds: string[] = [];
    const grantRoutes: Record<string, any>[] = [];
    let narrowed = 0;
    for (const member of poolMembers(system, grant.model_id, poolRevision)) {
      const assessment = assessMember(system, grant.model_id, identity, member, now);
      if (assessment.codes.length) continue;
      if (inputs.productionCandidate && !inputs.productionCandidate(member.deployment_id, member.deployment_revision, rate.source_rate_key)) continue;
      const row = system.get<{ provider_id: string; upstream_model: string; context_tokens: number | null;
        max_output_tokens: number | null; protocol: string; base_url: string; auth_adapter: string }>(
        `SELECT d.provider_id, r.upstream_model, r.context_tokens, r.max_output_tokens, er.protocol, er.base_url, er.auth_adapter
         FROM model_deployments d JOIN model_deployment_revisions r ON r.deployment_id = d.deployment_id AND r.deployment_revision = ?
         JOIN provider_endpoint_revisions er ON er.endpoint_id = r.endpoint_id AND er.endpoint_revision = r.endpoint_revision
         WHERE d.deployment_id = ?`, [member.deployment_revision, member.deployment_id]);
      // Only native ingress in this batch; converters register later.
      if (!row || row.protocol !== grant.ingress_protocol) continue;
      // A provider outside the member's narrowed policy is never projected, and its credential is never requested.
      if (providers && !providers.has(row.provider_id)) { narrowed++; continue; }
      const ref = inputs.credentialRef(member.deployment_id, member.deployment_revision);
      if (!ref || !credentialAvailable(inputs, ref)) {
        if (inputs.productionExecution) continue;
        throw new ProjectionFailure('missing_route_credential', { deployment_id: member.deployment_id });
      }
      const evidence = system.get<{ observed_at: string; valid_until: string | null }>(`SELECT max(observed_at) AS observed_at,
        min(valid_until) AS valid_until FROM model_evidence WHERE evidence_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(member.evidence_ids)])!;
      deploymentIds.push(member.deployment_id);
      grantRoutes.push({ model: grant.aliases[0] ?? grant.model_id, model_id: grant.model_id, deployment_id: member.deployment_id,
        deployment_revision: member.deployment_revision, pool_revision: poolRevision, provider_id: row.provider_id, protocol: row.protocol,
        base_url: row.base_url, upstream_model: row.upstream_model, auth: row.auth_adapter, priority: member.priority,
        features: assessment.capabilities, max_context_tokens: row.context_tokens, max_output_tokens: row.max_output_tokens,
        ...(assessment.inputCapabilities && { input_capabilities: assessment.inputCapabilities }),
        valid_until: evidence.valid_until, availability: { state: 'eligible', observed_at: evidence.observed_at, valid_until: evidence.valid_until },
        credential_ref: { credential_id: ref.credential_id, credential_version: ref.credential_version } });
    }
    if (!deploymentIds.length) {
      // Narrowed away by the member's provider policy: the binding is simply not granted to this device.
      if (narrowed || inputs.productionExecution) continue;
      throw new ProjectionFailure('no_eligible_deployment', { model_id: grant.model_id, pool_revision: poolRevision });
    }
    pools.set(poolKey, { model_id: grant.model_id, pool_revision: poolRevision, ...pool, cost_bands: [] });
    const display = system.get<{ display_name: string }>('SELECT display_name FROM models WHERE id = ?', [grant.model_id]);
    rates.set(grant.model_id, { model_id: grant.model_id, rate_version_id: rate.rate_version_id, model_display_name: display?.display_name ?? grant.model_id,
      input_multiplier_basis: rate.input_multiplier_basis, input_multiplier_ppm: rate.input_multiplier_ppm,
      input_milli_per_mtok: rate.input_milli_per_mtok, output_milli_per_mtok: rate.output_milli_per_mtok,
      cache_read_milli_per_mtok: rate.cache_read_milli_per_mtok, cache_write_milli_per_mtok: rate.cache_write_milli_per_mtok,
      effective_from: rate.valid_from, effective_until: rate.valid_until });
    if (rate.valid_until) validUntil = minTime(validUntil, rate.valid_until);
    agents.set(release.id, { ...release, url: artifactDownloadPath(release.id) });
    for (const route of grantRoutes) {
      const routeKey = `${route.model_id}/${route.deployment_id}`;
      if (!routes.has(routeKey)) routes.set(routeKey, route);
      if (route.valid_until) validUntil = minTime(validUntil, route.valid_until);
    }
    bindings.push({ binding_id: grant.binding_id, binding_revision: grant.binding_revision, agent_release_id: grant.agent_release_id,
      ingress_protocol: grant.ingress_protocol, model_id: grant.model_id, aliases: grant.aliases, deployment_ids: deploymentIds });
  }
  if (validUntil <= now) throw new ProjectionFailure('target_expired');
  for (const route of routes.values()) {
    route.valid_until = route.valid_until ? minTime(route.valid_until, validUntil) : validUntil;
    route.availability.valid_until = route.valid_until;
  }
  const revocation_revision = inputs.revocationRevision?.(tenantId, deviceId) ?? 0;
  const body = (revision: number, projection_id: string): RoutePoolConfig => ({
    type: 'config', revision, agent_cache: true,
    policy: { abi: 2, tenant_id: tenantId, user_id: device.user_id, device_id: deviceId, policy_revision: policy.policy_revision,
      platform_revision: policy.platform_revision, tenant_revision: policy.tenant_revision, groups: policy.groups.slice(-maxPolicyScopeRefs),
      member: policy.member, display: policy.display, notices: policy.notices, secrets: [], runtime,
      ...(policy.commerce_plan_id && { commerce_plan_id: policy.commerce_plan_id }), ...(mode && { balance: { mode, aliases: [] } }) },
    agents: structuredClone([...agents.values()]), tools: [], routes: structuredClone([...routes.values()]), rates: structuredClone([...rates.values()]),
    route_pool: { abi: 1, projection_id, signature_id: `sig_${policy.platform_revision}`, expires_at: validUntil, revocation_revision,
      pools: structuredClone([...pools.values()]), bindings: structuredClone(bindings), secrets: [] },
  });
  // Generation basis: everything except identity and time windows, so a later job with the same inputs reuses the target.
  // Built as an independent mapping; the rendered frame keeps every route field.
  const { route_pool: { expires_at: _expires, ...poolBasis }, routes: routeRows, ...restBasis } = body(0, '');
  const basis = { ...restBasis, route_pool: poolBasis,
    routes: routeRows.map(({ valid_until: _until, availability: _availability, ...route }) => route) };
  return { source_token: digest({ tenant_id: tenantId, config: basis }), valid_until: validUntil, user_id: device.user_id,
    platform_revision: policy.platform_revision, policy_revision: policy.policy_revision, revocation_revision, render: body };
}

type SnapshotRow = { device_id: string; config_revision: number; projection_id: string; user_id: string; platform_revision: number;
  policy_revision: number; revocation_revision: number; payload_json: string; digest: string; source_token: string; created_at: string; valid_until: string };

/** Only the device's latest target can be reused, and only while valid: A→B→A never falls back to the revision before B. */
function reusable(sql: Reader, deviceId: string, sourceToken: string, now: string): ProjectionTarget | null {
  const row = sql.get<{ config_revision: number; projection_id: string; source_token: string; valid_until: string }>(`SELECT config_revision,
    projection_id, source_token, valid_until FROM routing_config_snapshots WHERE device_id = ? ORDER BY config_revision DESC LIMIT 1`, [deviceId]);
  return row && row.source_token === sourceToken && row.valid_until > now
    ? { config_revision: row.config_revision, projection_id: row.projection_id, reused: true } : null;
}

export function readSnapshot(sql: Reader, deviceId: string, revision: number) {
  return sql.get<SnapshotRow>('SELECT * FROM routing_config_snapshots WHERE device_id = ? AND config_revision = ?', [deviceId, revision]);
}

/** Latest persisted target of a device. */
export function latestSnapshot(sql: Reader, deviceId: string) {
  return sql.get<SnapshotRow>('SELECT * FROM routing_config_snapshots WHERE device_id = ? ORDER BY config_revision DESC LIMIT 1', [deviceId]);
}

/**
 * Whether the member's current effective authorization still covers an applied projection: every binding is still
 * granted under the current signature (model, Agent, exact release, and the pinned pool revision when pinned), its exact
 * Agent release is still active for the device's OS/arch, and every route is still an eligible member of the exact
 * historical pool revision it was projected from (never the current pool head), keeps a permitted provider and the same
 * available credential version. A pure active-pool change of a follow grant does not void it; narrowing, a disabled or
 * re-versioned deployment, or a withdrawn release does.
 */
export function projectionStillAuthorized(store: Store, db: Reader, inputs: RoutingProjectionInputs, tenantId: string, deviceId: string,
  config: RoutePoolConfig, at: number) {
  const now = iso(at);
  const system = store.system;
  const device = db.get<Recipient>(`${recipientQuery} AND d.id = ?`, [now, deviceId]);
  if (!device || config.policy.user_id !== device.user_id) return false;
  const policy = readPolicyDevice(db as Transaction, device.user_id);
  if (!policy) return false;
  const grants = inputs.grants(tenantId).filter(grant => covers(grant, device.user_id) && grant.platform_revision === policy.platform_revision
    && authorized(store, policy, grant));
  const providers: Set<string> | null = policy.provider_ids_json == null ? null : new Set(JSON.parse(policy.provider_ids_json));
  for (const binding of config.route_pool.bindings as { binding_id: string; binding_revision: number; agent_release_id: string; model_id: string }[]) {
    const grant = grants.find(row => row.binding_id === binding.binding_id && row.binding_revision === binding.binding_revision
      && row.agent_release_id === binding.agent_release_id && row.model_id === binding.model_id);
    if (!grant) return false;
    const pool = (config.route_pool.pools as { model_id: string; pool_revision: number }[]).find(row => row.model_id === binding.model_id);
    if (grant.pool.mode === 'pinned' && grant.pool.pool_revision !== pool?.pool_revision) return false;
    if (!system.get(`SELECT 1 FROM agent_releases WHERE id = ? AND status = 'active' AND os = ? AND arch = ?`,
      [binding.agent_release_id, device.os, device.arch])) return false;
  }
  for (const route of config.routes) {
    if (providers && !providers.has(route.provider_id)) return false;
    const member = poolMembers(system, route.model_id, route.pool_revision)
      .find(row => row.deployment_id === route.deployment_id && row.deployment_revision === route.deployment_revision);
    if (!member || assessMember(system, route.model_id, currentIdentity(system, route.model_id), member, now).codes.length) return false;
    const ref = inputs.credentialRef(route.deployment_id, route.deployment_revision);
    if (!ref || ref.credential_id !== route.credential_ref?.credential_id || ref.credential_version !== route.credential_ref?.credential_version
      || !credentialAvailable(inputs, ref)) return false;
  }
  return true;
}

export function routingProjector(store: Store, inputs: RoutingProjectionInputs, now: () => number) {
  const listeners = new Set<(tenantId: string, deviceId: string) => void>();
  /**
   * Persists (or reuses) the device target. The system counter is advanced first; a reused basis or a failed tenant
   * transaction leaves a gap, which the contract allows. A new target notifies online test sessions.
   */
  async function project(tenantId: string, deviceId: string, at = now(), options: { notify?: boolean } = {}): Promise<ProjectionTarget> {
    const target = await persist(tenantId, deviceId, at);
    if (!target.reused && options.notify !== false) for (const listener of listeners) listener(tenantId, deviceId);
    return target;
  }
  async function persist(tenantId: string, deviceId: string, at: number): Promise<ProjectionTarget> {
    const db = store.tenant(tenantId);
    const first = buildProjection(store, db, inputs, tenantId, deviceId, at);
    const reusableAfter = (built: Built) => iso(at + (inputs.productionExecution && Date.parse(built.valid_until) > at + 60_000 ? 60_000 : 0));
    const existing = reusable(db, deviceId, first.source_token, reusableAfter(first));
    if (existing) return existing;
    const revision = await store.system.write(sql => sql.get<{ revision: number }>(
      'UPDATE edge_config_counter SET revision = revision + 1 WHERE id = 1 RETURNING revision')!.revision);
    return db.write(sql => {
      // Re-check member, device, signature and source_token inside the tenant transaction.
      const built = buildProjection(store, sql, inputs, tenantId, deviceId, at);
      const again = reusable(sql, deviceId, built.source_token, reusableAfter(built));
      if (again) return again;
      const projection_id = inputs.projectionId?.() ?? `prj_${ulid()}`;
      const payload = built.render(revision, projection_id);
      sql.run(`INSERT INTO routing_config_snapshots (device_id, config_revision, projection_id, user_id, platform_revision, policy_revision,
        revocation_revision, payload_json, digest, source_token, created_at, valid_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [deviceId, revision, projection_id, built.user_id, built.platform_revision, built.policy_revision, built.revocation_revision,
          JSON.stringify(payload), routeProjectionDigest(payload), built.source_token, iso(at), built.valid_until]);
      sql.run(`INSERT INTO routing_config_deliveries (device_id, config_revision, projection_id, targeted_at) VALUES (?, ?, ?, ?)`,
        [deviceId, revision, projection_id, iso(at)]);
      return { config_revision: revision, projection_id, reused: false };
    });
  }

  function markRoster(rolloutId: string, tenantId: string, deviceId: string, at: string,
    result: { target: ProjectionTarget } | { outcome: 'superseded' | 'failed'; reason: string; target?: ProjectionTarget }) {
    const target = 'target' in result && result.target ? result.target : null;
    const outcome = 'outcome' in result ? result.outcome : null;
    return store.system.write(sql => sql.run(`UPDATE route_rollout_targets SET
        target_config_revision = coalesce(?, target_config_revision), projection_id = coalesce(?, projection_id),
        outcome = ?, outcome_reason = ?, updated_at = ? WHERE rollout_id = ? AND tenant_id = ? AND device_id = ?`,
      [target?.config_revision ?? null, target?.projection_id ?? null, outcome, outcome ? (result as { reason: string }).reason : null, at,
        rolloutId, tenantId, deviceId]));
  }

  /**
   * Executes one pool release job: roster first (system), then per-device target (tenant), then the roster reference
   * (system). Re-running after a partial failure converges on the same rows through stable keys and source_token.
   */
  async function runRollout(rolloutId: string): Promise<string | null> {
    const job = store.system.get<{ job_id: string; model_id: string; pool_revision: number; status: string }>(
      'SELECT job_id, model_id, pool_revision, status FROM route_release_jobs WHERE job_id = ?', [rolloutId]);
    if (!job) return null;
    if (job.status === 'done' || job.status === 'failed') return job.status;
    await store.system.write(sql => sql.run("UPDATE route_release_jobs SET status = 'running' WHERE job_id = ? AND status IN ('pending', 'running')", [rolloutId]));
    const at = now(), stamp = iso(at);
    if (!store.system.get('SELECT 1 FROM model_pool_revisions WHERE model_id = ? AND pool_revision = ?', [job.model_id, job.pool_revision])) {
      await store.system.write(sql => sql.run("UPDATE route_release_jobs SET status = 'failed' WHERE job_id = ?", [rolloutId]));
      return 'failed';
    }
    for (const { id: tenantId } of store.system.all<{ id: string }>("SELECT id FROM tenants WHERE status = 'active' ORDER BY id")) {
      const relevant = inputs.grants(tenantId).filter(grant => grant.model_id === job.model_id
        && (grant.pool.mode === 'follow' || grant.pool.pool_revision === job.pool_revision));
      if (!relevant.length) continue;
      let db: QueuedDatabase;
      try { db = store.tenant(tenantId); } catch { continue; }
      const roster = db.all<Recipient>(`${recipientQuery} ORDER BY d.id`, [stamp]).filter(device => {
        if (inputs.productionExecution && !inputs.selectRoutePool(tenantId, device.id)) return false;
        const hot = readPolicyHot(db, device.user_id);
        return !!hot && relevant.some(grant => covers(grant, device.user_id) && authorized(store, hot, grant));
      });
      if (!roster.length) continue;
      await store.system.write(sql => {
        for (const device of roster) sql.run(`INSERT INTO route_rollout_targets (rollout_id, tenant_id, device_id, user_id, registered_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [rolloutId, tenantId, device.id, device.user_id, stamp, stamp]);
      });
      for (const device of roster) {
        const pinned = relevant.some(grant => grant.pool.mode === 'pinned' && covers(grant, device.user_id));
        if (!pinned && headRevision(store.system, job.model_id) !== job.pool_revision) {
          await markRoster(rolloutId, tenantId, device.id, stamp, { outcome: 'superseded', reason: 'pool_superseded' });
          continue;
        }
        let target: ProjectionTarget;
        try { target = await project(tenantId, device.id, at); }
        catch (error) {
          if (!(error instanceof ProjectionFailure)) throw error;
          await markRoster(rolloutId, tenantId, device.id, stamp, { outcome: 'failed', reason: error.reason });
          continue;
        }
        // A follow head that moved during projection belongs to the newer job, never to this one.
        const snapshot = readSnapshot(db, device.id, target.config_revision)!;
        const projected = (JSON.parse(snapshot.payload_json) as RoutePoolConfig).route_pool.pools
          .some((pool: { model_id: string; pool_revision: number }) => pool.model_id === job.model_id && pool.pool_revision === job.pool_revision);
        const skipped = inputs.productionExecution && pinned
          ? { outcome: 'failed' as const, reason: 'no_eligible_deployment' }
          : { outcome: 'superseded' as const, reason: 'pool_superseded' };
        await markRoster(rolloutId, tenantId, device.id, stamp, projected ? { target } : skipped);
      }
    }
    await store.system.write(sql => sql.run("UPDATE route_release_jobs SET status = 'done' WHERE job_id = ? AND status = 'running'", [rolloutId]));
    return 'done';
  }

  async function runPending() {
    const jobs = store.system.all<{ job_id: string }>(`SELECT job_id FROM route_release_jobs WHERE job_kind = 'project'
      AND status IN ('pending', 'running') ORDER BY created_at, job_id`);
    for (const job of jobs) await runRollout(job.job_id);
  }

  return { inputs, project, runRollout, runPending,
    subscribe(listener: (tenantId: string, deviceId: string) => void) { listeners.add(listener); return () => listeners.delete(listener); } };
}
export type RoutingProjector = ReturnType<typeof routingProjector>;
