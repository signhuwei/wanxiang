import { test, expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ApiError } from '../src/api';
import { hash, iso, randomToken } from '../src/credentials';
import { eventItems, ingestEvents, ingestUsage, usageItems } from '../src/ingest';
import { observationRoutes } from '../src/observe';
import type { signatureImpact } from '../src/policy-impact';
import { policyRoutes } from '../src/policy-routes';
import { ensureUser, seedTenant } from '../src/seed';
import { Store } from '../src/store';
import { tenantUpstreamTargets, upstreamRoutes } from '../src/tenant-upstreams';

test('signed execution controls preview, restore, private providers, sharing and retention through the API', async () => {
  let at = Date.parse('2026-11-01T00:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'onex-policy-execution-')), store = new Store(dir, 4);
  try {
    const { userId, tenantId } = await seedTenant(store, { target: 'owner@execution.example', platformAdmin: true, now: at });
    const db = store.tenant(tenantId);
    const owner = randomToken(), platform = randomToken(), member = randomToken(), device = 'device-execution';
    const expiry = iso(at + 31 * 86400000), masterKey = randomBytes(32);
    const memberId = await store.system.write(sql => {
      const recipient = ensureUser(sql, { kind: 'email', value: 'recipient@example.test' }, at).id;
      for (const [token, user, tenant] of [[owner, userId, tenantId], [member, recipient, tenantId], [platform, userId, null]] as const) {
        sql.run("INSERT INTO sessions (token_hash,user_id,tenant_id,kind,expires_at) VALUES (?,?,?,'web',?)", [hash(token), user, tenant, expiry]);
      }
      sql.run("INSERT INTO providers(id,name,protocol,base_url,secret_ciphertext,status) VALUES('prv','Provider','openai_chat','https://example.test',?,'active')", [randomBytes(48)]);
      sql.run("INSERT INTO models(id,provider_id,upstream_name,display_name,context_window,status) VALUES('model','prv','native','Model',2048,'active')");
      return recipient;
    });
    await db.write(sql => {
      sql.run("INSERT INTO members(user_id,role,status) VALUES(?,'member','active')", [memberId]);
      sql.run("INSERT INTO devices(id,user_id,name,os,arch,public_key,token_hash,token_expires_at,status) VALUES(?,?,'Device','darwin','arm64','test',?,?,'active')",
        [device, userId, hash(randomToken()), expiry]);
      sql.run("INSERT INTO devices(id,user_id,name,os,arch,public_key,token_hash,token_expires_at,status) VALUES(?,?,'Other device','win32','x64','test',?,?,'active')",
        [device + '-2', userId, hash(randomToken()), expiry]);
    });
    const app = new Hono(), opts = { now: () => at, codeSecret: 'fixture', dataDir: dir, masterKey };
    app.onError((error, c) => { if (error instanceof ApiError) return c.json({ error: error.body() }, error.status); throw error });
    policyRoutes(app, store, opts); upstreamRoutes(app, store, opts); observationRoutes(app, store, opts.now);
    const call = (token: string, path: string, method = 'GET', body?: unknown, key = randomToken()) => app.request(path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body !== undefined && { body: JSON.stringify(body) })
    });
    async function read(response: Response) { return await response.json() as { id: string; total: number; items: unknown[]; policy_revision: number }; }
    const ref = (id: string) => ({ id, version: 1 });
    const contract = '/v1/platform/policy/contracts/' + tenantId;
    const signed = (values: Record<string, unknown>, platformRevision = 0, policyRevision = 0) => ({
      expected_platform_revision: platformRevision, expected_policy_revision: policyRevision, base_revision: platformRevision || null, reason: 'test',
      entries: Object.entries(values).map(([id, adjustment]) => ({ clause_ref: ref(id), template_ref: null, adjustment }))
    });
    const terms = { 'session.export': true, 'session.share': true, 'session.retention_days': 1, 'upstream.custom': true, 'access.models': ['model'], 'lease.budget': 1000 };
    const previewPath = contract + '/preview?limit=1';
    async function previewImpact(path: string) {
      const response = await call(platform, path, 'POST', signed(terms));
      expect(response.status).toBe(200);
      const data = await response.json() as { impact: ReturnType<typeof signatureImpact> };
      return data.impact;
    }
    const impact = await previewImpact(previewPath);
    expect(impact).toMatchObject({ member_count: 2, device_count: 2,
      devices: { items: [{ device_id: device, unavailable: expect.arrayContaining([{ resource_id: 'model', reason: 'rate_missing' }]) }] } });
    const memberPage = previewPath + '&member_cursor=' + impact.members.next_cursor;
    const devicePage = previewPath + '&cursor=' + impact.devices.next_cursor;
    const otherMembers = await previewImpact(memberPage);
    expect(otherMembers.devices).toEqual(impact.devices);
    expect(otherMembers.members.next_cursor).toBeNull();
    expect([...impact.members.items, ...otherMembers.members.items]).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: userId, name: 'owner@execution.example', device_count: 2 }),
      expect.objectContaining({ user_id: memberId, name: 'recipient@example.test', device_count: 0,
        changed_clauses: expect.arrayContaining(['access.models', 'lease.budget']) }),
    ]));
    const otherDevices = await previewImpact(devicePage);
    expect(otherDevices.members).toEqual(impact.members);
    expect(otherDevices.devices).toMatchObject({ items: [{ device_id: device + '-2' }], next_cursor: null });
    expect((await call(member, memberPage, 'POST', signed(terms))).status).toBe(403);
    expect((await call(platform, contract + '/signatures', 'POST', signed(terms))).status).toBe(201);
    expect((await call(platform, memberPage, 'POST', signed(terms))).status).toBe(409);
    const profile = '/v1/policy/configurations/tenant/' + tenantId;
    const configure = (revision: number, value: boolean) => ({ expected_platform_revision: 1, expected_policy_revision: revision, template_ref: null, selections: [{ clause_ref: ref('session.export'), value }] });
    expect((await call(owner, profile, 'PUT', configure(1, false))).status).toBe(200);
    expect((await call(owner, profile, 'PUT', configure(2, true))).status).toBe(200);
    const restore = { restore_revision: 1, expected_platform_revision: 1, expected_policy_revision: 3 };
    expect((await call(owner, profile + '/preview', 'POST', restore)).status).toBe(200);
    expect((await read(await call(owner, profile + '/history'))).total).toBe(2);
    expect((await call(owner, profile, 'PUT', restore)).status).toBe(200);
    expect((await read(await call(owner, profile + '/history'))).items[0]).toMatchObject({ revision: 3, restored_from_revision: 1 });
    const up = '/v1/policy/upstreams', body = { expected_revision: 0, model_id: 'model', name: 'Tenant provider', base_url: 'https://tenant.example/v1', upstream_name: 'managed', priority: 3, secret: 'tenant-key' };
    expect((await call(member, up, 'POST', body)).status).toBe(403);
    const saved = await read(await call(owner, up, 'POST', body, 'same-key'));
    expect(saved).toMatchObject({ revision: 1, has_key: true });
    expect((await read(await call(owner, up, 'POST', body, 'same-key'))).id).toBe(saved.id);
    expect(JSON.stringify(await read(await call(owner, up)))).not.toContain('tenant-key');
    expect(tenantUpstreamTargets(db, tenantId, masterKey, 'model')[0]?.secret.toString()).toBe('tenant-key');
    expect(tenantUpstreamTargets(db, 'different-tenant', masterKey, 'model')).toHaveLength(0);
    expect((await call(owner, up + '/' + saved.id, 'PUT', { expected_revision: 0, status: 'disabled' })).status).toBe(409);
    await store.system.write(sql=>sql.run(`INSERT INTO rates(model_id,effective_from,input_milli_per_mtok,output_milli_per_mtok,
      cache_read_milli_per_mtok,cache_write_milli_per_mtok) VALUES('model',?,50,100,0,0)`,[iso(at)]));
    const targetPath='/v1/policy/targets/'+memberId+'?os=darwin&arch=arm64';
    expect(await (await call(owner,targetPath)).json()).toMatchObject({
      models:[{model_id:'model',rate:{output_milli_per_mtok:100}}],
      routes:[{model_id:'model',candidates:[{provider_id:saved.id,priority:3},{provider_id:'prv',priority:100}]}]});
    expect(JSON.stringify(await (await call(member,targetPath)).json())).not.toContain('output_milli_per_mtok');
    expect((await call(member,'/v1/policy/targets/'+userId+'?os=darwin&arch=arm64')).status).toBe(404);
    const session = 'session-execution';
    const ingest = (seq: number, kind: string) => ingestEvents(store, tenantId, device, userId, at, () => true,
      eventItems([{ seq, session_id: session, kind, at: iso(at), payload: { text: 'captured content' } }]), () => { });
    await ingest(1, 'session_start'); await ingest(2, 'user_message'); await ingest(3, 'session_end');
    const path = '/v1/observe/sessions/' + session;
    expect((await call(owner, path + '/export')).status).toBe(403);
    expect((await call(member, path + '/events')).status).toBe(404);
    expect((await call(owner, path + '/shares', 'POST', { recipient: memberId })).status).toBe(200);
    expect((await read(await call(member, '/v1/observe/shared'))).total).toBe(1);
    expect((await read(await call(member, path + '/events'))).total).toBe(3);
    expect((await call(owner, path + '/shares/' + memberId, 'DELETE')).status).toBe(200);
    expect((await call(member, path + '/events')).status).toBe(404);
    const head = await read(await call(owner, profile));
    expect((await call(owner, profile, 'PUT', configure(head.policy_revision, true))).status).toBe(200);
    expect((await read(await call(owner, path + '/export?limit=2'))).items).toHaveLength(2);
    at += 86400000;
    expect((await call(owner, path + '/events')).status).toBe(404);
    expect(await ingest(4, 'user_message')).toBe(4);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM session_events')!.n).toBe(0);
    expect(db.get('SELECT id FROM agent_sessions WHERE content_purged_at IS NOT NULL')).toBeTruthy();

    const desktop = 'desktop-session';
    const desktopPath = '/v1/observe/sessions/' + desktop;
    const originalStart = iso(at);
    const desktopEvent = (seq: number, kind: string, payload = {}, eventAt = at) =>
      ingestEvents(store, tenantId, device, userId, at, () => true,
        eventItems([{ seq, session_id: desktop, kind, at: iso(eventAt), payload }]), () => {});
    await desktopEvent(5, 'session_start', { agent: 'workbuddy' });
    await desktopEvent(6, 'user_message', { content: 'first dialogue' });
    await ingestUsage(store, tenantId, device, userId, at, () => true, usageItems([{
      seq: 7, session_id: desktop, request_id: 'workbuddy-usage', provider_id: 'prv', model: 'model', model_id: 'model',
      input_tokens: 13, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0,
      cost_milli: 7, at: iso(at), status: 'ok', complete: true,
    }]), () => {});
    await desktopEvent(8, 'session_end', { reason: 'exited' });
    expect((await call(owner, desktopPath + '/shares', 'POST', { recipient: memberId })).status).toBe(200);

    at += 60_000;
    await desktopEvent(10, 'session_resume');
    await desktopEvent(9, 'session_end', { reason: 'recovered' }, at - 30_000);
    await desktopEvent(11, 'user_message', { content: 'resumed before expiry' });
    at += 86_400_000;
    expect(db.get('SELECT started_at, ended_at FROM agent_sessions WHERE id = ?', [desktop]))
      .toEqual({ started_at: originalStart, ended_at: null });
    expect((await read(await call(member, desktopPath + '/events'))).total).toBe(6);

    await desktopEvent(12, 'session_end', { reason: 'crashed' });
    at += 86_400_000;
    expect((await call(owner, desktopPath + '/events')).status).toBe(404);
    expect(db.get('SELECT cost_milli FROM usage WHERE session_id = ?', [desktop])).toEqual({ cost_milli: 7 });
    expect(db.get('SELECT 1 FROM audit WHERE target = ? LIMIT 1', [desktop])).toBeTruthy();

    await desktopEvent(14, 'session_resume');
    await desktopEvent(13, 'assistant_message', { content: 'late old dialogue' }, at - 86_400_000);
    await desktopEvent(15, 'assistant_message', { content: 'old transcript appended after resume' }, at - 90_000_000);
    await desktopEvent(16, 'user_message', { content: 'new dialogue after expiry' });
    expect((await read(await call(owner, desktopPath + '/events'))).items).toMatchObject([
      { seq: 14, kind: 'session_resume' },
      { seq: 16, kind: 'user_message', payload: { content: 'new dialogue after expiry' } },
    ]);
    expect((await call(member, desktopPath + '/events')).status).toBe(404);
    expect(db.get('SELECT started_at, ended_at FROM agent_sessions WHERE id = ?', [desktop]))
      .toEqual({ started_at: originalStart, ended_at: null });

    // A restored head can be older than an already retained signature.
    await db.write(sql => sql.run(`INSERT INTO policy_signatures (revision, reason, issued_by, issued_at, entries_json)
      SELECT 7, reason, issued_by, issued_at, entries_json FROM policy_signatures WHERE revision = 1`));
    const active = await (await call(platform, contract)).json() as { platform_revision: number; policy_revision: number };
    expect(active.platform_revision).toBe(1);
    const recovery = signed(terms, active.platform_revision, active.policy_revision);
    expect((await call(platform, contract + '/preview', 'POST', recovery)).status).toBe(200);
    const renewed = await call(platform, contract + '/signatures', 'POST', recovery);
    expect(renewed.status).toBe(201);
    expect(await renewed.json()).toMatchObject({ revision: 8, platform_revision: 8, policy_revision: 8 });
    expect((await call(platform, contract + '/signatures/7')).status).toBe(200);
  } finally { await store.drain(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
