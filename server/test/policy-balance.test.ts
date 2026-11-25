import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ApiError } from '../src/api';
import { appendLedgerEntry, initialLease, renewLease } from '../src/billing';
import { hash, iso, randomToken } from '../src/credentials';
import { configPublisher } from '../src/edge-config';
import { policyRoutes } from '../src/policy-routes';
import { encryptProviderSecret } from '../src/provider-secret';
import { seedTenant } from '../src/seed';
import { Store } from '../src/store';

test('low-balance transitions publish an authorized floor, retain the final reserved milli, and recover after recharge', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-balance-'));
  const store = new Store(dataDir, 2);
  const at = Date.parse('2026-11-21T00:00:00Z');
  const expiry = '2027-01-01T00:00:00.000Z';
  const masterKey = Buffer.alloc(32, 7);
  const device = 'dev_balance_fixture';
  const member = 'usr_balance_member';
  const memberDevice = 'dev_balance_member';
  const publicKey = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const config = configPublisher(store, dataDir, () => at, masterKey);
  let pending = Promise.resolve();
  try {
    const { tenantId, userId } = await seedTenant(store, { target: 'balance@example.test', platformAdmin: true, now: at });
    const platform = randomToken();
    const owner = randomToken();
    await store.system.write(sql => {
      sql.run(`INSERT INTO sessions (token_hash, user_id, tenant_id, kind, expires_at)
        VALUES (?, ?, NULL, 'web', ?), (?, ?, ?, 'web', ?)`, [hash(platform), userId, expiry, hash(owner), userId, tenantId, expiry]);
      for (const name of ['full', 'floor', 'unpriced']) {
        const provider = `provider_${name}`;
        const model = `model_${name}`;
        sql.run(`INSERT INTO providers (id, name, protocol, base_url, secret_ciphertext, status)
          VALUES (?, ?, 'openai_chat', 'https://provider.invalid/v1', ?, 'active')`,
        [provider, provider, encryptProviderSecret(masterKey, provider, `fixture-${name}`)]);
        sql.run(`INSERT INTO models (id, provider_id, upstream_name, display_name, context_window, status)
          VALUES (?, ?, ?, ?, 2048, 'active')`, [model, provider, name, name]);
        if (name === 'full') sql.run("UPDATE models SET route_model = 'ful*' WHERE id = ?", [model]);
        if (name !== 'unpriced') sql.run(`INSERT INTO rates (model_id, input_milli_per_mtok, output_milli_per_mtok,
          cache_read_milli_per_mtok, cache_write_milli_per_mtok, effective_from) VALUES (?, 1, 1, 1, 1, ?)`, [model, iso(at)]);
      }
    });
    const db = store.tenant(tenantId);
    await db.write(sql => {
      sql.run("INSERT INTO members (user_id, role, status) VALUES (?, 'member', 'active')", [member]);
      for (const [id, user] of [[device, userId], [memberDevice, member]] as const) {
        sql.run(`INSERT INTO devices (id, user_id, name, os, arch, public_key, token_hash, token_expires_at, status)
          VALUES (?, ?, 'Fixture', 'darwin', 'arm64', ?, ?, ?, 'active')`, [id, user, publicKey, hash(randomToken()), expiry]);
      }
      appendLedgerEntry(sql, 'topup', 13, at);
    });

    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof ApiError) return c.json({ error: error.body() }, error.status);
      throw error;
    });
    policyRoutes(app, store, {
      codeSecret: 'fixture-only', now: () => at, dataDir,
      onConfigChange: id => { pending = config.changed(id); },
      onBalanceChange: id => { pending = config.balanceChanged(id); },
    });
    const send = (path: string, token: string, body: unknown, key: string, method = 'POST') => app.request(path, {
      method, body: JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    });
    for (const [adapter, title, schema, merge, defaultValue] of [
      ['balance.warn', '预警余额', { kind: 'money_milli', min: 0 }, 'min', 0],
      ['balance.restrict', '限模余额', { kind: 'money_milli', min: 0 }, 'min', 0],
      ['balance.fallback_models', '低成本模型', { kind: 'resource_set', catalog: 'models' }, 'intersection', []],
    ] as const) {
      expect((await send('/v1/platform/policy/definitions', platform, { id: `fixture.${adapter}`, expected_version: 0,
        title, description: '', category: 'limits', schema, scopes: ['tenant'], merge,
        default_value: defaultValue, binding: { adapter, abi: 1 },
      }, adapter)).status).toBe(201);
    }
    const contract = `/v1/platform/policy/contracts/${tenantId}`;
    const term = (id: string, adjustment: number | string[]) => ({ clause_ref: { id, version: 1 }, template_ref: null, adjustment });
    const signature = (warn: number) => ({
      expected_platform_revision: 0, expected_policy_revision: 0, base_revision: null, reason: '低余额策略',
      entries: [term('access.models', ['model_full', 'model_floor', 'model_unpriced']), term('lease.budget', 1),
        term('fixture.balance.warn', warn), term('fixture.balance.restrict', 10), term('fixture.balance.fallback_models', ['model_floor'])],
    });
    expect((await send(contract + '/preview', platform, signature(9), 'bad-sign')).status).toBe(422);
    expect((await send(contract + '/signatures', platform, signature(11), 'sign')).status).toBe(201);
    await pending;

    const overrides = (clause: string, value: number | string[]) => ({
      expected_platform_revision: 1, expected_policy_revision: 1, template_ref: null,
      selections: [{ clause_ref: { id: clause, version: 1 }, value }],
    });
    const tenantConfig = `/v1/policy/configurations/tenant/${tenantId}`;
    expect((await send(tenantConfig + '/preview', owner, overrides('fixture.balance.warn', 9), 'bad-tenant')).status).toBe(422);
    const memberConfig = `/v1/policy/configurations/member/${member}`;
    expect((await send(memberConfig, owner, overrides('access.models', ['model_full']), 'member-conf', 'PUT')).status).toBe(200);
    await pending;

    const live = () => true;
    const frames: Record<string, unknown>[] = [];
    const memberFrames: Record<string, unknown>[] = [];
    for (const [id, sink] of [[device, frames], [memberDevice, memberFrames]] as const) {
      await config.connect(id, { tenant: tenantId, agentCache: true, supportsCapabilityContract: true, supportsCapabilityPolicy: true,
        live, send: frame => { if (frame.type === 'config') sink.push(frame); } });
    }
    type Snapshot = { routes: { model_id: string }[]; rates: { model_id: string }[]; policy: {
      policy_revision: number; balance: { mode: string; aliases: { model: string; protocol: string }[] };
      secrets: { provider_id: string }[]; notices: { id: string; kind: string }[];
    } };
    const snapshot = () => frames.at(-1)! as unknown as Snapshot;
    expect(snapshot().policy.balance.mode).toBe('normal');
    expect(snapshot().routes.map(route => route.model_id)).toEqual(['model_floor', 'model_full']);
    const policyRevision = snapshot().policy.policy_revision;

    let reply = await initialLease(store, tenantId, device, userId, at, live, true, true);
    await config.balanceChanged(tenantId);
    expect(frames).toHaveLength(1);
    async function consume(seq: number) {
      if (reply.type !== 'lease') throw new Error('Expected an active lease');
      expect(reply.budget_milli).toBe(1);
      reply = await renewLease(store, tenantId, device, userId, at, live, reply.lease_id, 1, `usage-${seq}`, true, true);
      await Promise.all([config.balanceChanged(tenantId), config.balanceChanged(tenantId)]);
    }
    await consume(1);
    expect(snapshot().policy.balance.mode).toBe('warn');
    expect(snapshot().routes.map(route => route.model_id)).toEqual(['model_floor', 'model_full']);
    await consume(2);
    expect(snapshot().policy.balance).toEqual({ mode: 'restricted', aliases: [
      { model: 'floor', protocol: 'openai_chat' }, { model: 'ful*', protocol: 'openai_chat' },
      { model: 'full', protocol: 'openai_chat' },
    ] });
    expect(snapshot().routes.map(route => route.model_id)).toEqual(['model_floor']);
    expect(snapshot().rates.map(rate => rate.model_id)).toEqual(['model_floor']);
    expect(snapshot().policy.secrets.map(secret => secret.provider_id)).toEqual(['provider_floor']);
    expect(memberFrames.at(-1)).toMatchObject({ routes: [], rates: [], policy: { secrets: [], balance: { mode: 'restricted', aliases: [] } } });
    expect(await initialLease(store, tenantId, memberDevice, member, at, live, true, true)).toMatchObject({ type: 'cutoff', reason: 'contract' });
    for (let seq = 3; seq < 13; seq++) await consume(seq);
    expect(frames).toHaveLength(3);
    expect(reply.type).toBe('lease');
    await consume(13);
    expect(reply).toMatchObject({ type: 'cutoff', reason: 'balance' });
    expect(snapshot()).toMatchObject({ routes: [], rates: [], policy: { secrets: [], balance: { mode: 'stopped', aliases: [] } } });

    expect((await send(contract + '/recharges', platform, { amount_milli: 13 }, 'recharge')).status).toBe(201);
    await pending;
    expect((await send(contract + '/recharges', platform, { amount_milli: 13 }, 'recharge')).status).toBe(201);
    await pending;
    expect(frames).toHaveLength(5);
    expect(snapshot().policy.balance.mode).toBe('normal');
    expect(snapshot().policy.policy_revision).toBe(policyRevision);
    expect(snapshot().routes.map(route => route.model_id)).toEqual(['model_floor', 'model_full']);
    expect(snapshot().policy.notices.filter(notice => notice.id.startsWith('pbl_')).map(notice => notice.kind)).toEqual([
      'balance_warning', 'balance_restricted', 'balance_stopped', 'balance_restored',
    ]);
  } finally {
    await pending;
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
