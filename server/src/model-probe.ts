import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { limitedJson, postModelProbeOverHttp, type ProviderModelProbeFetch } from './channel-catalog-upstream';
import { iso } from './credentials';
import { int, platformActor, type ManagementOptions } from './management';
import { decryptProviderSecret } from './provider-secret';
import { boundPage, conflict, digest, replay, requirePlatformAdmin, routeId, strictObject } from './routing-http';
import { salesCostMilli, type RoutingSalesRates, type RoutingTokenUsage } from './routing-money';
import type { Store, Transaction } from './store';

const quotaPath = '/v1/platform/model-test-quotas';
const testPath = '/v1/platform/probe-jobs/:job_id/model-tests';
const timeoutMs = 15_000;
const interruptedMs = timeoutMs + 5000;
const maxInput = 256;
const maxOutput = 16;
const maxReserve = 1_000;
const prompt = 'Reply OK.';
type Reader = Pick<Transaction, 'get'>;
type Status = 'running' | 'succeeded' | 'failed' | 'pending_reconciliation';
type Quota = { user_id: string; name: string; revision: number; limit_milli: number; reserved_milli: number; spent_milli: number };
type Scope = { discovery_id: string; catalog_item_id: string; raw_model: string; provider_id: string; provider_revision: number;
  account_id: string; endpoint_id: string; endpoint_revision: number };
type Target = Scope & { protocol: 'openai_chat' | 'openai_responses' | 'anthropic'; auth: 'bearer' | 'x_api_key';
  base_url: string; credential_scope: string; proxy: string | null; secret_ciphertext: Uint8Array };
type Tariff = RoutingSalesRates & { source_reference: string; source: 'manual' | 'legacy_rate'; effective_from?: string; model_id?: string };
type Job = Scope & { id: string; actor_id: string; period: string; request_key: string; fingerprint: string; status: Status;
  created_at: string; completed_at: string | null; reason_code: string | null; reserved_milli: number; charged_milli: number | null;
  usage_json: string | null; tariff_json: string; reconciliation_json: string | null };
type Outcome = { status: Exclude<Status, 'running'>; reason_code: string | null; charged_milli: number | null; usage: RoutingTokenUsage | null };

const periodAt = (at: number) => iso(at + 8 * 3_600_000).slice(0, 7);
const quotaColumns = 'a.user_id,u.name,coalesce(q.revision,0) revision,coalesce(q.limit_milli,0) limit_milli,coalesce(q.reserved_milli,0) reserved_milli,coalesce(q.spent_milli,0) spent_milli';
const quotaJoin = `FROM platform_admins a JOIN platform_users u ON u.id=a.user_id
  LEFT JOIN platform_model_test_quotas q ON q.user_id=a.user_id AND q.period=?`;
const quotaView = (row: Quota, period: string) =>
  ({ ...row, period, available_milli: row.limit_milli - row.reserved_milli - row.spent_milli, actions: ['read', 'allocate'] });

function audit(db: Transaction, actor: string, action: string, target: string, detail: object, at: number) {
  db.run('INSERT INTO platform_audit(id,actor,action,target,detail_json,at) VALUES (?,?,?,?,?,?)',
    [`aud_${ulid()}`, actor, action, target, JSON.stringify(detail), iso(at)]);
}

function canReconcile(row: Job, at: number) {
  return row.status === 'pending_reconciliation' || row.status === 'running' && Date.parse(row.created_at) + interruptedMs < at;
}

function jobView(row: Job, at: number) {
  const { request_key, fingerprint, usage_json, tariff_json, reconciliation_json, ...view } = row;
  const interrupted = row.status === 'running' && canReconcile(row, at);
  return { ...view, status: interrupted ? 'pending_reconciliation' : row.status,
    reason_code: interrupted ? 'completion_unknown' : row.reason_code, usage: usage_json ? JSON.parse(usage_json) : null,
    tariff: JSON.parse(tariff_json), reconciliation: reconciliation_json ? JSON.parse(reconciliation_json) : null,
    actions: canReconcile(row, at) ? ['read', 'reconcile'] : ['read'] };
}

export function latestModelTest(db: Reader, catalogue: string, endpointRevision: number, at: number) {
  const job = db.get<Job>(`SELECT * FROM platform_model_tests WHERE catalog_item_id=? AND endpoint_revision=?
    ORDER BY created_at DESC,rowid DESC LIMIT 1`, [catalogue, endpointRevision]);
  return job ? jobView(job, at) : null;
}

function currentTarget(db: Reader, discovery: string, catalogue: string): Target {
  const row = db.get<Target>(`SELECT j.id discovery_id,c.catalog_item_id,c.raw_model,j.provider_id,j.provider_revision,
    j.account_id,j.endpoint_id,j.endpoint_revision,p.protocol,p.base_url,p.proxy,p.secret_ciphertext,
    coalesce(p.auth,CASE p.protocol WHEN 'anthropic' THEN 'x_api_key' ELSE 'bearer' END) auth,s.credential_scope
    FROM provider_channel_discoveries d
    JOIN provider_channel_catalog c ON c.catalog_item_id=d.catalog_item_id
    JOIN provider_channel_jobs j ON j.id=d.discovery_id
    JOIN providers p ON p.id=j.provider_id AND p.revision=j.provider_revision AND p.status='active'
    JOIN provider_channel_defaults s ON s.provider_id=p.id AND s.account_id=j.account_id AND s.endpoint_id=j.endpoint_id
    JOIN provider_accounts a ON a.account_id=j.account_id AND a.provider_id=j.provider_id AND a.status='active'
    JOIN provider_endpoints e ON e.endpoint_id=j.endpoint_id AND e.current_revision=j.endpoint_revision AND e.status='active'
    JOIN provider_account_endpoints b ON b.endpoint_id=e.endpoint_id AND b.account_id=a.account_id AND b.state='enabled'
    WHERE j.id=? AND c.catalog_item_id=? AND j.kind='discovery' AND j.status IN ('succeeded','partial')
    AND j.id=(SELECT x.id FROM provider_channel_jobs x WHERE x.provider_id=j.provider_id
      AND x.provider_revision=j.provider_revision AND x.kind='discovery' AND x.endpoint_id=j.endpoint_id
      AND x.endpoint_revision=j.endpoint_revision AND x.status IN ('succeeded','partial')
      ORDER BY (x.status='succeeded') DESC,x.observed_at DESC,x.rowid DESC LIMIT 1)`, [discovery, catalogue]);
  if (!row) throw conflict('model_test_requires_current_catalogue');
  const url = URL.parse(row.base_url);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw conflict('destination_denied');
  }
  if (row.proxy && row.proxy !== 'none') throw conflict('unsupported_proxy');
  if (row.credential_scope !== JSON.stringify([url.origin, row.protocol, row.auth])) throw conflict('credential_scope_changed');
  return row;
}

function parseTariff(value: unknown): Tariff | null {
  if (value === undefined) return null;
  const row = strictObject(value, 'test_tariff', ['input_milli_per_mtok', 'output_milli_per_mtok', 'source_reference']);
  const input = int(row.input_milli_per_mtok, 'test_tariff.input_milli_per_mtok', 0, Number.MAX_SAFE_INTEGER);
  const output = int(row.output_milli_per_mtok, 'test_tariff.output_milli_per_mtok', 0, Number.MAX_SAFE_INTEGER);
  return { source: 'manual', source_reference: field(row.source_reference, 'test_tariff.source_reference', 250).trim(),
    input_milli_per_mtok: input, output_milli_per_mtok: output, cache_read_milli_per_mtok: input, cache_write_milli_per_mtok: input };
}

function existingTariff(db: Reader, target: Target, at: number): Tariff | null {
  const active = db.get<RoutingSalesRates & { model_id: string; effective_from: string }>(`SELECT r.model_id,r.effective_from,r.input_milli_per_mtok,
    r.output_milli_per_mtok,r.cache_read_milli_per_mtok,r.cache_write_milli_per_mtok FROM rates r JOIN models m ON m.id=r.model_id
    WHERE m.provider_id=? AND m.upstream_name=? AND m.status='active' AND r.effective_from<=?
    AND (SELECT count(*) FROM models WHERE provider_id=? AND upstream_name=? AND status='active')=1
    ORDER BY r.effective_from DESC LIMIT 1`, [target.provider_id, target.raw_model, iso(at), target.provider_id, target.raw_model]);
  return active ? { ...active, source: 'legacy_rate', source_reference: active.model_id } : null;
}

function reserveFor(tariff: Tariff) {
  const input = Math.max(tariff.input_milli_per_mtok, tariff.cache_read_milli_per_mtok, tariff.cache_write_milli_per_mtok);
  const amount = Math.max(1, salesCostMilli({ input_tokens: maxInput, output_tokens: maxOutput, cache_read_tokens: 0,
    cache_write_tokens: 0 }, { ...tariff, input_milli_per_mtok: input }));
  if (amount > maxReserve) throw conflict('model_test_cost_limit_exceeded');
  return amount;
}

function requestFor(target: Target, secret: string) {
  const url = new URL(target.base_url);
  const base = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
  headers.set(target.auth === 'bearer' ? 'Authorization' : 'x-api-key', target.auth === 'bearer' ? 'Bearer ' + secret : secret);
  const messages = [{ role: 'user', content: prompt }];
  const common = { model: target.raw_model, stream: false };
  if (target.protocol === 'anthropic') {
    url.pathname = base + '/v1/messages';
    headers.set('anthropic-version', '2023-06-01');
    return { url, headers, body: JSON.stringify({ ...common, messages, max_tokens: maxOutput }) };
  }
  if (target.protocol === 'openai_responses') {
    url.pathname = base + '/v1/responses';
    return { url, headers, body: JSON.stringify({ ...common, input: prompt, store: false, max_output_tokens: maxOutput }) };
  }
  url.pathname = base + '/v1/chat/completions';
  return { url, headers, body: JSON.stringify({ ...common, messages, max_tokens: maxOutput, n: 1 }) };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function measured(body: Record<string, unknown>, protocol: Target['protocol']): RoutingTokenUsage | null {
  const usage = object(body.usage);
  const chat = protocol === 'openai_chat';
  const anthropic = protocol === 'anthropic';
  let input = usage[chat ? 'prompt_tokens' : 'input_tokens'];
  const output = usage[chat ? 'completion_tokens' : 'output_tokens'];
  const cached = anthropic ? usage.cache_read_input_tokens ?? 0
    : object(usage[chat ? 'prompt_tokens_details' : 'input_tokens_details']).cached_tokens ?? 0;
  const written = anthropic ? usage.cache_creation_input_tokens ?? 0 : 0;
  function valid(count: unknown): count is number {
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  }
  if (!valid(input) || !valid(output) || !valid(cached) || !valid(written)) return null;
  if (!anthropic) {
    if (cached > input) return null;
    input -= cached;
  }
  return { input_tokens: input, output_tokens: output, cache_read_tokens: cached, cache_write_tokens: written };
}

function returnedText(body: Record<string, unknown>, protocol: Target['protocol']) {
  const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (protocol === 'openai_chat') {
    return Array.isArray(body.choices) && body.choices.some(choice => nonEmpty(object(object(choice).message).content));
  }
  const textPart = (value: unknown, kind: string) => Array.isArray(value) &&
    value.some(part => object(part).type === kind && nonEmpty(object(part).text));
  if (protocol === 'anthropic') return textPart(body.content, 'text');
  return Array.isArray(body.output) && body.output.some(row => object(row).type === 'message' && textPart(object(row).content, 'output_text'));
}

function pending(reason_code: string, usage: RoutingTokenUsage | null = null): Outcome {
  return { status: 'pending_reconciliation', reason_code, charged_milli: null, usage };
}

async function execute(target: Target, tariff: Tariff, masterKey: Uint8Array, reserved: number,
  send: ProviderModelProbeFetch): Promise<Outcome> {
  const failed = (reason_code: string): Outcome => ({ status: 'failed', reason_code, charged_milli: 0, usage: null });
  let secret: Buffer;
  try { secret = decryptProviderSecret(masterKey, target.provider_id, target.secret_ciphertext); }
  catch { return failed('missing_credential'); }
  try {
    const apiKey = secret.toString().trim();
    if (!/^[\x21-\x7e]+$/.test(apiKey)) return failed('missing_credential');
    const { url, headers, body } = requestFor(target, apiKey);
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await send(url, headers, signal, body);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const known: Record<number, string> = { 401: 'credential_rejected', 403: 'permission_denied',
        404: 'model_or_protocol_unavailable', 405: 'model_or_protocol_unavailable', 422: 'request_rejected', 429: 'upstream_rate_limited' };
      const reason = known[response.status];
      return reason ? failed(reason) : pending('upstream_outcome_unknown');
    }
    const data = await limitedJson(response, 64 * 1024);
    const usage = measured(data, target.protocol);
    if (!usage) return pending('usage_unavailable');
    const input = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
    if (!Number.isSafeInteger(input) || input > maxInput || usage.output_tokens > maxOutput) return pending('usage_outside_limit', usage);
    const cost = salesCostMilli(usage, tariff);
    if (cost > reserved) return pending('cost_outside_reservation', usage);
    if (typeof data.model === 'string' && data.model !== target.raw_model) {
      return { status: 'failed', reason_code: 'upstream_model_mismatch', charged_milli: cost, usage };
    }
    const text = returnedText(data, target.protocol);
    return { status: text ? 'succeeded' : 'failed', reason_code: text ? null : 'no_text_returned', charged_milli: cost, usage };
  } catch (error) {
    const reason = error instanceof Error && error.message;
    if (reason === 'destination_denied') return failed(reason);
    if (reason === 'probe_timeout' || error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return pending('upstream_timeout');
    }
    if (reason === 'schema_mismatch' || reason === 'response_limit') return pending('usage_unavailable');
    return pending('upstream_outcome_unknown');
  } finally { secret.fill(0); }
}

export function modelProbeRoutes(app: Hono, store: Store, opts: ManagementOptions & { providerModelProbeFetch?: ProviderModelProbeFetch }) {
  app.get(quotaPath, c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const period = periodAt(at);
    const q = c.req.query('q') ?? '';
    if (q.length > 200) invalid('q');
    const page = boundPage(c, opts.codeSecret, actor, { period, q });
    const where = 'WHERE instr(lower(u.name), lower(?))>0 OR instr(lower(a.user_id), lower(?))>0';
    const params = [period, q, q];
    const count = store.system.get<{ n: number }>(`SELECT count(*) n ${quotaJoin} ${where}`, params)!.n;
    const records = store.system.all<Quota>(`SELECT ${quotaColumns} ${quotaJoin} ${where} ORDER BY u.name,a.user_id LIMIT ? OFFSET ?`,
      [...params, page.limit, page.offset]).map(row => ({ ...quotaView(row, period), self: row.user_id === actor }));
    return c.json(page.page(records, count, ['read', 'allocate']));
  });

  app.get(quotaPath + '/:user_id/tests', c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const id = routeId(c.req.param('user_id'), 'user_id');
    const period = c.req.query('period') ?? periodAt(at);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) invalid('period');
    const db = store.system;
    if (!db.get('SELECT 1 FROM platform_admins WHERE user_id=? UNION SELECT 1 FROM platform_model_test_quotas WHERE user_id=? LIMIT 1',
      [id, id])) throw new ApiError('not_found');
    const page = boundPage(c, opts.codeSecret, actor, { id, period });
    const filter = [id, period];
    const count = db.get<{ n: number }>('SELECT count(*) n FROM platform_model_tests WHERE actor_id=? AND period=?', filter)!.n;
    const records = db.all<Job>(`SELECT * FROM platform_model_tests WHERE actor_id=? AND period=?
      ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, [...filter, page.limit, page.offset]).map(row => jobView(row, at));
    return c.json({ ...page.page(records, count, ['read']), period });
  });

  app.post(quotaPath + '/:user_id', async c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const id = routeId(c.req.param('user_id'), 'user_id');
    const body = strictObject(await json(c), 'body', ['expected_revision', 'limit_milli', 'reason']);
    const expected = int(body.expected_revision, 'expected_revision');
    const limit = int(body.limit_milli, 'limit_milli');
    const reason = field(body.reason, 'reason', 500).trim();
    const op = operation(c, opts.codeSecret, at, actor, body);
    if (!op.key) invalid('Idempotency-Key');
    const period = periodAt(at);
    return store.system.write(db => {
      requirePlatformAdmin(db, actor);
      const previous = replay(op, db);
      if (previous) return previous;
      const row = db.get<Quota>(`SELECT ${quotaColumns} ${quotaJoin} WHERE a.user_id=?`, [period, id]);
      if (!row) throw new ApiError('not_found');
      if (row.revision !== expected) throw conflict('revision_changed', row.revision);
      if (limit < row.spent_milli + row.reserved_milli) throw conflict('model_test_quota_below_usage');
      db.run(`INSERT INTO platform_model_test_quotas(user_id,period,limit_milli,revision) VALUES (?,?,?,1)
        ON CONFLICT(user_id,period) DO UPDATE SET limit_milli=excluded.limit_milli,revision=platform_model_test_quotas.revision+1`, [id, period, limit]);
      audit(db, actor, 'model_test.quota.allocate', id, { period, previous_limit_milli: row.limit_milli, limit_milli: limit, reason }, at);
      return op.complete(db, { status: 200, payload: quotaView({ ...row, revision: row.revision + 1, limit_milli: limit }, period) });
    });
  });

  app.get(testPath, c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const discovery = routeId(c.req.param('job_id'), 'job_id');
    const rawFilter = c.req.query('catalog_item_id');
    const catalogue = rawFilter === undefined ? null : routeId(rawFilter, 'catalog_item_id');
    if (!store.system.get("SELECT 1 FROM provider_channel_jobs WHERE id=? AND kind='discovery'", [discovery])) throw new ApiError('not_found');
    if (catalogue && !store.system.get('SELECT 1 FROM provider_channel_discoveries WHERE discovery_id=? AND catalog_item_id=?',
      [discovery, catalogue])) throw new ApiError('not_found');
    const page = boundPage(c, opts.codeSecret, actor, { discovery, catalogue });
    const column = catalogue ? 'catalog_item_id' : 'discovery_id';
    const filter = [catalogue ?? discovery];
    const count = store.system.get<{ n: number }>(`SELECT count(*) n FROM platform_model_tests WHERE ${column}=?`, filter)!.n;
    const records = store.system.all<Job>(`SELECT * FROM platform_model_tests WHERE ${column}=?
      ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, [...filter, page.limit, page.offset]).map(row => jobView(row, at));
    const actions = ['read'];
    let blocked_reason: string | null = null;
    let requires_tariff = false;
    if (catalogue) {
      try {
        const target = currentTarget(store.system, discovery, catalogue);
        requires_tariff = !existingTariff(store.system, target, at);
        const quota = store.system.get<Quota>(`SELECT ${quotaColumns} ${quotaJoin} WHERE a.user_id=?`, [periodAt(at), actor])!;
        if (!opts.masterKey) blocked_reason = 'model_test_key_unavailable';
        else if (quota.revision === 0) blocked_reason = 'model_test_quota_required';
        else if (quota.limit_milli <= quota.spent_milli + quota.reserved_milli) blocked_reason = 'model_test_quota_exhausted';
        else actions.push('run_model_test');
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        blocked_reason = String(error.detail?.reason ?? error.code);
      }
    }
    return c.json({ ...page.page(records, count, actions), requires_tariff, blocked_reason, output_token_limit: maxOutput });
  });

  app.post(testPath, async c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const discovery = routeId(c.req.param('job_id'), 'job_id');
    const body = strictObject(await json(c), 'body', ['catalog_item_id', 'test_tariff']);
    const catalogue = routeId(body.catalog_item_id, 'catalog_item_id');
    const custom = parseTariff(body.test_tariff);
    const key = operation(c, opts.codeSecret, at, actor, body).key;
    if (!key) invalid('Idempotency-Key');
    const fingerprint = digest([discovery, catalogue, custom]);
    const period = periodAt(at);
    const master = opts.masterKey;
    if (!master) throw conflict('model_test_key_unavailable');
    const prepared = await store.system.write(db => {
      requirePlatformAdmin(db, actor);
      const previous = db.get<Job>('SELECT * FROM platform_model_tests WHERE actor_id=? AND request_key=?', [actor, key]);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw conflict('idempotency_mismatch');
        return { previous } as const;
      }
      const target = currentTarget(db, discovery, catalogue);
      const tariff = custom ?? existingTariff(db, target, at);
      if (!tariff) throw conflict('model_test_price_required');
      const amount = reserveFor(tariff);
      const quota = db.get<Quota>(`SELECT ${quotaColumns} ${quotaJoin} WHERE a.user_id=?`, [period, actor])!;
      if (quota.revision === 0) throw conflict('model_test_quota_required');
      if (quota.limit_milli - quota.reserved_milli - quota.spent_milli < amount) throw conflict('model_test_quota_exhausted');
      if (db.get(`SELECT 1 FROM platform_model_tests WHERE actor_id=? AND status='running' AND created_at>=? LIMIT 1`,
        [actor, iso(at - timeoutMs)])) throw conflict('model_test_in_progress');
      const id = `mtest_${ulid()}`;
      db.run('UPDATE platform_model_test_quotas SET reserved_milli=reserved_milli+? WHERE user_id=? AND period=?', [amount, actor, period]);
      db.run(`INSERT INTO platform_model_tests(id,discovery_id,catalog_item_id,raw_model,provider_id,provider_revision,account_id,endpoint_id,endpoint_revision,
        actor_id,period,request_key,fingerprint,created_at,status,reserved_milli,tariff_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?)`,
      [id, discovery, catalogue, target.raw_model, target.provider_id, target.provider_revision, target.account_id, target.endpoint_id,
        target.endpoint_revision, actor, period, key, fingerprint, iso(at), amount, JSON.stringify(tariff)]);
      audit(db, actor, 'model_test.reserve', id, { period, reserved_milli: amount }, at);
      return { id, target, tariff, amount } as const;
    });
    if ('previous' in prepared) return c.json(jobView(prepared.previous!, at), 202);
    const { id, target, tariff, amount } = prepared;
    const outcome = await execute(target, tariff, master, amount, opts.providerModelProbeFetch ?? postModelProbeOverHttp);
    const finished = opts.now();
    const recorded = await store.system.write(db => {
      const latest = db.get<Job>('SELECT * FROM platform_model_tests WHERE id=?', [id])!;
      if (latest.status !== 'running') return latest;
      if (outcome.charged_milli !== null) db.run(`UPDATE platform_model_test_quotas SET reserved_milli=reserved_milli-?,spent_milli=spent_milli+?
        WHERE user_id=? AND period=?`, [amount, outcome.charged_milli, actor, period]);
      db.run(`UPDATE platform_model_tests SET status=?,reason_code=?,completed_at=?,charged_milli=?,usage_json=? WHERE id=?`,
        [outcome.status, outcome.reason_code, iso(finished), outcome.charged_milli, outcome.usage ? JSON.stringify(outcome.usage) : null, id]);
      audit(db, actor, 'model_test.finish', id, { status: outcome.status, charged_milli: outcome.charged_milli,
        reason_code: outcome.reason_code }, finished);
      return db.get<Job>('SELECT * FROM platform_model_tests WHERE id=?', [id])!;
    });
    return c.json(jobView(recorded, finished), 202);
  });

  app.post(testPath + '/:test_id/reconcile', async c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const discovery = routeId(c.req.param('job_id'), 'job_id');
    const test = routeId(c.req.param('test_id'), 'test_id');
    const body = strictObject(await json(c), 'body', ['charged_milli', 'reason', 'evidence_reference']);
    const charged = int(body.charged_milli, 'charged_milli');
    const reason = field(body.reason, 'reason', 500).trim();
    const evidence = field(body.evidence_reference, 'evidence_reference', 250).trim();
    const op = operation(c, opts.codeSecret, at, actor, body);
    if (!op.key) invalid('Idempotency-Key');
    return store.system.write(db => {
      requirePlatformAdmin(db, actor);
      const cached = replay(op, db);
      if (cached) return cached;
      const job = db.get<Job>('SELECT * FROM platform_model_tests WHERE id=? AND discovery_id=?', [test, discovery]);
      if (!job) throw new ApiError('not_found');
      if (!canReconcile(job, at)) throw conflict('model_test_not_pending_reconciliation');
      if (charged > job.reserved_milli) throw conflict('cost_outside_reservation');
      const reconciliation = { actor_id: actor, reconciled_at: iso(at), reason, evidence_reference: evidence };
      db.run(`UPDATE platform_model_test_quotas SET reserved_milli=reserved_milli-?,spent_milli=spent_milli+?
        WHERE user_id=? AND period=?`, [job.reserved_milli, charged, job.actor_id, job.period]);
      db.run(`UPDATE platform_model_tests SET status='failed',reason_code='reconciled_manually',completed_at=coalesce(completed_at,?),
        charged_milli=?,reconciliation_json=? WHERE id=?`, [iso(at), charged, JSON.stringify(reconciliation), test]);
      audit(db, actor, 'model_test.reconcile', test, { ...reconciliation, charged_milli: charged }, at);
      return op.complete(db, { status: 200, payload: jobView(db.get<Job>('SELECT * FROM platform_model_tests WHERE id=?', [test])!, at) });
    });
  });
}
