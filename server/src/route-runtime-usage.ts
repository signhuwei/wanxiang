import { ApiError, invalid } from './api';
import { deviceAllowed } from './billing';
import { modelBudgetWire } from './commerce-data';
import { iso } from './credentials';
import { ackCursor, advanceCursor, batchItems, markSequence, usageItems, type IngestSummary, type PublishSummary } from './ingest';
import { enumField, int } from './management';
import { MAX_ATTEMPTS } from './model-pool';
import type { QuoteItem } from './procurement';
import { digest, routeId, strictObject } from './routing-http';
import { procurementCostCnyMicro, salesCostMilli, type ProcurementPrice, type RoutingSalesRates, type RoutingTokenUsage } from './routing-money';
import type { Store, Transaction } from './store';

export type RouteProcurementCharge = {
  tenant_id: string; device_id: string; request_id: string; attempt_id: string;
  provider_id: string; account_id: string; deployment_id: string; deployment_revision: number;
  quote_id: string; quote_revision: number; currency: string; amount_micro: string;
  fx_revision: number | null; amount_cny_micro: string | null; observed_at: string;
};
export type PostRouteProcurement = (charge: RouteProcurementCharge) => Promise<void>;

type Usage = ReturnType<typeof usageItems>[number] & {
  attemptId: string; deploymentId: string; deploymentRevision: number; configRevision: number; projectionId: string; rateId: string;
  attempts: Attempt[];
};
type Attempt = { attempt_id: string; deployment_id: string; deployment_revision: number; outcome: 'connect_refused' | 'completed' };
type Snapshot = { projection_id: string; platform_revision: number; payload_json: string; valid_until: string; created_at: string };
type Rate = RoutingSalesRates & { source_rate_key: string | null; valid_from: string; valid_until: string | null };
type Plan = { routes: Array<{ model_id: string; provider_id: string; deployment_id: string; deployment_revision: number; pool_revision: number }>;
  rates: Array<{ model_id: string; rate_version_id: string }>;
  route_pool: { bindings: Array<{ model_id: string; aliases: string[]; deployment_ids: string[] }>;
    pools: Array<{ model_id: string; pool_revision: number; max_attempts: number }> } };

function parseAttempts(input: unknown): Attempt[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_ATTEMPTS) invalid('attempts');
  return input.map((value, index) => {
    const name = `attempts.${index}`;
    const item = strictObject(value, name, ['attempt_id', 'deployment_id', 'deployment_revision', 'outcome']);
    return { attempt_id: routeId(item.attempt_id, `${name}.attempt_id`), deployment_id: routeId(item.deployment_id, `${name}.deployment_id`),
      deployment_revision: int(item.deployment_revision, `${name}.deployment_revision`, 1),
      outcome: enumField(item.outcome, `${name}.outcome`, ['connect_refused', 'completed']) };
  });
}

function parseBatch(value: unknown): Usage[] {
  const rows = batchItems(value);
  const base = usageItems(rows);
  return rows.map((raw, i) => {
    const item = base[i]!;
    if (!item.lease || !item.complete || item.status !== 'ok' || raw.measurement_basis !== 'upstream_usage') invalid('measurement_basis');
    return { ...item, attemptId: routeId(raw.attempt_id, 'attempt_id'), deploymentId: routeId(raw.deployment_id, 'deployment_id'),
      deploymentRevision: int(raw.deployment_revision, 'deployment_revision', 1),
      configRevision: int(raw.config_revision, 'config_revision', 1), projectionId: routeId(raw.projection_id, 'projection_id'),
      rateId: routeId(raw.rate_version_id, 'rate_version_id'), attempts: parseAttempts(raw.attempts) };
  });
}

const tokens = (u: Usage): RoutingTokenUsage => ({
  input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite,
});
const refused = (reason: string) => new ApiError('conflict', { reason });

function frozenProcurement(store: Store, tenant: string, device: string, row: Usage, rate: Rate, poolRevision: number): RouteProcurementCharge | null {
  if (!rate.source_rate_key) return null;
  type Quote = Pick<RouteProcurementCharge, 'quote_id' | 'quote_revision' | 'account_id' | 'currency' | 'fx_revision'> &
    { rate_numerator: string | null; rate_denominator: string | null };
  const q = store.system.get<Quote>(`SELECT p.quote_id,p.quote_revision,p.account_id,p.currency,c.fx_revision,c.rate_numerator,c.rate_denominator
    FROM platform_rate_channels c
    JOIN platform_rate_versions v ON v.source_rate_key=c.source_rate_key
    JOIN procurement_quotes p ON p.quote_id=c.quote_id AND p.quote_revision=c.quote_revision
      AND p.deployment_id=c.deployment_id AND p.deployment_revision=c.deployment_revision
    WHERE c.source_rate_key=? AND v.model_id=? AND v.pool_revision=? AND c.deployment_id=? AND c.deployment_revision=? AND p.provider_id=?`,
    [rate.source_rate_key, row.modelId, poolRevision, row.deploymentId, row.deploymentRevision, row.provider]);
  if (!q) return null;
  const items = store.system.all<QuoteItem>(`SELECT dimension,rate_micro,quantity_basis,unit FROM procurement_quote_items
    WHERE quote_id=? AND quote_revision=?`, [q.quote_id, q.quote_revision]);
  if (!items.length) return null;
  const price: ProcurementPrice = { currency: q.currency, items: Object.fromEntries(items.map(item => [item.dimension, item])) };
  const { rate_numerator, rate_denominator, ...quote } = q;
  const fx = rate_numerator && rate_denominator
    ? { base_currency: q.currency, quote_currency: 'CNY', rate_numerator, rate_denominator } : null;
  let amount: string, cny: string | null;
  try {
    const measured = tokens(row);
    amount = procurementCostCnyMicro(measured, { ...price, currency: 'CNY' }, null, 'ceil');
    cny = q.currency === 'CNY' ? amount : fx ? procurementCostCnyMicro(measured, price, fx, 'ceil') : null;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return null;
  }
  return { ...quote, tenant_id: tenant, device_id: device, request_id: row.request, attempt_id: row.attemptId,
    provider_id: row.provider, deployment_id: row.deploymentId, deployment_revision: row.deploymentRevision,
    amount_micro: amount, amount_cny_micro: cny, observed_at: row.at };
}

function validateAttempts(sql: Transaction, device: string, plan: Plan, row: Usage, poolRevision: number) {
  const pool = plan.route_pool.pools.find(item => item.model_id === row.modelId && item.pool_revision === poolRevision);
  const final = row.attempts.at(-1)!;
  if (!pool || row.attempts.length > pool.max_attempts || final.outcome !== 'completed' || final.attempt_id !== row.attemptId ||
      final.deployment_id !== row.deploymentId || final.deployment_revision !== row.deploymentRevision ||
      row.attempts.slice(0, -1).some(attempt => attempt.outcome !== 'connect_refused') ||
      new Set(row.attempts.map(attempt => attempt.deployment_id)).size !== row.attempts.length ||
      new Set(row.attempts.map(attempt => attempt.attempt_id)).size !== row.attempts.length) throw refused('route_usage_attempts_mismatch');
  const sameBinding = plan.route_pool.bindings.some(binding => binding.model_id === row.modelId &&
    binding.aliases.some(alias => alias.endsWith('*') ? row.model.startsWith(alias.slice(0, -1)) : alias === row.model) &&
    row.attempts.every(attempt => binding.deployment_ids.includes(attempt.deployment_id) && plan.routes.some(route =>
      route.model_id === row.modelId && route.pool_revision === poolRevision && route.deployment_id === attempt.deployment_id &&
      route.deployment_revision === attempt.deployment_revision)));
  if (!sameBinding) throw refused('route_usage_deployment_mismatch');
  const attemptIds = JSON.stringify(row.attempts.map(attempt => attempt.attempt_id));
  if (sql.get('SELECT 1 FROM route_runtime_attempts WHERE device_id=? AND attempt_id IN (SELECT value FROM json_each(?))', [device, attemptIds])) {
    throw refused('route_usage_replay_conflict');
  }
}

function persistReceipt(store: Store, sql: Transaction, tenant: string, device: string, at: number, row: Usage) {
  const fingerprint = digest(row);
  const old = sql.get<{ digest: string; procurement_json: string | null; procurement_state: string }>(
    'SELECT digest,procurement_json,procurement_state FROM route_runtime_usage WHERE device_id=? AND seq=?', [device, row.seq]);
  if (old) {
    if (old.digest !== fingerprint) throw refused('route_usage_replay_conflict');
    return old.procurement_state === 'pending' ? JSON.parse(old.procurement_json!) as RouteProcurementCharge : null;
  }
  if (row.seq <= ackCursor(sql, device) || sql.get('SELECT 1 FROM ingest_sequences WHERE device_id=? AND seq=?', [device, row.seq])) {
    throw refused('route_usage_sequence_conflict');
  }
  if (row.at > iso(at + 60_000)) invalid('at');
  const lease = sql.get<{ budget_milli: number; expires_at: string }>(`SELECT budget_milli,expires_at FROM leases
    WHERE id=? AND device_id=? AND status='active'`, [row.lease, device]);
  if (!lease || row.at >= lease.expires_at) throw refused('route_usage_lease_mismatch');
  if (row.session && sql.get('SELECT 1 FROM agent_sessions WHERE id=? AND device_id<>?', [row.session, device])) {
    throw refused('route_usage_session_mismatch');
  }
  const snapshot = sql.get<Snapshot>(`SELECT s.projection_id,s.platform_revision,s.payload_json,s.valid_until,s.created_at
    FROM routing_config_snapshots s JOIN routing_lease_projections p ON p.device_id=s.device_id AND p.config_revision=s.config_revision
      AND p.projection_id=s.projection_id WHERE p.lease_id=? AND s.device_id=? AND s.config_revision=?`,
    [row.lease, device, row.configRevision]);
  if (!snapshot || snapshot.projection_id !== row.projectionId || row.at < snapshot.created_at || row.at >= snapshot.valid_until) throw refused('route_usage_projection_mismatch');
  const plan = JSON.parse(snapshot.payload_json) as Plan;
  const route = plan.routes.find(r => r.model_id === row.modelId && r.provider_id === row.provider &&
    r.deployment_id === row.deploymentId && r.deployment_revision === row.deploymentRevision);
  if (!route) throw refused('route_usage_deployment_mismatch');
  validateAttempts(sql, device, plan, row, route.pool_revision);
  if (!plan.rates.some(rate => rate.model_id === row.modelId && rate.rate_version_id === row.rateId)) {
    throw refused('route_usage_rate_mismatch');
  }
  const rate = sql.get<Rate>(`SELECT source_rate_key,valid_from,valid_until,input_milli_per_mtok,output_milli_per_mtok,
    cache_read_milli_per_mtok,cache_write_milli_per_mtok FROM sales_rate_snapshots
    WHERE rate_version_id=? AND platform_revision=? AND model_id=?`, [row.rateId, snapshot.platform_revision, row.modelId]);
  if (!rate || rate.valid_from > row.at || (rate.valid_until && rate.valid_until <= row.at)) throw refused('route_usage_rate_mismatch');
  const cost = salesCostMilli(tokens(row), rate);
  if (cost !== row.cost) throw refused('route_usage_cost_mismatch');
  const allocated = modelBudgetWire(sql, row.lease!);
  const previous = sql.get<{ total: number; model_total: number }>(`SELECT coalesce(sum(cost_milli),0) total,
    coalesce(sum(CASE WHEN model_id=? THEN cost_milli ELSE 0 END),0) model_total
    FROM usage WHERE lease_id=?`, [row.modelId, row.lease])!;
  if (previous.total + cost > lease.budget_milli || (Object.hasOwn(allocated, row.modelId) && previous.model_total + cost > allocated[row.modelId]!)) {
    throw refused('route_usage_budget_exceeded');
  }
  if (sql.get('SELECT 1 FROM route_runtime_usage WHERE device_id=? AND (request_id=? OR attempt_id=?)', [device, row.request, row.attemptId])) {
    throw refused('route_usage_replay_conflict');
  }
  const charge = frozenProcurement(store, tenant, device, row, rate, route.pool_revision);
  sql.run(`INSERT INTO usage(device_id,seq,request_id,session_id,lease_id,provider_id,model_id,model,input_tokens,output_tokens,
    cache_read_tokens,cache_write_tokens,cost_milli,status,at,complete,settlement_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'ok',?,1,'pending')`, [device, row.seq, row.request, row.session, row.lease,
    row.provider, row.modelId, row.model, row.input, row.output, row.cacheRead, row.cacheWrite, cost, row.at]);
  sql.run(`INSERT INTO route_runtime_usage(device_id,seq,request_id,attempt_id,projection_id,config_revision,pool_revision,
    deployment_id,deployment_revision,rate_version_id,digest,procurement_json,procurement_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [device, row.seq, row.request, row.attemptId, snapshot.projection_id, row.configRevision, route.pool_revision,
      row.deploymentId, row.deploymentRevision, row.rateId, fingerprint, charge ? JSON.stringify(charge) : null, charge ? 'pending' : 'unavailable']);
  for (const [index, attempt] of row.attempts.entries()) sql.run(`INSERT INTO route_runtime_attempts
    (device_id,seq,ordinal,attempt_id,deployment_id,deployment_revision,outcome) VALUES(?,?,?,?,?,?,?)`,
    [device, row.seq, index + 1, attempt.attempt_id, attempt.deployment_id, attempt.deployment_revision, attempt.outcome]);
  return charge;
}

export async function ingestRouteUsage(store: Store, tenant: string, device: string, user: string, batch: unknown, at: number,
  postProcurement: PostRouteProcurement, live: () => boolean, publish: PublishSummary): Promise<number> {
  const items = parseBatch(batch);
  const db = store.tenant(tenant);
  const pending = await db.write(sql => {
    if (!live() || !deviceAllowed(store, sql, tenant, device, at)) throw new ApiError('forbidden');
    return items.map(row => persistReceipt(store, sql, tenant, device, at, row));
  });
  for (const charge of pending) {
    if (!charge) continue;
    await postProcurement(charge);
  }
  const { ack, summaries } = await db.write(sql => {
    if (!live()) throw new ApiError('forbidden');
    const summaries: IngestSummary[] = [];
    for (const row of items) {
      sql.run(`UPDATE route_runtime_usage SET procurement_state='posted'
        WHERE device_id=? AND seq=? AND procurement_state='pending'`, [device, row.seq]);
      if (markSequence(sql, device, row.seq) && row.session) {
        sql.run('UPDATE agent_sessions SET revision=revision+1 WHERE id=? AND device_id=?', [row.session, device]);
        summaries.push({ type: 'usage', session_id: row.session, user_id: user, seq: row.seq });
      }
    }
    const previous = ackCursor(sql, device);
    const ack = advanceCursor(sql, device);
    if (ack > previous) summaries.push({ type: 'cursor', user_id: user, seq: ack });
    return { ack, summaries };
  });
  publish(tenant, summaries);
  return ack;
}

/** A metered route lease can settle only through a contiguous ACK of validated receipts. */
export function settleRouteUsage(sql: Transaction, device: string, lease: string, through: number | null | undefined,
  used: number, modelUsed: Record<string, number> | null, releaseOnly: boolean) {
  const rows = sql.all<{ seq: number; model_id: string; cost_milli: number; procurement_state: string }>(`
    SELECT u.seq,u.model_id,u.cost_milli,r.procurement_state FROM usage u JOIN route_runtime_usage r ON r.device_id=u.device_id AND r.seq=u.seq
    WHERE u.device_id=? AND u.lease_id=? ORDER BY u.seq`, [device, lease]);
  if (releaseOnly && rows.length) throw refused('route_lease_already_used');
  const ack = ackCursor(sql, device);
  if ((through != null && (!Number.isSafeInteger(through) || through < 0 || through > ack)) ||
    rows.some(row => through == null || row.seq > through || row.procurement_state === 'pending')) {
    throw refused('route_usage_not_acknowledged');
  }
  const total = rows.reduce((sum, row) => sum + BigInt(row.cost_milli), 0n);
  if (total !== BigInt(used)) throw refused('route_usage_settlement_mismatch');
  const allocation = modelBudgetWire(sql, lease);
  for (const model of Object.keys(allocation)) {
    const expected = rows.filter(row => row.model_id === model).reduce((sum, row) => sum + BigInt(row.cost_milli), 0n);
    if (modelUsed?.[model] == null || expected !== BigInt(modelUsed[model]!)) throw refused('route_usage_settlement_mismatch');
  }
}
