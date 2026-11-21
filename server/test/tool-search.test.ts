import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ApiError } from '../src/api';
import { authRoutes } from '../src/auth';
import { balance, initialLease } from '../src/billing';
import { commerceRoutes } from '../src/commerce';
import { hash, iso, randomToken } from '../src/credentials';
import { configPublisher } from '../src/edge-config';
import { eventItems, ingestEvents } from '../src/ingest';
import { policyRoutes } from '../src/policy-routes';
import { seedTenant } from '../src/seed';
import { Store } from '../src/store';
import { toolReleaseRoutes } from '../src/tool-releases';
import { runHttpSearch, searchResults } from '../src/tool-search-upstream';

test('registered device HTTP search uses a signed price, one upstream call and one monthly package debit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onex-tool-search-'));
  const store = new Store(dir, 2);
  const secret = randomToken();
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const entered = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const calls: string[] = [];
  const upstream = Bun.serve({
    port: 0, hostname: '127.0.0.1', async fetch(req) {
      if (req.headers.get('Authorization') !== 'Bearer ' + secret) return new Response(null, { status: 401 });
      const { query } = await req.json() as { query: string };
      calls.push(query);
      entered.get(query)?.resolve();
      await pending.get(query)?.promise;
      if (query === 'upstream-error') return new Response(null, { status: 502 });
      if (query === 'invalid-upstream') return Response.json({ results: [{ url: 'javascript:fail' }] });
      return Response.json({ results: query === 'empty' ? [] : [{ url: 'https://example.test/', title: '知识条目', snippet: '可用摘要' }] });
    },
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: error.body() }, error.status);
    throw error;
  });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch });
  let at = Date.parse('2026-11-21T12:00:00Z');
  let notifications = 0;
  try {
    const { tenantId, userId } = await seedTenant(store, { target: 'search@example.test', platformAdmin: true, now: at });
    const platform = randomToken(), owner = randomToken();
    await store.system.write(sql => {
      sql.run("INSERT INTO sessions(token_hash,user_id,tenant_id,kind,expires_at) VALUES(?,?,NULL,'web',?),(?,?,?,'web',?)",
        [hash(platform), userId, iso(at + 3600000), hash(owner), userId, tenantId, iso(at + 3600000)]);
      sql.run("INSERT INTO providers(id,name,protocol,base_url,secret_ciphertext,status) VALUES('pv','P','openai_chat','https://example.invalid',?,'active')", [new Uint8Array(0)]);
      sql.run("INSERT INTO models(id,provider_id,upstream_name,display_name,context_window,status) VALUES('model','pv','test','test',8192,'active')");
    });
    const opts = { dataDir: dir, now: () => at, masterKey: Buffer.alloc(32, 5), codeSecret: 'test-only', onBalanceChange: () => { notifications++; } };
    authRoutes(app, store, opts);
    policyRoutes(app, store, opts);
    commerceRoutes(app, store, opts);
    toolReleaseRoutes(app, store, opts, async (target, input) => {
      expect(target.endpoint).toBe('https://127.0.0.1/search');
      expect(target.publicNetwork).toBeFalse();
      const response = await fetch(upstream.url, { method: 'POST', headers: { Authorization: 'Bearer ' + target.secret }, body: JSON.stringify(input) });
      if (!response.ok) throw Error('fixture unavailable');
      return searchResults(await response.json(), input.limit);
    });

    function request(path: string, actor: string, body?: unknown, key = randomToken()) {
      return fetch(new URL('/v1' + path, server.url), {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + actor, 'Idempotency-Key': key,
          'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function ok<T>(path: string, actor: string, body?: unknown): Promise<T> {
      const result = await request(path, actor, body);
      if (!result.ok) throw new Error(path + ' ' + result.status + ' ' + (await result.text()));
      return await result.json() as T;
    }
    const data = { name: 'search', version: '1', kind: 'http_search', agents: ['codex'], endpoint: 'https://127.0.0.1/search', secret };
    const draft = await ok<{ id: string; revision: number; actions: string[] }>('/platform/tool-releases', platform, data);
    expect(draft.actions).toContain('publish');
    expect(draft.actions).not.toContain('upload');
    expect(JSON.stringify(draft)).not.toContain(secret);
    expect((await request('/platform/tool-releases', platform, { ...data, endpoint: 'http://127.0.0.1/search' })).status).toBe(422);
    const toolPath = '/platform/tool-releases/' + draft.id;
    const release = await ok<{ id: string; revision: number }>(toolPath + '/publish', platform, { revision: draft.revision });
    const noPrice = await ok<{ id: string; revision: number }>('/platform/tool-releases', platform,
      { ...data, name: 'unpriced' });
    await ok('/platform/tool-releases/' + noPrice.id + '/publish', platform, { revision: noPrice.revision });
    const plan = await ok<{ id: string }>('/platform/commerce/plans', platform, {
      name: '搜索计费', expected_version: 0, terms: { monthly_grant_milli: 10_000, tool_prices: [{ release_id: release.id, per_call_milli: 75 }] },
    });
    const term = (id: string, adjustment: unknown) => ({ template_ref: null, clause_ref: { id, version: 1 }, adjustment });
    await ok('/platform/policy/contracts/' + tenantId + '/signatures', platform, {
      expected_platform_revision: 0, expected_policy_revision: 0, base_revision: null, reason: '测试搜索',
      entries: [term('access.models', ['model']), term('access.agents', ['codex']), term('access.tools', [release.id, noPrice.id]),
        term('lease.budget', 500), term('network.public', false), term('billing.plan', [plan.id])],
    });
    const register = () => ok<{ device_id: string; device_token: string }>('/devices', owner, { name: '测试设备', os: 'darwin', arch: 'arm64' });
    const device = await register();
    const other = await register();
    const db = store.tenant(tenantId);
    const frames: Record<string, unknown>[] = [];
    const publisher = configPublisher(store, dir, opts.now, opts.masterKey);
    await publisher.connect(device.device_id, { tenant: tenantId, agentCache: true, supportsCapabilityContract: true,
      supportsCapabilityPolicy: true, supportsPolicyRuntime: true, live: () => true, send: frame => { frames.push(frame); } });
    expect(frames[0]).toMatchObject({ tools: [], policy: { search_tools: [{ id: release.id, name: 'search', agents: ['codex'] }] } });
    expect(JSON.stringify(frames)).not.toContain(data.endpoint);
    expect(JSON.stringify(frames)).not.toContain(secret);
    expect(JSON.stringify((frames[0]?.policy as { search_tools?: unknown }).search_tools)).not.toContain(noPrice.id);
    const firstLease = await initialLease(store, tenantId, device.device_id, userId, at, () => true, true, true);
    expect(firstLease.type).toBe('lease');
    const search = (key: string, query: string, actor = device.device_token) =>
      request('/edge/tool-search/' + release.id, actor, { session_id: 'search-session', query, limit: 2 }, key);
    expect((await search('not-registered', 'use after registration')).status).toBe(404);
    await ingestEvents(store, tenantId, device.device_id, userId, at, () => true,
      eventItems([{ seq: 1, session_id: 'search-session', kind: 'session_start', at: iso(at), payload: { agent: 'codex' } }]), () => {});
    expect((await search('bad-device', 'use after registration', other.device_token)).status).toBe(404);
    expect((await request('/edge/tool-artifacts/' + release.id, device.device_token)).status).toBe(404);
    expect(calls).toEqual([]);

    const baseline = balance(db, at);
    const query = 'test query content not saved';
    entered.set(query, Promise.withResolvers<void>());
    pending.set(query, Promise.withResolvers<void>());
    const result = search('one', query);
    await entered.get(query)!.promise;
    expect(balance(db, at).reserved_milli).toBe(baseline.reserved_milli + 75);
    expect(balance(db, at).balance_milli).toBe(baseline.balance_milli - 75);
    expect((await search('one', query)).status).toBe(202);
    expect((await search('one', 'changed query')).status).toBe(409);
    pending.get(query)!.resolve();

    const first = await result;
    expect(first.status).toBe(200);
    const reply = await first.json() as { receipt: object; results: unknown[] };
    expect(reply).toMatchObject({ receipt: { release_id: release.id, session_id: 'search-session',
      fee_milli: 75, package_used_milli: 75, status: 'charged' }, results: [{ title: '知识条目' }] });
    expect(await (await search('one', query)).json()).toEqual({ receipt: reply.receipt });
    expect(calls).toEqual([query]);
    expect(JSON.stringify(db.all('SELECT * FROM commerce_tool_calls'))).not.toContain(query);
    expect(JSON.stringify(db.all('SELECT * FROM ledger'))).not.toContain('知识条目');

    for (const probe of ['upstream-error', 'invalid-upstream']) {
      expect((await search(probe, probe)).status).toBe(502);
      expect((await search(probe, probe)).status).toBe(502);
      expect(calls.filter(q => q === probe)).toHaveLength(1);
    }
    expect(balance(db, at).reserved_milli).toBe(baseline.reserved_milli);
    expect(balance(db, at).month_used_milli).toBe(75);
    expect((await search('empty', 'empty')).status).toBe(200);
    expect(balance(db, at).month_used_milli).toBe(150);

    entered.set('uncertain', Promise.withResolvers<void>());
    pending.set('uncertain', Promise.withResolvers<void>());
    const uncertain = search('uncertain', 'uncertain');
    await entered.get('uncertain')!.promise;
    at += 31_000;
    expect(balance(db, at).reserved_milli).toBe(baseline.reserved_milli);
    const lost = await search('uncertain', 'uncertain');
    expect(lost.status).toBe(502);
    expect(await lost.json()).toMatchObject({ receipt: { status: 'failed', outcome: 'upstream_unconfirmed' } });
    pending.get('uncertain')!.resolve();
    expect((await uncertain).status).toBe(502);
    expect(calls.filter(q => q === 'uncertain')).toHaveLength(1);
    expect(db.get("SELECT count(*) n FROM ledger WHERE kind='settle'")).toEqual({ n: 2 });
    expect(notifications).toBe(2);

    await ingestEvents(store, tenantId, device.device_id, userId, at, () => true,
      eventItems([{ seq: 2, session_id: 'search-session', kind: 'session_end', at: iso(at), payload: {} }]), () => {});
    expect((await search('closed', 'closed')).status).toBe(404);
    expect(await (await search('one', query)).json()).toEqual({ receipt: reply.receipt });
    expect(calls).not.toContain('closed');
  } finally {
    for (const item of pending.values()) item.resolve();
    server.stop(true);
    upstream.stop(true);
    await store.drain();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test('private-network tool search rejects a public address before dialing', async () => {
  await expect(runHttpSearch({ endpoint: 'https://1.1.1.1/search', secret: 'unused', publicNetwork: false },
    { query: 'unused', limit: 1 })).rejects.toThrow('search egress denied');
});
