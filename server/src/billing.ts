import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { grantPackage, modelBudgetWire, modelReport, packageFunds, readPlan, reserveCommercial, settleCommercial } from './commerce-data';
import { settlePendingTools,toolSnapshot } from './commerce-tools';
import { ApiError, field, invalid, json, operation } from './api';
import { isTenantId } from './auth';
import { quotaConfigurable, readContract } from './capability-data';
import { balanceFallbackModels, balancePolicyMode } from './policy-balance';
import { readEffective as effectivePolicy, readHead, readPolicyHot } from './policy-data';
import { day, iso, monthBounds } from './credentials';
import { enumField, int, pagination, platformActor, tenantActor, type ManagementOptions } from './management';
import type { Store, Transaction } from './store';

type Reader = Pick<Transaction, 'get'>;
type LedgerKind = 'topup' | 'reserve' | 'settle' | 'release' | 'adjust' | 'overage_pending';
type LeaseRow = { id: string; device_id: string; user_id: string; budget_milli: number; used_milli: number; expires_at: string; status: string; seq: number };
export type Cutoff = { type: 'cutoff'; id: string; reason: 'balance' | 'contract' | 'disabled' | 'quota'; settled_lease_id?: string };
type Lease = { type: 'lease'; id: string; lease_id: string; expires_at: string; budget_milli: number; seq: number };
type LeaseReply = Cutoff | Lease;
const leaseView = (row: LeaseRow, sql:Transaction): Lease => ({ type: 'lease', id: `msg_${ulid()}`, lease_id: row.id,
  expires_at: row.expires_at, budget_milli: row.budget_milli, seq: row.seq, ...leaseModelLimits(sql,row.id) });
function leaseModelLimits(sql:Transaction,id:string) {
  const model_budgets=modelBudgetWire(sql,id);
  const c=sql.get<{plan_id:string}>('SELECT plan_id FROM commerce_leases WHERE lease_id=? AND platform_revision>0',[id]);
  return {...(c && {commerce_plan_id:c.plan_id}),...(Object.keys(model_budgets).length>0 && {model_budgets})};
}
// settledLeaseId 只在续租结清旧租约之后才带（v0.13）；disabled 在结清前判定，不带这个字段。
export const cutoff = (reason: Cutoff['reason'], settledLeaseId?: string): Cutoff =>
  ({ type: 'cutoff', id: `msg_${ulid()}`, reason, ...(settledLeaseId !== undefined && { settled_lease_id: settledLeaseId }) });

export function balance(sql: Reader, now: number) {
  // 月份口径同配额和 observe.ts 的 month_cost_milli：Asia/Shanghai 自然月（v0.13）。
  const [month] = monthBounds(now);
  const { credits, month_used_milli } = sql.get<{credits: number; month_used_milli: number}>(`SELECT
    coalesce(sum(CASE WHEN l.kind IN ('topup','adjust') THEN l.amount_milli
      WHEN l.kind='settle' THEN -(l.amount_milli-coalesce(c.package_used,t.package_used,0)) ELSE 0 END),0) AS credits,
    coalesce(sum(CASE WHEN l.kind='settle' AND l.at>=? THEN l.amount_milli ELSE 0 END),0) AS month_used_milli
    FROM ledger l LEFT JOIN commerce_leases c ON c.lease_id=l.lease_id LEFT JOIN commerce_tool_calls t ON t.ledger_id=l.id`,[month])!;
  const { reserved_milli, permanent_reserved } = sql.get<{reserved_milli:number;permanent_reserved:number}>(`SELECT
    coalesce(sum(total),0) reserved_milli, coalesce(sum(permanent),0) permanent_reserved FROM (
      SELECT l.budget_milli total, l.budget_milli-coalesce(c.package_reserved,0) permanent
      FROM leases l LEFT JOIN commerce_leases c ON c.lease_id=l.id WHERE l.status='active'
      UNION ALL SELECT fee_milli, fee_milli-package_reserved FROM commerce_tool_calls
      WHERE source_kind='http_search' AND status='awaiting_result' AND reserved_until>?
    )`, [iso(now)])!;
  const {package_available_milli} = packageFunds(sql,now);
  const available = credits-permanent_reserved+package_available_milli;
  if (![available,reserved_milli,month_used_milli,credits].every(Number.isSafeInteger)) invalid('balance_milli');
  return {balance_milli:available,reserved_milli,month_used_milli};
}

// 组和个人月配额（v0.12）：本月已用 = 本月 settle（按 user_id 归属）+ 仍在 active 的租约的 budget_milli，
// 月份边界同 observe.ts 的 month_cost_milli（Asia/Shanghai），overage_pending 不计。
const groupSubtree = `WITH RECURSIVE subtree(id) AS (VALUES (?) UNION
  SELECT g.id FROM groups g JOIN subtree s ON g.parent_id = s.id) SELECT id FROM subtree`;

function usageByUsers(sql: Reader, usersSql: string, usersParams: string[], from: string, to: string, at: number) {
  const { settled } = sql.get<{ settled: number }>(`SELECT coalesce(sum(amount_milli), 0) AS settled FROM ledger
    WHERE kind = 'settle' AND at >= ? AND at < ? AND user_id IN (${usersSql})`, [from, to, ...usersParams])!;
  const { reserved } = sql.get<{ reserved: number }>(`SELECT coalesce(sum(amount),0) reserved FROM (
    SELECT budget_milli amount, user_id FROM leases WHERE status='active'
    UNION ALL SELECT fee_milli, user_id FROM commerce_tool_calls
    WHERE source_kind='http_search' AND status='awaiting_result' AND reserved_until>?
  ) WHERE user_id IN (${usersSql})`, [iso(at), ...usersParams])!;
  return { settled, reserved };
}
function usedByUsers(sql: Reader, usersSql: string, usersParams: string[], from: string, to: string, at: number) {
  const { settled, reserved } = usageByUsers(sql, usersSql, usersParams, from, to, at);
  return settled + reserved;
}

export type QuotaLevel = { limited_by: string; quota_milli: number; used_milli: number; remaining_milli: number };

/** 本人剩余与祖先组（含本组）每一级剩余，只含设了配额（非 null）的级别，按限制力度（remaining 升序）排好。 */
export function quotaLevels(sql: Reader, userId: string, at: number): QuotaLevel[] {
  const head=readHead(sql);
  if (!head && !quotaConfigurable(sql)) return [];
  const tenantPolicy=head?sql.get<{subject_id:string}>("SELECT subject_id FROM policy_effective WHERE scope='tenant'"):null;
  const tenantQuota=tenantPolicy?effectivePolicy(sql,'tenant',tenantPolicy.subject_id)?.hot.quota_milli:null;
  const [from, to] = monthBounds(at);
  const member = sql.get<{ quota_milli: number | null; group_id: string | null }>(
    'SELECT quota_milli, group_id FROM members WHERE user_id = ?', [userId]);
  if (!member) return [];
  const levels: QuotaLevel[] = [];
  const distribution=quotaConfigurable(sql);
  if (tenantQuota !== null && tenantQuota !== undefined) {
    const used=usedByUsers(sql,'SELECT user_id FROM members',[],from,to,at);
    levels.push({limited_by:'tenant',quota_milli:tenantQuota,used_milli:used,remaining_milli:tenantQuota-used});
  }
  if (!distribution) return levels;
  const memberPolicy=head?effectivePolicy(sql,'member',userId):null;
  const memberQuota=head?memberPolicy?.hot.quota_milli:member.quota_milli;
  if (memberQuota !== null && memberQuota !== undefined) {
    const used = usedByUsers(sql, '?', [userId], from, to, at);
    levels.push({ limited_by: 'member', quota_milli: memberQuota, used_milli: used, remaining_milli: memberQuota - used });
  }
  let groupId = member.group_id;
  const chain: string[] = [];
  while (groupId) {
    chain.push(groupId);
    const row = sql.get<{ parent_id: string | null }>('SELECT parent_id FROM groups WHERE id = ?', [groupId]);
    groupId = row?.parent_id ?? null;
  }
  for (const id of chain) {
    const group = sql.get<{ quota_milli: number | null }>('SELECT quota_milli FROM groups WHERE id = ?', [id]);
    const groupQuota=head?effectivePolicy(sql,'group',id)?.hot.quota_milli:group?.quota_milli;
    if (groupQuota === undefined || groupQuota === null) continue;
    const members = `SELECT user_id FROM members WHERE group_id IN (${groupSubtree})`;
    const used = usedByUsers(sql, members, [id], from, to, at);
    levels.push({ limited_by: `group:${id}`, quota_milli: groupQuota, used_milli: used, remaining_milli: groupQuota - used });
  }
  return levels.sort((a, b) => a.remaining_milli - b.remaining_milli);
}

/** 当前生效的限制：剩余最小的一级；没有任何配额时返回 null（不限）。 */
export function quotaBinding(sql: Reader, userId: string, at: number): QuotaLevel | null {
  return quotaLevels(sql, userId, at)[0] ?? null;
}

/** 本人本月已用（供 /me.quota 在不限时也能展示用量），不区分是否被某一级配额限制。 */
export function selfMonthUsage(sql: Reader, userId: string, at: number) {
  const [from, to] = monthBounds(at);
  return usedByUsers(sql, '?', [userId], from, to, at);
}

/** 组及其全部子组成员的本月已用合计，供台账展示（口径同配额）。 */
export function groupMonthUsage(sql: Reader, groupId: string, at: number) {
  const [from, to] = monthBounds(at);
  const members = `SELECT user_id FROM members WHERE group_id IN (${groupSubtree})`;
  return usedByUsers(sql, members, [groupId], from, to, at);
}

/** 一次查询取全体成员本月已用（settle + 活跃预留），供 /members 台账批量展示，避免逐行查询。 */
export function monthUsageByUser(sql: Pick<Transaction, 'all'>, at: number): Map<string, number> {
  const [from, to] = monthBounds(at);
  const usage = new Map<string, number>();
  for (const { user_id, settled } of sql.all<{ user_id: string; settled: number }>(
    "SELECT user_id, sum(amount_milli) AS settled FROM ledger WHERE kind = 'settle' AND at >= ? AND at < ? GROUP BY user_id", [from, to])) {
    usage.set(user_id, (usage.get(user_id) ?? 0) + settled);
  }
  for (const { user_id, reserved } of sql.all<{ user_id: string; reserved: number }>(
    `SELECT user_id, sum(amount) AS reserved FROM (
      SELECT user_id,budget_milli amount FROM leases WHERE status='active'
      UNION ALL SELECT user_id,fee_milli FROM commerce_tool_calls
      WHERE source_kind='http_search' AND status='awaiting_result' AND reserved_until>?
    ) GROUP BY user_id`, [iso(at)])) {
    usage.set(user_id, (usage.get(user_id) ?? 0) + reserved);
  }
  return usage;
}

/** 一次查询取全体组本月已用（含子组成员合计），供 /groups 台账批量展示，避免逐行查询和逐组的子树查询。 */
export function monthUsageByGroup(sql: Pick<Transaction, 'all'>, at: number): Map<string, number> {
  const byUser = monthUsageByUser(sql, at);
  const parentOf = new Map<string, string | null>();
  for (const { id, parent_id } of sql.all<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM groups')) {
    parentOf.set(id, parent_id);
  }
  const usage = new Map<string, number>([...parentOf.keys()].map((id) => [id, 0]));
  for (const { user_id, group_id } of sql.all<{ user_id: string; group_id: string | null }>('SELECT user_id, group_id FROM members')) {
    const spent = byUser.get(user_id);
    if (!spent || group_id === null) continue;
    // 从成员所在组一路加到每一级祖先，等价于逐组做子树聚合，但只走一遍成员列表。
    let current: string | null = group_id;
    while (current !== null && usage.has(current)) {
      usage.set(current, usage.get(current)! + spent);
      current = parentOf.get(current) ?? null;
    }
  }
  return usage;
}

function entry(sql: Transaction, kind: LedgerKind, amount_milli: number, at: number, options: {
  lease?: Pick<LeaseRow, 'id' | 'user_id'>; requestRef?: string; actor?: string; note?: string;
} = {}) {
  const row = { id: `led_${ulid()}`, kind, amount_milli, user_id: options.lease?.user_id ?? null, lease_id: options.lease?.id ?? null,
    request_ref: options.requestRef ?? null, by: options.actor ?? null, at: iso(at), note: options.note ?? null, revision: 1 };
  sql.run(`INSERT INTO ledger (id, kind, amount_milli, user_id, lease_id, request_ref, "by", at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.kind, row.amount_milli, row.user_id, row.lease_id, row.request_ref, row.by, row.at, row.note]);
  return { ...row, actions: ['read'] };
}

export { entry as appendLedgerEntry };

export function deviceAllowed(store: Store, sql: Reader, tenantId: string, deviceId: string, at: number) {
  return !!(store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [tenantId])
    && sql.get(`SELECT 1 FROM devices d JOIN members m ON m.user_id = d.user_id WHERE d.id = ?
      AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`, [deviceId, iso(at)]));
}

// 断流优先级（v0.13 edge-ws.md「断流原因优先级」）：disabled（调用方在 issue() 之前判定）> contract > balance > quota。
function issue(store:Store, sql: Transaction, deviceId: string, userId: string, at: number, supportsCapabilityContract: boolean, supportsCapabilityPolicy: boolean,
  settledLeaseId?: string): LeaseReply {
  const policy=readPolicyHot(sql,userId);
  if (policy && (!supportsCapabilityPolicy || policy.allowed_models_json==='[]')) return cutoff('contract',settledLeaseId);
  const contract=policy??readContract(sql);
  if (!contract || contract.lease_budget_milli <= 0 || (!policy && contract.platform_revision > 0 && !supportsCapabilityContract)) {
    return cutoff('contract', settledLeaseId);
  }
  const outstanding = sql.get<LeaseRow>("SELECT * FROM leases WHERE device_id = ? AND status = 'active'", [deviceId]);
  if (outstanding) return leaseView(outstanding,sql);
  const plan=readPlan(store,policy);
  grantPackage(sql,plan,at);
  settlePendingTools(sql,at);
  const wallet = balance(sql, at);
  const available = wallet.balance_milli;
  // 余额和配额都耗尽时报 balance（合约优先级见 data-model.md 配额一节）。
  if (available <= 0) return cutoff('balance', settledLeaseId);
  const binding = quotaBinding(sql, userId, at);
  if (binding && binding.remaining_milli <= 0) return cutoff('quota', settledLeaseId);
  const budget = Math.min(available, contract.lease_budget_milli, Math.max(1, Math.floor(available / 20)),
    ...(binding ? [binding.remaining_milli] : []));
  // The reservation itself can cross the threshold. Avoid reserving money for a member with no permitted fallback.
  if (policy && balancePolicyMode(policy, { balance_milli: available - budget, reserved_milli: wallet.reserved_milli + budget }) === 'restricted') {
    const allowed = new Set<string>(JSON.parse(policy.allowed_models_json));
    if (!balanceFallbackModels(policy).some(id => allowed.has(id))) return cutoff('contract', settledLeaseId);
  }
  const last = sql.get<{ seq: number }>('SELECT seq FROM leases WHERE device_id = ? ORDER BY seq DESC LIMIT 1', [deviceId]);
  const row: LeaseRow = { id: `lse_${ulid()}`, device_id: deviceId, user_id: userId, budget_milli: budget, used_milli: 0,
    expires_at: iso(Math.min(at + contract.lease_minutes * 60_000,plan?Date.parse(monthBounds(at)[1]):Infinity)), status: 'active', seq: (last?.seq ?? 0) + 1 };
  sql.run('INSERT INTO leases (id, device_id, user_id, budget_milli, expires_at, status, seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [row.id, deviceId, userId, budget, row.expires_at, row.status, row.seq]);
  if (policy && plan) {
    reserveCommercial(sql,row.id,budget,plan,policy,at);
    sql.run('UPDATE commerce_leases SET tool_prices_json=? WHERE lease_id=?',
      [JSON.stringify(toolSnapshot(store,sql,deviceId,plan,policy)),row.id]);
  } else if (packageFunds(sql,at).package_available_milli>0) {
    sql.run(`INSERT INTO commerce_leases(lease_id,month,plan_id,terms_json,platform_revision,policy_revision,package_reserved,issued_at)
      SELECT ?,month,plan_id,'{}',0,0,?,? FROM commerce_packages WHERE month=strftime('%Y-%m',?,'+8 hours')`,
      [row.id,Math.min(budget,packageFunds(sql,at).package_available_milli),iso(at),iso(at)]);
  }
  if (policy && policy.discount_ppm < 1_000_000) {
    sql.run(`INSERT INTO policy_discount_leases (lease_id, platform_revision, policy_revision, ratio_ppm)
      VALUES (?, ?, ?, ?)`, [row.id, policy.platform_revision, policy.policy_revision, policy.discount_ppm]);
  }
  entry(sql, 'reserve', budget, at, { lease: row });
  return leaseView(row,sql);
}

export function initialLease(store: Store, tenantId: string, deviceId: string, userId: string, at: number, live: () => boolean,
  supportsCapabilityContract: boolean, supportsCapabilityPolicy = false) {
  return store.tenant(tenantId).write((sql) => {
    if (!live() || !deviceAllowed(store, sql, tenantId, deviceId, at)) return cutoff('disabled');
    return issue(store, sql, deviceId, userId, at, supportsCapabilityContract, supportsCapabilityPolicy);
  });
}

/** lease_request（v0.13）：设备不可用回 disabled；已有 active 租约直接回它；否则按签发规则裁决。不写 lease_operations。 */
export function requestLease(store: Store, tenantId: string, deviceId: string, userId: string, at: number, live: () => boolean,
  supportsCapabilityContract: boolean, supportsCapabilityPolicy = false) {
  return initialLease(store, tenantId, deviceId, userId, at, live, supportsCapabilityContract, supportsCapabilityPolicy);
}

export function reconcileUsage(sql: Transaction, deviceId: string) {
  const { settled } = sql.get<{ settled: number }>("SELECT coalesce(sum(used_milli), 0) AS settled FROM leases WHERE device_id = ? AND status = 'settled'", [deviceId])!;
  // A stream can finish on a later lease but keep its original lease_id in usage.
  const { reported } = sql.get<{ reported: number }>(`SELECT total(cost_milli) AS reported FROM usage
    WHERE device_id = ? AND lease_id IS NOT NULL AND complete = 1`, [deviceId])!;
  const status = reported === settled ? 'reconciled' : 'pending';
  sql.run(`UPDATE usage SET settlement_status = ? WHERE device_id = ? AND lease_id IS NOT NULL
    AND complete = 1 AND settlement_status <> ?`, [status, deviceId, status]);
}

export function renewLease(store: Store, tenantId: string, deviceId: string, userId: string, at: number, live: () => boolean,
  leaseId: string, used: number, opId: string, supportsCapabilityContract: boolean, supportsCapabilityPolicy = false, modelUsed?:unknown) {
  return store.tenant(tenantId).write((sql) => {
    if (!live() || !deviceAllowed(store, sql, tenantId, deviceId, at)) return cutoff('disabled');
    const report=modelReport(modelUsed);
    const reportJson=report?JSON.stringify(report):null;
    const cached = sql.get<{ lease_id: string; used_milli: number; result_json: string;model_used_json:string|null }>(
      'SELECT lease_id, used_milli, result_json, model_used_json FROM lease_operations WHERE device_id = ? AND op_id = ?', [deviceId, opId]);
    if (cached) {
      if (cached.lease_id !== leaseId || cached.used_milli !== used || cached.model_used_json!==reportJson) throw new ApiError('conflict');
      const result = JSON.parse(cached.result_json) as LeaseReply;
      const policy=readPolicyHot(sql,userId);
      if (result.type==='lease') {
        const contract=policy??readContract(sql);
        if (!contract || contract.lease_budget_milli<=0 || (policy
          ? (!supportsCapabilityPolicy || policy.allowed_models_json==='[]')
          : (contract.platform_revision>0&&!supportsCapabilityContract))) return cutoff('contract',leaseId);
      }
      return result;
    }
    const lease = sql.get<LeaseRow>('SELECT * FROM leases WHERE id = ? AND device_id = ?', [leaseId, deviceId]);
    if (!lease) throw new ApiError('not_found');
    if (lease.status !== 'active') throw new ApiError('conflict');
    // Edge 诚实上报的实际用量可能略超这份额度（尾部花费在发出预留之后才计出）。租户只按这份额度实扣，
    // 多出的部分单独记一笔 overage_pending 挂账待核对，不计入余额、消费或预留，也不转嫁到下一份租约。
    const charged = Math.min(used, lease.budget_milli);
    sql.run("UPDATE leases SET used_milli = ?, status = 'settled', revision = revision + 1 WHERE id = ?", [charged, leaseId]);
    settleCommercial(sql,leaseId,charged,used,report,at);
    if (charged) entry(sql, 'settle', charged, at, { lease, requestRef: opId });
    if (charged < lease.budget_milli) entry(sql, 'release', lease.budget_milli - charged, at, { lease, requestRef: opId });
    if (used > charged) entry(sql, 'overage_pending', used - charged, at, { lease, requestRef: opId, note: '超租约差额待核对' });
    reconcileUsage(sql, deviceId);
    // 旧租约已经在上面结清；如果这次裁决回 cutoff，带上 settled_lease_id 让 Edge 知道这份租约不用再保留或重放（v0.13）。
    const response = issue(store, sql, deviceId, userId, at, supportsCapabilityContract, supportsCapabilityPolicy, lease.id);
    sql.run('INSERT INTO lease_operations (device_id, op_id, lease_id, used_milli, result_json, model_used_json) VALUES (?, ?, ?, ?, ?, ?)',
      [deviceId, opId, leaseId, used, JSON.stringify(response), reportJson]);
    return response;
  });
}

export function billingRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  app.get('/v1/quota/usage', (c) => {
    const at = opts.now();
    const actor = tenantActor(store, c, at);
    const { db, role } = actor;
    const scope = enumField(c.req.query('scope') ?? '', 'scope', ['member', 'group']);
    const id = field(c.req.query('id') ?? '', 'id');
    const quota_distribution = quotaConfigurable(db);
    const [from, to] = monthBounds(at);
    // 无权查看和不存在一律 404，不借由 403/404 的区别探测 id 是否存在（v0.13 契约修订）。
    if (scope === 'member') {
      const member = db.get<{ quota_milli: number | null; group_id: string | null }>('SELECT quota_milli, group_id FROM members WHERE user_id = ?', [id]);
      const allowed = role !== 'member' || id === actor.userId;
      const groupAllowed = role !== 'group_admin' || id === actor.userId || (actor.group_id && db.get(
        `SELECT 1 FROM members WHERE user_id = ? AND group_id IN (${groupSubtree})`, [id, actor.group_id]));
      if (!member || !allowed || !groupAllowed) throw new ApiError('not_found');
      const { settled, reserved } = usageByUsers(db, '?', [id], from, to, at);
      const quota_milli = quota_distribution ? (readHead(db)?effectivePolicy(db,'member',id)?.hot.quota_milli??null:member.quota_milli) : null;
      return c.json({ scope, id, quota_distribution, quota_milli, used_milli: settled, reserved_milli: reserved,
        remaining_milli: quota_milli === null ? null : quota_milli - settled - reserved, actions: ['read'] });
    }
    const group = db.get<{ quota_milli: number | null }>('SELECT quota_milli FROM groups WHERE id = ?', [id]);
    const groupAllowed = role !== 'member' && (role !== 'group_admin' || (actor.group_id && db.get(`SELECT 1 FROM (${groupSubtree}) WHERE id = ?`, [actor.group_id, id])));
    if (!group || !groupAllowed) throw new ApiError('not_found');
    const members = `SELECT user_id FROM members WHERE group_id IN (${groupSubtree})`;
    const { settled, reserved } = usageByUsers(db, members, [id], from, to, at);
    const quota_milli = quota_distribution ? (readHead(db)?effectivePolicy(db,'group',id)?.hot.quota_milli??null:group.quota_milli) : null;
    return c.json({ scope, id, quota_distribution, quota_milli, used_milli: settled, reserved_milli: reserved,
      remaining_milli: quota_milli === null ? null : quota_milli - settled - reserved, actions: ['read'] });
  });
  app.get('/v1/balance', (c) => {
    const at = opts.now();
    const { db, role } = tenantActor(store, c, at);
    if (role !== 'owner' && role !== 'admin') throw new ApiError('forbidden');
    // The immutable ledger advances the balance object's revision.
    const { revision } = db.get<{ revision: number }>('SELECT count(*) + 1 AS revision FROM commerce_ledger')!;
    return c.json({ ...balance(db, at), revision, actions: ['read'] });
  });
  app.get('/v1/ledger', (c) => {
    const { db, role } = tenantActor(store, c, opts.now());
    if (role !== 'owner' && role !== 'admin') throw new ApiError('forbidden');
    const p = pagination(c);
    const where = "WHERE instr(lower(kind || ' ' || coalesce(note, '')), lower(?)) > 0";
    const { n } = db.get<{ n: number }>(`SELECT count(*) AS n FROM commerce_ledger ${where}`, [p.query])!;
    const month = role === 'owner' ? ', (SELECT month FROM policy_discount_periods p WHERE p.adjustment_ledger_id = ledger.id) AS discount_month' : '';
    const rows = db.all<Record<string, unknown>>(`SELECT ledger.*${month} FROM commerce_ledger ledger ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`, [p.query, p.limit, p.offset]);
    return c.json(p.page(rows.map(({ discount_month, ...row }) => ({ ...row,
      ...(discount_month && typeof discount_month === 'string' ? { discount_month, actions: ['read', 'read_discount'] } : { actions: ['read'] }),
    })), n));
  });
  app.post('/v1/platform/ledger/topup', async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const id = body.tenant_id;
    if (!isTenantId(id)) invalid('tenant_id');
    if (!store.system.get('SELECT 1 FROM tenants WHERE id = ?', [id])) throw new ApiError('not_found');
    const amount = int(body.amount_milli, 'amount_milli', 1);
    const note = body.note === undefined ? undefined : field(body.note, 'note', 500);
    const op = operation(c, opts.codeSecret, at, actor, [id, amount, note]);
    return store.tenant(id).write((sql) => {
      if (!store.system.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [actor])) throw new ApiError('forbidden');
      if (readHead(sql) || !readContract(sql)) throw new ApiError('conflict', { reason: 'use_policy_recharges' });
      const cached = op.read(sql);
      if (cached) return cached;
      // Keep aggregate ledger arithmetic exactly representable by the API's integers.
      const { total } = sql.get<{ total: number }>("SELECT coalesce(sum(amount_milli), 0) AS total FROM ledger WHERE kind = 'topup'")!;
      if (!Number.isSafeInteger(total + amount)) invalid('amount_milli');
      const row = entry(sql, 'topup', amount, at, { actor, note });
      sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${ulid()}`, actor, 'ledger.topup', row.id, JSON.stringify({ amount_milli: amount, note }), iso(at)]);
      return op.complete(sql, { status: 201, payload: { ...row, tenant_id: id } });
    });
  });
  app.get('/v1/observe/stale-leases', (c) => {
    const at = opts.now();
    const { db, role } = tenantActor(store, c, at);
    if (role !== 'owner' && role !== 'admin') throw new ApiError('forbidden');
    const p = pagination(c);
    const where = `WHERE l.status = 'active' AND l.expires_at < ? AND coalesce(d.last_seen_at, '') < ?
      AND instr(lower(l.id || ' ' || d.name), lower(?)) > 0`;
    const params = [iso(at), iso(at - day), p.query];
    const { n } = db.get<{ n: number }>(`SELECT count(*) AS n FROM leases l JOIN devices d ON d.id = l.device_id ${where}`, params)!;
    const rows = db.all<Record<string, unknown>>(`SELECT l.*, d.last_seen_at FROM leases l JOIN devices d ON d.id = l.device_id ${where}
      ORDER BY l.expires_at, l.id LIMIT ? OFFSET ?`, [...params, p.limit, p.offset]);
    return c.json(p.page(rows.map((row) => ({ ...row, actions: ['read'] })), n));
  });
}
