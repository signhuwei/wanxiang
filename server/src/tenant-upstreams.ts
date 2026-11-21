import { hkdfSync } from 'node:crypto';
import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { iso } from './credentials';
import { int, pagination, tenantActor, type ManagementOptions } from './management';
import { readEffective, readHead, refreshPolicyForOrganization } from './policy-data';
import { choice, object, type PolicyReader } from './policy-types';
import { decryptProviderSecret, encryptProviderSecret } from './provider-secret';
import type { Store } from './store';

type Upstream = {
  id: string; name: string; model_id: string; protocol: 'openai_chat' | 'openai_responses' | 'anthropic'; base_url: string;
  upstream_name: string; priority: number; revision: number; status: 'active' | 'disabled'; secret_ciphertext: Uint8Array
};
const columns = 'id,name,model_id,protocol,base_url,upstream_name,priority,revision,status';
export const platformUpstreamPriority = 100;
export function upstreamOrder(a: {priority:number},b: {priority:number}) {
  return a.priority-b.priority;
}
function tenantKey(master: Uint8Array, id: string) {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from(id), Buffer.from('onex/tenant-provider/v1'), 32));
}
export function tenantUpstreamTargets(db: PolicyReader, tenantId: string, masterKey: Uint8Array | undefined, modelId: string) {
  if (!masterKey) return [];
  const rows = db.all<Upstream>("SELECT * FROM tenant_upstreams WHERE model_id=? AND status='active' ORDER BY priority,id", [modelId]);
  const key = tenantKey(masterKey, tenantId);
  try {
    return rows.flatMap(({ secret_ciphertext, ...row }) => {
      try { return [{ ...row, secret: decryptProviderSecret(key, row.id, secret_ciphertext) }]; }
      catch { return []; }
    });
  } finally { key.fill(0); }
}
export function upstreamRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const path = '/v1/policy/upstreams';
  function readOwner(c: Parameters<typeof tenantActor>[1]) {
    const actor = tenantActor(store, c, opts.now());
    if (actor.role !== 'owner') throw new ApiError('forbidden');
    return actor;
  }
  function policy(db: PolicyReader, id: string) {
    const hot = readEffective(db, 'tenant', id)?.hot;
    return { enabled: JSON.parse(hot?.runtime_rules_json ?? '{}')['upstream.custom'] === true, models: new Set<string>(JSON.parse(hot?.allowed_models_json ?? '[]')) };
  }
  app.get(path, c => {
    const actor = readOwner(c), p = pagination(c);
    const editable = policy(actor.db, actor.id).enabled;
    const where = "WHERE instr(lower(name||' '||model_id),lower(?))>0";
    const n = actor.db.get<{ n: number }>(`SELECT count(*) AS n FROM tenant_upstreams ${where}`, [p.query])!.n;
    const items = actor.db.all<Omit<Upstream, 'secret_ciphertext'>>(`SELECT ${columns} FROM tenant_upstreams ${where} ORDER BY priority,id LIMIT ? OFFSET ?`, [p.query, p.limit, p.offset]);
    return c.json(p.page(items.map(row => ({ ...row, has_key: true, actions: editable ? ['read', 'update'] : ['read'] })), n, editable ? ['create'] : []));
  });
  for (const create of [true, false]) app.on(create ? 'POST' : 'PUT', create ? path : path + '/:id', async c => {
    const actor = readOwner(c), at = opts.now(), body = await json(c);
    object(body, 'body', ['expected_revision', 'model_id', 'name', 'base_url', 'upstream_name', 'priority', 'status', 'secret']);
    const op = operation(c, opts.codeSecret, at, actor.userId, body);
    if (!op.key) invalid('Idempotency-Key');
    const result = await actor.db.write(sql => {
      readOwner(c);
      const access = policy(sql, actor.id);
      if (!access.enabled) throw new ApiError('forbidden');
      const cached = op.read(sql);
      if (cached) return { response: cached, changed: false };
      const id = create ? 'tpr_' + ulid() : field(c.req.param('id'), 'id');
      const old = sql.get<Upstream>('SELECT * FROM tenant_upstreams WHERE id=?', [id]);
      if (!create && !old) throw new ApiError('not_found');
      if (int(body.expected_revision, 'expected_revision') !== (old?.revision ?? 0)) throw new ApiError('conflict', { revision: old?.revision ?? 0 });
      const model = field(body.model_id ?? old?.model_id, 'model_id');
      const status = choice(body.status ?? old?.status ?? 'active', ['active', 'disabled'], 'status');
      const source = store.system.get<{ protocol: Upstream['protocol'] }>(`SELECT p.protocol FROM models m JOIN providers p ON p.id=m.provider_id
        WHERE m.id=? AND m.status='active' AND p.status='active'`, [model]);
      if (status === 'active' && (!access.models.has(model) || !source)) invalid('model_id');
      const protocol = source?.protocol ?? old?.protocol;
      if (!protocol) invalid('model_id');
      const address = URL.parse(field(body.base_url ?? old?.base_url, 'base_url', 1024));
      if (!address || address.protocol !== 'https:' || address.username || address.password || address.search || address.hash) invalid('base_url');
      const name = field(body.name ?? old?.name, 'name'), upstreamName = field(body.upstream_name ?? old?.upstream_name, 'upstream_name');
      const priority = int(body.priority ?? old?.priority ?? 0, 'priority', 0, 10000);
      let ciphertext = old?.secret_ciphertext;
      if (body.secret !== undefined || !ciphertext) {
        if (!opts.masterKey) throw new ApiError('conflict', { reason: 'master_key_required' });
        const secret = field(body.secret, 'secret', 8192);
        const key = tenantKey(opts.masterKey, actor.id);
        try { ciphertext = encryptProviderSecret(key, id, secret); } finally { key.fill(0); }
      }
      const revision = (old?.revision ?? 0) + 1, base_url = address.href.replace(/\/$/, '');
      sql.run(`INSERT INTO tenant_upstreams (${columns},secret_ciphertext) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,model_id=excluded.model_id,protocol=excluded.protocol,base_url=excluded.base_url,
        upstream_name=excluded.upstream_name,priority=excluded.priority,revision=excluded.revision,status=excluded.status,secret_ciphertext=excluded.secret_ciphertext`,
        [id, name, model, protocol, base_url, upstreamName, priority, revision, status, ciphertext]);
      refreshPolicyForOrganization(sql, actor.id, actor.userId, at);
      const recipients = sql.all<{ user_id: string }>(`SELECT m.user_id FROM members m JOIN policy_effective p ON p.scope='member' AND p.subject_id=m.user_id
        WHERE m.status='active' AND EXISTS (SELECT 1 FROM json_each(json_extract(p.document_json,'$.hot.allowed_models_json'))
          WHERE value IN (?,?))`, [model, old?.model_id ?? model]);
      if (recipients.length) sql.run(`INSERT INTO policy_notices(id,policy_revision,kind,title,at,user_ids_json) VALUES(?,?,'policy_changed',?,?,?)`,
        ['pch_' + ulid(), readHead(sql)!.policy_revision, '租户模型上游已变更', iso(at), JSON.stringify(recipients.map(row => row.user_id))]);
      sql.run('INSERT INTO audit (id,actor,action,target,detail_json,at) VALUES (?,?,?,?,?,?)',
        ['aud_' + ulid(), actor.userId, 'policy.upstream.publish', id, JSON.stringify({ revision, model_id: model, status }), iso(at)]);
      return { changed: true, response: op.complete(sql, { status: create ? 201 : 200, payload: { id, name, model_id: model, protocol, base_url, upstream_name: upstreamName, priority, revision, status, has_key: true, actions: ['read', 'update'] } }) };
    });
    if (result.changed) opts.onConfigChange?.(actor.id);
    return result.response;
  });
}
