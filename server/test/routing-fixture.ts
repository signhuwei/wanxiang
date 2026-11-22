import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import fixture from '../../tests/fixtures/routing/p0-ab.json';
import { ApiError } from '../src/api';
import { hash, iso, randomToken } from '../src/credentials';
import { modelPoolRoutes } from '../src/model-pool';
import { platformRoutes } from '../src/platform-management';
import { procurementRoutes } from '../src/procurement';
import { ensureUser, seedTenant } from '../src/seed';
import { Store, type Transaction } from '../src/store';

export const clock = Date.parse(fixture.clock_utc);
export const minutes = (n: number) => iso(clock + n * 60_000);
export type Json = Record<string, any>;
export const body = async (response: Response) => await response.json() as Json;

/** Synthetic A/B supply matching tests/fixtures/routing/p0-ab.json; no real hosts or keys. */
export function seedSupply(sql: Transaction) {
  const at = minutes(-60);
  for (const [provider, account, endpoint, domain] of [['prv_a', 'acct_a', 'ep_a', 'fd_a'], ['prv_b', 'acct_b', 'ep_b', 'fd_b']] as const) {
    sql.run(`INSERT INTO providers (id, name, protocol, base_url, secret_ciphertext, status) VALUES (?, ?, 'openai_responses', ?, ?, 'active')`,
      [provider, provider.toUpperCase(), `https://${provider}.example.test/v1`, randomBytes(48)]);
    sql.run("INSERT INTO provider_accounts (account_id, provider_id, name, status, created_at) VALUES (?, ?, ?, 'active', ?)", [account, provider, account, at]);
    sql.run("INSERT INTO provider_endpoints (endpoint_id, provider_id, status, current_revision, created_at) VALUES (?, ?, 'active', 1, ?)", [endpoint, provider, at]);
    sql.run(`INSERT INTO provider_endpoint_revisions (endpoint_id, endpoint_revision, protocol, base_url, region, fault_domain_id, auth_adapter, created_at)
      VALUES (?, 1, 'openai_responses', ?, 'cn', ?, 'bearer', ?)`, [endpoint, `https://${provider}.example.test/v1`, domain, at]);
    sql.run("INSERT INTO provider_account_endpoints (provider_id, account_id, endpoint_id, state) VALUES (?, ?, ?, 'enabled')", [provider, account, endpoint]);
  }
  sql.run(`INSERT INTO models (id, provider_id, upstream_name, display_name, context_window, status)
    VALUES ('mdl_m', 'prv_a', 'vendor-a/m-20261121', 'DeepSeek V4.1 Flash', 128000, 'active')`);
  sql.run(`INSERT INTO models (id, provider_id, upstream_name, display_name, context_window, status)
    VALUES ('mdl_legacy', 'prv_a', 'legacy', 'Legacy', 4096, 'active')`);
  // Legacy platform rate. Output and cache rates carry into new signable versions; nothing rewrites this row.
  sql.run(`INSERT INTO rates (model_id, input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok, cache_write_milli_per_mtok, effective_from)
    VALUES ('mdl_m', 3500, 12000, 1000, 5000, ?)`, [minutes(-120)]);
  sql.run(`INSERT INTO model_identity_revisions (model_id, identity_revision, maker_id, model_family, model_variant, identity_mode, model_snapshot,
    capability_floor_json, created_by, created_at) VALUES ('mdl_m', 1, 'deepseek', 'v4.1', 'flash', 'pinned_snapshot', '20261121', '["text","stream"]', 'seed', ?)`, [at]);
  sql.run("UPDATE models SET current_identity_revision = 1 WHERE id = 'mdl_m'");
  const deployments = [
    ['dep_a', 'prv_a', 'acct_a', 'ep_a', 3, 'vendor-a/m-20261121', 'A · M'],
    ['dep_b', 'prv_b', 'acct_b', 'ep_b', 2, 'vendor-b/m', 'B · M'],
    ['dep_quant', 'prv_b', 'acct_b', 'ep_b', 1, 'vendor-b/m-int4', 'B · M INT4'],
  ] as const;
  for (const [id, provider, account, endpoint, revision, upstream, name] of deployments) {
    sql.run(`INSERT INTO model_deployments (deployment_id, provider_id, account_id, endpoint_id, display_name, status, current_revision, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`, [id, provider, account, endpoint, name, revision, at]);
    sql.run(`INSERT INTO model_deployment_revisions (deployment_id, deployment_revision, endpoint_id, endpoint_revision, upstream_model,
      capabilities_json, context_tokens, max_output_tokens, created_by, created_at) VALUES (?, ?, ?, 1, ?, '["text","stream","function_tools"]', 128000, 16000, 'seed', ?)`,
      [id, revision, endpoint, upstream, at]);
  }
  const evidence = [['ev_a', 'dep_a', 3, 'passed', 1, minutes(60)], ['ev_b', 'dep_b', 2, 'passed', 1, minutes(10)], ['ev_quant', 'dep_quant', 1, 'passed', 0, minutes(60)]] as const;
  for (const [id, deployment, revision, outcome, identity, until] of evidence) {
    sql.run(`INSERT INTO model_evidence (evidence_id, deployment_id, deployment_revision, source_kind, outcome, identity_verified, capabilities_json,
      observed_at, valid_until, created_by) VALUES (?, ?, ?, 'runtime_probe', ?, ?, '["text","stream","function_tools"]', ?, ?, 'seed')`,
      [id, deployment, revision, outcome, identity, at, until]);
  }
  const matches = [['mt_a', 'dep_a', 3, 'accepted', '["same_snapshot"]'], ['mt_b', 'dep_b', 2, 'accepted', '["catalog_mapping"]'],
    ['mt_quant', 'dep_quant', 1, 'needs_review', '["quantization_variant"]']] as const;
  for (const [id, deployment, revision, status, reasons] of matches) {
    const decided = status === 'accepted';
    sql.run(`INSERT INTO model_discovery_matches (candidate_id, model_id, identity_revision, deployment_id, deployment_revision, match_kind, normalized_key,
      confidence, reasons_json, status, decided_by, decided_at, created_at) VALUES (?, 'mdl_m', 1, ?, ?, 'manual', 'deepseek/v4.1/flash', 'high', ?, ?, ?, ?, ?)`,
      [id, deployment, revision, reasons, status, decided ? 'seed' : null, decided ? at : null, at]);
  }
  sql.run(`INSERT INTO model_pool_revisions (model_id, pool_revision, based_on_revision, identity_revision, strategy, max_attempts, attempt_timeout_ms,
    total_timeout_ms, reason, digest, released_by, released_at) VALUES ('mdl_m', 6, 5, 1, 'ordered', 1, 5000, 12000, 'seed v6', 'seed', 'seed', ?)`, [at]);
  sql.run(`INSERT INTO model_pool_deployments (model_id, pool_revision, deployment_id, deployment_revision, approved_match_id, priority, evidence_ids_json)
    VALUES ('mdl_m', 6, 'dep_a', 3, 'mt_a', 10, '["ev_a"]')`);
  sql.run("INSERT INTO model_pool_heads (model_id, pool_revision, updated_at) VALUES ('mdl_m', 6, ?)", [at]);
}

/** Isolated system and tenant databases in a temp directory with platform, tenant and outsider sessions. */
export async function setup() {
  let at = clock;
  const dir = mkdtempSync(join(tmpdir(), 'onex-routing-'));
  const store = new Store(dir, 4);
  const { userId, tenantId } = await seedTenant(store, { target: 'owner@routing.example', platformAdmin: true, now: at });
  const platform = randomToken(), tenant = randomToken(), outsider = randomToken();
  const expiry = iso(at + 86_400_000);
  await store.system.write((sql) => {
    const other = ensureUser(sql, { kind: 'email', value: 'outsider@routing.example' }, at).id;
    for (const [token, user, scope] of [[platform, userId, null], [tenant, userId, tenantId], [outsider, other, null]] as const) {
      sql.run("INSERT INTO sessions (token_hash, user_id, tenant_id, kind, expires_at) VALUES (?, ?, ?, 'web', ?)", [hash(token), user, scope, expiry]);
    }
    seedSupply(sql);
  });
  await store.tenant(tenantId).write((sql) => {
    // Retired flat contract grants must not count as impact; only the signed tenant policy does.
    sql.run(`UPDATE contract SET allowed_models_json = '["mdl_m"]'`);
    sql.run("INSERT INTO policy_effective (scope, subject_id, document_json) VALUES ('tenant', ?, ?)",
      [tenantId, JSON.stringify({ hot: { allowed_models_json: '["mdl_m"]' } })]);
    sql.run(`INSERT INTO devices (id, user_id, name, os, arch, public_key, token_hash, token_expires_at, status)
      VALUES ('dev_lin', ?, 'Lin', 'darwin', 'arm64', 'test', ?, ?, 'active')`, [userId, hash(randomToken()), expiry]);
  });
  const app = new Hono();
  app.onError((error, c) => { if (error instanceof ApiError) return c.json({ error: error.body() }, error.status); throw error; });
  let configChanges = 0;
  const opts = { now: () => at, codeSecret: 'routing-fixture', dataDir: dir, onConfigChange: () => { configChanges++; } };
  platformRoutes(app, store, opts);
  modelPoolRoutes(app, store, opts);
  procurementRoutes(app, store, opts);
  const call = (token: string, path: string, payload?: unknown, key?: string) => app.request(`/v1/platform${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key && { 'Idempotency-Key': key }) },
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
  });
  return { store, dir, platform, tenant, outsider, tenantId, call, configChanges: () => configChanges,
    setClock: (value: number) => { at = value; },
    close: () => { store.system.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export type RoutingFixture = Awaited<ReturnType<typeof setup>>;
