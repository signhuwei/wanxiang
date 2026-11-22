import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { hmac, iso } from './credentials';
import { int, platformActor, type ManagementOptions } from './management';
import { assessMember, currentIdentity, headRevision, poolMembers, requireDraftableModel, requireModel } from './model-pool';
import { applicableFx, applicableQuote } from './procurement';
import { canonical, digest, replay, requirePlatformAdmin, routeId, routeIdPattern, strictObject, utcTime } from './routing-http';
import { recommendInputMultiplier, type InputPriceChannel } from './routing-money';
import type { Store, Transaction } from './store';

type Reader = Pick<Transaction, 'get' | 'all'>;
export const INPUT_MULTIPLIER_BASIS = 'cny_1_per_mtok_input';
const MAX_PPM = 1_000_000_000_000;
type Request = { expected_pool_revision: number; expected_source_rate_key: string | null; pricing_at: string | null;
  manual_input_multiplier_ppm: number | null; reason: string | null };
export type PricingChannel = {
  deployment_id: string; deployment_revision: number; quote_id: string | null; quote_revision: number | null; currency: string | null;
  amount_micro: string | null; quantity_basis: number | null; unit: string | null; fx_revision: number | null; rate_numerator: string | null;
  rate_denominator: string | null; input_cny_micro_per_mtok: string | null; reason_code?: string; eligibility_codes?: string[];
};
type SalesBase = { output_milli_per_mtok: number; cache_read_milli_per_mtok: number; cache_write_milli_per_mtok: number; source: string };
type VersionRow = { source_rate_key: string; model_id: string; input_multiplier_basis: string; input_multiplier_ppm: number;
  recommended_input_multiplier_ppm: number | null; input_milli_per_mtok: number; output_milli_per_mtok: number; cache_read_milli_per_mtok: number;
  cache_write_milli_per_mtok: number; sales_rates_source: string; pool_revision: number; pricing_at: string; calculation_status: string;
  based_on_source_rate_key: string | null; source_digest: string; override_reason: string | null; status: string; created_by: string; created_at: string };

const messages: Record<string, string> = {
  multiplier_unavailable: '没有可用的建议倍率，请手工填写倍率和理由',
  missing_sales_rates: '没有可沿用的输出和缓存费率',
  reason_required: '存在缺项、偏离建议或手调为零时必须填写理由',
  multiplier_out_of_range: '报价换算后的倍率超出可表示范围',
};
const issue = (code: string) => ({ code, message: messages[code] ?? code });

export function parseMultiplierRequest(body: Record<string, unknown>, publish: boolean): Request & { preview_basis?: string } {
  strictObject(body, 'body', ['expected_pool_revision', 'expected_source_rate_key', 'pricing_at', 'manual_input_multiplier_ppm', 'reason',
    ...(publish ? ['preview_basis'] : [])]);
  if (!('expected_source_rate_key' in body)) invalid('expected_source_rate_key');
  const manual = body.manual_input_multiplier_ppm;
  const manual_input_multiplier_ppm = manual === undefined || manual === null ? null : int(manual, 'manual_input_multiplier_ppm', 0, MAX_PPM);
  if (manual_input_multiplier_ppm !== null && manual_input_multiplier_ppm % 1000 !== 0) invalid('manual_input_multiplier_ppm');
  if (publish && (body.pricing_at === undefined || body.pricing_at === null)) invalid('pricing_at');
  return {
    expected_pool_revision: int(body.expected_pool_revision, 'expected_pool_revision'),
    expected_source_rate_key: body.expected_source_rate_key === null ? null : routeId(body.expected_source_rate_key, 'expected_source_rate_key'),
    pricing_at: body.pricing_at === undefined || body.pricing_at === null ? null : utcTime(body.pricing_at, 'pricing_at'),
    manual_input_multiplier_ppm,
    reason: body.reason === undefined || body.reason === null ? null : field(body.reason, 'reason', 500),
    ...(publish && { preview_basis: field(body.preview_basis, 'preview_basis', 256) }),
  };
}

export const rateHead = (sql: Reader, modelId: string) =>
  sql.get<{ source_rate_key: string }>('SELECT source_rate_key FROM platform_rate_heads WHERE model_id = ?', [modelId])?.source_rate_key ?? null;
const version = (sql: Reader, key: string) => sql.get<VersionRow>('SELECT * FROM platform_rate_versions WHERE source_rate_key = ?', [key]) ?? null;

/** Output and cache rates carry over unchanged: from the current signable version, otherwise the legacy platform rate. */
function salesBase(sql: Reader, modelId: string, headKey: string | null, at: string): SalesBase | null {
  if (headKey) {
    const row = version(sql, headKey)!;
    return { output_milli_per_mtok: row.output_milli_per_mtok, cache_read_milli_per_mtok: row.cache_read_milli_per_mtok,
      cache_write_milli_per_mtok: row.cache_write_milli_per_mtok, source: `platform_rate:${headKey}` };
  }
  const legacy = sql.get<{ output_milli_per_mtok: number; cache_read_milli_per_mtok: number; cache_write_milli_per_mtok: number; effective_from: string }>(
    `SELECT output_milli_per_mtok, cache_read_milli_per_mtok, cache_write_milli_per_mtok, effective_from FROM rates
     WHERE model_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1`, [modelId, at]);
  return legacy ? { output_milli_per_mtok: legacy.output_milli_per_mtok, cache_read_milli_per_mtok: legacy.cache_read_milli_per_mtok,
    cache_write_milli_per_mtok: legacy.cache_write_milli_per_mtok, source: `legacy_rate:${modelId}@${legacy.effective_from}` } : null;
}

const ceilDiv = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;

/** One pricing sample per active-pool member at `at`. Cooling and balance are not inputs; pool qualification is. */
function priceChannels(sql: Reader, modelId: string, poolRevision: number, at: string) {
  const identity = currentIdentity(sql, modelId);
  const rows: PricingChannel[] = [];
  const money: InputPriceChannel[] = [];
  for (const member of poolMembers(sql, modelId, poolRevision)) {
    const empty: PricingChannel = { deployment_id: member.deployment_id, deployment_revision: member.deployment_revision, quote_id: null, quote_revision: null,
      currency: null, amount_micro: null, quantity_basis: null, unit: null, fx_revision: null, rate_numerator: null, rate_denominator: null,
      input_cny_micro_per_mtok: null };
    const reject = (row: PricingChannel, reason_code: string, extra: Partial<PricingChannel> = {}) => {
      rows.push({ ...row, reason_code, ...extra });
      money.push({ deployment_id: member.deployment_id, reason_code });
    };
    const { codes } = assessMember(sql, modelId, identity, member, at);
    if (codes.length) { reject(empty, 'deployment_ineligible', { eligibility_codes: codes }); continue; }
    const found = applicableQuote(sql, member.deployment_id, member.deployment_revision, at);
    if (!('items' in found)) {
      const ref = found.quote ? { quote_id: found.quote.quote_id, quote_revision: found.quote.quote_revision, currency: found.quote.currency } : {};
      reject({ ...empty, ...ref }, found.reason_code === 'missing_quote' ? 'missing_input_quote' : found.reason_code);
      continue;
    }
    const input = found.items.find((item) => item.dimension === 'input');
    const quoted = { ...empty, quote_id: found.quote.quote_id, quote_revision: found.quote.quote_revision, currency: found.quote.currency };
    if (!input) { reject(quoted, 'missing_input_quote'); continue; }
    if (input.unit !== 'token') { reject(quoted, 'invalid_input_unit'); continue; }
    const priced = { ...quoted, amount_micro: input.rate_micro, quantity_basis: input.quantity_basis, unit: input.unit };
    let fx = { fx_revision: null as number | null, rate_numerator: '1', rate_denominator: '1' };
    if (found.quote.currency !== 'CNY') {
      const rate = applicableFx(sql, found.quote.currency, at);
      if ('reason_code' in rate) {
        reject({ ...priced, ...(rate.fx && { fx_revision: rate.fx.fx_revision }) }, rate.reason_code);
        continue;
      }
      fx = { fx_revision: rate.fx.fx_revision, rate_numerator: rate.fx.rate_numerator, rate_denominator: rate.fx.rate_denominator };
    }
    const display = ceilDiv(BigInt(input.rate_micro) * 1_000_000n * BigInt(fx.rate_numerator), BigInt(input.quantity_basis) * BigInt(fx.rate_denominator));
    rows.push({ ...priced, ...fx, input_cny_micro_per_mtok: display.toString() });
    money.push({ deployment_id: member.deployment_id, currency: found.quote.currency,
      input: { rate_micro: input.rate_micro, quantity_basis: input.quantity_basis },
      fx: found.quote.currency === 'CNY' ? null : { base_currency: found.quote.currency, quote_currency: 'CNY',
        rate_numerator: fx.rate_numerator, rate_denominator: fx.rate_denominator } });
  }
  return { rows, recommendation: safeRecommendation(money) };
}

/** A quote too large to express as a safe-integer ppm is reported, not thrown as a server error. */
function safeRecommendation(money: InputPriceChannel[]) {
  try { return { ...recommendInputMultiplier(money), out_of_range: false }; } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { calculation_status: 'unavailable' as const, recommended_input_multiplier_ppm: null, unavailable: [], out_of_range: true };
  }
}

/** References that must stay the same between the preview's pricing_at and the publish instant. */
const channelRefs = (rows: PricingChannel[]) => rows.map((row) => [row.deployment_id, row.deployment_revision, row.quote_id, row.quote_revision,
  row.fx_revision, row.reason_code ?? null, row.eligibility_codes ?? null]);

export function evaluateMultiplier(sql: Reader, secret: string, actor: string, modelId: string, request: Request, pricingAt: string) {
  const pool_revision = headRevision(sql, modelId);
  const source_rate_key = rateHead(sql, modelId);
  const { rows, recommendation } = priceChannels(sql, modelId, pool_revision, pricingAt);
  const recommended = recommendation.recommended_input_multiplier_ppm;
  const final = request.manual_input_multiplier_ppm ?? recommended;
  const base = salesBase(sql, modelId, source_rate_key, pricingAt);
  const blocking = [];
  if (recommendation.out_of_range) blocking.push(issue('multiplier_out_of_range'));
  if (final === null) blocking.push(issue('multiplier_unavailable'));
  if (!base) blocking.push(issue('missing_sales_rates'));
  const needsReason = recommendation.calculation_status !== 'complete' || final === 0
    || (request.manual_input_multiplier_ppm !== null && request.manual_input_multiplier_ppm !== recommended);
  if (needsReason && !request.reason) blocking.push(issue('reason_required'));
  const normalized = { expected_pool_revision: request.expected_pool_revision, expected_source_rate_key: request.expected_source_rate_key,
    pricing_at: pricingAt, manual_input_multiplier_ppm: request.manual_input_multiplier_ppm, reason: request.reason };
  // Any new version in a related quote or FX series, even one starting later, invalidates the preview.
  const quoteHeads = rows.map((row) => [row.deployment_id, sql.get<{ head_revision: number }>(
    'SELECT head_revision FROM procurement_quote_heads WHERE deployment_id = ?', [row.deployment_id])?.head_revision ?? 0]);
  const fxHeads = [...new Set(rows.map((row) => row.currency).filter((code): code is string => !!code && code !== 'CNY'))].sort().map((code) =>
    [code, sql.get<{ head_revision: number }>("SELECT head_revision FROM procurement_fx_heads WHERE base_currency = ? AND quote_currency = 'CNY'",
      [code])?.head_revision ?? 0]);
  const preview_basis = 'pv_' + hmac(secret, ['input_multiplier_preview', 1, actor, modelId, canonical(normalized), pool_revision,
    source_rate_key, rows, base, recommended, final, recommendation.calculation_status, quoteHeads, fxHeads]);
  return {
    pool_revision, source_rate_key, rows, base, blocking, preview_basis, publishable: blocking.length === 0,
    view: {
      model_id: modelId, expected_pool_revision: request.expected_pool_revision, expected_source_rate_key: request.expected_source_rate_key,
      pool_revision, pricing_at: pricingAt, input_multiplier_basis: INPUT_MULTIPLIER_BASIS, calculation_status: recommendation.calculation_status,
      channels: rows, recommended_input_multiplier_ppm: recommended, input_multiplier_ppm: final,
      input_milli_per_mtok: final === null ? null : final / 1000,
      output_milli_per_mtok: base?.output_milli_per_mtok ?? null, cache_read_milli_per_mtok: base?.cache_read_milli_per_mtok ?? null,
      cache_write_milli_per_mtok: base?.cache_write_milli_per_mtok ?? null, sales_rates_source: base?.source ?? null,
      manual_input_multiplier_ppm: request.manual_input_multiplier_ppm, reason: request.reason, blocking, preview_basis,
    },
  };
}

const versionConflict = (reason: string, poolRevision: number, rateKey: string | null, changed: string[] = []) =>
  new ApiError('conflict', { reason, current_pool_revision: poolRevision, current_source_rate_key: rateKey, ...(changed.length && { changed }) });

function checkExpected(sql: Reader, modelId: string, request: Request) {
  const pool = headRevision(sql, modelId), key = rateHead(sql, modelId);
  const changed = [...(request.expected_pool_revision !== pool ? ['pool_revision'] : []),
    ...(request.expected_source_rate_key !== key ? ['source_rate_key'] : [])];
  if (changed.length) throw versionConflict('revision_changed', pool, key, changed);
}

function versionView(sql: Reader, row: VersionRow) {
  const channels = sql.all<PricingChannel & { reason_code: string | null; source_rate_key: string }>(`SELECT * FROM platform_rate_channels
    WHERE source_rate_key = ? ORDER BY deployment_id`, [row.source_rate_key]).map(({ source_rate_key: _, reason_code, ...rest }) =>
    ({ ...rest, ...(reason_code !== null && { reason_code }) }));
  return {
    model_id: row.model_id, source_rate_key: row.source_rate_key, input_multiplier_basis: row.input_multiplier_basis,
    input_multiplier_ppm: row.input_multiplier_ppm, recommended_input_multiplier_ppm: row.recommended_input_multiplier_ppm,
    input_milli_per_mtok: row.input_milli_per_mtok, output_milli_per_mtok: row.output_milli_per_mtok,
    cache_read_milli_per_mtok: row.cache_read_milli_per_mtok, cache_write_milli_per_mtok: row.cache_write_milli_per_mtok,
    sales_rates_source: row.sales_rates_source, pool_revision: row.pool_revision, pricing_at: row.pricing_at,
    calculation_status: row.calculation_status, based_on_source_rate_key: row.based_on_source_rate_key, override_reason: row.override_reason,
    status: row.status, channels, created_by: row.created_by, created_at: row.created_at,
    current: rateHead(sql, row.model_id) === row.source_rate_key, actions: ['read'],
  };
}

/** Ledger fields for the platform models list. Legacy rates show their exact input multiplier until a signable version exists. */
export function modelPricingSummary(sql: Reader, modelId: string, active: boolean, at: string) {
  const key = rateHead(sql, modelId);
  const ppm = key ? version(sql, key)!.input_multiplier_ppm : (sql.get<{ input_milli_per_mtok: number }>(`SELECT input_milli_per_mtok FROM rates
    WHERE model_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1`, [modelId, at])?.input_milli_per_mtok ?? null);
  return { current_source_rate_key: key, input_multiplier_ppm: ppm === null ? null : key ? ppm : ppm * 1000,
    actions: active ? ['preview_input_multiplier'] : [] };
}

export function inputMultiplierRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const base = '/v1/platform/models/:model_id/input-multiplier';

  app.post(`${base}/preview`, async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const modelId = c.req.param('model_id');
    const request = parseMultiplierRequest(body, false);
    const sql = store.system;
    requireDraftableModel(sql, modelId);
    checkExpected(sql, modelId, request);
    const result = evaluateMultiplier(sql, opts.codeSecret, actor, modelId, request, request.pricing_at ?? iso(at));
    return c.json({ ...result.view, actions: ['read', ...(result.publishable ? ['publish_input_multiplier'] : [])] });
  });

  app.post(`${base}/revisions`, async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const modelId = c.req.param('model_id');
    if (!c.req.header('Idempotency-Key')) invalid('Idempotency-Key');
    const request = parseMultiplierRequest(body, true);
    const op = operation(c, opts.codeSecret, at, actor, request);
    return store.system.write((sql) => {
      requirePlatformAdmin(sql, actor);
      const cached = replay(op, sql);
      if (cached) return cached;
      requireDraftableModel(sql, modelId);
      checkExpected(sql, modelId, request);
      const now = iso(at);
      const result = evaluateMultiplier(sql, opts.codeSecret, actor, modelId, request, request.pricing_at!);
      if (result.preview_basis !== request.preview_basis || !result.publishable) {
        throw versionConflict('preview_stale', result.pool_revision, result.source_rate_key, ['preview_basis']);
      }
      // A preview priced at another instant is only valid while the same quote, FX and eligibility still apply now.
      const live = evaluateMultiplier(sql, opts.codeSecret, actor, modelId, request, now);
      if (digest(channelRefs(live.rows)) !== digest(channelRefs(result.rows)) || live.base?.source !== result.base?.source) {
        throw versionConflict('preview_stale', result.pool_revision, result.source_rate_key, ['pricing_window']);
      }
      const view = result.view;
      const key = `prate_${ulid()}`;
      const sourceDigest = digest({ channels: result.rows, base: result.base, pool_revision: result.pool_revision, pricing_at: request.pricing_at });
      sql.run(`INSERT INTO platform_rate_versions (source_rate_key, model_id, input_multiplier_basis, input_multiplier_ppm, recommended_input_multiplier_ppm,
        input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok, cache_write_milli_per_mtok, sales_rates_source, pool_revision, pricing_at,
        calculation_status, based_on_source_rate_key, source_digest, override_reason, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available_to_sign', ?, ?)`,
        [key, modelId, INPUT_MULTIPLIER_BASIS, view.input_multiplier_ppm!, view.recommended_input_multiplier_ppm, view.input_milli_per_mtok!,
          result.base!.output_milli_per_mtok, result.base!.cache_read_milli_per_mtok, result.base!.cache_write_milli_per_mtok, result.base!.source,
          result.pool_revision, request.pricing_at!, view.calculation_status, result.source_rate_key, sourceDigest, request.reason, actor, now]);
      for (const row of result.rows) {
        sql.run(`INSERT INTO platform_rate_channels (source_rate_key, deployment_id, deployment_revision, quote_id, quote_revision, currency, amount_micro,
          quantity_basis, unit, fx_revision, rate_numerator, rate_denominator, input_cny_micro_per_mtok, reason_code)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [key, row.deployment_id, row.deployment_revision, row.quote_id, row.quote_revision,
          row.currency, row.amount_micro, row.quantity_basis, row.unit, row.fx_revision, row.rate_numerator, row.rate_denominator,
          row.input_cny_micro_per_mtok, row.reason_code ?? null]);
      }
      sql.run(`INSERT INTO platform_rate_heads (model_id, source_rate_key, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET source_rate_key = excluded.source_rate_key, updated_at = excluded.updated_at`, [modelId, key, now]);
      sql.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${ulid()}`, actor, 'input_multiplier.publish', modelId, JSON.stringify({ source_rate_key: key, based_on: result.source_rate_key,
          input_multiplier_ppm: view.input_multiplier_ppm, recommended_input_multiplier_ppm: view.recommended_input_multiplier_ppm,
          calculation_status: view.calculation_status, pool_revision: result.pool_revision }), now]);
      return op.complete(sql, { status: 201, payload: { model_id: modelId, source_rate_key: key, input_multiplier_basis: INPUT_MULTIPLIER_BASIS,
        input_multiplier_ppm: view.input_multiplier_ppm, input_milli_per_mtok: view.input_milli_per_mtok, status: 'available_to_sign' } });
    });
  });

  app.get(`${base}/revisions/:source_rate_key`, (c) => {
    platformActor(store, c, opts.now());
    const modelId = c.req.param('model_id');
    requireModel(store.system, modelId);
    const key = c.req.param('source_rate_key');
    const row = routeIdPattern.test(key) ? version(store.system, key) : null;
    if (!row || row.model_id !== modelId) throw new ApiError('not_found');
    return c.json(versionView(store.system, row));
  });
}
