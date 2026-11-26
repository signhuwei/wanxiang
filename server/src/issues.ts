import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, json } from './api';
import { bearer, hash, iso } from './credentials';
import { pagination, platformActor, type ManagementOptions } from './management';
import type { Store } from './store';

const maxText = 20_000;
const maxLogs = 28;
const maxImages = 3;
const maxImageBytes = 1_048_576;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
type Image = { mime: string; data: string };
function decodeImage(value: unknown): { mime: string; bytes: Uint8Array } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid', { fields: ['images'] });
  const image = value as Image;
  if (!imageTypes.has(image.mime) || typeof image.data !== 'string' || image.data.length > 1_500_000) throw new ApiError('invalid', { fields: ['images'] });
  let bytes: Uint8Array;
  try { bytes = Buffer.from(image.data, 'base64'); } catch { throw new ApiError('invalid', { fields: ['images'] }); }
  if (!bytes.length || bytes.length > maxImageBytes) throw new ApiError('invalid', { fields: ['images'] });
  const magic = image.mime === 'image/png' ? Buffer.from(bytes).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : image.mime === 'image/jpeg' ? Buffer.from(bytes).subarray(0, 2).equals(Buffer.from([255,216]))
    : Buffer.from(bytes).subarray(0, 4).equals(Buffer.from('RIFF')) && Buffer.from(bytes).subarray(8, 12).equals(Buffer.from('WEBP'));
  if (!magic) throw new ApiError('invalid', { fields: ['images'] });
  return { mime: image.mime, bytes };
}
function safeLogs(value: unknown) {
  if (!Array.isArray(value) || value.length > maxLogs) throw new ApiError('invalid', { fields: ['logs'] });
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 100_000) throw new ApiError('invalid', { fields: ['logs'] });
  const names = new Set(['source','component','level','event','version','agent','code','stage','model']);
  const counts = new Set(['at_ms','http_status','config_revision','exit_code','reservation_milli','lease_budget_milli','requested_output_tokens','applied_output_tokens']);
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !['desktop','daemon'].includes(entry.source) ||
        !['info','warn','error'].includes(entry.level) || typeof entry.event !== 'string' || !Number.isSafeInteger(entry.at_ms)) throw new ApiError('invalid', { fields: ['logs'] });
    for (const [key, v] of Object.entries(entry)) {
      const allowed = names.has(key) ? v === null || (typeof v === 'string' && /^[a-zA-Z0-9._:+/\-]{1,128}$/.test(v)) : counts.has(key) && (v === null || Number.isSafeInteger(v));
      if (!allowed) throw new ApiError('invalid', { fields: ['logs'] });
    }
  }
  return value;
}
function deviceActor(store: Store, c: Context, at: number) {
  const token = bearer(c.req.header('Authorization'));
  if (!token) throw new ApiError('unauthenticated');
  const digest = hash(token);
  const scope = store.system.get<{tenant_id:string}>(`SELECT tenant_id FROM device_directory d JOIN tenants t ON t.id=d.tenant_id
    WHERE d.token_hash=? AND t.status='active'`, [digest]);
  if (!scope) throw new ApiError('unauthenticated');
  const device = store.tenant(scope.tenant_id).get<{user_id:string; id:string}>(`SELECT d.id,d.user_id FROM devices d JOIN members m ON m.user_id=d.user_id
    WHERE d.token_hash=? AND d.status='active' AND d.token_expires_at>? AND m.status='active'`, [digest, iso(at)]);
  if (!device) throw new ApiError('unauthenticated');
  return {tenant:scope.tenant_id, user:device.user_id, device:device.id};
}
const source = ' FROM issues i JOIN tenants t ON t.id=i.tenant_id JOIN platform_users u ON u.id=i.user_id ';
const columns = 'i.id,i.tenant_id,i.user_id,t.name tenant_name,u.name user_name,i.text,i.created_at,i.image_count,i.log_count';
export function issueRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  function list(c:Context, own?:ReturnType<typeof deviceActor>) {
    const p=pagination(c), args=own?[own.tenant,own.user,p.query]:[p.query];
    const where=' WHERE '+(own?'i.tenant_id=? AND i.user_id=? AND ':'')+"instr(lower(i.text||' '||t.name||' '||u.name),lower(?))>0";
    const total=store.system.get<{n:number}>('SELECT count(*) n'+source+where,args)!.n;
    const rows=store.system.all<Record<string,unknown>>('SELECT '+columns+source+where+' ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?', [...args,p.limit,p.offset]);
    return c.json(p.page(rows.map(r=>({...r,actions:['read']})),total));
  }
  app.get('/v1/edge/issues', c=>list(c,deviceActor(store,c,opts.now())));
  app.post('/v1/edge/issues', async c=>{
    const actor=deviceActor(store,c,opts.now());
    const body=await json(c), text=field(body.text,'text',maxText).trim();
    const images=body.images ?? [];
    if (!Array.isArray(images)||images.length>maxImages) throw new ApiError('invalid',{fields:['images']});
    const decoded=images.map(decodeImage), logs=safeLogs(body.logs ?? []);
    const id=`iss_${ulid()}`, at=iso(opts.now());
    await store.system.write(sql=>{
      deviceActor(store,c,opts.now());
      if (sql.get('SELECT 1 FROM issues WHERE tenant_id=? AND user_id=? AND created_at>? LIMIT 1 OFFSET 19',[actor.tenant,actor.user,iso(opts.now()-3600000)])) throw new ApiError('rate_limited');
      sql.run('INSERT INTO issues (id,tenant_id,user_id,device_id,text,logs_json,created_at,image_count,log_count) VALUES (?,?,?,?,?,?,?,?,?)', [id,actor.tenant,actor.user,actor.device,text,JSON.stringify(logs),at,decoded.length,logs.length]);
      decoded.forEach((image,index)=>sql.run('INSERT INTO issue_images VALUES (?,?,?,?)',[id,index,image.mime,image.bytes]));
    });
    return c.json({id},201);
  });
  app.get('/v1/platform/issues', c=>{platformActor(store,c,opts.now());return list(c)});
  app.get('/v1/platform/issues/:id', c=>{
    platformActor(store,c,opts.now());
    const row=store.system.get<Record<string,unknown>&{logs_json:string}>('SELECT '+columns+',i.logs_json'+source+' WHERE i.id=?',[c.req.param('id')]);
    if (!row) throw new ApiError('not_found');
    const {logs_json,...rest}=row; return c.json({...rest,logs:JSON.parse(logs_json)});
  });
  app.get('/v1/platform/issues/:id/images/:index', c=>{
    platformActor(store,c,opts.now());
    if (!/^[0-2]$/.test(c.req.param('index'))) throw new ApiError('not_found');
    const img=store.system.get<{mime:string;bytes:Uint8Array}>('SELECT mime,bytes FROM issue_images WHERE issue_id=? AND image_index=?',[c.req.param('id'),Number(c.req.param('index'))]);
    if (!img) throw new ApiError('not_found');
    return new Response(new Uint8Array(img.bytes),{headers:{'Content-Type':img.mime,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
  });
}
