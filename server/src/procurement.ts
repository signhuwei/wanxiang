import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { iso } from './credentials';
import { int, platformActor, type ManagementOptions } from './management';
import { boundPage, conflict, currencyCode, decimalText, queryValue, replay, requirePlatformAdmin, routeIdPattern, strictObject,
  utcTime } from './routing-http';
import type { Store, Transaction } from './store';

type Reader = Pick<Transaction, 'get' | 'all'>;
export const quoteDimensions = ['input', 'output', 'cache_read', 'cache_write', 'request'] as const;
type Dimension = typeof quoteDimensions[number];
export type QuoteItem = { dimension: Dimension; rate_micro: string; quantity_basis: number; unit: 'token' | 'request' };
type QuoteRow = { quote_id: string; quote_revision: number; deployment_id: string; deployment_revision: number; provider_id: string;
  account_id: string; currency: string; tariff_scope_kind: string; valid_from: string; valid_until: string | null; source_kind: string;
  source_reference: string | null; reason: string; published_by: string; published_at: string };
type FxRow = { base_currency: string; quote_currency: string; fx_revision: number; rate_numerator: string; rate_denominator: string;
  observed_at: string; valid_from: string; valid_until: string; source_kind: string; source_reference: string | null; reason: string;
  published_by: string; published_at: string };

/** Lookup end of a version: its own validity or the next later start, whichever comes first. */
const lookupUntil = (validUntil: string | null, nextFrom: string | null) =>
  validUntil === null ? nextFrom : nextFrom === null ? validUntil : (nextFrom < validUntil ? nextFrom : validUntil);

function source(body: unknown) {
  const row = strictObject(body, 'source', ['kind', 'reference']);
  if (row.kind !== 'manual') invalid('source.kind');
  return { kind: 'manual' as const, reference: row.reference === undefined || row.reference === null ? null : field(row.reference, 'source.reference', 200) };
}

function parseItems(value: unknown): QuoteItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > quoteDimensions.length) invalid('items');
  const items = value.map((raw, i) => {
    const row = strictObject(raw, `items[${i}]`, ['dimension', 'rate_micro', 'quantity_basis', 'unit']);
    if (typeof row.dimension !== 'string' || !(quoteDimensions as readonly string[]).includes(row.dimension)) invalid(`items[${i}].dimension`);
    const dimension = row.dimension as Dimension;
    const unit = row.unit;
    if (unit !== (dimension === 'request' ? 'request' : 'token')) invalid(`items[${i}].unit`);
    return { dimension, rate_micro: decimalText(row.rate_micro, `items[${i}].rate_micro`),
      quantity_basis: int(row.quantity_basis, `items[${i}].quantity_basis`, 1), unit: unit as QuoteItem['unit'] };
  });
  if (new Set(items.map((row) => row.dimension)).size !== items.length) invalid('items');
  return items.sort((a, b) => quoteDimensions.indexOf(a.dimension) - quoteDimensions.indexOf(b.dimension));
}

export function parseQuote(body: Record<string, unknown>) {
  strictObject(body, 'body', ['deployment_revision', 'expected_quote_revision', 'currency', 'tariff_scope', 'valid_from', 'valid_until', 'source', 'reason', 'items']);
  const scope = strictObject(body.tariff_scope, 'tariff_scope', ['kind']);
  if (scope.kind !== 'deployment') invalid('tariff_scope.kind');
  const valid_from = utcTime(body.valid_from, 'valid_from');
  const valid_until = body.valid_until === undefined || body.valid_until === null ? null : utcTime(body.valid_until, 'valid_until');
  if (valid_until !== null && valid_until <= valid_from) invalid('valid_until');
  return {
    deployment_revision: int(body.deployment_revision, 'deployment_revision', 1),
    expected_quote_revision: int(body.expected_quote_revision, 'expected_quote_revision'),
    currency: currencyCode(body.currency, 'currency'), tariff_scope: { kind: 'deployment' as const }, valid_from, valid_until,
    source: source(body.source), reason: field(body.reason, 'reason', 500), items: parseItems(body.items),
  };
}

export function parseFx(body: Record<string, unknown>) {
  strictObject(body, 'body', ['base_currency', 'quote_currency', 'expected_fx_revision', 'rate_numerator', 'rate_denominator', 'observed_at',
    'valid_from', 'valid_until', 'source', 'reason']);
  const base_currency = currencyCode(body.base_currency, 'base_currency');
  if (base_currency === 'CNY') invalid('base_currency');
  if (body.quote_currency !== 'CNY') invalid('quote_currency');
  const valid_from = utcTime(body.valid_from, 'valid_from');
  const valid_until = utcTime(body.valid_until, 'valid_until');
  if (valid_until <= valid_from) invalid('valid_until');
  return {
    base_currency, quote_currency: 'CNY' as const, expected_fx_revision: int(body.expected_fx_revision, 'expected_fx_revision'),
    rate_numerator: decimalText(body.rate_numerator, 'rate_numerator', true), rate_denominator: decimalText(body.rate_denominator, 'rate_denominator', true),
    observed_at: utcTime(body.observed_at, 'observed_at'), valid_from, valid_until, source: source(body.source), reason: field(body.reason, 'reason', 500),
  };
}

function quoteItems(sql: Reader, quoteId: string, revision: number) {
  return sql.all<QuoteItem>(`SELECT dimension, rate_micro, quantity_basis, unit FROM procurement_quote_items WHERE quote_id = ? AND quote_revision = ?`,
    [quoteId, revision]).sort((a, b) => quoteDimensions.indexOf(a.dimension) - quoteDimensions.indexOf(b.dimension));
}
/** The immutable published form; replay returns exactly this. */
function quoteRecord(sql: Reader, row: QuoteRow) {
  return {
    quote_id: row.quote_id, quote_revision: row.quote_revision, deployment_id: row.deployment_id, deployment_revision: row.deployment_revision,
    provider_id: row.provider_id, account_id: row.account_id, currency: row.currency, tariff_scope: { kind: row.tariff_scope_kind },
    valid_from: row.valid_from, valid_until: row.valid_until, source: { kind: row.source_kind, reference: row.source_reference },
    reason: row.reason, items: quoteItems(sql, row.quote_id, row.quote_revision), published_by: row.published_by, published_at: row.published_at,
    actions: ['read'],
  };
}
function nextQuoteStart(sql: Reader, row: QuoteRow) {
  return sql.get<{ valid_from: string }>(`SELECT valid_from FROM procurement_quotes WHERE quote_id = ? AND valid_from > ?
    ORDER BY valid_from LIMIT 1`, [row.quote_id, row.valid_from])?.valid_from ?? null;
}
/** Read form: the record plus the server-derived lookup window. */
function quoteView(sql: Reader, row: QuoteRow) {
  const next = nextQuoteStart(sql, row);
  return { ...quoteRecord(sql, row), lookup_until: lookupUntil(row.valid_until, next), superseded_from: next };
}

export type QuoteLookup =
  | { quote: QuoteRow; items: QuoteItem[] }
  | { reason_code: 'missing_quote' | 'quote_expired' | 'quote_deployment_revision_changed'; quote?: QuoteRow };
/**
 * The version whose start is the latest at or before `at`. A later expiry never revives an older version,
 * and the quote must be for the exact deployment revision.
 */
export function applicableQuote(sql: Reader, deploymentId: string, deploymentRevision: number, at: string): QuoteLookup {
  const row = sql.get<QuoteRow>(`SELECT q.* FROM procurement_quote_heads h JOIN procurement_quotes q ON q.quote_id = h.quote_id
    WHERE h.deployment_id = ? AND q.valid_from <= ? ORDER BY q.valid_from DESC LIMIT 1`, [deploymentId, at]);
  if (!row) return { reason_code: 'missing_quote' };
  if (row.valid_until !== null && row.valid_until <= at) return { reason_code: 'quote_expired', quote: row };
  if (row.deployment_revision !== deploymentRevision) return { reason_code: 'quote_deployment_revision_changed', quote: row };
  return { quote: row, items: quoteItems(sql, row.quote_id, row.quote_revision) };
}

export type FxLookup = { fx: FxRow } | { reason_code: 'missing_fx' | 'fx_expired'; fx?: FxRow };
export function applicableFx(sql: Reader, base: string, at: string): FxLookup {
  const row = sql.get<FxRow>(`SELECT * FROM procurement_fx_rates WHERE base_currency = ? AND quote_currency = 'CNY' AND valid_from <= ?
    ORDER BY valid_from DESC LIMIT 1`, [base, at]);
  if (!row) return { reason_code: 'missing_fx' };
  if (row.valid_until <= at) return { reason_code: 'fx_expired', fx: row };
  return { fx: row };
}
function fxRecord(row: FxRow) {
  return {
    base_currency: row.base_currency, quote_currency: row.quote_currency, fx_revision: row.fx_revision, rate_numerator: row.rate_numerator,
    rate_denominator: row.rate_denominator, observed_at: row.observed_at, valid_from: row.valid_from, valid_until: row.valid_until,
    source: { kind: row.source_kind, reference: row.source_reference }, reason: row.reason, published_by: row.published_by,
    published_at: row.published_at, actions: ['read'],
  };
}
function fxView(sql: Reader, row: FxRow) {
  const next = sql.get<{ valid_from: string }>(`SELECT valid_from FROM procurement_fx_rates WHERE base_currency = ? AND quote_currency = ?
    AND valid_from > ? ORDER BY valid_from LIMIT 1`, [row.base_currency, row.quote_currency, row.valid_from])?.valid_from ?? null;
  return { ...fxRecord(row), lookup_until: lookupUntil(row.valid_until, next), superseded_from: next };
}

function deploymentHead(sql: Reader, deploymentId: string) {
  const row = routeIdPattern.test(deploymentId) ? sql.get<{ deployment_id: string; provider_id: string; account_id: string; status: string;
    current_revision: number }>('SELECT deployment_id, provider_id, account_id, status, current_revision FROM model_deployments WHERE deployment_id = ?',
    [deploymentId]) : null;
  if (!row) throw new ApiError('not_found');
  return row;
}
const quoteHead = (sql: Reader, deploymentId: string) =>
  sql.get<{ quote_id: string; head_revision: number }>('SELECT quote_id, head_revision FROM procurement_quote_heads WHERE deployment_id = ?', [deploymentId]) ?? null;
const fxHead = (sql: Reader, base: string) =>
  sql.get<{ head_revision: number }>("SELECT head_revision FROM procurement_fx_heads WHERE base_currency = ? AND quote_currency = 'CNY'", [base])?.head_revision ?? 0;
const asOf = (value: string | undefined) => value === undefined ? undefined : utcTime(value, 'as_of');

export function procurementRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const P = '/v1/platform';

  app.post(`${P}/deployments/:deployment_id/quotes`, async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    if (!c.req.header('Idempotency-Key')) invalid('Idempotency-Key');
    const deploymentId = c.req.param('deployment_id');
    const draft = parseQuote(body);
    const op = operation(c, opts.codeSecret, at, actor, draft);
    return store.system.write((sql) => {
      requirePlatformAdmin(sql, actor);
      const cached = replay(op, sql);
      if (cached) return cached;
      const deployment = deploymentHead(sql, deploymentId);
      const head = quoteHead(sql, deploymentId);
      const current = head?.head_revision ?? 0;
      if (draft.expected_quote_revision !== current) throw conflict('revision_changed', current, ['quote_revision']);
      if (deployment.status === 'archived') throw conflict('deployment_archived', current);
      if (draft.deployment_revision !== deployment.current_revision) throw conflict('revision_changed', current, ['deployment_revision']);
      if (head) {
        const latest = sql.get<{ valid_from: string }>('SELECT valid_from FROM procurement_quotes WHERE quote_id = ? AND quote_revision = ?',
          [head.quote_id, head.head_revision])!;
        if (draft.valid_from <= latest.valid_from) throw new ApiError('invalid', { fields: ['valid_from'], issues: [{ code: 'valid_from_not_after_head' }] });
      }
      const now = iso(at);
      const quoteId = head?.quote_id ?? `quote_${ulid()}`;
      const revision = current + 1;
      if (head) sql.run('UPDATE procurement_quote_heads SET head_revision = ?, updated_at = ? WHERE deployment_id = ?', [revision, now, deploymentId]);
      else sql.run('INSERT INTO procurement_quote_heads (deployment_id, quote_id, head_revision, updated_at) VALUES (?, ?, ?, ?)', [deploymentId, quoteId, revision, now]);
      sql.run(`INSERT INTO procurement_quotes (quote_id, quote_revision, deployment_id, deployment_revision, provider_id, account_id, currency,
        tariff_scope_kind, valid_from, valid_until, source_kind, source_reference, reason, published_by, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'deployment', ?, ?, 'manual', ?, ?, ?, ?)`, [quoteId, revision, deploymentId, draft.deployment_revision,
        deployment.provider_id, deployment.account_id, draft.currency, draft.valid_from, draft.valid_until, draft.source.reference, draft.reason, actor, now]);
      for (const item of draft.items) {
        sql.run(`INSERT INTO procurement_quote_items (quote_id, quote_revision, dimension, rate_micro, quantity_basis, unit) VALUES (?, ?, ?, ?, ?, ?)`,
          [quoteId, revision, item.dimension, item.rate_micro, item.quantity_basis, item.unit]);
      }
      sql.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${ulid()}`, actor, 'procurement_quote.publish', deploymentId, JSON.stringify({ quote_id: quoteId, quote_revision: revision,
          deployment_revision: draft.deployment_revision, valid_from: draft.valid_from, valid_until: draft.valid_until }), now]);
      const row = sql.get<QuoteRow>('SELECT * FROM procurement_quotes WHERE quote_id = ? AND quote_revision = ?', [quoteId, revision])!;
      return op.complete(sql, { status: 201, payload: quoteRecord(sql, row) });
    });
  });

  app.get(`${P}/deployments/:deployment_id/quotes`, (c) => {
    const actor = platformActor(store, c, opts.now());
    const deploymentId = c.req.param('deployment_id');
    const sql = store.system;
    const deployment = deploymentHead(sql, deploymentId);
    const when = asOf(queryValue(c, 'as_of'));
    const p = boundPage(c, opts.codeSecret, actor, { deploymentId, as_of: when ?? null });
    const head = quoteHead(sql, deploymentId);
    const total = head?.head_revision ?? 0;
    const rows = head ? sql.all<QuoteRow>(`SELECT * FROM procurement_quotes WHERE quote_id = ? ORDER BY quote_revision DESC LIMIT ? OFFSET ?`,
      [head.quote_id, p.limit, p.offset]) : [];
    const result: Record<string, unknown> = { ...p.page(rows.map((row) => quoteView(sql, row)), total,
      deployment.status === 'archived' ? [] : ['publish_quote']), deployment_revision: deployment.current_revision, head_revision: total };
    if (when !== undefined) {
      const found = applicableQuote(sql, deploymentId, deployment.current_revision, when);
      result.applicable = 'items' in found ? quoteView(sql, found.quote) : null;
      if (!('items' in found)) result.applicable_reason = found.reason_code;
    }
    return c.json(result);
  });

  app.get(`${P}/deployments/:deployment_id/quotes/:quote_id/revisions/:quote_revision`, (c) => {
    platformActor(store, c, opts.now());
    const raw = c.req.param('quote_revision');
    if (!/^[1-9]\d{0,15}$/.test(raw)) throw new ApiError('not_found');
    const deploymentId = c.req.param('deployment_id');
    deploymentHead(store.system, deploymentId);
    const row = store.system.get<QuoteRow>(`SELECT q.* FROM procurement_quotes q JOIN procurement_quote_heads h ON h.quote_id = q.quote_id
      WHERE h.deployment_id = ? AND q.quote_id = ? AND q.quote_revision = ?`, [deploymentId, c.req.param('quote_id'), Number(raw)]);
    if (!row) throw new ApiError('not_found');
    return c.json(quoteView(store.system, row));
  });

  app.post(`${P}/procurement/fx-rates`, async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    if (!c.req.header('Idempotency-Key')) invalid('Idempotency-Key');
    const draft = parseFx(body);
    const op = operation(c, opts.codeSecret, at, actor, draft);
    return store.system.write((sql) => {
      requirePlatformAdmin(sql, actor);
      const cached = replay(op, sql);
      if (cached) return cached;
      const current = fxHead(sql, draft.base_currency);
      if (draft.expected_fx_revision !== current) throw conflict('revision_changed', current, ['fx_revision']);
      const now = iso(at);
      if (draft.observed_at > now) invalid('observed_at');
      if (current) {
        const latest = sql.get<{ valid_from: string }>(`SELECT valid_from FROM procurement_fx_rates WHERE base_currency = ? AND quote_currency = 'CNY'
          AND fx_revision = ?`, [draft.base_currency, current])!;
        if (draft.valid_from <= latest.valid_from) throw new ApiError('invalid', { fields: ['valid_from'], issues: [{ code: 'valid_from_not_after_head' }] });
      }
      const revision = current + 1;
      sql.run(`INSERT INTO procurement_fx_heads (base_currency, quote_currency, head_revision, updated_at) VALUES (?, 'CNY', ?, ?)
        ON CONFLICT(base_currency, quote_currency) DO UPDATE SET head_revision = excluded.head_revision, updated_at = excluded.updated_at`,
        [draft.base_currency, revision, now]);
      sql.run(`INSERT INTO procurement_fx_rates (base_currency, quote_currency, fx_revision, rate_numerator, rate_denominator, observed_at, valid_from,
        valid_until, source_kind, source_reference, reason, published_by, published_at) VALUES (?, 'CNY', ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
        [draft.base_currency, revision, draft.rate_numerator, draft.rate_denominator, draft.observed_at, draft.valid_from, draft.valid_until,
          draft.source.reference, draft.reason, actor, now]);
      sql.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${ulid()}`, actor, 'procurement_fx.publish', `${draft.base_currency}/CNY`, JSON.stringify({ fx_revision: revision,
          valid_from: draft.valid_from, valid_until: draft.valid_until }), now]);
      const row = sql.get<FxRow>(`SELECT * FROM procurement_fx_rates WHERE base_currency = ? AND quote_currency = 'CNY' AND fx_revision = ?`,
        [draft.base_currency, revision])!;
      return op.complete(sql, { status: 201, payload: fxRecord(row) });
    });
  });

  app.get(`${P}/procurement/fx-rates`, (c) => {
    const actor = platformActor(store, c, opts.now());
    const base = currencyCode(queryValue(c, 'base_currency'), 'base_currency');
    if (base === 'CNY') invalid('base_currency');
    const when = asOf(queryValue(c, 'as_of'));
    const p = boundPage(c, opts.codeSecret, actor, { base, as_of: when ?? null });
    const sql = store.system;
    const total = fxHead(sql, base);
    const rows = sql.all<FxRow>(`SELECT * FROM procurement_fx_rates WHERE base_currency = ? AND quote_currency = 'CNY'
      ORDER BY fx_revision DESC LIMIT ? OFFSET ?`, [base, p.limit, p.offset]);
    const result: Record<string, unknown> = { ...p.page(rows.map((row) => fxView(sql, row)), total, ['publish_fx_rate']), head_revision: total };
    if (when !== undefined) {
      const found = applicableFx(sql, base, when);
      result.applicable = 'fx' in found && !('reason_code' in found) ? fxView(sql, found.fx) : null;
      if ('reason_code' in found) result.applicable_reason = found.reason_code;
    }
    return c.json(result);
  });

  app.get(`${P}/procurement/fx-rates/:base_currency/:quote_currency/revisions/:fx_revision`, (c) => {
    platformActor(store, c, opts.now());
    const raw = c.req.param('fx_revision');
    if (c.req.param('quote_currency') !== 'CNY' || !/^[A-Z]{3}$/.test(c.req.param('base_currency')) || !/^[1-9]\d{0,15}$/.test(raw)) {
      throw new ApiError('not_found');
    }
    const row = store.system.get<FxRow>(`SELECT * FROM procurement_fx_rates WHERE base_currency = ? AND quote_currency = 'CNY' AND fx_revision = ?`,
      [c.req.param('base_currency'), Number(raw)]);
    if (!row) throw new ApiError('not_found');
    return c.json(fxView(store.system, row));
  });
}
