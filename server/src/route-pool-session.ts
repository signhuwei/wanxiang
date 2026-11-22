import { ulid } from 'ulid';
import { ApiError } from './api';
import { iso } from './credentials';
import { buildProjection, latestSnapshot, ProjectionFailure, readSnapshot, type RoutePoolConfig, type RoutingProjector } from './route-projection';
import { RouteSecretError, sealRoutePoolConfig } from './route-secret';
import { digest, routeIdPattern } from './routing-http';
import type { Store, Transaction } from './store';

/**
 * Isolated route_pool.v1 device sessions (contracts/routing-projection.md, device protocol).
 * Only reachable when tests inject routing inputs; production handshakes never select the capability.
 */
export const ROUTE_POOL_CAPABILITY = 'route_pool.v1';
export const routePoolLeasePending = () => new ApiError('forbidden', { reason: 'route_pool_lease_pending' });
/** A device registered for the isolated stage connected without the capability: show needs_upgrade, no legacy fallback. */
export const unsupportedRoutePool = () => new ApiError('unsupported_capability', { reason: 'route_pool_required' });

const stableCode = /^[a-z][a-z0-9_]{0,63}$/;
const receiptKeys = ['type', 'id', 'config_revision', 'policy_revision', 'projection_id', 'result', 'error'];
const deviceQuery = `SELECT d.id, d.public_key FROM devices d JOIN members m ON m.user_id = d.user_id
  WHERE d.id = ? AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`;

export type Receipt = { id: string; config_revision: number; policy_revision: number; projection_id: string; result: 'applied' | 'rejected';
  error_code: string | null; error_reason: string | null; content_digest: string };

/** The hello must declare the capability together with its prerequisites; the server-side test factory decides selection. */
export function selectsRoutePool(projector: RoutingProjector | undefined, tenantId: string, deviceId: string, hello: Record<string, unknown>) {
  if (!projector?.inputs.selectRoutePool(tenantId, deviceId)) return { selected: false, observedUnsupported: false };
  const declared = Array.isArray(hello.capabilities) && hello.capabilities.includes(ROUTE_POOL_CAPABILITY)
    && hello.capability_policy_v2 === true && hello.policy_runtime_v1 === true && hello.agent_cache === true;
  return { selected: declared, observedUnsupported: !declared };
}

/**
 * Strict new-protocol receipt. Missing or extra fields reject the frame instead of degrading to a legacy confirmation.
 * The digest covers the whole valid receipt; only stable codes are persisted.
 */
export function parseReceipt(msg: Record<string, unknown>): Receipt {
  const fields: string[] = Object.keys(msg).filter(key => !receiptKeys.includes(key));
  const id = msg.id, revision = msg.config_revision, policy = msg.policy_revision, projection = msg.projection_id, result = msg.result;
  if (typeof id !== 'string' || !id || id.length > 128) fields.push('id');
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) fields.push('config_revision');
  if (typeof policy !== 'number' || !Number.isSafeInteger(policy) || policy < 1) fields.push('policy_revision');
  if (typeof projection !== 'string' || !routeIdPattern.test(projection)) fields.push('projection_id');
  if (result !== 'applied' && result !== 'rejected') fields.push('result');
  let code: string | null = null, reason: string | null = null;
  if (result === 'applied' && Object.hasOwn(msg, 'error')) fields.push('error');
  if (result === 'rejected') {
    const error = msg.error as Record<string, unknown> | undefined;
    if (!error || typeof error !== 'object' || Array.isArray(error) || Object.keys(error).some(key => !['code', 'message', 'detail'].includes(key))) fields.push('error');
    else {
      if (typeof error.code !== 'string' || !stableCode.test(error.code)) fields.push('error.code');
      else code = error.code;
      if (error.message !== undefined && (typeof error.message !== 'string' || error.message.length > 500)) fields.push('error.message');
      const detail = error.detail as Record<string, unknown> | undefined;
      if (!detail || typeof detail !== 'object' || Array.isArray(detail) || typeof detail.reason !== 'string' || !stableCode.test(detail.reason)) {
        fields.push('error.detail.reason');
      } else reason = detail.reason;
    }
  }
  if (fields.length) throw new ApiError('invalid', { fields: [...new Set(fields)] });
  return { id: id as string, config_revision: revision as number, policy_revision: policy as number, projection_id: projection as string,
    result: result as Receipt['result'], error_code: code, error_reason: reason, content_digest: digest(msg) };
}

const failure = (code: string, reason: string, at: string) => JSON.stringify({ code, reason, at });

/**
 * Commits a receipt against the persisted target of the authenticated device. Applied receipts advance the head
 * monotonically; a late rejection never overrides a confirmed success; a legal lower revision is kept but does not
 * move the head. Throws ApiError for conflicts; the caller acknowledges only after this resolves.
 */
export function applyReceipt(store: Store, tenantId: string, deviceId: string, receipt: Receipt, at: number, live: () => boolean) {
  return store.tenant(tenantId).write(sql => {
    const now = iso(at);
    if (!live() || !store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [tenantId]) || !sql.get(deviceQuery, [deviceId, now])) {
      throw new ApiError('forbidden', { reason: 'device_unavailable' });
    }
    const previous = sql.get<{ content_digest: string }>('SELECT content_digest FROM routing_config_receipts WHERE device_id = ? AND receipt_id = ?', [deviceId, receipt.id]);
    if (previous) {
      if (previous.content_digest !== receipt.content_digest) throw new ApiError('conflict', { reason: 'receipt_changed' });
      return 'replayed' as const;
    }
    const target = readSnapshot(sql, deviceId, receipt.config_revision);
    if (!target) throw new ApiError('conflict', { reason: 'unknown_target' });
    if (target.projection_id !== receipt.projection_id) throw new ApiError('conflict', { reason: 'projection_mismatch' });
    if (target.policy_revision !== receipt.policy_revision) throw new ApiError('conflict', { reason: 'policy_revision_mismatch' });
    sql.run(`INSERT INTO routing_config_receipts (device_id, receipt_id, config_revision, projection_id, policy_revision, result, error_code,
      error_reason, content_digest, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [deviceId, receipt.id, receipt.config_revision,
      receipt.projection_id, receipt.policy_revision, receipt.result, receipt.error_code, receipt.error_reason, receipt.content_digest, now]);
    if (receipt.result === 'applied') {
      sql.run('UPDATE routing_config_deliveries SET applied_at = coalesce(applied_at, ?) WHERE device_id = ? AND config_revision = ?',
        [now, deviceId, receipt.config_revision]);
      sql.run(`INSERT INTO policy_device_applications (device_id, config_revision, policy_revision, applied_at, projection_id)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET config_revision = excluded.config_revision,
        policy_revision = excluded.policy_revision, applied_at = excluded.applied_at, projection_id = excluded.projection_id
        WHERE excluded.config_revision > policy_device_applications.config_revision`,
        [deviceId, receipt.config_revision, receipt.policy_revision, now, receipt.projection_id]);
    } else {
      sql.run(`UPDATE routing_config_deliveries SET rejected_at = coalesce(rejected_at, ?), last_failure_json = ?
        WHERE device_id = ? AND config_revision = ? AND applied_at IS NULL`,
        [now, failure(receipt.error_code!, receipt.error_reason!, now), deviceId, receipt.config_revision]);
    }
    return 'stored' as const;
  });
}

/** Records that a test-selected device connected without the capability, for the rollout's needs_upgrade state. */
export async function observeUnsupported(store: Store, tenantId: string, deviceId: string, at: number) {
  const now = iso(at);
  await store.tenant(tenantId).write(sql => sql.run(`UPDATE routing_config_deliveries SET last_failure_json = ?
    WHERE device_id = ? AND applied_at IS NULL AND rejected_at IS NULL`, [failure('unsupported_capability', 'unsupported_capability', now), deviceId]));
  await store.system.write(sql => sql.run(`UPDATE route_rollout_targets SET outcome = 'failed', outcome_reason = 'unsupported_capability', updated_at = ?
    WHERE tenant_id = ? AND device_id = ? AND target_config_revision IS NULL AND (outcome IS NULL OR outcome = 'failed')`, [now, tenantId, deviceId]));
}

function recordFailure(sql: Transaction, deviceId: string, revision: number, code: string, reason: string, now: string) {
  sql.run(`UPDATE routing_config_deliveries SET last_failure_json = ?, retry_count = retry_count + 1 WHERE device_id = ? AND config_revision = ?`,
    [failure(code, reason, now), deviceId, revision]);
}

/**
 * Sends the device's current authorized projection, resealed with fresh envelopes for the same identity.
 * Before resealing, the original authorization, validity and revocation are re-checked by rebuilding the basis:
 * an unchanged, still valid target is resent (even if already applied); an expired or changed one records the
 * reason and a new target is generated, which takes a higher revision.
 */
export async function sendCurrentTarget(store: Store, projector: RoutingProjector, tenantId: string, deviceId: string, at: number,
  live: () => boolean, send: (frame: Record<string, unknown>) => void) {
  const db = store.tenant(tenantId);
  const now = iso(at);
  const latest = latestSnapshot(db, deviceId);
  let token: string | null = null;
  try { token = buildProjection(store, db, projector.inputs, tenantId, deviceId, at).source_token; }
  catch (error) {
    if (!(error instanceof ProjectionFailure)) throw error;
    if (latest) await db.write(sql => recordFailure(sql, deviceId, latest.config_revision, error.reason, error.reason, now));
    return null;
  }
  if (latest && (latest.valid_until <= now || latest.source_token !== token)) {
    const reason = latest.valid_until <= now ? 'target_expired' : 'authorization_changed';
    await db.write(sql => recordFailure(sql, deviceId, latest.config_revision, reason, reason, now));
  }
  let target;
  try { target = await projector.project(tenantId, deviceId, at, { notify: false }); }
  catch (error) { if (error instanceof ProjectionFailure) return null; throw error; }
  if (!live()) return null;
  const snapshot = readSnapshot(db, deviceId, target.config_revision)!;
  const device = db.get<{ public_key: string }>(deviceQuery, [deviceId, now]);
  let frame: RoutePoolConfig;
  try {
    if (!device) throw new RouteSecretError('invalid_config', 'device_unavailable');
    const config = { ...JSON.parse(snapshot.payload_json) as RoutePoolConfig, id: `msg_${ulid()}` };
    frame = sealRoutePoolConfig(config, { tenant_id: tenantId, device_id: deviceId, recipient_public_key: device.public_key },
      (id, version) => projector.inputs.credentialMaterial(id, version));
  } catch (error) {
    if (!(error instanceof RouteSecretError)) throw error;
    await db.write(sql => recordFailure(sql, deviceId, snapshot.config_revision, error.code, error.reason, now));
    return null;
  }
  send(frame);
  await db.write(sql => sql.run(`UPDATE routing_config_deliveries SET retry_count = retry_count + (sent_at IS NOT NULL), sent_at = coalesce(sent_at, ?)
    WHERE device_id = ? AND config_revision = ?`, [now, deviceId, snapshot.config_revision]));
  return { config_revision: snapshot.config_revision, projection_id: snapshot.projection_id };
}
