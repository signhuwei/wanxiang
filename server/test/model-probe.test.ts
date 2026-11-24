import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postModelProbeOverHttp } from '../src/channel-catalog-upstream';
import { hash, iso, randomToken } from '../src/credentials';
import { MemoryPresence } from '../src/presence';
import { seedTenant } from '../src/seed';
import { createServer } from '../src/server';

test('paid probe transport rejects loopback and cloud metadata without sending credentials', async () => {
  for (const target of ['http://127.0.0.1/v1/responses', 'http://169.254.169.254/', 'http://[::1]/']) {
    await expect(postModelProbeOverHttp(new URL(target), new Headers({ Authorization: 'Bearer fixture-only' }),
      AbortSignal.timeout(1000), '{}')).rejects.toThrow('destination_denied');
  }
});

test('channel inference tests reserve, charge and replay under one administrator quota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onex-model-probe-'));
  const upstream = 'https://probe-relay.example.test';
  const secret = 'fixture-upstream-inference-secret';
  let calls = 0;
  let noThinkingCalls = 0;
  let blocked: Promise<void> | null = null;
  let arrived = () => {};
  let release = () => {};
  let status = 200;
  let mode: 'text' | 'no_text' | 'no_usage' | 'too_many_tokens' | 'model_mismatch' = 'text';
  let now = Date.parse('2026-11-24T14:00:00Z');

  const relay = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/v1/models') return Response.json({ data: [{ id: 'native/model-001', context_window: 9999 }] });
    calls++;
    expect(request.method).toBe('POST');
    expect(request.headers.get(path === '/v1/messages' ? 'x-api-key' : 'Authorization')).toBe(path === '/v1/messages' ? secret : 'Bearer ' + secret);
    const input = await request.json() as Record<string, unknown>;
    expect(input).toMatchObject({ model: 'native/model-001', stream: false });
    if (path === '/v1/responses') expect(input).toMatchObject({ max_output_tokens: 16, store: false, input: 'Reply OK.' });
    else {
      expect(['/v1/chat/completions', '/v1/messages']).toContain(path);
      expect(input).toMatchObject({ max_tokens: 16, messages: [{ role: 'user', content: 'Reply OK.' }] });
    }
    expect(input.tools).toBeUndefined();
    const noThinking = input.chat_template_kwargs !== undefined;
    if (noThinking) {
      expect(path).toBe('/v1/chat/completions');
      expect(input.chat_template_kwargs).toEqual({ enable_thinking: false });
      noThinkingCalls++;
    }
    arrived();
    if (blocked) await blocked;
    if (status !== 200) return Response.json({ error: secret }, { status });
    const output = mode === 'no_text' && !noThinking ? '' : 'OK';
    const tokens = mode === 'too_many_tokens' ? 400 : 10;
    let body;
    if (path === '/v1/messages') body = {
      content: [{ type: 'text', text: output }],
      usage: { input_tokens: tokens, output_tokens: 3, cache_read_input_tokens: 2 },
    };
    else if (path === '/v1/responses') body = {
      output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }],
      usage: { input_tokens: tokens, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } },
    };
    else body = {
      choices: [{ message: { content: output } }],
      usage: { prompt_tokens: tokens, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } },
    };
    return Response.json(mode === 'no_usage' ? { ...body, usage: null }
      : mode === 'model_mismatch' ? { ...body, model: 'other/model-001' } : body);
  } });

  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const fetchFixture = (target: URL, headers: Headers, signal: AbortSignal, body?: string) => {
      expect(target.origin).toBe(upstream);
      return fetch(new URL(target.pathname, relay.url), {
        method: body === undefined ? 'GET' : 'POST', body, headers, signal, proxy: '', redirect: 'manual',
      });
    };
    app = await createServer({ hostname: '127.0.0.1', port: 0, dataDir: dir, tenantCacheSize: 2, heartbeatMs: 1000,
      codeSecret: 'test-model-probe', masterKey: new Uint8Array(32).fill(7), presence: new MemoryPresence(), commit: 'test', now: () => now,
      providerChannelFetch: fetchFixture, providerModelProbeFetch: fetchFixture,
    });
    const { tenantId, userId } = await seedTenant(app.store, { target: 'probe-admin@example.test', platformAdmin: true });
    const { userId: secondId } = await seedTenant(app.store, { target: 'probe-admin2@example.test', platformAdmin: true });
    const admin = randomToken(), tenant = randomToken(), second = randomToken();
    await app.store.system.write(db => {
      for (const [token, user, scope] of [[admin, userId, null], [tenant, userId, tenantId], [second, secondId, null]]) {
        db.run("INSERT INTO sessions(token_hash,user_id,tenant_id,kind,expires_at) VALUES (?,?,?,'web',?)",
          [hash(token!), user, scope, iso(now + 60 * 60_000)]);
      }
    });
    const before = app.store.tenant(tenantId).get<{ n: number }>('SELECT count(*) n FROM ledger')!.n;
    async function api(path: string, data?: object, code = 200, token = admin, key = crypto.randomUUID() as string) {
      const response = await fetch(new URL('/v1/platform' + path, app!.server.url), {
        method: data ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, ...(data && { 'Content-Type': 'application/json', 'Idempotency-Key': key }) },
        body: data && JSON.stringify(data),
      });
      const raw = await response.text();
      expect(raw).not.toContain(secret);
      expect({ status: response.status, body: response.status === code ? null : raw }).toEqual({ status: code, body: null });
      return JSON.parse(raw) as Record<string, any>;
    }
    async function discover(provider: Record<string, any>) {
      const job = await api(`/providers/${provider.id}/discoveries`, { revision: provider.revision }, 202);
      const results = await api(`/probe-jobs/${job.id}/results`);
      return { path: `/probe-jobs/${job.id}/model-tests`, item: results.items[0].catalog_item_id as string };
    }
    const provider = await api('/providers', { name: 'Probe Chat', protocol: 'openai_chat', base_url: upstream + '/v1', secret }, 201);
    const { path, item } = await discover(provider);
    const payload = { catalog_item_id: item, test_tariff: {
      input_milli_per_mtok: 1_000_000, output_milli_per_mtok: 2_000_000, source_reference: 'fixture verified test tariff',
    } };
    await api(path, payload, 403, tenant);
    expect(await api(path, { catalog_item_id: item }, 409)).toMatchObject({ error: { detail: { reason: 'model_test_price_required' } } });
    expect(await api(path, payload, 409)).toMatchObject({ error: { detail: { reason: 'model_test_quota_required' } } });
    expect(calls).toBe(0);
    const budget = { expected_revision: 0, limit_milli: 1_000, reason: 'fixture budget' };
    await api('/model-test-quotas/' + userId, budget);
    await api('/model-test-quotas/' + secondId, budget);
    expect((await api('/model-test-quotas?q=' + userId)).items).toMatchObject([{ user_id: userId, self: true }]);
    expect(await api(path + '?catalog_item_id=' + item)).toMatchObject({ actions: ['read', 'run_model_test'], requires_tariff: true,
      output_token_limit: 16, test_modes: ['default', 'chat_template_no_thinking'] });

    const key = 'one-paid-call';
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    blocked = new Promise<void>(resolve => { release = resolve; });
    const initial = api(path, payload, 202, admin, key);
    await ready;
    expect(await api(path, payload, 202, admin, key)).toMatchObject({ status: 'running', charged_milli: null });
    const quotas = (await api('/model-test-quotas')).items;
    expect(quotas.find((row: { user_id: string }) => row.user_id === userId)).toMatchObject({ reserved_milli: 288, spent_milli: 0, available_milli: 712 });
    expect(quotas.find((row: { user_id: string }) => row.user_id === secondId)).toMatchObject({ reserved_milli: 0, spent_milli: 0, available_milli: 1000 });
    expect(await api('/model-test-quotas/' + userId, { ...budget, expected_revision: 1, limit_milli: 287 }, 409))
      .toMatchObject({ error: { detail: { reason: 'model_test_quota_below_usage' } } });
    expect(await api(path, payload, 409)).toMatchObject({ error: { detail: { reason: 'model_test_in_progress' } } });
    release();
    blocked = null;
    const completed = await initial;
    expect(completed).toMatchObject({ status: 'succeeded', actor_id: userId, test_mode: 'default', charged_milli: 16, raw_model: 'native/model-001',
      usage: { input_tokens: 8, cache_read_tokens: 2, output_tokens: 3 }, tariff: { ...payload.test_tariff, source: 'manual' } });
    expect(await api(path, payload, 202, admin, key)).toEqual(completed);
    expect(await api(path, { ...payload, test_mode: 'default' }, 202, admin, key)).toEqual(completed);
    expect(await api(path, { ...payload, test_tariff: { ...payload.test_tariff, output_milli_per_mtok: 20 } }, 409, admin, key))
      .toMatchObject({ error: { detail: { reason: 'idempotency_mismatch' } } });
    expect(calls).toBe(1);

    status = 429;
    expect(await api(path, payload, 202)).toMatchObject({ status: 'failed', charged_milli: 0, reason_code: 'upstream_rate_limited' });
    status = 200;
    mode = 'no_text';
    expect(await api(path, payload, 202)).toMatchObject({ status: 'failed', charged_milli: 16, reason_code: 'no_text_returned' });
    mode = 'no_usage';
    const pending = await api(path, payload, 202);
    expect(pending).toMatchObject({ status: 'pending_reconciliation', charged_milli: null, reason_code: 'usage_unavailable' });
    mode = 'too_many_tokens';
    expect(await api(path, payload, 202)).toMatchObject({ status: 'pending_reconciliation', charged_milli: null, reason_code: 'usage_outside_limit' });
    expect((await api('/model-test-quotas')).items.find((row: { user_id: string }) => row.user_id === userId))
      .toMatchObject({ reserved_milli: 576, spent_milli: 32, available_milli: 392 });
    const resolvePath = path + '/' + pending.id + '/reconcile';
    const reconciliation = { charged_milli: 5, reason: 'verified fixture debit', evidence_reference: 'fixture ledger receipt' };
    expect(await api(resolvePath, { ...reconciliation, charged_milli: 289 }, 409))
      .toMatchObject({ error: { detail: { reason: 'cost_outside_reservation' } } });
    const resolved = await api(resolvePath, reconciliation, 200, second, 'reconcile-first');
    expect(resolved).toMatchObject({ status: 'failed', reason_code: 'reconciled_manually', charged_milli: 5, actions: ['read'],
      reconciliation: { actor_id: secondId, evidence_reference: reconciliation.evidence_reference } });
    expect(await api(resolvePath, reconciliation, 200, second, 'reconcile-first')).toEqual(resolved);
    expect(await api(resolvePath, reconciliation, 409)).toMatchObject({ error: { detail: { reason: 'model_test_not_pending_reconciliation' } } });
    expect((await api('/model-test-quotas')).items.find((row: { user_id: string }) => row.user_id === userId))
      .toMatchObject({ reserved_milli: 288, spent_milli: 37, available_milli: 675 });
    expect(await api('/model-test-quotas/' + userId + '/tests?period=2026-11')).toMatchObject({ total: 5, period: '2026-11' });
    expect(await api('/model-test-quotas/' + secondId + '/tests?period=2026-11')).toMatchObject({ total: 0 });
    expect(app.store.tenant(tenantId).get<{ n: number }>('SELECT count(*) n FROM ledger')!.n).toBe(before);

    now += 1000;
    const renewed = await discover(provider);
    expect(renewed.item).toBe(item);
    expect((await api(renewed.path + '?catalog_item_id=' + item)).items).toHaveLength(5);
    expect(await api(path, payload, 409)).toMatchObject({ error: { detail: { reason: 'model_test_requires_current_catalogue' } } });
    mode = 'model_mismatch';
    expect(await api(renewed.path, payload, 202)).toMatchObject({ status: 'failed', charged_milli: 16, reason_code: 'upstream_model_mismatch' });
    mode = 'text';
    for (const [protocol, cost] of [['openai_responses', 16], ['anthropic', 18]] as const) {
      const source = await api('/providers', { name: protocol, protocol, base_url: upstream + '/v1', secret }, 201);
      const target = await discover(source);
      expect(await api(target.path + '?catalog_item_id=' + target.item, undefined, 200, second)).toMatchObject({ test_modes: ['default'] });
      expect(await api(target.path, { ...payload, catalog_item_id: target.item, test_mode: 'chat_template_no_thinking' }, 409, second))
        .toMatchObject({ error: { detail: { reason: 'model_test_mode_unsupported' } } });
      expect(await api(target.path, { ...payload, catalog_item_id: target.item }, 202, second))
        .toMatchObject({ status: 'succeeded', charged_milli: cost, actor_id: secondId, test_mode: 'default' });
    }
    expect(calls).toBe(8);
    expect(noThinkingCalls).toBe(0);
    mode = 'no_text';
    const explicit = { ...payload, test_mode: 'chat_template_no_thinking' };
    const chosen = await api(renewed.path, explicit, 202, admin, 'opt-in-no-thinking');
    expect(chosen).toMatchObject({ status: 'succeeded', test_mode: explicit.test_mode, charged_milli: 16 });
    expect(await api(renewed.path, explicit, 202, admin, 'opt-in-no-thinking')).toEqual(chosen);
    expect(await api(renewed.path, payload, 409, admin, 'opt-in-no-thinking'))
      .toMatchObject({ error: { detail: { reason: 'idempotency_mismatch' } } });
    expect(await api(renewed.path, { ...payload, test_mode: 'other' }, 422)).toMatchObject({ error: { detail: { fields: ['test_mode'] } } });
    expect((await api(renewed.path + '?catalog_item_id=' + item)).items).toContainEqual(chosen);
    const audit = app.store.system.all<{ detail_json: string }>('SELECT detail_json FROM platform_audit WHERE target=? AND action IN (?,?)',
      [chosen.id, 'model_test.reserve', 'model_test.finish']);
    expect(audit.map(row => JSON.parse(row.detail_json).test_mode)).toEqual([explicit.test_mode, explicit.test_mode]);
    expect(calls).toBe(9);
    expect(noThinkingCalls).toBe(1);
  } finally {
    release();
    await app?.close();
    await relay.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
