import { Hono } from 'hono';
import { ApiError } from '../src/api';
import { commerceRoutes } from '../src/commerce';
import { hash, randomToken } from '../src/credentials';
import { policyRoutes } from '../src/policy-routes';
import type { RouteGrant, RoutingProjectionInputs } from '../src/route-projection';
import { x25519PublicKey } from '../src/route-secret';
import { ensureUser, seedTenant } from '../src/seed';
import { indexDevice, indexMember, type Store } from '../src/store';
import { minutes, seedSupply } from './routing-fixture';

/** Synthetic device key (0x07 × 32, contract vector) and synthetic inference material. Never production values. */
export const devicePrivate = new Uint8Array(32).fill(7);
export const fixturePlaintext: Record<string, string> = { 'cred_a@1': 'fixture-inference-key', 'cred_b@2': 'fixture-inference-key-b' };
export const fixtureRefs: Record<string, { credential_id: string; credential_version: number }> = {
  'dep_a@3': { credential_id: 'cred_a', credential_version: 1 }, 'dep_b@2': { credential_id: 'cred_b', credential_version: 2 },
};
export const followGrant: RouteGrant = { binding_id: 'bnd_codex_m', binding_revision: 1, agent_release_id: 'rel_codex', model_id: 'mdl_m',
  ingress_protocol: 'openai_responses', aliases: ['model-m'], pool: { mode: 'follow' }, platform_revision: 1 };

const ok = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

/**
 * Seeds the A/B projection sample into a store: owner device dev_lin follows the active pool (v7, A/B), a second
 * member's dev_fix is pinned to v6 (A only), both under a real 4× signature. Returns device tokens and the
 * isolated routing inputs (grants and synthetic credential versions) to inject into the projector or Server.
 */
export async function seedProjection(store: Store, dir: string, now: () => number, options: { credentials?: Record<string, string> } = {}) {
  const { tenantId, userId } = await seedTenant(store, { target: 'owner@projection.test', platformAdmin: true, now: now() });
  const platform = randomToken();
  const tokens = { dev_lin: randomToken(), dev_fix: randomToken() };
  const pinnedUser = await store.system.write(sql => {
    seedSupply(sql);
    sql.run(`INSERT INTO platform_rate_versions (source_rate_key, model_id, input_multiplier_basis, input_multiplier_ppm,
      input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok, cache_write_milli_per_mtok,
      sales_rates_source, pool_revision, pricing_at, calculation_status, source_digest, status, created_by, created_at)
      VALUES ('prate_m_12', 'mdl_m', 'cny_1_per_mtok_input', 4000000, 4000, 12000, 1000, 5000, 'fixture', 6, ?, 'complete', ?, 'available_to_sign', 'fixture', ?)`,
      [minutes(0), hash('prate_m_12'), minutes(0)]);
    sql.run("INSERT INTO sessions (token_hash, user_id, tenant_id, kind, expires_at) VALUES (?, ?, NULL, 'web', ?)", [hash(platform), userId, minutes(600)]);
    sql.run(`INSERT INTO agent_releases (id, agent, version, os, arch, url, sha256, size, status)
      VALUES ('rel_codex', 'codex', '1.0.0', 'darwin', 'arm64', 'https://releases.openai.com/codex.tgz', ?, 1024, 'active')`, ['0'.repeat(64)]);
    // Pool v7 adds dep_b next to dep_a; v6 stays readable for pinned grants.
    sql.run(`INSERT INTO model_pool_revisions (model_id, pool_revision, based_on_revision, identity_revision, strategy, max_attempts, attempt_timeout_ms,
      total_timeout_ms, reason, digest, released_by, released_at) VALUES ('mdl_m', 7, 6, 1, 'ordered', 2, 5000, 12000, 'add B', 'seed7', 'seed', ?)`, [minutes(-1)]);
    sql.run(`INSERT INTO model_pool_deployments (model_id, pool_revision, deployment_id, deployment_revision, approved_match_id, priority, evidence_ids_json)
      VALUES ('mdl_m', 7, 'dep_a', 3, 'mt_a', 10, '["ev_a"]'), ('mdl_m', 7, 'dep_b', 2, 'mt_b', 20, '["ev_b"]')`);
    sql.run("UPDATE model_pool_heads SET pool_revision = 7 WHERE model_id = 'mdl_m'");
    sql.run(`INSERT INTO route_release_jobs (job_id, model_id, pool_revision, job_kind, source_digest, status, created_at)
      VALUES ('rol_v6', 'mdl_m', 6, 'project', 'seed', 'pending', ?), ('rol_v7', 'mdl_m', 7, 'project', 'seed7', 'pending', ?)`, [minutes(-2), minutes(-1)]);
    sql.run('UPDATE edge_config_counter SET revision = 90 WHERE id = 1');
    const other = ensureUser(sql, { kind: 'email', value: 'pinned@projection.test' }, now()).id;
    indexMember(sql, tenantId, { user_id: other, role: 'member', status: 'active' });
    return other;
  });
  const db = store.tenant(tenantId);
  const publicKey = x25519PublicKey(devicePrivate);
  await db.write(sql => {
    sql.run("INSERT INTO members (user_id, role, status) VALUES (?, 'member', 'active')", [pinnedUser]);
    for (const [device, user] of [['dev_lin', userId], ['dev_fix', pinnedUser]] as const) {
      sql.run(`INSERT INTO devices (id, user_id, name, os, arch, public_key, token_hash, token_expires_at, status)
        VALUES (?, ?, ?, 'darwin', 'arm64', ?, ?, ?, 'active')`, [device, user, device, publicKey, hash(tokens[device]), minutes(600)]);
    }
  });
  await store.system.write(sql => { for (const id of ['dev_lin', 'dev_fix'] as const) indexDevice(sql, tenantId, { id, token_hash: hash(tokens[id]) }); });

  // Real signature with the 4× plan: sales_rate_snapshots come from the signing transaction.
  const app = new Hono(), opts = { codeSecret: 'projection', now, dataDir: dir };
  app.onError((err, c) => err instanceof ApiError ? c.json(err.body(), err.status) : c.json({ error: String(err) }, 500));
  commerceRoutes(app, store, opts); policyRoutes(app, store, opts);
  const call = (path: string, payload: unknown) => app.request('/v1' + path, { method: 'POST',
    headers: { authorization: 'Bearer ' + platform, 'content-type': 'application/json', 'idempotency-key': randomToken() }, body: JSON.stringify(payload) });
  const plan = await call('/platform/commerce/plans', { name: 'demo', expected_version: 0,
    terms: { model_prices: [{ model_id: 'mdl_m', source_rate_key: 'prate_m_12' }], monthly_grant_milli: 500 } });
  ok(plan.status === 201, `commerce plan failed: ${plan.status}`);
  const planId = (await plan.json() as { id: string }).id;
  const signed = await call(`/platform/policy/contracts/${tenantId}/signatures`, { expected_platform_revision: 0, expected_policy_revision: 0,
    base_revision: null, reason: 'routing projection', entries: [['access.models', ['mdl_m']], ['access.agents', ['codex']], ['billing.plan', [planId]], ['lease.budget', 100000]]
      .map(([id, adjustment]) => ({ template_ref: null, clause_ref: { id, version: 1 }, adjustment })) });
  ok(signed.status === 201, `signature failed: ${signed.status}`);
  const signature = await signed.json() as { sales_rate_snapshots: Record<string, any>[] };

  const credentials = options.credentials ?? fixturePlaintext;
  let grants: RouteGrant[] = [{ ...followGrant, user_ids: [userId] },
    { ...followGrant, binding_id: 'bnd_codex_m_fixed', pool: { mode: 'pinned', pool_revision: 6 }, user_ids: [pinnedUser] }];
  let projectionSeq = 90;
  let selected = (_tenant: string, _device: string) => true;
  const inputs: RoutingProjectionInputs = {
    grants: () => grants,
    credentialRef: (deployment, revision) => fixtureRefs[`${deployment}@${revision}`] ?? null,
    credentialMaterial: (id, version) => {
      const value = credentials[`${id}@${version}`];
      return value ? { purpose: 'inference', material_class: 'inference', plaintext: Buffer.from(value) } : null;
    },
    selectRoutePool: (tenant, device) => selected(tenant, device),
    projectionId: () => `prj_${++projectionSeq}`,
  };
  return { db, tenantId, userId, pinnedUser, platform, tokens, signature, inputs, publicKey,
    setGrants: (next: RouteGrant[]) => { grants = next; },
    setSelection: (next: (tenant: string, device: string) => boolean) => { selected = next; } };
}
