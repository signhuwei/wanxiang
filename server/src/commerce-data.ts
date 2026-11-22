import { invalid } from './api';
import { iso } from './credentials';
import { int, enumField } from './management';
import type { PolicyReader } from './policy-types';
import type { Store, Transaction } from './store';

export const rateKeys = ['input_milli_per_mtok', 'output_milli_per_mtok', 'cache_read_milli_per_mtok', 'cache_write_milli_per_mtok'] as const;
export const tiers = ['floor', 'standard', 'pro', 'advanced', 'top'] as const;
export type ModelRate = Record<(typeof rateKeys)[number], number>;
type ModelPrice = ModelRate & { model_id: string; source_rate_key?: string };
export type Terms = {
  monthly_grant_milli: number; monthly_fee_fen: number;
  tiers: { from_milli: number; ratio_ppm: number }[]; commitment: { up_to_milli: number; ratio_ppm: number } | null;
  model_prices: ModelPrice[]; model_budgets: { model_id: string; monthly_milli: number }[];
  tool_prices: { release_id: string; per_call_milli: number }[];
};
export type Plan = { id: string; plan_id: string; version: number; name: string; terms: Terms; created_at: string; created_by: string };
type Row = Omit<Plan, 'terms'> & { terms_json: string };
export type CommercialPolicy = { commerce_plan_id?: string | null };
type Get = Pick<Transaction, 'get'>;
export function record(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(key);
  return value as Record<string, unknown>;
}
export function rows<T>(value: unknown, key: string, parse: (v: Record<string, unknown>) => T, identify: (v: T) => string | number) {
  if (!Array.isArray(value) || value.length > 128) invalid(key);
  const result = value.map(v => parse(record(v, key)));
  if (new Set(result.map(identify)).size !== result.length) invalid(key);
  return result;
}
export function modelId(sql: Get, id: unknown) {
  if (typeof id !== 'string' || !sql.get('SELECT 1 FROM models WHERE id=?', [id])) invalid('model_id');
  return id;
}
function fourRates(value: Record<string, unknown>): ModelRate {
  return Object.fromEntries(rateKeys.map(key => [key, int(value[key], key)])) as ModelRate;
}

export function inputMultiplierPpm(inputMilliPerMtok: number) {
  return int(inputMilliPerMtok * 1000, 'input_multiplier_ppm');
}

function parseModelPrice(sql: Get, row: Record<string, unknown>): ModelPrice {
  const model_id = modelId(sql, row.model_id);
  const key = row.source_rate_key;
  if (key === undefined) {
    const rates = fourRates(row);
    inputMultiplierPpm(rates.input_milli_per_mtok);
    return { model_id, ...rates };
  }
  if (typeof key !== 'string' || !key.length || key.length > 128) invalid('source_rate_key');
  const source = sql.get<ModelRate>(`SELECT ${rateKeys.join(', ')} FROM platform_rate_versions
    WHERE model_id = ? AND source_rate_key = ? AND status = 'available_to_sign'`, [model_id, key]);
  if (!source) invalid('source_rate_key');
  const supplied = rateKeys.filter(field => Object.hasOwn(row, field)).length;
  if (supplied !== 0 && supplied !== rateKeys.length) invalid('model_prices');
  const rates = fourRates(supplied ? row : source);
  inputMultiplierPpm(rates.input_milli_per_mtok);
  return { model_id, source_rate_key: key, ...rates };
}

export function parseTerms(sql: Get, value: unknown): Terms {
  const t = record(value, 'terms');
  const allowed = ['monthly_grant_milli', 'monthly_fee_fen', 'tiers', 'commitment', 'model_prices', 'model_budgets', 'tool_prices'];
  if (Object.keys(t).some(k => !allowed.includes(k))) invalid('terms');
  const commitment = t.commitment == null ? null : record(t.commitment, 'commitment');
  const levels = rows(t.tiers ?? [], 'tiers', r => ({ from_milli: int(r.from_milli, 'from_milli'), ratio_ppm: int(r.ratio_ppm, 'ratio_ppm', 0, 1_000_000) }), r => r.from_milli)
    .sort((a, b) => a.from_milli - b.from_milli);
  if (levels.some((r, i) => i > 0 && r.ratio_ppm > levels[i - 1]!.ratio_ppm)) invalid('tiers');
  return {
    monthly_grant_milli: int(t.monthly_grant_milli ?? 0, 'monthly_grant_milli'), monthly_fee_fen: int(t.monthly_fee_fen ?? 0, 'monthly_fee_fen'), tiers: levels,
    commitment: commitment && { up_to_milli: int(commitment.up_to_milli, 'up_to_milli', 1), ratio_ppm: int(commitment.ratio_ppm, 'ratio_ppm', 0, 1_000_000) },
    model_prices: rows(t.model_prices ?? [], 'model_prices', row => parseModelPrice(sql, row), row => row.model_id),
    model_budgets: rows(t.model_budgets ?? [], 'model_budgets', r => ({ model_id: modelId(sql, r.model_id), monthly_milli: int(r.monthly_milli, 'monthly_milli') }), r => r.model_id),
    tool_prices: rows(t.tool_prices ?? [], 'tool_prices', r => {
      if (typeof r.release_id !== 'string' || !sql.get("SELECT 1 FROM tool_releases WHERE id=? AND status='published' AND kind IN ('mcp','http_search')", [r.release_id])) invalid('release_id');
      return { release_id: r.release_id, per_call_milli: int(r.per_call_milli, 'per_call_milli', 1) };
    }, r => r.release_id)
  };
}
export function planRow({ terms_json, ...rest }: Row): Plan { return { ...rest, terms: JSON.parse(terms_json) }; }
export function readPlan(store: Store, policy: CommercialPolicy | null) {
  const id = policy?.commerce_plan_id;
  const row = id && store.system.get<Row>('SELECT * FROM commerce_plans WHERE id=?', [id]);
  return row ? planRow(row) : null;
}
export function commerceCatalog(sql: PolicyReader) {
  return sql.all<{ id: string; label: string }>("SELECT id,name || ' v' || version AS label FROM commerce_plans ORDER BY name,version DESC");
}
export function commerceRates<T extends { model_id: string }>(store: Store, policy: CommercialPolicy | null, rates: T[]): T[] {
  const prices = readPlan(store, policy)?.terms.model_prices;
  if (!prices?.length) return rates;
  return rates.map(rate => {
    const negotiated = prices.find(price => price.model_id === rate.model_id);
    return negotiated ? { ...rate, ...fourRates(negotiated) } : rate;
  });
}
type Tier = { model_id: string; tier: typeof tiers[number] };
export function parseTiers(sql: Get, body: Record<string, unknown>) {
  const floor_model_id = modelId(sql, body.floor_model_id);
  const models = rows(body.models, 'models', r => ({ model_id: modelId(sql, r.model_id), tier: enumField(r.tier, 'tier', tiers) }), r => r.model_id);
  if (!models.some(r => r.model_id === floor_model_id && r.tier === 'floor')) invalid('floor_model_id');
  return { floor_model_id, models };
}
export function tierTable(store: Store, now: number, plan: Plan | null = null) {
  const cfg = store.system.get<{ floor_model_id: string; revision: number; models_json: string }>('SELECT * FROM commerce_tiers');
  const prices = new Map(store.system.all<{ model_id: string; value: number }>(`SELECT r.model_id,r.output_milli_per_mtok AS value FROM rates r
    WHERE effective_from=(SELECT max(effective_from) FROM rates WHERE model_id=r.model_id AND effective_from<=?)`, [iso(now)]).map(r => [r.model_id, r.value]));
  for (const r of plan?.terms.model_prices ?? []) prices.set(r.model_id, r.output_milli_per_mtok);
  const floor = cfg && prices.get(cfg.floor_model_id);
  const models: Tier[] = cfg ? JSON.parse(cfg.models_json) : [];
  return {
    revision: cfg?.revision ?? 0, floor_model_id: cfg?.floor_model_id ?? null, models: models.map(r => {
      const output = prices.get(r.model_id);
      return { ...r, output_milli_per_mtok: output ?? null, display_multiplier: floor && output !== undefined ? output / floor : null };
    })
  };
}
export function commerceDisplay(store: Store, policy: CommercialPolicy & { allowed_models_json: string }, at: number) {
  const allowed = new Set<string>(JSON.parse(policy.allowed_models_json));
  const table = tierTable(store, at, readPlan(store, policy));
  const labels = { floor: '兜底', standard: '标准', pro: '专业', advanced: '高级', top: '顶级' };
  return table.models.filter(r => allowed.has(r.model_id)).map(r => ({
    id: '_runtime.tier.' + r.model_id, title: r.model_id + ' 价格档位',
    kind: 'text', value: labels[r.tier] + (r.display_multiplier === null ? '' : ' · ' + Number(r.display_multiplier.toFixed(3)) + '×')
  }));
}
export function commerceMonth(at: number) { return new Date(at + 8 * 3600000).toISOString().slice(0, 7); }
export function grantPackage(sql: Transaction, plan: Plan | null, at: number) {
  if (plan && (plan.terms.monthly_grant_milli || plan.terms.monthly_fee_fen)) sql.run(
    'INSERT OR IGNORE INTO commerce_packages VALUES(?,?,?,?,?)', [commerceMonth(at), plan.id, plan.terms.monthly_grant_milli, plan.terms.monthly_fee_fen, iso(at)]);
}
export function packageFunds(sql: Get, at: number) {
  const month = commerceMonth(at);
  return sql.get<{ package_available_milli: number }>(`SELECT coalesce((SELECT grant_milli FROM commerce_packages WHERE month=?),0)
    - coalesce((SELECT sum(CASE WHEN l.status='active' THEN c.package_reserved ELSE c.package_used END)
      FROM commerce_leases c JOIN leases l ON l.id=c.lease_id WHERE c.month=?),0)
    - coalesce((SELECT sum(package_used) FROM commerce_tool_calls WHERE status='charged' AND month=?),0)
    - coalesce((SELECT sum(package_reserved) FROM commerce_tool_calls WHERE source_kind='http_search'
      AND status='awaiting_result' AND month=? AND reserved_until>?),0) AS package_available_milli`,
    [month, month, month, month, iso(at)])!;
}
export function modelUsage(sql: Get, model: string, month: string, excludeLease: string | null = null) {
  // A newly signed cap also sees earlier leases this month. Before per-model counters were requested,
  // reserve the unattributed remainder until the device's durable usage events arrive.
  return sql.get<{ reserved: number; used: number }>(`WITH monthly AS (
    SELECT l.*,a.reserved AS model_reserved,a.used AS model_used FROM leases l
    JOIN ledger r ON r.lease_id=l.id AND r.kind='reserve'
    LEFT JOIN commerce_model_allocations a ON a.lease_id=l.id AND a.model_id=?
    WHERE strftime('%Y-%m',r.at,'+8 hours')=? AND l.id IS NOT ?
  ), reported AS (
    SELECT u.lease_id, sum(u.cost_milli) AS total,sum(CASE WHEN u.model_id=? THEN u.cost_milli ELSE 0 END) AS model
    FROM usage u JOIN monthly l ON l.id=u.lease_id WHERE l.model_reserved IS NULL GROUP BY u.lease_id
  ) SELECT coalesce(sum(CASE WHEN l.status='active' THEN coalesce(l.model_reserved,l.budget_milli)
      WHEN l.model_used IS NULL THEN max(0,l.used_milli-coalesce(r.total,0)) ELSE 0 END),0) AS reserved,
    coalesce(sum(CASE WHEN l.status='settled' THEN coalesce(l.model_used,r.model,0) ELSE 0 END),0) AS used
    FROM monthly l LEFT JOIN reported r ON r.lease_id=l.id`, [model, month, excludeLease, model])!;
}
export function reserveCommercial(sql: Transaction, id: string, budget: number, plan: Plan, policy: { platform_revision: number; policy_revision: number; allowed_models_json: string }, at: number) {
  const month = commerceMonth(at);
  sql.run('INSERT INTO commerce_leases(lease_id,month,plan_id,terms_json,platform_revision,policy_revision,package_reserved,issued_at) VALUES(?,?,?,?,?,?,?,?)',
    [id, month, plan.id, JSON.stringify(plan.terms), policy.platform_revision, policy.policy_revision, Math.min(budget, packageFunds(sql, at).package_available_milli), iso(at)]);
  const allowed = new Set<string>(JSON.parse(policy.allowed_models_json));
  for (const r of plan.terms.model_budgets.filter(r => allowed.has(r.model_id))) {
    const { used, reserved } = modelUsage(sql, r.model_id, month, id);
    sql.run('INSERT INTO commerce_model_allocations(lease_id,model_id,month,reserved) VALUES(?,?,?,?)',
      [id, r.model_id, month, Math.min(budget, Math.max(0, r.monthly_milli - used - reserved))]);
  }
}
export function modelBudgetWire(sql: PolicyReader, id: string) {
  return Object.fromEntries(sql.all<{ model_id: string; reserved: number }>('SELECT model_id,reserved FROM commerce_model_allocations WHERE lease_id=?', [id])
    .map(r => [r.model_id, r.reserved]));
}
export function modelReport(v: unknown) {
  if (v === undefined || v === null) return null;
  const r = record(v, 'model_used_milli');
  if (Object.keys(r).length > 128) invalid('model_used_milli');
  return Object.fromEntries(Object.keys(r).sort().map(k => [k, int(r[k], 'model_used_milli')]));
}
export function settleCommercial(sql: Transaction, id: string, charged: number, actual: number, report: Record<string, number> | null, at: number) {
  const limits = modelBudgetWire(sql, id);
  const keys = Object.keys(limits);
  if (keys.length && (!report || keys.some(k => !Object.hasOwn(report, k)))) invalid('model_used_milli');
  if (report && (Object.keys(report).some(k => !Object.hasOwn(limits, k)) || Object.values(report).reduce((a, v) => a + BigInt(v), 0n) > BigInt(actual))) invalid('model_used_milli');
  for (const key of keys) sql.run('UPDATE commerce_model_allocations SET used=? WHERE lease_id=? AND model_id=?', [report![key]!, id, key]);
  sql.run('UPDATE commerce_leases SET package_used=min(package_reserved,?),closed_at=? WHERE lease_id=?', [charged, iso(at), id]);
}
