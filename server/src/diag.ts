// 诊断：Server API 让在线 Edge 打包日志上传 RustFS，再由有权限的调用者下载。
// contracts/http-api.md 的 `/devices/:id/diag`、`/diag/:id`；contracts/edge-ws.md 的 `diag`/`diag_result`。
//
// `upload_url`/下载地址都不是直给 RustFS 的预签名 URL：RustFS 只绑回环（部署细节见 deploy/run-service.sh），
// 远程 Mac 和外部 Agent 连不上它，也不该知道它的存在。两段改成同源的 Server 路由，Server 用 object-storage.ts
// 的方法在内部和 RustFS 对话，字节不离开本机。
import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, json, operation } from './api';
import { authenticate, isTenantId } from './auth';
import { bearer, hash, iso } from './credentials';
import { enumField, pagination, tenantActor, type ManagementOptions } from './management';
import type { ObjectStorage } from './object-storage';
import type { Store, Transaction } from './store';

const kinds = ['logs', 'status'] as const;
const day = 86_400_000;
const retentionMs = 7 * day;
const rateLimitMs = 10 * 60_000;
export const DIAG_MAX_BYTES = 2 * 1024 * 1024;
export const DIAG_UPLOAD_PATH = /^\/v1\/diag\/[^/]+\/upload$/;

type DiagRow = { id: string; device_id: string; kind: string; status: string; object_key: string | null;
  requested_by: string; at: string; expires_at: string | null; uploaded_at: string | null; detail_json: string | null; revision: number };
type DeviceRow = { id: string; user_id: string; name: string; os: string; arch: string; edge_version: string | null;
  status: string; last_seen_at: string | null; revision: number };
const deviceColumns = 'id, user_id, name, os, arch, edge_version, status, last_seen_at, revision';
const deviceColumnsJoined = deviceColumns.split(', ').map((c) => `d.${c}`).join(', ');

/** 同一台设备、同一条有效登录关系下才允许续租令牌有效期；和 edge.ts 的 deviceQuery 口径一致，
 * 但这里按 device_id 查（diag 的调用者已经知道设备 ID），WS 握手按 token_hash 查。另取 token_hash
 * 核对调用者出示的令牌确实还是当前有效的那一份（设备可能已经重新登记换了新令牌）。 */
function activeDevice(sql: Pick<Transaction, 'get'>, deviceId: string, at: number): (DeviceRow & { token_hash: string }) | null {
  return sql.get<DeviceRow & { token_hash: string }>(`SELECT ${deviceColumnsJoined}, d.token_hash FROM devices d JOIN members m ON m.user_id = d.user_id
    WHERE d.id = ? AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`, [deviceId, iso(at)]);
}

/** 在线设备的订阅登记，edge.ts 在握手成功/断开时调用。诊断指令和设备上行的 diag_result 都走它。 */
export function diagChannel(store: Store) {
  const online = new Map<string, { tenant: string; send: (value: Record<string, unknown>) => void; live: () => boolean }>();
  return {
    connect(device: string, tenant: string, send: (value: Record<string, unknown>) => void, live: () => boolean) {
      online.set(device, { tenant, send, live });
    },
    disconnect(device: string, send: (value: Record<string, unknown>) => void) {
      if (online.get(device)?.send === send) online.delete(device);
    },
    /** 设备在线且这条连接仍然有效时下发 diag，返回是否送达。 */
    dispatch(device: string, message: Record<string, unknown>) {
      const sub = online.get(device);
      if (!sub || !sub.live()) return false;
      sub.send(message);
      return true;
    },
    isOnline(device: string) {
      const sub = online.get(device);
      return !!sub && sub.live();
    },
    /** Edge 回报 diag_result：落盘状态，kind=status 的结果直接记为完成；kind=logs 的 ok 只表示打包
     * 成功，真正可下载要等 PUT /v1/diag/:id/upload 落盘对象后才置 ready（见下面的状态机）。 */
    async result(tenantId: string, device: string, diagId: string, ok: boolean, detail: unknown, live: () => boolean) {
      if (!live() || !activeTenant(store, tenantId)) return;
      await store.tenant(tenantId).write((sql) => {
        if (!live()) return;
        const row = sql.get<DiagRow>('SELECT * FROM diag_jobs WHERE id = ? AND device_id = ?', [diagId, device]);
        if (!row || row.status !== 'pending') return;
        const detail_json = JSON.stringify(safeDetail(detail));
        if (!ok) { sql.run("UPDATE diag_jobs SET status = 'failed', detail_json = ?, revision = revision + 1 WHERE id = ?", [detail_json, diagId]); return; }
        if (row.kind === 'status') { sql.run("UPDATE diag_jobs SET status = 'ready', detail_json = ?, revision = revision + 1 WHERE id = ?", [detail_json, diagId]); return; }
        sql.run('UPDATE diag_jobs SET detail_json = ?, revision = revision + 1 WHERE id = ?', [detail_json, diagId]);
      });
    },
  };
}
export type DiagChannel = ReturnType<typeof diagChannel>;

function canRequestDiag(role: string) { return role === 'owner' || role === 'admin'; }

/** 设备所属租户 + 调用者是否有权发起/查看诊断。平台管理员跨租户都算有权限。 */
function deviceActor(store: Store, c: Context, at: number, deviceId: string) {
  const session = authenticate(store, c, at);
  if (session.tenant_id) {
    const actor = tenantActor(store, c, at);
    const device = actor.db.get<DeviceRow>(`SELECT ${deviceColumns} FROM devices WHERE id = ?`, [deviceId]);
    if (!device) throw new ApiError('not_found');
    return { ...actor, device, allowed: canRequestDiag(actor.role) };
  }
  if (!store.system.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [session.user_id])) throw new ApiError('forbidden');
  const located = store.system.get<{ tenant_id: string }>('SELECT tenant_id FROM device_directory WHERE device_id = ?', [deviceId]);
  if (!located || !store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [located.tenant_id])) throw new ApiError('not_found');
  const db = store.tenant(located.tenant_id);
  const device = db.get<DeviceRow>(`SELECT ${deviceColumns} FROM devices WHERE id = ?`, [deviceId]);
  if (!device) throw new ApiError('not_found');
  return { id: located.tenant_id, db, userId: session.user_id, role: 'platform_admin', group_id: null, device, allowed: true };
}

const deviceView = (row: DeviceRow, canManage: boolean) => ({
  id: row.id, user_id: row.user_id, name: row.name, os: row.os, arch: row.arch, edge_version: row.edge_version,
  status: row.status, last_seen_at: row.last_seen_at, revision: row.revision, actions: canManage ? ['read', 'create_diag'] : ['read'] });
const diagView = (row: DiagRow, downloadable: boolean) => ({ id: row.id, device_id: row.device_id, kind: row.kind, status: row.status,
  diag_id: row.id,
  requested_by: row.requested_by, at: row.at, expires_at: row.expires_at,
  download_url: downloadable && row.object_key ? `/v1/diag/${row.id}/download` : null,
  ...(row.kind === 'status' && row.detail_json && { detail: JSON.parse(row.detail_json) }), revision: row.revision, actions: ['read'] });

export function deviceRoutes(app: Hono, store: Store, opts: ManagementOptions, diag: DiagChannel) {
  app.get('/v1/devices', (c) => {
    const actor = tenantActor(store, c, opts.now());
    const manage = canRequestDiag(actor.role);
    const p = pagination(c);
    const where = 'WHERE instr(lower(name || \' \' || os || \' \' || arch), lower(?)) > 0';
    const { n } = actor.db.get<{ n: number }>(`SELECT count(*) AS n FROM devices ${where}`, [p.query])!;
    const rows = actor.db.all<DeviceRow>(`SELECT ${deviceColumns} FROM devices ${where} ORDER BY id LIMIT ? OFFSET ?`, [p.query, p.limit, p.offset]);
    return c.json(p.page(rows.map((row) => ({ ...deviceView(row, manage), online: diag.isOnline(row.id) })), n));
  });
  app.get('/v1/devices/:id', (c) => {
    const actor = tenantActor(store, c, opts.now());
    const row = actor.db.get<DeviceRow>(`SELECT ${deviceColumns} FROM devices WHERE id = ?`, [c.req.param('id')]);
    if (!row) throw new ApiError('not_found');
    return c.json({ ...deviceView(row, canRequestDiag(actor.role)), online: diag.isOnline(row.id) });
  });
}

export function diagRoutes(app: Hono, store: Store, opts: ManagementOptions, storage: ObjectStorage | undefined) {
  const channel = diagChannel(store);
  const objectKey = (tenantId: string, deviceId: string, diagId: string) => `diag/${tenantId}/${deviceId}/${diagId}.tar`;
  let uploads = 0;

  app.post('/v1/devices/:id/diag', async (c) => {
    const at = opts.now();
    const deviceId = field(c.req.param('id'), 'id');
    const actor = deviceActor(store, c, at, deviceId);
    if (!actor.allowed) throw new ApiError('forbidden');
    const body = await json(c);
    const kind = enumField(body.kind, 'kind', kinds);
    const op = operation(c, opts.codeSecret, at, actor.userId, [deviceId, kind]);
    const result = await actor.db.write((sql) => {
      const cached = op.read(sql);
      if (cached) return { response: cached };
      const last = sql.get<{ at: string }>('SELECT at FROM diag_jobs WHERE device_id = ? ORDER BY at DESC LIMIT 1', [deviceId]);
      if (last && at - Date.parse(last.at) < rateLimitMs) {
        throw new ApiError('rate_limited', { retry_after_ms: rateLimitMs - (at - Date.parse(last.at)) });
      }
      const id = `dgj_${ulid()}`;
      const row: DiagRow = { id, device_id: deviceId, kind, status: 'pending', object_key: null, requested_by: actor.userId,
        at: iso(at), expires_at: null, uploaded_at: null, detail_json: null, revision: 1 };
      sql.run(`INSERT INTO diag_jobs (id, device_id, kind, status, object_key, requested_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, deviceId, kind, row.status, row.object_key, row.requested_by, row.at]);
      sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${ulid()}`, actor.userId, 'device.diag.create', deviceId, JSON.stringify({ diag_id: id, kind }), row.at]);
      return { response: op.complete(sql, { status: 201, payload: diagView(row, false) }), id };
    });
    if (result.id) {
      const delivered = channel.dispatch(deviceId, kind === 'logs'
        ? { type: 'diag', id: `msg_${ulid()}`, diag_id: result.id, kind, upload_url: `/v1/diag/${result.id}/upload` }
        : { type: 'diag', id: `msg_${ulid()}`, diag_id: result.id, kind });
      if (!delivered) {
        await actor.db.write((sql) => sql.run("UPDATE diag_jobs SET status = 'failed', detail_json = ?, revision = revision + 1 WHERE id = ? AND status = 'pending'",
          [JSON.stringify({ reason: 'device_offline' }), result.id]));
      }
    }
    return result.response;
  });

  app.get('/v1/diag/:id', (c) => {
    const at = opts.now();
    const id = field(c.req.param('id'), 'id');
    const session = authenticate(store, c, at);
    const db = resolveDiagDb(store, session, id);
    const row = db.get<DiagRow>('SELECT * FROM diag_jobs WHERE id = ?', [id]);
    if (!row) throw new ApiError('not_found');
    const expired = row.status === 'ready' && row.expires_at !== null && Date.parse(row.expires_at) <= at;
    return c.json(diagView(expired ? { ...row, status: 'expired' } : row, row.status === 'ready' && !expired));
  });

  // Edge 直传：device token 鉴权，和 WS 握手一样要求设备、所属成员都在活跃状态、令牌未过期。
  // pending → uploading → ready 的状态机防止并发重复上传互相覆盖，也防止失败结果被迟到的上传盖回 ready。
  app.put('/v1/diag/:id/upload', async (c) => {
    const at = opts.now();
    const id = field(c.req.param('id'), 'id');
    const token = bearer(c.req.header('Authorization'));
    if (!token) throw new ApiError('unauthenticated');
    const tokenHash = hash(token);
    const match = await store.device(tokenHash);
    if (!match || !activeTenant(store, match.id)) throw new ApiError('unauthenticated');
    if (uploads >= 4) throw new ApiError('rate_limited', { retry_after_ms: 1_000 });
    uploads++;
    let key: string | undefined;
    let write: Promise<void> | undefined;
    try {
      const claimed = await store.tenant(match.id).write((sql) => {
        if (activeDevice(sql, match.value.id, at)?.token_hash !== tokenHash) return false;
        return sql.run("UPDATE diag_jobs SET status = 'uploading', revision = revision + 1 WHERE id = ? AND device_id = ? AND kind = 'logs' AND status = 'pending'",
          [id, match.value.id]).changes === 1;
      });
      if (!claimed) throw new ApiError('not_found');
      key = objectKey(match.id, match.value.id, id);
      if (!storage) throw new ApiError('internal', { trace_id: `trc_${ulid()}` });
      const payload = await readUpload(c.req.raw);
      await storage.ensureBucket();
      write = storage.put(key, payload);
      await withTimeout(write, 20_000, 'upload');
      const stat = await withTimeout(storage.file(key).stat(), 5_000, 'verify upload');
      if (stat.size !== payload.byteLength) throw new Error('diagnostic object size mismatch');
      const completed = opts.now();
      const ready = await store.tenant(match.id).write((sql) => {
        if (!activeTenant(store, match.id) || activeDevice(sql, match.value.id, completed)?.token_hash !== tokenHash) return false;
        return sql.run(`UPDATE diag_jobs SET status = 'ready', object_key = ?, uploaded_at = ?, expires_at = ?, revision = revision + 1
          WHERE id = ? AND status = 'uploading'`, [key!, iso(completed), iso(completed + retentionMs), id]).changes === 1;
      });
      if (!ready) throw new ApiError('forbidden');
      return c.body(null, 204);
    } catch (error) {
      if (key) {
        if (write && storage) {
          const object = key;
          void write.catch(() => {}).then(() => storage.delete(object)).catch(() => {});
        }
        await store.tenant(match.id).write((sql) => sql.run("UPDATE diag_jobs SET status = 'failed', detail_json = ?, revision = revision + 1 WHERE id = ? AND status = 'uploading'",
          [JSON.stringify({ reason: 'upload_failed' }), id]));
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError('internal', { trace_id: `trc_${ulid()}` });
    } finally {
      uploads--;
    }
  });

  app.get('/v1/diag/:id/download', async (c) => {
    const at = opts.now();
    const id = field(c.req.param('id'), 'id');
    const session = authenticate(store, c, at);
    const db = resolveDiagDb(store, session, id);
    const row = db.get<DiagRow>('SELECT * FROM diag_jobs WHERE id = ?', [id]);
    if (!row || row.status !== 'ready' || !row.object_key) throw new ApiError('not_found');
    if (row.expires_at !== null && Date.parse(row.expires_at) <= at) throw new ApiError('not_found');
    if (!storage) throw new ApiError('internal', { trace_id: `trc_${ulid()}` });
    const file = storage.file(row.object_key);
    if (!await file.exists()) throw new ApiError('not_found');
    await resolveDiagDb(store, session, id).write((sql) => sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
      [`aud_${ulid()}`, session.user_id, 'device.diag.download', row.device_id, JSON.stringify({ diag_id: id }), iso(at)]));
    return new Response(file.stream(), { status: 200, headers: { 'content-type': 'application/x-tar',
      'content-disposition': `attachment; filename="${id}.tar"` } });
  });

  return channel;
}

function activeTenant(store: Store, tenantId: string) {
  return !!store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [tenantId]);
}

function invalidDetail(): never {
  throw new ApiError('invalid', { fields: ['detail'] });
}

function safeDetail(value: unknown) {
  const safe: Record<string, string | boolean | number> = {};
  if (value == null) return safe;
  if (typeof value !== 'object' || Array.isArray(value)) invalidDetail();
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return invalidDetail(); }
  if (Buffer.byteLength(serialized, 'utf8') > 4096) invalidDetail();
  const fields = value as Record<string, unknown>;
  if (typeof fields.connected === 'boolean') safe.connected = fields.connected;
  for (const name of ['outbox_last_seq', 'config_revision', 'bytes']) {
    const number = fields[name];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) safe[name] = number;
  }
  const reasons = ['busy', 'invalid_upload_target', 'logs_unavailable', 'unsupported_kind', 'upload_failed'];
  if (typeof fields.reason === 'string' && reasons.includes(fields.reason)) safe.reason = fields.reason;
  return safe;
}

async function readUpload(request: Request) {
  const invalidBody = () => new ApiError('invalid', { fields: ['body'] });
  const header = request.headers.get('content-length');
  const limit = header === null ? DIAG_MAX_BYTES : Number(header);
  if (!request.body || !Number.isSafeInteger(limit) || limit <= 0 || limit > DIAG_MAX_BYTES) throw invalidBody();
  const buffer = new Uint8Array(limit);
  const reader = request.body.getReader();
  let length = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 15_000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > limit - length) throw invalidBody();
      buffer.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    if (expired || length === 0 || (header !== null && length !== limit)) throw invalidBody();
    return buffer.subarray(0, length);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** 七天保留届满后的真清理：下载接口已经按 expires_at 拒绝访问，这里再把对象从 RustFS 删掉，
 * 不是只在 API 层隐藏（短期签名失效不等于对象已清理，见 s1-acceptance.md #6）。按需调用，不建计时器。 */
export async function sweepExpiredJobs(store: Store, storage: ObjectStorage | undefined, nowMs: number) {
  if (!storage) return;
  const at = iso(nowMs);
  for (const { id } of store.system.all<{ id: string }>('SELECT id FROM tenants')) {
    const db = store.tenant(id);
    const due = db.all<DiagRow>("SELECT * FROM diag_jobs WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= ? AND object_key IS NOT NULL", [at]);
    for (const row of due) {
      try { await withTimeout(storage.delete(row.object_key!), 10_000, 'delete expired object'); }
      catch { continue; }
      await store.tenant(id).write((sql) => sql.run("UPDATE diag_jobs SET status = 'expired', object_key = NULL, revision = revision + 1 WHERE id = ? AND status = 'ready'", [row.id]));
    }
  }
}

/** 会话是租户范围令牌时按角色校验；平台管理员跨租户，但目标设备必须存在于某个活跃租户。 */
function resolveDiagDb(store: Store, session: { user_id: string; tenant_id: string | null }, diagId: string) {
  if (session.tenant_id) {
    if (!isTenantId(session.tenant_id) || !store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [session.tenant_id])) {
      throw new ApiError('forbidden');
    }
    const db = store.tenant(session.tenant_id);
    const member = db.get<{ role: string }>("SELECT role FROM members WHERE user_id = ? AND status = 'active'", [session.user_id]);
    if (!member || !canRequestDiag(member.role)) throw new ApiError('forbidden');
    return db;
  }
  if (!store.system.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [session.user_id])) throw new ApiError('forbidden');
  for (const { id } of store.system.all<{ id: string }>("SELECT id FROM tenants WHERE status = 'active'")) {
    const db = store.tenant(id);
    if (db.get('SELECT 1 FROM diag_jobs WHERE id = ?', [diagId])) return db;
  }
  throw new ApiError('not_found');
}
