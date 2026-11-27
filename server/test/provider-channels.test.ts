import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, iso, randomToken } from '../src/credentials';
import type { PoolMember } from '../src/model-pool';
import { MemoryPresence } from '../src/presence';
import { seedTenant } from '../src/seed';
import { createServer } from '../src/server';
import { effectiveModelConfig } from '../src/edge-config';

test('real HTTP channel actions retain all pages and publish a one-to-many pool from reviewed exact discoveries', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'onex-channel-catalog-'));
  const keyA = 'local-test-catalog-key-a';
  const keyB = 'local-test-catalog-key-b';
  const requestLog: { method: string; path: string; cursor: string | null }[] = [];
  let failB = false;
  let refreshedCatalog: 'partial' | 'failed' | 'succeeded' = 'partial';
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => {
    const url = new URL(req.url);
    const cursor = url.searchParams.get('after');
    requestLog.push({ method: req.method, path: url.pathname, cursor });
    if (req.method !== 'GET' || !['/a/v1/models', '/a/refresh/v1/models', '/b/v1/models'].includes(url.pathname)) return new Response(null, { status: 404 });
    if (req.headers.get('authorization') !== `Bearer ${url.pathname.startsWith('/a') ? keyA : keyB}`) return new Response(null, { status: 401 });
    if (url.pathname.startsWith('/b')) return failB ? new Response(null, { status: 403 }) : Response.json({ data: [{ id: 'Supplier-B/M' }] });
    if (url.pathname === '/a/refresh/v1/models') {
      if (refreshedCatalog === 'failed') return new Response(null, { status: 503 });
      return Response.json({ data: [{ id: 'Supplier-A/Refreshed' }], has_more: refreshedCatalog === 'partial' });
    }
    if (!cursor) return Response.json({ data: [{ id: 'Supplier-A/M', context_window: 128000, capabilities: ['text'] },
      ...Array.from({ length: 220 }, (_, i) => ({ id: `visible-${i}` }))], has_more: true, last_id: 'next-1' });
    return Response.json({ data: [{ id: 'untouched-page-two' }], has_more: false });
  } });
  let svc: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    svc = await createServer({ hostname: '127.0.0.1', port: 0, dataDir: scratch, tenantCacheSize: 2, heartbeatMs: 15_000,
      codeSecret: 'test-provider-channels', commit: 'test', presence: new MemoryPresence(), masterKey: new Uint8Array(32).fill(9),
      providerChannelFetch: (url, headers, signal) => fetch(url, { headers, signal, redirect: 'error', proxy: '' }) });
    const { tenantId, userId } = await seedTenant(svc.store, { target: 'admin@example.test', platformAdmin: true });
    const token = randomToken();
    const tenantToken = randomToken();
    await svc.store.system.write((sql) => {
      for (const [auth, scope] of [[token, null], [tenantToken, tenantId]] as const) sql.run(
        "INSERT INTO sessions (token_hash,user_id,tenant_id,kind,expires_at) VALUES (?,?,?,'web',?)",
        [hash(auth), userId, scope, iso(Date.now() + 60_000)]);
    });
    const api = async (path: string, payload?: unknown, expected = 200, idem?: string, auth = token) => {
      const hasPayload = payload !== undefined;
      const response = await fetch(new URL(`/v1/platform${path}`, svc!.server.url), { method: hasPayload ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${auth}`, ...(hasPayload && { 'Content-Type': 'application/json', 'Idempotency-Key': idem ?? crypto.randomUUID() }) },
        ...(hasPayload && { body: JSON.stringify(payload) }) });
      const body = await response.json() as Record<string, any>;
      expect({ status: response.status, detail: body.error?.detail }).toEqual({ status: expected, detail: body.error?.detail });
      expect(JSON.stringify(body)).not.toContain(keyA);
      expect(JSON.stringify(body)).not.toContain(keyB);
      return body;
    };
    const make = (name: string, tail: string, secret: string) => api('/providers', { name, protocol: 'openai_chat',
      base_url: new URL(tail, upstream.url).href, secret }, 201);
    const a = await make('A', '/a/v1', keyA);
    const b = await make('B', '/b', keyB);
    const channel = await api(`/providers/${a.id}/channel`);
    expect(channel.accounts).toMatchObject([{ name: '默认渠道', balance_mode: 'prepaid' }]);
    expect(channel.accounts[0].funding_id).toBe(channel.accounts[0].account_id);
    await api(`/providers/${a.id}/channel`, undefined, 403, undefined, tenantToken);
    const test = await api(`/providers/${a.id}/probes`, { revision: a.revision, kind: 'connectivity' }, 202);
    expect(test).toMatchObject({ kind: 'connectivity', status: 'succeeded' });
    const pullA = () => api(`/providers/${a.id}/discoveries`, { revision: a.revision }, 202, 'discover-a');
    const resultA = await pullA();
    expect(resultA).toMatchObject({ status: 'succeeded', summary: { model_count: 222 } });
    expect((await pullA()).id).toBe(resultA.id);
    const first = await api(`/probe-jobs/${resultA.id}/results?limit=200`);
    const last = await api(`/probe-jobs/${resultA.id}/results?limit=200&cursor=${first.next_cursor}`);
    expect(first.items.length + last.items.length).toBe(222);
    const exact = await api(`/probe-jobs/${resultA.id}/results?q=Supplier-A%2FM`);
    expect(exact.items).toMatchObject([{ raw_model: 'Supplier-A/M', context_tokens: 128000 }]);
    const [newSource] = (await api(`/probe-jobs/${resultA.id}/results?q=untouched-page-two`)).items;
    const newModel = { catalog_item_id: newSource.catalog_item_id, display_name: '原生第二页模型', context_window: 128000,
      maker_id: 'fixture', model_family: 'page-two', model_variant: 'standard', capabilities: ['text'], reason: '核对原厂目录及样例' };
    const newPath = `/probe-jobs/${resultA.id}/adoptions`;
    await api(newPath, { ...newModel, identity_mode: 'pinned_snapshot', model_snapshot: 'not-attested' }, 409);
    expect((await api('/models?q=untouched-page-two')).items).toEqual([]);
    const created = await api(newPath, { ...newModel, identity_mode: 'family_follow' }, 201);
    expect((await api('/models?q=untouched-page-two')).items).toMatchObject([
      { id: created.model_id, provider_id: a.id, upstream_name: 'untouched-page-two', context_window: 128000 }]);
    const resultB = await api(`/providers/${b.id}/discoveries`, { revision: b.revision }, 202);
    failB = true;
    expect(await api(`/providers/${b.id}/discoveries`, { revision: b.revision }, 202)).toMatchObject({ status: 'failed', summary: { reason: 'permission_denied' } });
    expect(await api(`/providers/${b.id}/channel`)).toMatchObject({ latest_discovery: { status: 'failed' }, latest_catalog: { id: resultB.id } });
    const other = await api(`/probe-jobs/${resultB.id}/results`);
    const model = await api('/models', { provider_id: a.id, upstream_name: 'Supplier-A/M', display_name: '签约 M', context_window: 128000 }, 201);
    const identity = await api(`/models/${model.id}/identity`, { revision: model.revision, maker_id: 'maker', model_family: 'M',
      model_variant: 'full', identity_mode: 'family_follow', capability_floor: ['text'] }, 201);
    expect((await api(`/deployments?target_model_id=${model.id}`)).items).toEqual([]);
    const review = await api(`/models/${model.id}/pool/candidates/review`, { expected_identity_revision: identity.identity.identity_revision,
      reason: '核对贡献方目录与实际能力说明', decisions: [exact.items[0], other.items[0]].map(({ discovery_id, catalog_item_id }) =>
        ({ discovery_id, catalog_item_id, decision: 'accept', capabilities: ['text'] })) });
    const approvals = review.items as Array<Omit<PoolMember, 'priority'> & { status: string }>;
    expect(approvals.map((entry) => entry.status)).toEqual(['accepted', 'accepted']);
    const nominations = await api(`/deployments?target_model_id=${model.id}`);
    expect(nominations.items.every((entry: Record<string, any>) => entry.eligible && entry.actions.includes('select'))).toBe(true);
    const draft = { expected_pool_revision: 0, members: approvals.map(({ deployment_id, deployment_revision, approved_match_id, evidence_ids }, priority) =>
      ({ deployment_id, deployment_revision, approved_match_id, evidence_ids, priority })), routing: { strategy: 'ordered', max_attempts: 2,
      attempt_timeout_ms: 1000, total_timeout_ms: 2500 }, reason: '两条独立渠道共同供货' };
    const preview = await api(`/models/${model.id}/pool/preview`, draft);
    expect(preview.publishable).toBe(true);
    const published = await api(`/models/${model.id}/pool/revisions`, { ...draft, preview_basis: preview.preview_basis }, 201);
    const real = await api(`/models/${model.id}/pool/revisions/${published.pool_revision}`);
    expect(real.members.map((entry: Record<string, any>) => entry.raw_model)).toEqual(['Supplier-A/M', 'Supplier-B/M']);
    expect(requestLog.filter(({ path }) => path === '/a/v1/models').map(({ cursor }) => cursor)).toEqual([null, null, 'next-1']);
    expect(requestLog.every(({ method }) => method === 'GET')).toBe(true);

    await svc.store.system.write((sql) => sql.run(`INSERT INTO rates (model_id, input_milli_per_mtok, output_milli_per_mtok,
      cache_read_milli_per_mtok, cache_write_milli_per_mtok, effective_from) VALUES (?, 100, 200, 50, 100, ?)`,
    [model.id, iso(Date.now() - 1000)]));
    const contract = { allowed_models_json: JSON.stringify([model.id]), lease_budget_milli: 1000 };
    const route = () => effectiveModelConfig(svc!.store, contract, Date.now()).routes[0];
    expect(route()?.upstream_model).toBe('Supplier-A/M');
    expect(route()?.input_capabilities).toBeUndefined();
    const refreshedSameChannel = await api(`/providers/${a.id}/discoveries`, { revision: a.revision }, 202);
    const [sameModel] = (await api(`/probe-jobs/${refreshedSameChannel.id}/results?q=Supplier-A%2FM`)).items;
    const extended = await api(`/models/${model.id}/pool/candidates/review`, {
      expected_identity_revision: identity.identity.identity_revision, reason: '核对同一端点的图片输入能力',
      decisions: [{ discovery_id: sameModel.discovery_id, catalog_item_id: sameModel.catalog_item_id,
        decision: 'accept', capabilities: ['text', 'images'] }],
    });
    const [addition] = extended.items;
    const original = draft.members[0]!;
    expect(addition).toMatchObject({ deployment_id: original.deployment_id, deployment_revision: original.deployment_revision });
    expect(route()?.input_capabilities).toBeUndefined();
    const candidates = (await api(`/deployments?target_model_id=${model.id}`)).items;
    expect(candidates.find((row: Record<string, unknown>) => row.candidate_id === original.approved_match_id))
      .toMatchObject({ capabilities: ['text'], evidence_ids: original.evidence_ids });
    expect(candidates.find((row: Record<string, unknown>) => row.candidate_id === addition.approved_match_id))
      .toMatchObject({ capabilities: ['text', 'images'], eligible: true });
    const revisionDraft = { ...draft, expected_pool_revision: published.pool_revision,
      members: [{ ...original, evidence_ids: addition.evidence_ids }, draft.members[1]!],
      reason: '发布新增的图片输入能力' };
    expect(await api(`/models/${model.id}/pool/preview`, revisionDraft)).toMatchObject({
      publishable: false, blocking: [expect.objectContaining({ code: 'evidence_invalid' })],
    });
    revisionDraft.members[0]!.approved_match_id = addition.approved_match_id;
    const visionPreview = await api(`/models/${model.id}/pool/preview`, revisionDraft);
    expect(visionPreview).toMatchObject({ publishable: true });
    await api(`/models/${model.id}/pool/revisions`, { ...revisionDraft, preview_basis: visionPreview.preview_basis }, 201);
    expect(route()?.input_capabilities?.modalities).toEqual(['text', 'image']);
    expect((await api(`/providers/${a.id}/deployments?q=Supplier-A%2FM`)).items).toMatchObject([
      { deployment_revision: original.deployment_revision, capabilities: ['text', 'images'] },
    ]);
    expect(await api(`/models/${model.id}/pool/revisions/${published.pool_revision}`)).toEqual(
      { ...real, current: false });

    const refreshed = await api(`/providers/${a.id}`, { revision: a.revision, base_url: new URL('/a/refresh/v1', upstream.url).href });
    const viewChannel = () => api(`/providers/${a.id}/channel`);
    const pullRefreshed = () => api(`/providers/${a.id}/discoveries`, { revision: refreshed.revision }, 202);
    expect(await viewChannel()).toMatchObject({ latest_catalog: null,
      historical_catalog: { id: refreshedSameChannel.id, scope: { provider_revision: a.revision } } });
    const partial = await pullRefreshed();
    expect(partial).toMatchObject({ status: 'partial', summary: { reason: 'pagination_incomplete', model_count: 1 } });
    expect(await viewChannel()).toMatchObject({ latest_catalog: { id: partial.id, scope: { provider_revision: refreshed.revision } },
      historical_catalog: { id: refreshedSameChannel.id } });
    expect((await api(`/probe-jobs/${resultA.id}/results`)).actions).toEqual(['read']);
    expect((await api(`/probe-jobs/${partial.id}/results`)).actions).toEqual(['read', 'review_candidates']);

    refreshedCatalog = 'failed';
    const failed = await pullRefreshed();
    expect(await viewChannel()).toMatchObject({ latest_discovery: { id: failed.id, status: 'failed' },
      latest_catalog: { id: partial.id }, historical_catalog: { id: refreshedSameChannel.id } });
    refreshedCatalog = 'succeeded';
    const succeeded = await pullRefreshed();
    refreshedCatalog = 'partial';
    const newerPartial = await pullRefreshed();
    expect(await viewChannel()).toMatchObject({ latest_discovery: { id: newerPartial.id }, latest_catalog: { id: succeeded.id },
      historical_catalog: { id: refreshedSameChannel.id } });

    const adoptionPath = `/probe-jobs/${succeeded.id}/adoptions`;
    const [incoming] = (await api(`/probe-jobs/${succeeded.id}/results`)).items;
    const { catalog_item_id } = incoming;
    const stage = { mode: 'draft', catalog_item_id };
    await api(adoptionPath, stage, 403, undefined, tenantToken);
    const intake = await api(adoptionPath, stage, 201);
    expect(intake).toMatchObject({ status: 'needs_review', raw_model: 'Supplier-A/Refreshed' });
    expect(await api(adoptionPath, stage, 201)).toEqual(intake);
    expect((await api('/models?q=Supplier-A%2FRefreshed')).items).toEqual([]);
    const preserved = await api('/models', { provider_id: a.id, upstream_name: 'Supplier-A/Refreshed',
      display_name: '已登记的签约型号', context_window: 32000 }, 201);
    const adoption = { catalog_item_id, display_name: '不会覆写旧名', context_window: 32000, maker_id: 'maker',
      model_family: 'Refreshed', model_variant: 'standard', identity_mode: 'family_follow', capabilities: ['text'], reason: '已核实的原厂型号' };
    await api(adoptionPath, { ...adoption, capabilities: [] }, 422);
    expect((await api(`/models/${preserved.id}/identity`)).identity).toBeNull();
    const adopted = await api(adoptionPath, adoption, 201, 'adopt-exact');
    expect(adopted).toMatchObject({ model_id: preserved.id, display_name: preserved.display_name, status: 'accepted', identity_revision: 1 });
    expect(await api(adoptionPath, adoption, 201, 'adopt-exact')).toEqual(adopted);
    expect(await api(adoptionPath, adoption, 201)).toEqual(adopted);
    await api(adoptionPath, { ...adoption, model_variant: 'other' }, 409);
    refreshedCatalog = 'succeeded';
    const freshSource = await pullRefreshed();
    const [latest] = (await api(`/probe-jobs/${freshSource.id}/results`)).items;
    expect(latest).toMatchObject({ intake, adoptions: [{ model_id: preserved.id, status: 'accepted', pool_revision: null }] });
    expect(await api(`/probe-jobs/${freshSource.id}/adoptions`, adoption, 201)).toEqual(adopted);

    const changed = new URL('/a/v1', upstream.url);
    changed.hostname = '127.0.0.2';
    const edited = await api(`/providers/${a.id}`, { revision: refreshed.revision, base_url: changed.href });
    const count = requestLog.length;
    expect(await api(`/providers/${a.id}/probes`, { revision: edited.revision, kind: 'connectivity' }, 202))
      .toMatchObject({ status: 'failed', summary: { reason: 'credential_scope_changed' } });
    expect(requestLog.length).toBe(count);
  } finally {
    await svc?.close();
    await upstream.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
});
