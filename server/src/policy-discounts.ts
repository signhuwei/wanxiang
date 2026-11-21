import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { refreshCommerce } from './commerce';
import type {Terms} from './commerce-data';
import { ApiError, invalid, operation } from './api';
import { isTenantId } from './auth';
import { appendLedgerEntry, balance } from './billing';
import { iso, monthBounds } from './credentials';
import { platformActor, tenantActor, type ManagementOptions } from './management';
import type { Store, Transaction } from './store';

const ppm = 1_000_000n;
const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
const closeBatchSize = 12;

type PeriodRow = {
  month: string;
  gross_milli: number;
  net_milli: number;
  discount_milli: number;
  cash_credit_milli:number;
  expired_package_credit_milli:number;
  buckets_json: string;
  adjustment_ledger_id: string | null;
  closed_at: string;
  closed_by: string;
};
function periodBounds(month: string) {
  if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) invalid('month');
  return monthBounds(Date.parse(month + '-01T12:00:00Z'));
}

function magnitude(value: bigint) {
  if (value < 0n || value > maxSafe) invalid('amount_milli');
  return Number(value);
}

function readPeriod(sql: Pick<Transaction, 'get'>, month: string) {
  return sql.get<PeriodRow>('SELECT * FROM policy_discount_periods WHERE month = ?', [month]);
}

function view(row: PeriodRow, tenant_id: string) {
  const { buckets_json, ...period } = row;
  return { tenant_id, ...period, buckets: JSON.parse(buckets_json), actions: ['read'] };
}

function closeMonth(sql: Transaction, month: string, actor: string, at: number) {
  const prior = readPeriod(sql, month);
  if (prior) return { row: prior, credited: false };

  const [from, to] = periodBounds(month);
  if (Date.parse(to) > at) throw new ApiError('conflict', { reason: 'discount_period_open' });
  const rows = sql.all<{platform_revision:number|null;policy_revision:number|null;ratio_ppm:number|null;plan_id:string|null;terms_json:string|null;amount_milli:number}>(
    `SELECT coalesce(nullif(c.platform_revision,0),d.platform_revision) platform_revision,
      coalesce(nullif(c.policy_revision,0),d.policy_revision) policy_revision,d.ratio_ppm,c.plan_id,c.terms_json,l.amount_milli
      FROM ledger l LEFT JOIN policy_discount_leases d ON d.lease_id=l.lease_id
      LEFT JOIN commerce_leases c ON c.lease_id=l.lease_id WHERE l.kind='settle' AND l.at>=? AND l.at<? ORDER BY l.at,l.id`,[from,to]);
  const denominator=ppm*ppm*ppm;
  let gross=0n,net=0n, modelGross=0n;
  const groups=new Map<string,{platform_revision:number|null;policy_revisions:Set<number>;ratio_ppm:number;plan_id:string|null;gross:bigint;numerator:bigint}>();
  for(const row of rows) {
    const ratio=row.ratio_ppm??Number(ppm),key=JSON.stringify([row.platform_revision,ratio,row.plan_id]);
    const bucket=groups.get(key)??{platform_revision:row.platform_revision,policy_revisions:new Set<number>(),ratio_ppm:ratio,plan_id:row.plan_id,gross:0n,numerator:0n};
    if(row.policy_revision!==null) bucket.policy_revisions.add(row.policy_revision);
    const amount=BigInt(row.amount_milli);
    const terms=row.terms_json?JSON.parse(row.terms_json) as Partial<Terms>:null;
    const end=modelGross+amount;
    const boundaries=new Set<bigint>([modelGross,end]);
    for(const boundary of [...(terms?.tiers??[]).map(t=>t.from_milli),terms?.commitment?.up_to_milli??0]) {
      if(BigInt(boundary)>modelGross && BigInt(boundary)<end) boundaries.add(BigInt(boundary));
    }
    const points=[...boundaries].sort((a,b)=>a<b?-1:a>b?1:0);
    for(let i=1;i<points.length;i++){
      const from=points[i-1]!,to=points[i]!;
      const tier=(terms?.tiers??[]).findLast(t=>BigInt(t.from_milli)<=from)?.ratio_ppm??Number(ppm);
      const committed=terms?.commitment && from<BigInt(terms.commitment.up_to_milli)?terms.commitment.ratio_ppm:Number(ppm);
      bucket.numerator+=(to-from)*BigInt(ratio)*BigInt(tier)*BigInt(committed);
    }
    bucket.gross+=amount;gross+=amount;groups.set(key,bucket);
    if(row.plan_id||row.platform_revision!==null) modelGross=end;
  }
  const buckets=[];
  for(const g of groups.values()) {
    const paid=(g.numerator+denominator-1n)/denominator;
    net+=paid;
    if(g.platform_revision!==null) buckets.push({platform_revision:g.platform_revision,policy_revisions:[...g.policy_revisions].sort((a,b)=>a-b),
      ratio_ppm:g.ratio_ppm,...(g.plan_id&&{plan_id:g.plan_id}),gross_milli:magnitude(g.gross),net_milli:magnitude(paid),discount_milli:magnitude(g.gross-paid)});
  }
  const gross_milli = magnitude(gross);
  const net_milli = magnitude(net);
  const discount_milli = magnitude(gross - net);
  const paidFromPackage=sql.get<{amount:number}>(`SELECT coalesce(sum(coalesce(c.package_used,t.package_used,0)),0) AS amount
    FROM ledger l LEFT JOIN commerce_leases c ON c.lease_id=l.lease_id LEFT JOIN commerce_tool_calls t ON t.ledger_id=l.id
    WHERE l.kind='settle' AND l.at>=? AND l.at<?`,[from,to])!.amount;
  const cash_credit_milli=Math.min(discount_milli,Math.max(0,gross_milli-paidFromPackage));
  const expired_package_credit_milli=discount_milli-cash_credit_milli;
  let adjustment_ledger_id = null;
  if (discount_milli > 0) {
    const { total } = sql.get<{ total: string }>(`SELECT CAST(coalesce(sum(amount_milli), 0) AS TEXT) AS total
      FROM ledger WHERE kind IN ('topup', 'adjust') AND amount_milli > 0`)!;
    magnitude(BigInt(total) + BigInt(cash_credit_milli));
    if (!Number.isSafeInteger(balance(sql, at).balance_milli + cash_credit_milli)) invalid('amount_milli');
    adjustment_ledger_id = appendLedgerEntry(sql, 'adjust', cash_credit_milli, at, {
      actor, requestRef: 'policy-discount:' + month, note: cash_credit_milli ? '月度折扣返还' : '月度折扣由到期月包抵免',
    }).id;
  }

  const row: PeriodRow = { month, gross_milli, net_milli, discount_milli, cash_credit_milli,expired_package_credit_milli,adjustment_ledger_id,
    buckets_json: JSON.stringify(buckets), closed_at: iso(at), closed_by: actor };
  sql.run(`INSERT INTO policy_discount_periods (month, gross_milli, net_milli, discount_milli, buckets_json,
    adjustment_ledger_id, closed_at, closed_by,cash_credit_milli,expired_package_credit_milli) VALUES (?, ?, ?, ?, ?, ?, ?, ?,?,?)`,
  [month, gross_milli, net_milli, discount_milli, row.buckets_json, adjustment_ledger_id, row.closed_at, actor,cash_credit_milli,expired_package_credit_milli]);
  sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
    ['aud_' + ulid(), actor, 'policy.discount.close', month,
      JSON.stringify({ gross_milli, net_milli, discount_milli, cash_credit_milli,expired_package_credit_milli,adjustment_ledger_id }), row.closed_at]);
  return { row, credited: cash_credit_milli > 0 };
}

export function settleUnclosedDiscountMonths(store: Store, tenantId: string, at: number) {
  return store.tenant(tenantId).write(sql => {
    const previous=balance(sql,at).balance_milli;
    refreshCommerce(store,tenantId,sql,at);
    const changed=balance(sql,at).balance_milli!==previous;
    if (!sql.get('SELECT 1 FROM policy_discount_leases LIMIT 1') && !sql.get('SELECT 1 FROM commerce_leases LIMIT 1')) return changed;
    // Use settlement time, not lease creation or the time at which the device reported tokens.
    const months = sql.all<{ month: string }>(`SELECT DISTINCT strftime('%Y-%m', l.at, '+8 hours') AS month
      FROM ledger l LEFT JOIN policy_discount_leases d ON d.lease_id=l.lease_id LEFT JOIN commerce_leases c ON c.lease_id=l.lease_id
      WHERE (d.lease_id IS NOT NULL OR c.lease_id IS NOT NULL) AND l.kind = 'settle' AND l.at < ? AND NOT EXISTS (
        SELECT 1 FROM policy_discount_periods p WHERE p.month = strftime('%Y-%m', l.at, '+8 hours'))
      ORDER BY month LIMIT ?`, [monthBounds(at)[0], closeBatchSize]);
    let credited = false;
    for (const { month } of months) if (closeMonth(sql, month, 'system', at).credited) credited = true;
    return credited || changed;
  });
}

export function policyDiscountRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const platformPath = '/v1/platform/policy/contracts/:tenant_id/discounts/:month';

  function platform(c: Context, at: number) {
    const actor = platformActor(store, c, at);
    const id = c.req.param('tenant_id');
    if (!isTenantId(id) || !store.system.get('SELECT id FROM tenants WHERE id = ?', [id])) throw new ApiError('not_found');
    return { actor, id, db: store.tenant(id) };
  }
  function load(c: Context, sql: Pick<Transaction, 'get'>, id: string) {
    const month = c.req.param('month');
    if (!month) invalid('month');
    periodBounds(month);
    const row = readPeriod(sql, month);
    if (!row) throw new ApiError('not_found');
    return c.json(view(row, id));
  }

  app.get(platformPath, c => {
    const { id, db } = platform(c, opts.now());
    return load(c, db, id);
  });
  app.get('/v1/policy/discounts/:month', c => {
    const actor = tenantActor(store, c, opts.now());
    if (actor.role !== 'owner') throw new ApiError('forbidden');
    return load(c, actor.db, actor.id);
  });
  app.post(platformPath, async c => {
    const at = opts.now();
    const { id, actor, db } = platform(c, at);
    const month = c.req.param('month');
    periodBounds(month);
    const op = operation(c, opts.codeSecret, at, actor, { month }, platformPath);
    if (!op.key) invalid('Idempotency-Key');
    const result = await db.write(sql => {
      if (!store.system.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [actor])) throw new ApiError('forbidden');
      const cached = op.read(sql);
      if (cached) return { response: cached, credited: false };
      const { row, credited } = closeMonth(sql, month, actor, at);
      return { response: op.complete(sql, { status: 200, payload: view(row, id) }), credited };
    });
    if (result.credited) opts.onBalanceChange?.(id);
    return result.response;
  });
}
