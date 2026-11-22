import { ulid } from 'ulid';
import { ApiError } from './api';
import { cutoff, deviceAllowed, issueLeaseInTransaction, leaseView, settleLease, type Cutoff, type LeaseReply, type LeaseRow } from './billing';
import { modelBudgetWire, modelReport } from './commerce-data';
import { iso } from './credentials';
import { readPolicyDevice } from './policy-data';
import { projectionStillAuthorized, type RoutePoolConfig, type RoutingProjectionInputs } from './route-projection';
import type { Store, Transaction } from './store';

/**
 * Isolated lease gate for route_pool.v1 sessions (contracts/routing-lease-gate.md). Reachable only when tests inject
 * routing inputs with leaseGate on; production handshakes never select route_pool.v1 and keep the legacy lease path.
 */
export const leaseGateReasons = ['projection_not_applied', 'projection_signature_stale', 'projection_plan_changed', 'projection_revoked',
  'projection_expired', 'projection_authorization_changed'] as const;
export type LeaseGateReason = typeof leaseGateReasons[number];

type Snapshot = { device_id: string; config_revision: number; projection_id: string; user_id: string; platform_revision: number;
  revocation_revision: number; payload_json: string; valid_until: string };
type Context = { store: Store; inputs: RoutingProjectionInputs; tenantId: string; deviceId: string; userId: string; at: number };

const snapshotQuery = `SELECT device_id, config_revision, projection_id, user_id, platform_revision, revocation_revision, payload_json, valid_until
  FROM routing_config_snapshots WHERE device_id = ? AND config_revision = ? AND projection_id = ?`;

/** The exact applied head of the authenticated device, backed by its own persisted snapshot and a stored applied receipt. */
export function appliedHead(sql: Transaction, deviceId: string, userId: string): Snapshot | null {
  const head = sql.get<{ config_revision: number; projection_id: string | null }>(
    'SELECT config_revision, projection_id FROM policy_device_applications WHERE device_id = ?', [deviceId]);
  if (!head?.projection_id) return null;
  const snapshot = sql.get<Snapshot>(snapshotQuery, [deviceId, head.config_revision, head.projection_id]);
  if (!snapshot || snapshot.user_id !== userId) return null;
  const applied = sql.get(`SELECT 1 FROM routing_config_receipts WHERE device_id = ? AND config_revision = ? AND projection_id = ?
    AND result = 'applied'`, [deviceId, snapshot.config_revision, snapshot.projection_id]);
  return applied ? snapshot : null;
}

/** Checks a projection against the current signature, plan, revocation, validity and authorization, in contract order. */
function projectionFault(ctx: Context, sql: Transaction, snapshot: Snapshot): Exclude<LeaseGateReason, 'projection_not_applied'> | null {
  const policy = readPolicyDevice(sql, ctx.userId);
  const config = JSON.parse(snapshot.payload_json) as RoutePoolConfig;
  if (!policy || policy.platform_revision !== snapshot.platform_revision) return 'projection_signature_stale';
  if ((config.policy.commerce_plan_id ?? null) !== (policy.commerce_plan_id ?? null)) return 'projection_plan_changed';
  if (snapshot.revocation_revision < (ctx.inputs.revocationRevision?.(ctx.tenantId, ctx.deviceId) ?? 0)) return 'projection_revoked';
  if (snapshot.valid_until <= iso(ctx.at)) return 'projection_expired';
  if (!projectionStillAuthorized(ctx.store, sql, ctx.inputs, ctx.tenantId, ctx.deviceId, config, ctx.at)) return 'projection_authorization_changed';
  return null;
}

/** First applicable gate reason for issuing a new lease, or the applied snapshot to bind it to. */
export function gateNewLease(ctx: Context, sql: Transaction): { snapshot: Snapshot } | { reason: LeaseGateReason } {
  const snapshot = appliedHead(sql, ctx.deviceId, ctx.userId);
  if (!snapshot) return { reason: 'projection_not_applied' };
  const fault = projectionFault(ctx, sql, snapshot);
  return fault ? { reason: fault } : { snapshot };
}

/** The immutable projection link of a lease, if any. */
export function leaseProjection(sql: Transaction, lease: Pick<LeaseRow, 'id' | 'device_id'>): Snapshot | null {
  return sql.get<Snapshot>(`SELECT s.device_id, s.config_revision, s.projection_id, s.user_id, s.platform_revision, s.revocation_revision,
    s.payload_json, s.valid_until FROM routing_lease_projections p JOIN routing_config_snapshots s ON s.device_id = p.device_id
    AND s.config_revision = p.config_revision AND s.projection_id = p.projection_id WHERE p.lease_id = ? AND p.device_id = ?`,
    [lease.id, lease.device_id]) ?? null;
}

/** An active lease can be reaffirmed only with its link intact, unexpired, and its projection still current and authorized. */
export function reaffirmable(ctx: Context, sql: Transaction, lease: LeaseRow) {
  if (lease.status !== 'active' || lease.expires_at <= iso(ctx.at)) return null;
  const linked = leaseProjection(sql, lease);
  return linked && !projectionFault(ctx, sql, linked) ? linked : null;
}

export type RouteLease = Extract<LeaseReply, { type: 'lease' }> & { signature_id: string; config_revision: number; projection_id: string;
  settled_lease_id?: string };

export function routeLeaseFrame(sql: Transaction, lease: LeaseRow, snapshot: Snapshot, settledLeaseId?: string): RouteLease {
  const config = JSON.parse(snapshot.payload_json) as RoutePoolConfig;
  return { ...leaseView(lease, sql), signature_id: config.route_pool.signature_id, config_revision: snapshot.config_revision,
    projection_id: snapshot.projection_id, ...(settledLeaseId !== undefined && { settled_lease_id: settledLeaseId }) };
}

/**
 * Issues a lease bound to the passed applied snapshot, inside the caller's tenant transaction. Balance, quota and
 * contract cutoffs keep the legacy decision; the lease never outlives the projection.
 */
export function issueBound(ctx: Context, sql: Transaction, snapshot: Snapshot, settledLeaseId?: string): LeaseReply | RouteLease {
  const reply = issueLeaseInTransaction(ctx.store, sql, ctx.deviceId, ctx.userId, ctx.at, true, true, settledLeaseId,
    { notAfter: snapshot.valid_until });
  if (reply.type !== 'lease') return reply;
  const lease = sql.get<LeaseRow>('SELECT * FROM leases WHERE id = ? AND device_id = ?', [reply.lease_id, ctx.deviceId])!;
  sql.run('INSERT INTO routing_lease_projections (lease_id, device_id, config_revision, projection_id) VALUES (?, ?, ?, ?)',
    [lease.id, ctx.deviceId, snapshot.config_revision, snapshot.projection_id]);
  return routeLeaseFrame(sql, lease, snapshot, settledLeaseId);
}

/**
 * lease_request on an isolated session. Never pushed by hello or config_applied. An active lease is reaffirmed with its
 * original link or must be settled first; otherwise the applied head of this device gates a new lease. A refusal
 * writes no reserve.
 */
export function requestRouteLease(store: Store, inputs: RoutingProjectionInputs, tenantId: string, deviceId: string, userId: string,
  at: number, live: () => boolean) {
  const ctx: Context = { store, inputs, tenantId, deviceId, userId, at };
  return store.tenant(tenantId).write((sql): LeaseReply | RouteLease => {
    if (!live() || !deviceAllowed(store, sql, tenantId, deviceId, at)) return cutoff('disabled');
    const active = sql.get<LeaseRow>("SELECT * FROM leases WHERE device_id = ? AND status = 'active'", [deviceId]);
    if (active) {
      const linked = reaffirmable(ctx, sql, active);
      if (!linked) throw new ApiError('forbidden', { reason: 'lease_settlement_required', lease_id: active.id });
      return routeLeaseFrame(sql, active, linked);
    }
    const gate = gateNewLease(ctx, sql);
    if ('reason' in gate) throw new ApiError('forbidden', { reason: gate.reason });
    return issueBound(ctx, sql, gate.snapshot);
  });
}

export type RenewFrame = { lease_id: string; op_id: string; used_milli: number; model_used_milli: Record<string, number> | null; release_only: boolean };
type RouteCutoff = Cutoff & { detail?: { reason: string; lease_id?: string } };
const contractCutoff = (settledLeaseId: string, reason: string, leaseId?: string): RouteCutoff =>
  ({ ...cutoff('contract', settledLeaseId), detail: { reason, ...(leaseId !== undefined && { lease_id: leaseId }) } });

/** Strict isolated lease_renew fields; op_id is required and release_only must be a boolean when present. */
export function parseRenew(msg: Record<string, unknown>): RenewFrame {
  const fields: string[] = [];
  const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (!text(msg.lease_id)) fields.push('lease_id');
  if (!text(msg.op_id)) fields.push('op_id');
  if (typeof msg.used_milli !== 'number' || !Number.isSafeInteger(msg.used_milli) || msg.used_milli < 0) fields.push('used_milli');
  if (msg.release_only !== undefined && typeof msg.release_only !== 'boolean') fields.push('release_only');
  if (fields.length) throw new ApiError('invalid', { fields });
  return { lease_id: msg.lease_id as string, op_id: msg.op_id as string, used_milli: msg.used_milli as number,
    model_used_milli: modelReport(msg.model_used_milli), release_only: msg.release_only === true };
}

/**
 * lease_renew on an isolated session. Settles the old lease once by its original terms, then follows the first-lease
 * rules for a successor. The operation row keeps the settlement and the first decision; a replay never charges,
 * reserves or issues again and only re-checks a cached successor. release_only settles a lease the device never used
 * and issues nothing.
 */
export function renewRouteLease(store: Store, inputs: RoutingProjectionInputs, tenantId: string, deviceId: string, userId: string,
  at: number, live: () => boolean, frame: RenewFrame) {
  const ctx: Context = { store, inputs, tenantId, deviceId, userId, at };
  const mode = frame.release_only ? 'route_pool_release_only' : 'route_pool';
  const reportJson = frame.model_used_milli ? JSON.stringify(frame.model_used_milli) : null;
  return store.tenant(tenantId).write((sql): LeaseReply | RouteLease | RouteCutoff => {
    if (!live() || !deviceAllowed(store, sql, tenantId, deviceId, at)) return cutoff('disabled');
    const cached = sql.get<{ lease_id: string; used_milli: number; result_json: string; model_used_json: string | null; mode: string }>(
      'SELECT lease_id, used_milli, result_json, model_used_json, mode FROM lease_operations WHERE device_id = ? AND op_id = ?', [deviceId, frame.op_id]);
    if (cached) {
      if (cached.lease_id !== frame.lease_id || cached.used_milli !== frame.used_milli || cached.model_used_json !== reportJson || cached.mode !== mode) {
        throw new ApiError('conflict');
      }
      const first = JSON.parse(cached.result_json) as RouteLease | RouteCutoff;
      if (first.type !== 'lease') return { ...first, id: `msg_${ulid()}` };
      const successor = sql.get<LeaseRow>('SELECT * FROM leases WHERE id = ? AND device_id = ?', [first.lease_id, deviceId])!;
      const linked = reaffirmable(ctx, sql, successor);
      if (linked) return routeLeaseFrame(sql, successor, linked, cached.lease_id);
      return contractCutoff(cached.lease_id, 'successor_lease_unavailable', successor.status === 'active' ? successor.id : undefined);
    }
    const lease = sql.get<LeaseRow>('SELECT * FROM leases WHERE id = ? AND device_id = ?', [frame.lease_id, deviceId]);
    if (!lease) throw new ApiError('not_found');
    if (lease.status !== 'active') throw new ApiError('conflict');
    let response: LeaseReply | RouteLease | RouteCutoff;
    if (frame.release_only) {
      // Only a bound lease the device never accepted: zero in total and for every allocated model.
      if (!leaseProjection(sql, lease)) throw new ApiError('invalid', { fields: ['release_only'] });
      if (frame.used_milli !== 0) throw new ApiError('invalid', { fields: ['used_milli'] });
      const allocated = Object.keys(modelBudgetWire(sql, lease.id));
      const report = frame.model_used_milli ?? {};
      if (allocated.some(model => report[model] !== 0) || Object.keys(report).some(model => !allocated.includes(model))) {
        throw new ApiError('invalid', { fields: ['model_used_milli'] });
      }
      settleLease(sql, deviceId, lease, 0, frame.model_used_milli, frame.op_id, at);
      response = contractCutoff(lease.id, 'lease_released');
    } else {
      settleLease(sql, deviceId, lease, frame.used_milli, frame.model_used_milli, frame.op_id, at);
      const gate = gateNewLease(ctx, sql);
      response = 'reason' in gate ? contractCutoff(lease.id, gate.reason) : issueBound(ctx, sql, gate.snapshot, lease.id);
    }
    sql.run('INSERT INTO lease_operations (device_id, op_id, lease_id, used_milli, result_json, model_used_json, mode) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [deviceId, frame.op_id, lease.id, frame.used_milli, JSON.stringify(response), reportJson, mode]);
    return response;
  });
}
