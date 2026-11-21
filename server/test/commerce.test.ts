import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { Store } from '../src/store';
import { seedTenant } from '../src/seed';
import { ApiError } from '../src/api';
import { hash, iso, randomToken } from '../src/credentials';
import { appendLedgerEntry, balance, initialLease, renewLease } from '../src/billing';
import { commerceRoutes, commerceRates } from '../src/commerce';
import { type Plan, type tierTable } from '../src/commerce-data';
import { policyRoutes } from '../src/policy-routes';
import { policyDiscountRoutes, settleUnclosedDiscountMonths } from '../src/policy-discounts';
import { eventItems, ingestEvents } from '../src/ingest';

test('signed pricing, package funding, model allowances, negotiated rates, completed MCP and month close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onex-commerce-')), store = new Store(dir, 2);
  let at = Date.parse('2026-11-05T12:00:00Z');
  try {
    const { tenantId, userId } = await seedTenant(store, { target: 'sales@example.test', platformAdmin: true, now: at });
    const token = randomToken(), owner = randomToken(), exp = '2027-05-01T00:00:00.000Z';
    const tool = 'tool_01M7WTAQK4C81842QVN6XQACSA';
    await store.system.write(sql => {
      sql.run("INSERT INTO sessions (token_hash,user_id,tenant_id,kind,expires_at) VALUES (?,?,NULL,'web',?),(?,?,?,'web',?)", [hash(token), userId, exp, hash(owner), userId, tenantId, exp]);
      sql.run("INSERT INTO providers(id,name,protocol,base_url,secret_ciphertext,status) VALUES('pv','P','openai_chat','https://example.invalid',?,'active')", [new Uint8Array(0)]);
      for (const [model, rate] of [['m1', 1000], ['m2', 5000]] as const) {
        sql.run("INSERT INTO models(id,provider_id,upstream_name,display_name,context_window,status) VALUES(?,'pv',?,?,4096,'active')", [model, model, model]);
        sql.run('INSERT INTO rates VALUES(?,1000,?,0,0,?,1)', [model, rate, iso(at)]);
      }
      sql.run(`INSERT INTO tool_releases(id,name,version,kind,agents_json,os,arch,entrypoint,args_json,sha256,size,status,revision,created_at)
        VALUES(?,'search','1.0','mcp','["codex"]','macos','arm64','bin/search','[]',?,1,'published',1,?)`, [tool, '0'.repeat(64), iso(at)]);
    });
    const db = store.tenant(tenantId);
    await db.write(sql => {
      for (const d of ['one', 'two']) sql.run("INSERT INTO devices(id,user_id,name,os,arch,public_key,token_hash,token_expires_at,status) VALUES(?,?,'Desk','darwin','arm64','test',?,?,'active')", [d, userId, hash(randomToken()), exp]);
      appendLedgerEntry(sql, 'topup', 1000, at);
    });
    const app = new Hono(), opts = { codeSecret: 'test', now: () => at, dataDir: dir };
    app.onError((err, c) => { if (err instanceof ApiError) return c.json(err.body(), err.status); throw err; });
    commerceRoutes(app, store, opts); policyRoutes(app, store, opts); policyDiscountRoutes(app, store, opts);
    type Account = { tool_calls: Array<{ native_id: string; status: string; fee_milli: number }>; model_budgets: Array<{ monthly_milli: number; used: number; reserved: number }>; packages: unknown[] };
    async function request<T = unknown>(path: string, body?: unknown, method = 'POST', actor = token, key = randomToken()) {
      const res = await app.request('/v1' + path, { method: body === undefined ? 'GET' : method, headers: { Authorization: 'Bearer ' + actor, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json(); if (!res.ok) throw Error(res.status + ' ' + JSON.stringify(data)); return data as T;
    }
    const terms = {
      monthly_grant_milli: 200, monthly_fee_fen: 123, tiers: [{ from_milli: 10, ratio_ppm: 500000 }], commitment: { up_to_milli: 20, ratio_ppm: 500000 },
      model_prices: [{ model_id: 'm2', input_milli_per_mtok: 100, output_milli_per_mtok: 3000, cache_read_milli_per_mtok: 7, cache_write_milli_per_mtok: 13 }],
      model_budgets: [{ model_id: 'm2', monthly_milli: 40 }], tool_prices: [{ release_id: tool, per_call_milli: 5 }]
    };
    await expect(request('/platform/commerce/plans', { name: 'invalid', expected_version: 0, terms: { tool_prices: [{ release_id: tool, per_call_milli: -1 }] } })).rejects.toThrow('422');
    const body = { name: '团队', expected_version: 0, terms }, plan = await request<Plan>('/platform/commerce/plans', body, 'POST', token, 'publish');
    expect(await request('/platform/commerce/plans', body, 'POST', token, 'publish')).toEqual(plan);
    const tiers = await request<ReturnType<typeof tierTable>>('/platform/commerce/model-tiers', { expected_revision: 0, floor_model_id: 'm1', models: [{ model_id: 'm1', tier: 'floor' }, { model_id: 'm2', tier: 'pro' }] }, 'PUT');
    expect(tiers.models[1].display_multiplier).toBe(5);
    const term = (id: string, adjustment: unknown) => ({ template_ref: null, clause_ref: { id, version: 1 }, adjustment });
    await request('/platform/policy/contracts/' + tenantId + '/signatures', {
      expected_platform_revision: 0, expected_policy_revision: 0, base_revision: null, reason: 'commercial',
      entries: [term('access.models', ['m1', 'm2']), term('access.agents', ['codex']), term('access.tools', [tool]), term('session.retention_days', 1), term('lease.budget', 30), term('billing.plan', [plan.id])]
    });
    const account = () => request<Account>('/commerce/account', undefined, 'GET', owner);
    expect(await account()).toMatchObject({ permanent_available_milli: 1000, package_available_milli: 200, tiers: { models: [{ display_multiplier: 1 }, { display_multiplier: 3 }] } });
    expect(commerceRates(store, { commerce_plan_id: plan.id }, [{ model_id: 'm2', output_milli_per_mtok: 5000 }])[0]).toMatchObject(terms.model_prices[0]!);
    const first = await initialLease(store, tenantId, 'one', userId, at, () => true, true, true);
    const other = await initialLease(store, tenantId, 'two', userId, at, () => true, true, true);
    expect(first).toMatchObject({ commerce_plan_id: plan.id, model_budgets: { m2: 30 }, budget_milli: 30 });
    expect(other).toMatchObject({ model_budgets: { m2: 10 } });
    if (first.type !== 'lease') throw Error('missing lease');
    const atCall = iso(at + 1000);
    const event = (seq: number, kind: string, payload: Record<string, unknown>) => ({ seq, kind, session_id: 'sess', at: atCall, payload });
    at += 2000;
    await ingestEvents(store, tenantId, 'one', userId, at, () => true, eventItems([event(1, 'session_start', { agent: 'codex' }), event(2, 'session_end', {})]), () => { });
    at += 2 * 24 * 3600000;
    // Retention removes all transcript rows before the result arrives. Neither the late input nor output may be restored.
    const result = event(3, 'tool_result', { tool_call_id: 'search-1', output: 'private result' });
    const rows = [event(4, 'tool_call', { tool_call_id: 'search-1', tool: 'mcp__search__lookup', input: 'private query' }),
    event(5, 'tool_result', { tool_call_id: 'search-1', output: 'private result' }), event(6, 'tool_call', { tool_call_id: 'free', tool: 'shell' }), event(7, 'tool_result', { tool_call_id: 'free' })];
    await ingestEvents(store, tenantId, 'one', userId, at, () => true, eventItems([result]), () => { });
    expect(db.get("SELECT count(*) AS n FROM session_events WHERE session_id='sess'")).toEqual({ n: 0 });
    const receipt = db.get("SELECT * FROM commerce_tool_receipts WHERE native_id='search-1'");
    expect(JSON.stringify(receipt)).not.toContain('private result');
    await ingestEvents(store, tenantId, 'one', userId, at, () => true, eventItems(rows), () => { });
    await ingestEvents(store, tenantId, 'one', userId, at, () => true, eventItems(rows), () => { });
    expect(db.get("SELECT count(*) AS n FROM session_events WHERE session_id='sess'")).toEqual({ n: 0 });
    expect(db.get("SELECT count(*) AS n FROM ledger WHERE kind='settle' AND lease_id IS NULL")).toEqual({ n: 1 });
    expect((await account()).tool_calls).toMatchObject([{ native_id: 'search-1', status: 'charged', fee_milli: 5 }]);
    await expect(renewLease(store, tenantId, 'one', userId, at, () => true, first.lease_id, 25, 'settle', true, true)).rejects.toThrow();
    const settle = (used: number) => renewLease(store, tenantId, 'one', userId, at, () => true, first.lease_id, 25, 'settle', true, true, { m2: used });
    const next = await settle(25); expect(await settle(25)).toEqual(next);
    await expect(settle(24)).rejects.toThrow();
    expect(next).toMatchObject({ model_budgets: { m2: 5 } });
    expect((await account()).model_budgets[0]).toMatchObject({ monthly_milli: 40, used: 25, reserved: 15 });
    expect(db.get('SELECT package_used FROM commerce_leases WHERE lease_id=?', [first.lease_id])).toEqual({ package_used: 25 });
    at = Date.parse('2026-11-30T16:00:01Z');
    const before = balance(db, at).balance_milli;
    expect(await settleUnclosedDiscountMonths(store, tenantId, at)).toBe(true);
    expect(await settleUnclosedDiscountMonths(store, tenantId, at)).toBe(false);
    const report = await request('/policy/discounts/2026-11', undefined, 'GET', owner);
    expect(report).toMatchObject({ gross_milli: 30, net_milli: 15, discount_milli: 15, cash_credit_milli: 0, expired_package_credit_milli: 15 });
    expect(balance(db, at).balance_milli - before).toBe(200);
    expect((await account()).packages).toMatchObject([{ month: '2026-12', grant_milli: 200 }, { month: '2026-11', used_milli: 30, reserved_milli: 60, expired_milli: 110 }]);
  } finally { await store.drain(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
