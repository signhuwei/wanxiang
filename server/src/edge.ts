import type { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import type { WSContext } from 'hono/ws';
import { ulid } from 'ulid';
import { ApiError } from './api';
import { deviceTtl } from './auth';
import { initialLease, renewLease } from './billing';
import { ackCursor, ingestUsage, usageItems } from './ingest';
import { int } from './management';
import type { PendingWork } from './pending';
import { bearer, hash, iso, randomToken } from './credentials';
import type { ConfigPublisher } from './edge-config';
import type { Presence } from './presence';
import type { Device, Store } from './store';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const isText = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isSeq = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function edgeGateway(app: Hono, store: Store, presence: Presence, now: () => number, heartbeatMs: number, config: ConfigPublisher, pending: PendingWork) {
  const current = new Map<string, WSContext>();
  const sockets = new Set<WSContext>();
  let closing = false;
  let allClosed: (() => void) | undefined;
  const ttl = heartbeatMs * 4;
  const activeTenant = (id: string) => store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [id]);
  const deviceQuery = `SELECT d.id, d.user_id, d.token_hash, d.token_expires_at, d.status FROM devices d JOIN members m ON m.user_id = d.user_id
    WHERE d.token_hash = ? AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`;

  app.get('/v1/edge/ws', async (c, next) => {
    const token = bearer(c.req.header('Authorization'));
    if (!token) throw new ApiError('unauthenticated');
    const tokenHash = hash(token);
    const version = c.req.header('OneX-Edge-Version');
    const parsed = version && version.length <= 64 ? semver.exec(version) : null;
    if (!parsed || parsed[4]?.split('.').some((part) => /^0\d+$/.test(part))) throw new ApiError('invalid', { fields: ['OneX-Edge-Version'] });
    if (c.req.header('OneX-Protocol') !== '0') throw new ApiError('invalid', { fields: ['OneX-Protocol'] });
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') throw new ApiError('invalid', { fields: ['Upgrade'] });
    const match = await store.device(tokenHash);
    if (!match || !activeTenant(match.id)) throw new ApiError('unauthenticated');
    const tenantId = match.id;
    const device = store.tenant(tenantId).get<Device>(deviceQuery, [tokenHash, iso(now())]);
    if (!device) throw new ApiError('unauthenticated');
    const { id: deviceId, user_id: userId } = device;
    const connectionId = randomToken();
    let state: 'hello' | 'starting' | 'ready' | 'closed' = 'hello';
    let timer: ReturnType<typeof setTimeout>;
    let socket: WSContext;
    let lastRenewal = 0;
    const awaiting = new Set<string>();
    let heartbeatBusy = false;

    const live = () => state !== 'closed' && current.get(deviceId) === socket;
    const send = (msg: Record<string, unknown>) => { if (live()) socket.send(JSON.stringify(msg)); };
    const subscription = { tenant: tenantId, live, send };
    const stop = (code: number, reason: string) => {
      state = 'closed';
      clearTimeout(timer);
      socket.close(code, reason);
    };
    async function renew() {
      return store.tenant(tenantId).write((sql) => {
        if (!live() || !activeTenant(tenantId)) return false;
        const at = now();
        if (!sql.get(deviceQuery, [tokenHash, iso(at)])) return false;
        sql.run('UPDATE devices SET last_seen_at = ?, token_expires_at = ?, edge_version = ? WHERE id = ?',
          [iso(at), iso(at + deviceTtl), version!, deviceId]);
        lastRenewal = at;
        return true;
      });
    }
    const tick = () => {
      if (!live()) return;
      if (awaiting.size >= 3) { stop(1008, 'heartbeat timeout'); return; }
      const id = `msg_${ulid()}`;
      awaiting.add(id);
      send({ type: 'ping', id });
      timer = setTimeout(tick, heartbeatMs);
    };

    if (closing) throw new ApiError('forbidden');
    return upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        socket = ws;
        sockets.add(ws);
        if (closing) { ws.close(1001, 'server shutdown'); return; }
        const old = current.get(deviceId);
        current.set(deviceId, socket);
        old?.close(4001, 'replaced');
        timer = setTimeout(() => stop(1008, 'hello timeout'), ttl);
      },
      onMessage(event) { return pending.track(onMessage(event.data)); },
      onClose() {
        state = 'closed';
        config.disconnect(deviceId, subscription);
        clearTimeout(timer);
        if (current.get(deviceId) === socket) current.delete(deviceId);
        void pending.track(presence.release(deviceId, connectionId).catch(() => {}));
        sockets.delete(socket);
        if (sockets.size === 0) allClosed?.();
      },
    }))(c, next);

    async function onMessage(data: unknown) {
        if (!live()) return;
        let msg: Record<string, unknown> | null = null;
        try {
          if (typeof data === 'string') {
            try { msg = JSON.parse(data); } catch { /* Bad frame. */ }
          }
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { stop(1007, 'invalid JSON frame'); return; }
          if (state === 'hello') {
            if (msg.type !== 'hello' || !isText(msg.id) || msg.edge_version !== version || !isText(msg.os, 32) || !isText(msg.arch, 32)
              || !isSeq(msg.config_revision) || !isSeq(msg.outbox_last_seq) || (msg.lease_id != null && !isText(msg.lease_id))) {
              stop(1008, 'hello required'); return;
            }
            state = 'starting';
            if (!await renew()) { if (live()) stop(1008, 'device unavailable'); return; }
            if (!live()) return;
            await presence.claim(deviceId, connectionId, ttl);
            if (!live()) { await presence.release(deviceId, connectionId); return; }
            clearTimeout(timer);
            state = 'ready';
            send({ type: 'welcome', re: msg.id, device_id: deviceId, user_id: userId, tenant_id: tenantId,
              server_time: iso(now()), ack_seq: ackCursor(store.tenant(tenantId), deviceId), heartbeat_ms: heartbeatMs });
            timer = setTimeout(tick, heartbeatMs);
            if (msg.lease_id == null) send(await initialLease(store, tenantId, deviceId, userId, now(), live));
            if (live()) await config.connect(deviceId, subscription);
            return;
          }
          if (state === 'starting') { stop(1008, 'welcome pending'); return; }
          if (msg.type === 'ping' && isText(msg.id)) { send({ type: 'pong', re: msg.id }); return; }
          if (msg.type === 'pong' && isText(msg.re) && awaiting.has(msg.re)) {
            for (const id of awaiting) {
              awaiting.delete(id);
              if (id === msg.re) break;
            }
            if (heartbeatBusy) return;
            heartbeatBusy = true;
            try {
              const allowed = now() - lastRenewal >= 60_000 ? await renew()
                : activeTenant(tenantId) && store.tenant(tenantId).get(deviceQuery, [tokenHash, iso(now())]);
              if (!live()) return;
              if (!allowed || !await presence.refresh(deviceId, connectionId, ttl)) {
                if (live()) stop(1008, 'device unavailable');
              }
            } finally { heartbeatBusy = false; }
            return;
          }
          if (msg.type === 'pong' || (msg.type === 'ack' && isText(msg.re) && typeof msg.ok === 'boolean')) return;
          if (msg.type === 'lease_renew' && isText(msg.id)) {
            if (!isText(msg.lease_id)) throw new ApiError('invalid', { fields: ['lease_id'] });
            const opId = msg.op_id ?? msg.id;
            if (!isText(opId)) throw new ApiError('invalid', { fields: ['op_id'] });
            const used = int(msg.used_milli, 'used_milli');
            send({ ...await renewLease(store, tenantId, deviceId, userId, now(), live, msg.lease_id, used, opId), re: msg.id });
            return;
          }
          if (msg.type === 'usage' && isText(msg.id)) {
            const ack_seq = await ingestUsage(store, tenantId, deviceId, now(), live, usageItems(msg.batch));
            send({ type: 'events_ack', re: msg.id, ack_seq });
            return;
          }
          if (isText(msg.id)) {
            send({ type: 'ack', re: msg.id, ok: false, error: new ApiError('invalid', { fields: ['type'] }).body() });
          } else {
            stop(1008, 'invalid message');
          }
        } catch (error) {
          if (error instanceof ApiError && msg && isText(msg.id)) send({ type: 'ack', re: msg.id, ok: false, error: error.body() });
          else if (live()) stop(1011, 'gateway unavailable');
        }
    }
  });
  return function closeSockets() {
    closing = true;
    const done = sockets.size ? new Promise<void>((resolve) => { allClosed = resolve; }) : Promise.resolve();
    for (const ws of sockets) ws.close(1001, 'server shutdown');
    return done;
  };
}
