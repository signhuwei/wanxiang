import type { Hono } from 'hono';
import { ApiError, invalid } from './api';
import { iso } from './credentials';
import { platformActor, type ManagementOptions } from './management';
import type { Presence } from './presence';
import { boundPage, queryValue, routeId } from './routing-http';
import type { Store } from './store';

/**
 * Platform rollout ledger (contracts/routing-projection.md, 管理端). State is folded per roster row from the tenant
 * database at read time: applied when the exact target has a persisted success receipt, otherwise superseded,
 * rejected, observed unsupported, offline, pending — in that order.
 */
export const rolloutStates = ['pending', 'applied', 'rejected', 'offline', 'needs_upgrade', 'superseded'] as const;
type State = typeof rolloutStates[number];
type RosterRow = { tenant_id: string; device_id: string; user_id: string; target_config_revision: number | null; projection_id: string | null;
  outcome: 'superseded' | 'failed' | null; outcome_reason: string | null };
export type RolloutTarget = { tenant_id: string; user_id: string; device_id: string; target_config_revision: number | null;
  applied_config_revision: number | null; state: State; reason: string | null; last_seen_at: string | null; last_receipt_at: string | null; actions: string[] };

async function fold(store: Store, presence: Presence, rows: RosterRow[], now: string): Promise<RolloutTarget[]> {
  const result: RolloutTarget[] = [];
  for (const row of rows) {
    let db;
    try { db = store.tenant(row.tenant_id); } catch { db = null; }
    const device = db?.get<{ last_seen_at: string | null }>('SELECT last_seen_at FROM devices WHERE id = ?', [row.device_id]);
    const head = db?.get<{ config_revision: number }>('SELECT config_revision FROM policy_device_applications WHERE device_id = ?', [row.device_id]);
    const target = row.target_config_revision === null ? null : db?.get<{ rejected_at: string | null; last_failure_json: string | null; valid_until: string }>(
      `SELECT d.rejected_at, d.last_failure_json, s.valid_until FROM routing_config_deliveries d JOIN routing_config_snapshots s
       ON s.device_id = d.device_id AND s.config_revision = d.config_revision AND s.projection_id = d.projection_id
       WHERE d.device_id = ? AND d.config_revision = ? AND d.projection_id = ?`,
      [row.device_id, row.target_config_revision, row.projection_id]);
    const receipts = row.target_config_revision === null ? null : db?.get<{ applied: number; last: string | null }>(`SELECT
      count(*) FILTER (WHERE result = 'applied') AS applied, max(received_at) AS last FROM routing_config_receipts
      WHERE device_id = ? AND config_revision = ? AND projection_id = ?`, [row.device_id, row.target_config_revision, row.projection_id]);
    const failure = target?.last_failure_json ? JSON.parse(target.last_failure_json) as { code: string; reason: string } : null;
    // An unapplied target past its validity is never resent; it waits for a job to regenerate a higher revision.
    const waiting = target && target.valid_until <= now ? 'target_expired' : failure?.reason ?? 'awaiting_receipt';
    let state: State, reason: string | null;
    if (receipts?.applied) [state, reason] = ['applied', null];
    else if (row.outcome === 'superseded') [state, reason] = ['superseded', row.outcome_reason];
    else if (target?.rejected_at) [state, reason] = ['rejected', failure?.reason ?? null];
    else if (failure?.code === 'unsupported_capability' || row.outcome_reason === 'unsupported_capability') [state, reason] = ['needs_upgrade', 'unsupported_capability'];
    else if (!await presence.get(row.device_id)) [state, reason] = ['offline', row.outcome === 'failed' ? row.outcome_reason
      : target && target.valid_until <= now ? 'target_expired' : 'device_offline'];
    else [state, reason] = ['pending', row.outcome === 'failed' ? row.outcome_reason
      : row.target_config_revision === null ? 'not_projected' : waiting];
    result.push({ tenant_id: row.tenant_id, user_id: row.user_id, device_id: row.device_id, target_config_revision: row.target_config_revision,
      applied_config_revision: head?.config_revision ?? null, state, reason, last_seen_at: device?.last_seen_at ?? null,
      last_receipt_at: receipts?.last ?? null, actions: [] });
  }
  return result;
}

export function rolloutRoutes(app: Hono, store: Store, opts: ManagementOptions, presence: Presence) {
  const base = '/v1/platform/model-pool-rollouts/:rollout_id';
  function load(id: string) {
    const job = store.system.get<{ job_id: string; model_id: string; pool_revision: number; status: string }>(
      'SELECT job_id, model_id, pool_revision, status FROM route_release_jobs WHERE job_id = ?', [id]);
    if (!job) throw new ApiError('not_found');
    const rows = store.system.all<RosterRow>(`SELECT tenant_id, device_id, user_id, target_config_revision, projection_id, outcome, outcome_reason
      FROM route_rollout_targets WHERE rollout_id = ? ORDER BY tenant_id, device_id`, [id]);
    return { job, rows };
  }

  app.get(base, async c => {
    platformActor(store, c, opts.now());
    const { job, rows } = load(routeId(c.req.param('rollout_id'), 'rollout_id'));
    const targets = await fold(store, presence, rows, iso(opts.now()));
    const counts = Object.fromEntries(rolloutStates.map(state => [state, targets.filter(row => row.state === state).length]));
    return c.json({ rollout_id: job.job_id, model_id: job.model_id, pool_revision: job.pool_revision, job_status: job.status,
      total: targets.length, counts, actions: ['read'] });
  });

  app.get(`${base}/targets`, async c => {
    const actor = platformActor(store, c, opts.now());
    const id = routeId(c.req.param('rollout_id'), 'rollout_id');
    const state = queryValue(c, 'state');
    if (state !== undefined && !(rolloutStates as readonly string[]).includes(state)) invalid('state');
    const page = boundPage(c, opts.codeSecret, actor, { rollout_id: id, state: state ?? null });
    const { rows } = load(id);
    const targets = (await fold(store, presence, rows, iso(opts.now()))).filter(row => !state || row.state === state);
    return c.json(page.page(targets.slice(page.offset, page.offset + page.limit), targets.length, ['read']));
  });
}
