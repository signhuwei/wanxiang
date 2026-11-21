import type { Hono } from 'hono';
import { ApiError, field, invalid } from './api';
import { balance, deviceAllowed, quotaBinding } from './billing';
import { commerceMonth, packageFunds, type Terms } from './commerce-data';
import { postToolCharge } from './commerce-tools';
import { bearer, hash, hmac, iso } from './credentials';
import { int, type ManagementOptions } from './management';
import { readPolicyHot } from './policy-data';
import { decryptProviderSecret } from './provider-secret';
import { runHttpSearch, UnconfirmedSearch, type RunSearch, type SearchInput } from './tool-search-upstream';
import type { Store, Transaction } from './store';

const searchOrigin = 'http_search';
const reserveMs = 30_000;
const requestLimit = 12 * 1024;
const identity = 'device_id=? AND session_id=? AND agent_id=? AND native_id=? AND source_kind=\'http_search\'';
type SearchKey = [device: string, session: string, origin: string, call: string];
type SearchRow = {
  device_id: string; session_id: string; agent_id: string; native_id: string; request_fingerprint: string;
  release_id: string; user_id: string; plan_id: string; month: string; fee_milli: number; package_reserved: number;
  status: 'awaiting_result' | 'charged' | 'failed'; called_at: string; settled_at: string | null;
  ledger_id: string | null; reserved_until: string; package_used: number; outcome: string | null;
};
type SearchTarget = {
  endpoint: string; secret_ciphertext: Uint8Array; agents_json: string;
};

function readCall(sql: Pick<Transaction, 'get'>, key: SearchKey) {
  return sql.get<SearchRow>('SELECT * FROM commerce_tool_calls WHERE ' + identity, key);
}

function failCall(sql: Transaction, key: SearchKey, outcome: 'upstream_failed' | 'upstream_unconfirmed', at: string) {
  sql.run(`UPDATE commerce_tool_calls SET status='failed',outcome=?,settled_at=? WHERE ${identity} AND status='awaiting_result'`,
    [outcome, at, ...key]);
}

function receipt(row: SearchRow) {
  return { call_id: row.native_id, release_id: row.release_id, session_id: row.session_id, plan_id: row.plan_id,
    status: row.status, fee_milli: row.fee_milli, package_used_milli: row.package_used,
    called_at: row.called_at, settled_at: row.settled_at, ledger_id: row.ledger_id, outcome: row.outcome };
}

async function searchBody(request: Request): Promise<SearchInput & { session_id: string }> {
  const reader = request.body?.getReader();
  if (!reader) invalid('body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > requestLimit) {
      await reader.cancel().catch(() => {});
      throw new ApiError('too_large', { max_bytes: requestLimit });
    }
    chunks.push(part.value);
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { invalid('body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(k => !['session_id', 'query', 'limit'].includes(k))) invalid('body');
  const values = body as Record<string, unknown>;
  const query = field(values.query, 'query', 2000);
  if (!query.isWellFormed()) invalid('query');
  return { session_id: field(values.session_id, 'session_id'), query, limit: int(values.limit, 'limit', 1, 20) };
}

export function toolSearchRoutes(app: Hono, store: Store, opts: ManagementOptions, runSearch: RunSearch = runHttpSearch) {
  app.post('/v1/edge/tool-search/:release_id', async c => {
    const token = bearer(c.req.header('Authorization'));
    if (!token) throw new ApiError('unauthenticated');
    const tokenHash = hash(token);
    const linked = await store.device(tokenHash);
    if (!linked) throw new ApiError('unauthenticated');
    const tenant = linked.id;
    const release = field(c.req.param('release_id'), 'release_id');
    const callId = c.req.header('Idempotency-Key');
    if (!callId || !/^[A-Za-z0-9_:-]{1,128}$/.test(callId)) invalid('Idempotency-Key');

    const { session_id, query, limit } = await searchBody(c.req.raw);
    const fingerprint = hmac(opts.codeSecret, [release, query, limit]);
    const db = store.tenant(tenant);
    const reserved = await db.write(sql => {
      const at = opts.now(), time = iso(at);
      const device = sql.get<{ id: string; user_id: string }>('SELECT id,user_id FROM devices WHERE token_hash=?', [tokenHash]);
      if (!device || !deviceAllowed(store, sql, tenant, device.id, at)) throw new ApiError('unauthenticated');
      const key: SearchKey = [device.id, session_id, searchOrigin, callId];
      const prior = readCall(sql, key);
      if (prior) {
        if (prior.user_id !== device.user_id || prior.request_fingerprint !== fingerprint) throw new ApiError('conflict');
        if (prior.status === 'awaiting_result' && prior.reserved_until <= time) {
          failCall(sql, key, 'upstream_unconfirmed', time);
          return { replay: readCall(sql, key)! };
        }
        return { replay: prior };
      }

      const session = sql.get<{ agent: string }>(`SELECT agent FROM agent_sessions WHERE id=? AND device_id=? AND user_id=?
        AND ended_at IS NULL AND content_purged_at IS NULL`, [session_id, device.id, device.user_id]);
      if (!session || session.agent === 'unknown') throw new ApiError('not_found', { reason: 'session_not_registered' });

      const policy = readPolicyHot(sql, device.user_id);
      if (!policy?.commerce_plan_id || !JSON.parse(policy.tool_release_ids_json).includes(release)
        || !JSON.parse(policy.allowed_agents_json).includes(session.agent)) throw new ApiError('forbidden');
      const target = store.system.get<SearchTarget>(`SELECT t.endpoint,t.secret_ciphertext,r.agents_json
        FROM tool_search_targets t JOIN tool_releases r ON r.id=t.release_id
        WHERE r.id=? AND r.kind='http_search' AND r.status='published'`, [release]);
      if (!target || !JSON.parse(target.agents_json).includes(session.agent)) throw new ApiError('not_found');

      const lease = sql.get<{ id: string; expires_at: string; plan_id: string; terms_json: string }>(`
        SELECT l.id,l.expires_at,a.plan_id,a.terms_json FROM leases l JOIN commerce_leases a ON a.lease_id=l.id
        WHERE l.device_id=? AND l.user_id=? AND l.status='active' AND l.expires_at>? AND a.plan_id=?
        ORDER BY l.seq DESC LIMIT 1`, [device.id, device.user_id, time, policy.commerce_plan_id]);
      if (!lease) throw new ApiError('conflict', { reason: 'search_lease_required' });
      const fee = (JSON.parse(lease.terms_json) as Partial<Terms>).tool_prices?.find(p => p.release_id === release)?.per_call_milli;
      if (fee === undefined) throw new ApiError('forbidden');
      const quota = quotaBinding(sql, device.user_id, at);
      if (quota && quota.remaining_milli < fee) throw new ApiError('forbidden', { reason: 'quota' });
      if (balance(sql, at).balance_milli < fee) throw new ApiError('forbidden', { reason: 'balance' });
      const grant = Math.min(fee, Math.max(0, packageFunds(sql, at).package_available_milli));
      if (!opts.masterKey) throw new ApiError('conflict', { reason: 'master_key_required' });
      const secret = decryptProviderSecret(opts.masterKey, release, target.secret_ciphertext);
      const publicNetwork = JSON.parse(policy.runtime_rules_json)['network.public'] !== false;

      sql.run(`INSERT INTO commerce_tool_calls(device_id,session_id,agent_id,native_id,release_id,user_id,plan_id,month,fee_milli,
        status,called_at,source_kind,request_fingerprint,lease_id,reserved_until,package_reserved)
        VALUES(?,?,?,?,?,?,?,?,?,'awaiting_result',?,'http_search',?,?,?,?)`,
        [...key, release, device.user_id, lease.plan_id, commerceMonth(at), fee, time, fingerprint, lease.id,
          iso(Math.min(at + reserveMs, Date.parse(lease.expires_at))), grant]);
      return { key, target: { endpoint: target.endpoint, secret, publicNetwork } };
    });

    c.header('Cache-Control', 'no-store');
    if (reserved.replay) {
      const row = reserved.replay;
      return c.json({ receipt: receipt(row) }, row.status === 'charged' ? 200 : row.status === 'failed' ? 502 : 202);
    }

    let results: Awaited<ReturnType<RunSearch>> | undefined;
    let failure: 'upstream_failed' | 'upstream_unconfirmed' = 'upstream_failed';
    try { results = await runSearch({ ...reserved.target, secret: reserved.target.secret.toString('utf8') }, { query, limit }); }
    catch (error) { if (error instanceof UnconfirmedSearch) failure = 'upstream_unconfirmed'; }
    finally { reserved.target.secret.fill(0); }
    const row = await db.write(sql => {
      const at = opts.now(), time = iso(at);
      const current = readCall(sql, reserved.key)!;
      if (current.reserved_until <= time) failCall(sql, reserved.key, 'upstream_unconfirmed', time);
      else if (results === undefined) failCall(sql, reserved.key, failure, time);
      else if (current.status === 'awaiting_result') postToolCharge(sql, current, current.package_reserved, at, 'HTTP 搜索按次');
      return readCall(sql, reserved.key)!;
    });
    if (row.status !== 'charged') return c.json({ receipt: receipt(row) }, 502);
    opts.onBalanceChange?.(tenant);
    return c.json({ receipt: receipt(row), results });
  });
}
