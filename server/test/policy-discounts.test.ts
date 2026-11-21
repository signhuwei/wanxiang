import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ApiError } from '../src/api';
import { appendLedgerEntry, balance, initialLease, renewLease } from '../src/billing';
import { hash, iso, randomToken } from '../src/credentials';
import { policyDiscountRoutes, settleUnclosedDiscountMonths } from '../src/policy-discounts';
import { policyRoutes } from '../src/policy-routes';
import { seedTenant } from '../src/seed';
import { Store } from '../src/store';

test('monthly discount freezes lease policy, caps paid usage, and posts one exact refund', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-discount-'));
  const store = new Store(dataDir, 2);
  let at = Date.parse('2026-11-30T15:50:00Z');
  try {
    const { tenantId, userId } = await seedTenant(store, {
      target: 'discount@example.test', platformAdmin: true, now: at,
    });
    const owner = randomToken();
    const platform = randomToken();
    const unknown = randomToken();
    const expires = '2027-06-01T00:00:00.000Z';
    await store.system.write(sql => {
      sql.run(`INSERT INTO sessions (token_hash, user_id, tenant_id, kind, expires_at)
        VALUES (?, ?, ?, 'web', ?), (?, ?, NULL, 'web', ?)`, [hash(owner), userId, tenantId, expires, hash(platform), userId, expires]);
      sql.run(`INSERT INTO providers (id, name, protocol, base_url, secret_ciphertext, status)
        VALUES ('provider_fixture_a', 'Fixture', 'openai_chat', 'https://provider.invalid/v1', ?, 'active')`, [new Uint8Array(0)]);
      sql.run(`INSERT INTO models (id, provider_id, upstream_name, display_name, context_window, status)
        VALUES ('model_discount_a', 'provider_fixture_a', 'example-a', 'Fixture', 2048, 'active')`);
    });
    const db = store.tenant(tenantId);
    const deviceId = 'dev_discount_fixture';
    await db.write(sql => {
      sql.run(`INSERT INTO devices (id,user_id,name,os,arch,public_key,token_hash,token_expires_at,status)
        VALUES (?, ?, 'Fixture', 'darwin', 'arm64', 'test', ?, ?, 'active')`, [deviceId, userId, hash(randomToken()), expires]);
      appendLedgerEntry(sql, 'topup', 10_000, at);
    });

    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json({ error: err.body() }, err.status);
      throw err;
    });
    const changes: string[] = [];
    const opts = { codeSecret: 'fixture-only', now: () => at, dataDir, onBalanceChange: (tenant: string) => changes.push(tenant) };
    policyRoutes(app, store, opts);
    policyDiscountRoutes(app, store, opts);
    const request = (path: string, token: string, method = 'GET', body?: unknown, key?: string) => app.request(path, {
      method, body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { Authorization: 'Bearer ' + token, ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(key && { 'Idempotency-Key': key }) },
    });
    const definition = await request('/v1/platform/policy/definitions', platform, 'POST', {
      id: 'test.contract-discount', expected_version: 0, title: '月度结算折扣', description: '',
      category: 'pricing', schema: { kind: 'ratio_ppm', min: 0, max: 1_000_000 }, scopes: ['tenant'], merge: 'fixed',
      default_value: 1_000_000, binding: { adapter: 'billing.discount', abi: 1 },
    }, 'definition');
    expect(definition.status).toBe(201);

    const path = '/v1/platform/policy/contracts/' + tenantId;
    const term = (id: string, adjustment: number | string[]) => ({ clause_ref: { id, version: 1 }, template_ref: null, adjustment });
    const sign = (ratio: number, platformRevision: number, policyRevision: number) =>
      request(path + '/signatures', platform, 'POST', {
        expected_platform_revision: platformRevision, expected_policy_revision: policyRevision, base_revision: platformRevision || null,
        reason: '折扣签发', entries: [term('access.models', ['model_discount_a']), term('lease.budget', 8),
          term('test.contract-discount', ratio)],
      }, 'sign-' + platformRevision);
    expect((await sign(500_000, 0, 0)).status).toBe(201);

    const isLive = () => true;
    async function settle(leaseId: string, used: number, op: string) {
      const result = await renewLease(store, tenantId, deviceId, userId, at, isLive, leaseId, used, op, true, true);
      if (result.type !== 'lease') throw new Error('Discount must preserve normal lease renewal');
      return result.lease_id;
    }
    const first = await initialLease(store, tenantId, deviceId, userId, at, isLive, true, true);
    if (first.type !== 'lease') throw new Error('Expected a funded policy lease');
    expect(first.budget_milli).toBe(8);

    // The aggregate policy advances without changing the signed price.
    expect((await request('/v1/policy/configurations/tenant/' + tenantId, owner, 'PUT', {
      expected_platform_revision: 1, expected_policy_revision: 1, template_ref: null, selections: [],
    }, 'config')).status).toBe(200);
    const second = await settle(first.lease_id, 3, 'first');
    expect((await sign(750_000, 1, 2)).status).toBe(201);
    const third = await settle(second, 3, 'second');
    expect(db.get('SELECT platform_revision, policy_revision, ratio_ppm FROM policy_discount_leases WHERE lease_id=?', [second]))
      .toEqual({ platform_revision: 1, policy_revision: 2, ratio_ppm: 500_000 });
    const fourth = await settle(third, 100, 'overage');
    expect(db.all('SELECT amount_milli, kind FROM ledger WHERE lease_id = ? AND kind IN (\'settle\', \'overage_pending\') ORDER BY kind', [third]))
      .toEqual([{ amount_milli: 92, kind: 'overage_pending' }, { amount_milli: 8, kind: 'settle' }]);
    expect(await settle(third, 100, 'overage')).toBe(fourth);

    const november = path + '/discounts/2026-11';
    expect((await request(november, platform, 'POST', undefined, 'still-open')).status).toBe(409);
    // A lease issued in November but settled after local midnight belongs to December.
    at = Date.parse('2026-11-30T16:00:00Z');
    const fifth = await settle(fourth, 4, 'december');
    const before = balance(db, at).balance_milli;
    expect(await settleUnclosedDiscountMonths(store, tenantId, at)).toBe(true);
    expect(await settleUnclosedDiscountMonths(store, tenantId, at)).toBe(false);
    expect(balance(db, at).balance_milli).toBe(before + 5);
    const report = await (await request(november, platform)).json();
    expect(report).toMatchObject({
      month: '2026-11', gross_milli: 14, net_milli: 9, discount_milli: 5, closed_by: 'system',
      buckets: [
        { platform_revision: 1, policy_revisions: [1, 2], ratio_ppm: 500_000, gross_milli: 6, net_milli: 3 },
        { platform_revision: 2, policy_revisions: [3], ratio_ppm: 750_000, gross_milli: 8, net_milli: 6 },
      ],
    });
    expect(await (await request('/v1/policy/discounts/2026-11', owner)).json()).toEqual(report);
    expect((await request('/v1/policy/discounts/2026-11', platform)).status).toBe(403);
    expect((await request(november, unknown, 'POST', undefined, 'forged')).status).toBe(401);
    expect(await (await request(november, platform, 'POST', undefined, 'replay')).json()).toEqual(report);
    expect(db.all("SELECT amount_milli, request_ref FROM ledger WHERE kind = 'adjust'"))
      .toEqual([{ amount_milli: 5, request_ref: 'policy-discount:2026-11' }]);
    expect(changes).toEqual([]);

    at = Date.parse('2026-12-31T16:00:00Z');
    const december = path + '/discounts/2026-12';
    expect((await request(december, platform, 'POST')).status).toBe(422);
    const [manual, retry] = await Promise.all([
      request(december, platform, 'POST', undefined, 'december-close'),
      request(december, platform, 'POST', undefined, 'december-close'),
    ]);
    const credited = await manual.json();
    expect(credited).toMatchObject({ month: '2026-12', gross_milli: 4, net_milli: 3, discount_milli: 1, closed_by: userId });
    expect(await retry.json()).toEqual(credited);
    expect((await request(november, platform, 'POST', undefined, 'december-close')).status).toBe(409);
    expect(await (await request(december, platform, 'POST', undefined, 'other-key')).json()).toEqual(credited);
    expect(changes).toEqual([tenantId]);
    expect(db.all("SELECT amount_milli, request_ref FROM ledger WHERE kind = 'adjust' ORDER BY at")).toEqual([
      { amount_milli: 5, request_ref: 'policy-discount:2026-11' },
      { amount_milli: 1, request_ref: 'policy-discount:2026-12' },
    ]);

    expect((await sign(1_000_000, 2, 3)).status).toBe(201);
    const fullPrice = await settle(fifth, 0, 'restore-full-price');
    expect(db.get('SELECT 1 FROM policy_discount_leases WHERE lease_id = ?', [fullPrice])).toBeNull();
    await settle(fullPrice, 3, 'full-price');
    at = Date.parse('2027-01-31T16:00:00Z');
    expect(await settleUnclosedDiscountMonths(store, tenantId, at)).toBe(false);
    const fullPriceMonth = await request(path + '/discounts/2027-01', platform, 'POST', undefined, 'zero-credit');
    expect(await fullPriceMonth.json()).toMatchObject({ gross_milli: 3, net_milli: 3, discount_milli: 0,
      adjustment_ledger_id: null, buckets: [] });
    expect(changes).toEqual([tenantId]);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
