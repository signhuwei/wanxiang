import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, iso, randomToken } from '../src/credentials';
import { MemoryPresence } from '../src/presence';
import { seedTenant } from '../src/seed';
import { createServer } from '../src/server';

test('relay balances are verified against the configured account before updating eligible wallets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onex-channel-balance-'));
  const inference = 'local-test-inference-only';
  const subToken = 'local-test-management-sub2api';
  const newToken = 'local-test-management-new-api';
  const external = 'https://relay.test';
  const hits: string[] = [];
  let subReply: 'wallet' | 'another_account' | 'unauthorized' | 'key_quota' | 'redirect' = 'wallet';
  let blocker: Promise<void> | undefined;
  let onRequest = () => {};
  let now = Date.now();
  const relay = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    hits.push(path);
    expect(request.method).toBe('GET');
    expect(request.headers.get('Authorization')).not.toContain(inference);
    if (path === '/api/user/self') {
      expect(request.headers.get('New-Api-User')).toBe('23');
      expect(request.headers.get('Authorization')).toBe(newToken);
      return Response.json({ success: true, data: { id: 23, quota: 123_456, token: newToken } });
    }
    if (path !== '/api/v1/user/profile') return new Response(null, { status: 404 });
    expect(request.headers.get('New-Api-User')).toBeNull();
    expect(request.headers.get('Authorization')).toBe(`Bearer ${subToken}`);
    if (blocker) { onRequest(); await blocker; }
    if (subReply === 'unauthorized') return Response.json({ message: subToken }, { status: 403 });
    if (subReply === 'key_quota') return Response.json({ mode: 'unrestricted', remaining: 999, balance: 999 });
    if (subReply === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } });
    return Response.json({ code: 0, data: { id: subReply === 'another_account' ? 64 : 42, balance: '12.5000014', secret: subToken } });
  } });
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    server = await createServer({ hostname: '127.0.0.1', port: 0, dataDir: dir, tenantCacheSize: 2, heartbeatMs: 1000,
      codeSecret: 'test-channel-balance', masterKey: new Uint8Array(32).fill(7), presence: new MemoryPresence(), commit: 'test', now: () => now,
      providerChannelFetch: (target, headers, signal) => {
        expect(target.origin).toBe(external);
        expect(target.search).toBe('');
        return fetch(new URL(target.pathname, relay.url), { headers, signal, redirect: 'manual', proxy: '' });
      },
    });
    const { tenantId, userId } = await seedTenant(server.store, { target: 'balance-admin@example.test', platformAdmin: true });
    const admin = randomToken();
    const tenant = randomToken();
    await server.store.system.write(db => {
      const expires = iso(now + 60 * 60_000);
      for (const [token, scope] of [[admin, null], [tenant, tenantId]] as const) db.run(`INSERT INTO sessions
        (token_hash,user_id,tenant_id,kind,expires_at) VALUES (?,?,?,'web',?)`, [hash(token), userId, scope, expires]);
    });
    async function api(path: string, payload?: object, status = 200, token = admin, key: string = crypto.randomUUID()) {
      const response = await fetch(new URL(`/v1/platform${path}`, server!.server.url), { method: payload ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(payload && { 'Content-Type': 'application/json', 'Idempotency-Key': key }) },
        body: payload && JSON.stringify(payload) });
      const raw = await response.text();
      for (const secret of [inference, subToken, newToken]) expect(raw).not.toContain(secret);
      expect({ status: response.status, body: status === response.status ? null : raw }).toEqual({ status, body: null });
      return JSON.parse(raw) as Record<string, any>;
    }
    async function provider(name: string, base = external) {
      const saved = await api('/providers', { name, base_url: `${base}/v1`, protocol: 'openai_chat', secret: inference }, 201);
      const view = await api(`/providers/${saved.id}/channel`);
      return { provider: saved, base: `/providers/${saved.id}`, account: view.accounts[0].account_id as string,
        path: `/providers/${saved.id}/accounts/${view.accounts[0].account_id}` };
    }

    const sub = await provider('Sub2API');
    const newApi = await provider('New API');
    const unencrypted = await provider('HTTP relay', 'http://relay.test');
    const profilePath = `${sub.path}/balance-profile`;
    const ledgerPath = `${sub.base}/channel-ledger`;
    const input = { expected_profile_revision: 0, adapter: 'sub2api', currency: 'USD', expected_user_id: '42', sync_wallet: true };
    expect(await api(profilePath)).toMatchObject({ profile: null, actions: ['read', 'configure'] });
    await api(profilePath, { ...input, credential: subToken }, 403, tenant);
    expect(await api(profilePath, { ...input, credential: inference }, 409)).toMatchObject({ error: { detail: { reason: 'separate_management_credential_required' } } });
    expect(await api(`${unencrypted.path}/balance-profile`, { ...input, credential: subToken }, 409))
      .toMatchObject({ error: { detail: { reason: 'balance_endpoint_unavailable' } } });
    const saved = await api(profilePath, { ...input, credential: subToken });
    expect(saved).toMatchObject({ profile: { profile_revision: 1, credential_configured: true, credential_usable: true, source_origin: external },
      actions: ['read', 'configure', 'probe_balance', 'clear_balance_profile'] });
    const stored = server.store.system.get<{ credential_ciphertext: Uint8Array }>('SELECT credential_ciphertext FROM provider_balance_profiles WHERE account_id=?', [sub.account])!;
    expect(Buffer.from(stored.credential_ciphertext).toString('utf8')).not.toContain(subToken);
    expect(await api(`${newApi.path}/balance-profile`, { ...input, credential: subToken }, 409)).toMatchObject({ error: { detail: { reason: 'account_wallet_already_bound' } } });
    const reconfigured = await api(profilePath, { ...input, expected_profile_revision: 1 });
    const current = reconfigured.profile.profile_revision as number;
    const probe = (id?: string) => api(`${sub.path}/balance-probes`, { profile_revision: current }, 202, admin, id);

    await api(`${ledgerPath}/observations`, { account_id: sub.account, currency: 'USD', balance_micro: 1_000_000, reference: 'manual', note: '初始余额' }, 201);
    const bookingKey = crypto.randomUUID();
    const verified = await probe(bookingKey);
    expect(verified).toMatchObject({ status: 'ok', scope: 'account_balance', currency: 'USD', amount_micro: 12_500_001,
      wallet_synced: true, source: { adapter: 'sub2api', origin: external } });
    expect((await probe(bookingKey)).id).toBe(verified.id);
    const ledger = await api(ledgerPath);
    expect(ledger.accounts[0].balance_micro).toBe(12_500_001);
    expect(ledger.items).toMatchObject([{ reference: verified.id, source: 'upstream' }, { reference: 'manual', source: 'manual' }]);
    expect(hits).toEqual(['/api/v1/user/profile']);

    const failures = { another_account: 'account_scope_mismatch', unauthorized: 'permission_denied', key_quota: 'schema_mismatch', redirect: 'redirect_denied' } as const;
    for (const state of Object.keys(failures) as (keyof typeof failures)[]) {
      subReply = state;
      expect(await probe()).toMatchObject({ status: 'unknown', reason_code: failures[state], amount_micro: null, wallet_synced: false });
    }
    const observationPath = `${sub.path}/balance-observations`;
    const history = await api(`${observationPath}?limit=2`);
    expect(history).toMatchObject({ latest: { status: 'unknown', reason_code: 'redirect_denied' }, last_success: { id: verified.id, status: 'ok' }, total: 5 });
    expect((await api(`${observationPath}?limit=2&cursor=${history.next_cursor}`)).items).toHaveLength(2);
    expect((await api(ledgerPath)).items).toHaveLength(2);

    const newProfile = { expected_profile_revision: 0, adapter: 'new_api', expected_user_id: '23', currency: 'CNY', quota_per_unit: 500_000,
      sync_wallet: false, credential: newToken };
    await api(`${newApi.path}/balance-profile`, { ...newProfile, sync_wallet: true }, 422);
    await api(`${newApi.path}/balance-profile`, newProfile);
    expect(await api(`${newApi.path}/balance-probes`, { profile_revision: 1 }, 202)).toMatchObject({ status: 'ok', scope: 'account_quota',
      amount_micro: 246_912, quota_units: 123_456, currency: 'CNY', wallet_synced: false, source: { adapter: 'new_api' } });
    expect((await api(`${newApi.base}/channel-ledger`)).accounts[0].balance_micro).toBeNull();

    subReply = 'wallet';
    const requestEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onRequest = requestEntered.resolve;
    blocker = release.promise;
    const pending = probe();
    await requestEntered.promise;
    try {
      await api(`${ledgerPath}/recharges`, { account_id: sub.account, currency: 'USD', amount_micro: 1_000_000, reference: 'new-funds', note: '测试充值' }, 201);
    } finally { release.resolve(); }
    expect(await pending).toMatchObject({ status: 'ok', wallet_synced: false, reason_code: 'wallet_changed' });
    expect((await api(ledgerPath)).accounts[0].balance_micro).toBe(13_500_001);
    blocker = undefined;
    now += 16 * 60_000;
    expect((await api(observationPath)).last_success).toMatchObject({ status: 'stale', reason_code: 'observation_expired' });

    await api(sub.base, { revision: sub.provider.revision, base_url: 'https://rotated.test/v1' });
    expect((await api(profilePath)).profile.credential_usable).toBe(false);
    const sent = hits.length;
    expect(await probe()).toMatchObject({ status: 'unknown', reason_code: 'credential_scope_changed' });
    expect(hits).toHaveLength(sent);
    expect(await api(`${profilePath}/clear`, { expected_profile_revision: current })).toMatchObject({ profile: null });
    const recreated = await api(profilePath, { ...input, credential: subToken });
    expect(recreated.profile.profile_revision).toBeGreaterThan(current);
    expect((await api(observationPath)).last_success).toMatchObject({ status: 'stale', reason_code: 'profile_scope_changed' });
  } finally {
    await server?.close();
    await relay.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
