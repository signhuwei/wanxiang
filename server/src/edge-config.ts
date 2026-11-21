import { createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ulid } from 'ulid';
import { readContract } from './capability-data';
import { commerceDisplay, commerceRates } from './commerce';
import { tenantUpstreamTargets,platformUpstreamPriority,upstreamOrder } from './tenant-upstreams';
import { balance } from './billing';
import { iso } from './credentials';
import { allowedAgentReleases, artifactDownloadPath, hasPinnedAgentTarget, type DesktopCapabilities } from './agent-catalog';
import { decryptProviderSecret } from './provider-secret';
import { balanceFallbackModels, balanceLabels, balanceNotices, balancePolicyEnabled, balancePolicyMode,
  readBalanceMode, recordBalanceMode } from './policy-balance';
import { readEffective, readHead, readPolicyDevice } from './policy-data';
import type { Store } from './store';
import { allowedToolReleases } from './tool-releases';

const prefix = Buffer.from('302a300506032b656e032100', 'hex');
const info = Buffer.from('onex-edge-secret-v1');
const maxPolicyScopeRefs = 64;
type Subscription = DesktopCapabilities & { tenant: string; agentCache: boolean; supportsCapabilityContract: boolean; supportsCapabilityPolicy: boolean; supportsPolicyRuntime?: boolean;
  live: () => boolean; send: (value: Record<string, unknown>) => void };
type RouteRow = { model_id: string; route_model: string | null; upstream_model: string; provider_id: string; protocol: string;
  base_url: string; auth: string | null; proxy: string | null; name: string;
  input_milli_per_mtok: number; output_milli_per_mtok: number; cache_read_milli_per_mtok: number;
  cache_write_milli_per_mtok: number; effective_from: string };
type Participant = { user_id: string; os: string; arch: string; public_key: string | null };

export function encryptEdgeSecret(publicKey: string, providerId: string, plaintext: Uint8Array) {
  // The wire key_id is the sender's ephemeral X25519 public key.
  const raw = Buffer.from(publicKey, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== publicKey) throw new Error('Invalid X25519 public key');
  const remote = createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: remote });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
  try {
    const nonce = randomBytes(24);
    const ciphertext = xchacha20poly1305(key, nonce, Buffer.from(providerId)).encrypt(plaintext);
    return {
      key_id: ephemeral.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
      nonce: nonce.toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64'),
    };
  } finally {
    shared.fill(0);
    key.fill(0);
  }
}

const runtimeKeys = ['model.max_output_tokens','rate.member_rpm','rate.member_tpm','rate.member_concurrent','rate.key_concurrent',
  'route.failover','network.public'] as const;

export function deviceRuntime(policy: { runtime_rules_json?: string } | null) {
  const values = JSON.parse(policy?.runtime_rules_json ?? '{}') as Record<string,number|boolean>;
  return Object.fromEntries(runtimeKeys.filter(key => key in values).map(key => [key, values[key]]));
}

export function requiresPolicyRuntime(store: Store, policy: {
  runtime_rules_json?: string; commerce_plan_id?: string|null; tool_release_ids_json: string
} | null) {
  return !!policy && (!!policy.commerce_plan_id || Object.keys(deviceRuntime(policy)).length>0 ||
    (policy.tool_release_ids_json!=='[]' && !!store.system.get(`SELECT 1 FROM tool_releases
      WHERE kind='hook' AND status='published' AND id IN (SELECT value FROM json_each(?)) LIMIT 1`,[policy.tool_release_ids_json])));
}

export function effectiveModelConfig(store: Store, contract: { allowed_models_json: string; lease_budget_milli: number; commerce_plan_id?: string|null } | null, now: number) {
  const allowed = contract && contract.lease_budget_milli > 0 ? contract.allowed_models_json : '[]';
  const rows = store.system.all<RouteRow>(`SELECT m.id AS model_id, m.route_model, m.upstream_name AS upstream_model,
    m.display_name AS name, p.id AS provider_id, p.protocol, p.base_url, p.auth, p.proxy,
    r.input_milli_per_mtok, r.output_milli_per_mtok, r.cache_read_milli_per_mtok, r.cache_write_milli_per_mtok, r.effective_from
    FROM models m JOIN providers p ON p.id = m.provider_id
    JOIN rates r ON r.model_id = m.id AND r.effective_from = (
      SELECT max(r2.effective_from) FROM rates r2 WHERE r2.model_id = m.id AND r2.effective_from <= ?
    ) WHERE m.status = 'active' AND p.status = 'active' AND p.protocol IN ('anthropic', 'openai_chat', 'openai_responses')
    AND m.id IN (SELECT value FROM json_each(?)) ORDER BY m.id`, [iso(now), allowed]);
  const routes = rows.map(({ model_id, route_model, upstream_model, provider_id, protocol, base_url, auth, proxy }) =>
    ({ model_id, model: route_model ?? upstream_model, upstream_model, provider_id, protocol, base_url,
      auth: auth ?? (protocol === 'anthropic' ? 'x_api_key' : 'bearer'), ...(proxy && { proxy }) }));
  const rates = commerceRates(store, contract, rows.map(({ model_id, input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok,
    cache_write_milli_per_mtok, effective_from }) =>
    ({ model_id, input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok, cache_write_milli_per_mtok, effective_from })));
  const models = rows.map((row, i) => ({ model_id: row.model_id, name: row.name, model: routes[i]!.model,
    provider_id: row.provider_id, protocol: row.protocol, rate: rates[i]! }));
  return { routes, rates, models };
}

export function configPublisher(store: Store, dataDir: string, now: () => number, masterKey?: Uint8Array) {
  const online = new Map<string, Subscription>();
  const targets = new Map<string, { subscription: Subscription; revision: number; policyRevision: number }>();
  const balanceJobs = new Map<string, { dirty: boolean; promise: Promise<void> }>();

  function envelope(participant: Participant, device: string, provider_id: string) {
    if (!participant.public_key || !masterKey) return null;
    const provider = store.system.get<{ secret_ciphertext: Uint8Array }>(
      'SELECT secret_ciphertext FROM providers WHERE id = ?', [provider_id]);
    if (!provider) return null;
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptProviderSecret(masterKey, provider_id, provider.secret_ciphertext);
      return { provider_id, ...encryptEdgeSecret(participant.public_key, provider_id, plaintext) };
    } catch {
      console.warn('OneX could not envelope a provider secret', { provider_id, device_id: device });
      return null;
    } finally { plaintext?.fill(0); }
  }

  async function publish(device: string, sub: Subscription) {
    const revision = await store.system.write((sql) => sql.get<{ revision: number }>(
      'UPDATE edge_config_counter SET revision = revision + 1 WHERE id = 1 RETURNING revision')!.revision);
    if (online.get(device) !== sub || !sub.live()) return;
    targets.delete(device);
    const tenantActive = store.system.get<{ active: number }>("SELECT 1 AS active FROM tenants WHERE id = ? AND status = 'active'", [sub.tenant]);
    const db = store.tenant(sub.tenant);
    const participant = tenantActive && db.get<Participant>(`SELECT d.user_id, d.os, d.arch, d.public_key FROM devices d JOIN members m ON m.user_id = d.user_id
      WHERE d.id = ? AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`, [device, iso(now())]);
    if (!participant) {
      sub.send({ type: 'cutoff', id: `msg_${ulid()}`, reason: 'disabled' });
      return;
    }
    const policy = readPolicyDevice(db, participant.user_id);
    const contract = policy ?? readContract(db);
    const capability = contract && contract.platform_revision > 0 ? {
      capability_contract: { platform_revision: contract.platform_revision, tenant_revision: contract.tenant_revision },
    } : {};
    const runtime = deviceRuntime(policy);
    const runtimeRequired=requiresPolicyRuntime(store,policy);
    if ((policy && (!sub.supportsCapabilityPolicy || (!sub.supportsPolicyRuntime && runtimeRequired)))
      || (!policy && contract && contract.platform_revision > 0 && !sub.supportsCapabilityContract)
      || (!sub.agentCache && hasPinnedAgentTarget(contract || null, participant.os, participant.arch))) {
      sub.send({ type: 'config', id: `msg_${ulid()}`, revision, routes: [], rates: [], agents: [], ...(!policy && capability) });
      sub.send({ type: 'cutoff', id: `msg_${ulid()}`, reason: 'contract' });
      return;
    }
    const { routes: platformRoutes, rates } = effectiveModelConfig(store, contract || null, now());
    const agents = allowedAgentReleases(store, dataDir, contract || null, participant.os, participant.arch, sub.agentCache, sub)
      .map(({ id, agent, version, os, arch, url, sha256, size }) => ({
        id, agent, version, os, arch, url: sub.agentCache ? artifactDownloadPath(id) : url, sha256, size,
      }));
    if (policy) {
      const allowedProviders: Set<string> | null = policy.provider_ids_json == null ? null : new Set(JSON.parse(policy.provider_ids_json));
      const origins = platformRoutes.filter(route => !allowedProviders || allowedProviders.has(route.provider_id));
      const routeSecrets = new Map<string, ReturnType<typeof encryptEdgeSecret> & {provider_id:string}>();
      const custom = JSON.parse(policy.runtime_rules_json ?? '{}')['upstream.custom'] === true;
      const routes = origins.flatMap(route => {
        if (!routeSecrets.has(route.provider_id)) {
          const origin = envelope(participant, device, route.provider_id);
          if (origin) routeSecrets.set(origin.provider_id, origin);
        }
        const candidates = [{route, priority:platformUpstreamPriority}];
        if (custom && masterKey && participant.public_key) {
          for (const upstream of tenantUpstreamTargets(db, sub.tenant, masterKey, route.model_id)) {
            try {
              if (upstream.protocol !== route.protocol) continue;
              routeSecrets.set(upstream.id,{provider_id:upstream.id,...encryptEdgeSecret(participant.public_key,upstream.id,upstream.secret)});
              candidates.push({priority:upstream.priority, route:{model_id:route.model_id, model:route.model, provider_id:upstream.id,
                protocol:upstream.protocol, auth:upstream.protocol === 'anthropic'?'x_api_key':'bearer',
                upstream_model:upstream.upstream_name,base_url:upstream.base_url}});
            } finally { upstream.secret.fill(0); }
          }
        }
        return candidates.filter(item=>routeSecrets.has(item.route.provider_id)).sort(upstreamOrder).map(item=>item.route);
      });
      const tools = allowedToolReleases(store, dataDir, policy, participant.os, participant.arch);
      const mode = balancePolicyEnabled(policy) ? readBalanceMode(db) : null;
      const eligible = mode === 'restricted' ? new Set(balanceFallbackModels(policy)) : null;
      const availableRoutes = mode === 'stopped' ? [] : eligible ? routes.filter(route => eligible.has(route.model_id)) : routes;
      const availableModels = new Set(availableRoutes.map(route => route.model_id));
      const availableProviders = new Set(availableRoutes.map(route => route.provider_id));
      const secrets = [...routeSecrets.values()].filter(secret => availableProviders.has(secret.provider_id));
      const aliases = mode === 'restricted' && availableRoutes.length > 0
        ? [...new Map(routes.flatMap(({ model, protocol, upstream_model }) => {
          // Native desktop selectors only expose fixed wildcard targets. Keep each exact name across a downgrade.
          const names = model.endsWith('*') && upstream_model &&
            !upstream_model.includes('*') && upstream_model.startsWith(model.slice(0, -1)) ? [model, upstream_model] : [model];
          return names.map(name => [JSON.stringify([name, protocol]), {model:name, protocol}] as const);
        })).values()] : [];
      const display = mode ? [{ id: '_runtime.balance.mode', title: '余额路由状态', kind: 'enum', value: balanceLabels[mode] },
        ...policy.display] : [...policy.display];
      display.push(...commerceDisplay(store,policy,now()));
      const notices = [...policy.notices, ...balanceNotices(db, participant.user_id)]
        .sort((a, b) => a.at.localeCompare(b.at) || a.policy_revision - b.policy_revision).slice(-20);
      sub.send({ type: 'config', id: `msg_${ulid()}`, revision, agent_cache: sub.agentCache, agents, tools,
        routes: availableRoutes, rates: rates.filter(rate => availableModels.has(rate.model_id)),
        policy: { abi: runtimeRequired ? 2 : 1, ...(runtimeRequired && {runtime}), ...(policy.commerce_plan_id && {commerce_plan_id:policy.commerce_plan_id}), tenant_id: sub.tenant, user_id: participant.user_id, device_id: device,
          platform_revision: policy.platform_revision, policy_revision: policy.policy_revision,
          tenant_revision: policy.tenant_revision, groups: policy.groups.slice(-maxPolicyScopeRefs), member: policy.member,
          display, notices, secrets, ...(mode && { balance: { mode, aliases } }) } });
      targets.set(device, { subscription: sub, revision, policyRevision: policy.policy_revision });
      if (policy.lease_budget_milli <= 0) sub.send({ type: 'cutoff', id: `msg_${ulid()}`, reason: 'contract' });
      return;
    }
    const routes=platformRoutes;
    sub.send({ type: 'config', id: `msg_${ulid()}`, revision, routes, rates, agents, ...capability, ...(sub.agentCache && { agent_cache: true }) });
    if (!contract || contract.lease_budget_milli <= 0) sub.send({ type: 'cutoff', id: `msg_${ulid()}`, reason: 'contract' });
    if (!participant.public_key || !masterKey) return;
    for (const providerId of new Set(routes.map((route) => route.provider_id))) {
      const secret = envelope(participant, device, providerId);
      if (secret) sub.send({ type: 'secret', id: `msg_${ulid()}`, ...secret });
    }
  }

  function send(device: string, sub: Subscription) {
    return publish(device, sub).catch(() => { console.error('OneX could not publish Edge configuration', { device_id: device }); });
  }
  function publishTenant(tenant?: string) {
    return Promise.all([...online].filter(([, sub]) => !tenant || sub.tenant === tenant).map(([device, sub]) => send(device, sub)));
  }
  function refreshBalance(tenant: string) {
    const db = store.tenant(tenant);
    const effective = readEffective(db, 'tenant', tenant);
    if (!effective || (!balancePolicyEnabled(effective.hot) && readBalanceMode(db) === 'normal')) return Promise.resolve(false);
    return db.write(sql => {
      const head = readHead(sql);
      const settings = readEffective(sql, 'tenant', tenant)?.hot;
      if (!head || !settings) return false;
      const at = now();
      const mode = balancePolicyEnabled(settings) ? balancePolicyMode(settings, balance(sql, at)) : 'normal';
      return recordBalanceMode(sql, mode, head.policy_revision, at);
    });
  }
  function balanceChanged(tenant: string) {
    const existing = balanceJobs.get(tenant);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }
    const job = { dirty: true, promise: Promise.resolve() };
    job.promise = Promise.resolve().then(async () => {
      try {
        while (job.dirty) {
          job.dirty = false;
          if (await refreshBalance(tenant)) await publishTenant(tenant);
        }
      } catch {
        console.error('OneX could not refresh tenant balance policy', { tenant_id: tenant });
      } finally {
        balanceJobs.delete(tenant);
      }
    });
    balanceJobs.set(tenant, job);
    return job.promise;
  }
  return {
    balanceChanged,
    connect(device: string, sub: Subscription) {
      online.set(device, sub);
      targets.delete(device);
      return send(device, sub);
    },
    disconnect(device: string, sub: Subscription) {
      if (online.get(device) === sub) {
        online.delete(device);
        targets.delete(device);
      }
    },
    async applied(device: string, sub: Subscription, revision: number, policyRevision: number) {
      const target = targets.get(device);
      if (target?.subscription !== sub || target.revision !== revision || target.policyRevision !== policyRevision) return false;
      return store.tenant(sub.tenant).write(sql => {
        if (targets.get(device) !== target || online.get(device) !== sub || !sub.live()) return false;
        const at = iso(now());
        if (!sql.get(`SELECT 1 FROM devices d JOIN members m ON m.user_id = d.user_id
          WHERE d.id = ? AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`, [device, at])) return false;
        sql.run(`INSERT INTO policy_device_applications (device_id, config_revision, policy_revision, applied_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE
          SET config_revision = excluded.config_revision, policy_revision = excluded.policy_revision, applied_at = excluded.applied_at
          WHERE excluded.config_revision > policy_device_applications.config_revision`, [device, revision, policyRevision, at]);
        return true;
      });
    },
    async changed(tenant?: string) {
      if (tenant) await refreshBalance(tenant);
      await publishTenant(tenant);
    },
  };
}

export type ConfigPublisher = ReturnType<typeof configPublisher>;
