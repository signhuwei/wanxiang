import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { isTenantId } from './auth';
import { balance } from './billing';
import { iso, monthBounds } from './credentials';
import { int, pagination, platformActor, tenantActor, type ManagementOptions } from './management';
import { commerceMonth, grantPackage, modelUsage, packageFunds, parseTerms, parseTiers, planRow, readPlan, tierTable, type Plan } from './commerce-data';
import { settlePendingTools } from './commerce-tools';
import { readEffective } from './policy-data';
import type { Store, Transaction } from './store';
export { commerceCatalog, commerceRates, commerceDisplay } from './commerce-data';

function tenantPlan(store: Store, sql: Transaction, tenant: string) { return readPlan(store, readEffective(sql, 'tenant', tenant)?.hot ?? null); }
export function refreshCommerce(store: Store, tenant: string, sql: Transaction, at: number) {
  grantPackage(sql, tenantPlan(store, sql, tenant), at);
  balance(sql, at);
  settlePendingTools(sql, at);
}
function account(store: Store, tenant: string, sql: Transaction, at: number) {
  const plan = tenantPlan(store, sql, tenant);
  grantPackage(sql, plan, at);
  const month = commerceMonth(at), wallet = balance(sql, at), funds = packageFunds(sql, at);
  const [from, to] = monthBounds(at);
  const { package_used_milli } = sql.get<{ package_used_milli: number }>(`SELECT coalesce(sum(coalesce(c.package_used,t.package_used,0)),0) package_used_milli
    FROM ledger l LEFT JOIN commerce_leases c ON c.lease_id=l.lease_id LEFT JOIN commerce_tool_calls t ON t.ledger_id=l.id
    WHERE l.kind='settle' AND l.at>=? AND l.at<?`, [from, to])!;
  const packages = sql.all(`WITH funded AS (
    SELECT c.month,CASE WHEN l.status='active' THEN c.package_reserved ELSE 0 END reserved,c.package_used used
      FROM commerce_leases c JOIN leases l ON c.lease_id=l.id
    UNION ALL SELECT month,0,package_used FROM commerce_tool_calls WHERE status='charged'
    UNION ALL SELECT month,package_reserved,0 FROM commerce_tool_calls
      WHERE source_kind='http_search' AND status='awaiting_result' AND reserved_until>?
  ) SELECT p.*,coalesce(sum(f.reserved),0) reserved_milli,coalesce(sum(f.used),0) used_milli,
    CASE WHEN p.month<? THEN p.grant_milli-coalesce(sum(f.reserved+f.used),0) ELSE 0 END expired_milli
    FROM commerce_packages p LEFT JOIN funded f ON f.month=p.month GROUP BY p.month ORDER BY p.month DESC LIMIT 24`, [iso(at), month]);
  return {
    tenant_id: tenant, month, plan, ...wallet, monthly_sources: { package_used_milli, permanent_used_milli: wallet.month_used_milli - package_used_milli }, permanent_available_milli: wallet.balance_milli - funds.package_available_milli, package_available_milli: funds.package_available_milli,
    packages,
    model_budgets: (plan?.terms.model_budgets ?? []).map(r => ({ ...r, ...modelUsage(sql, r.model_id, month) })), tiers: tierTable(store, at, plan),
    tool_calls: sql.all(`SELECT release_id,native_id,source_kind,fee_milli,called_at,settled_at,
      CASE WHEN source_kind='http_search' AND status='awaiting_result' AND reserved_until<=? THEN 'failed' ELSE status END status
      FROM commerce_tool_calls ORDER BY called_at DESC LIMIT 100`, [iso(at)]), actions: ['read']
  };
}
type PlanRow = Parameters<typeof planRow>[0];
export function commerceRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const path = '/v1/platform/commerce/plans';
  app.get(path, c => {
    platformActor(store, c, opts.now());
    const pg = pagination(c), filter = " WHERE instr(lower(name || ' ' || plan_id),lower(?))>0";
    const count = store.system.get<{ n: number }>('SELECT count(*) n FROM commerce_plans' + filter, [pg.query])!.n;
    return c.json(pg.page(store.system.all<PlanRow>('SELECT * FROM commerce_plans' + filter + ' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?', [pg.query, pg.limit, pg.offset]).map(r => ({ ...planRow(r), actions: ['read'] })), count, ['publish']));
  });
  app.post(path, async c => {
    const at = opts.now(), actor = platformActor(store, c, at), body = await json(c);
    const name = field(body.name, 'name'), expected = int(body.expected_version, 'expected_version');
    const id = body.plan_id === undefined ? null : field(body.plan_id, 'plan_id');
    const op = operation(c, opts.codeSecret, at, actor, body);
    if (!op.key) invalid('Idempotency-Key');
    return store.system.write(sql => {
      platformActor(store, c, at);
      const cached = op.read(sql); if (cached) return cached;
      if ((!id && expected !== 0) || (id && !/^plan_[0-9A-HJKMNP-TV-Z]{26}$/.test(id))) invalid('plan_id');
      const latest = id ? sql.get<{ n: number }>('SELECT max(version) n FROM commerce_plans WHERE plan_id=?', [id])?.n : 0;
      if (id && !latest) throw new ApiError('not_found');
      if (latest !== expected) throw new ApiError('conflict', { version: latest });
      const plan: Plan = { id: 'cmp_' + ulid(), plan_id: id ?? 'plan_' + ulid(), version: expected + 1, name, terms: parseTerms(sql, body.terms), created_at: iso(at), created_by: actor };
      sql.run('INSERT INTO commerce_plans VALUES(?,?,?,?,?,?,?)', [plan.id, plan.plan_id, plan.version, name, JSON.stringify(plan.terms), plan.created_at, actor]);
      sql.run('INSERT INTO platform_audit VALUES(?,?,?,?,?,?)', ['aud_' + ulid(), actor, 'commerce.plan.publish', plan.id, JSON.stringify({ plan_id: plan.plan_id, version: plan.version }), plan.created_at]);
      return op.complete(sql, { status: 201, payload: plan });
    });
  });
  const tierPath = '/v1/platform/commerce/model-tiers';
  app.get(tierPath, c => { platformActor(store, c, opts.now()); return c.json(tierTable(store, opts.now())); });
  app.put(tierPath, async c => {
    const at = opts.now(), actor = platformActor(store, c, at), body = await json(c);
    const op = operation(c, opts.codeSecret, at, actor, body);
    if (!op.key) invalid('Idempotency-Key');
    const result = await store.system.write(sql => {
      platformActor(store, c, at);
      const cached = op.read(sql); if (cached) return cached;
      const revision = sql.get<{ revision: number }>('SELECT revision FROM commerce_tiers')?.revision ?? 0;
      if (int(body.expected_revision, 'expected_revision') !== revision) throw new ApiError('conflict', { revision });
      const cfg = parseTiers(sql, body);
      sql.run(`INSERT INTO commerce_tiers VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,
        floor_model_id=excluded.floor_model_id,models_json=excluded.models_json`, [revision + 1, cfg.floor_model_id, JSON.stringify(cfg.models)]);
      sql.run('INSERT INTO platform_audit VALUES(?,?,?,?,?,?)', ['aud_' + ulid(), actor, 'commerce.tiers.update', 'models', JSON.stringify(cfg), iso(at)]);
      return op.complete(sql, { status: 200, payload: tierTable(store, at) });
    });
    opts.onConfigChange?.(); return result;
  });
  app.get('/v1/platform/commerce/tenants/:tenant_id', async c => {
    const at = opts.now(); platformActor(store, c, at);
    const id = c.req.param('tenant_id');
    if (!isTenantId(id) || !store.system.get('SELECT 1 FROM tenants WHERE id=?', [id])) throw new ApiError('not_found');
    return c.json(await store.tenant(id).write(sql => account(store, id, sql, at)));
  });
  app.get('/v1/commerce/account', async c => {
    const at = opts.now(), actor = tenantActor(store, c, at);
    if (actor.role !== 'owner') throw new ApiError('forbidden');
    const { plan, ...view } = await actor.db.write(sql => account(store, actor.id, sql, at));
    return c.json({ ...view, plan: plan && {
      ...plan, terms: { ...plan.terms, model_prices: plan.terms.model_prices.map(({ source_rate_key: _, ...price }) => price) },
    } });
  });
}
