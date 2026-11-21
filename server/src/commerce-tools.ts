import { ulid } from 'ulid';
import { iso } from './credentials';
import { balance } from './billing';
import { commerceMonth, packageFunds, type Plan } from './commerce-data';
import type { Store, Transaction } from './store';

type ToolPrice = { id: string; name: string; agents: string[]; price: number };
export function toolSnapshot(store: Store, sql: Transaction, device: string, plan: Plan, allowed: { tool_release_ids_json: string; allowed_agents_json: string }) {
  const d = sql.get<{ os: string; arch: string }>('SELECT os,arch FROM devices WHERE id=?', [device]);
  const ids = new Set<string>(JSON.parse(allowed.tool_release_ids_json));
  const agents = new Set<string>(JSON.parse(allowed.allowed_agents_json));
  const os = d?.os === 'darwin' ? 'macos' : d?.os === 'win32' ? 'windows' : d?.os;
  if (!os || !d) return [];
  return plan.terms.tool_prices.flatMap(({ release_id, per_call_milli }): ToolPrice[] => {
    if (!ids.has(release_id)) return [];
    const r = store.system.get<{ id: string; name: string; agents_json: string }>("SELECT id,name,agents_json FROM tool_releases WHERE id=? AND kind='mcp' AND os=? AND arch=? AND status='published'", [release_id, os, d.arch]);
    return r ? [{ id: r.id, name: r.name, agents: (JSON.parse(r.agents_json) as string[]).filter(a => agents.has(a)), price: per_call_milli }] : [];
  });
}
type Call = { device_id: string; session_id: string; agent_id: string; native_id: string; release_id: string; user_id: string; month: string; fee_milli: number; status: string };
export function postToolCharge(sql: Transaction, call: Call, packageUsed: number, at: number, label: string) {
  const ledgerId = 'led_' + ulid(), time = iso(at);
  const update = sql.run(`UPDATE commerce_tool_calls SET status='charged',package_used=?,settled_at=?
    WHERE device_id=? AND session_id=? AND agent_id=? AND native_id=? AND status=?
      AND status IN ('awaiting_result','pending_funds') AND ledger_id IS NULL`,
    [packageUsed, time, call.device_id, call.session_id, call.agent_id, call.native_id, call.status]);
  if (!update.changes) return false;
  sql.run(`INSERT INTO ledger(id,kind,amount_milli,user_id,request_ref,at,note)
    VALUES(?,'settle',?,?,?,?,?)`, [ledgerId, call.fee_milli, call.user_id, call.native_id, time, label + ' · ' + call.release_id]);
  sql.run("UPDATE commerce_tool_calls SET ledger_id=? WHERE device_id=? AND session_id=? AND agent_id=? AND native_id=?",
    [ledgerId, call.device_id, call.session_id, call.agent_id, call.native_id]);
  return true;
}
function charge(sql: Transaction, call: Call, at: number) {
  const nowMonth = commerceMonth(at);
  const funds = packageFunds(sql, at);
  const wallet = balance(sql, at);
  const grant = call.month === nowMonth ? Math.min(call.fee_milli, funds.package_available_milli) : 0;
  if (wallet.balance_milli - funds.package_available_milli + grant < call.fee_milli) return false;
  return postToolCharge(sql, call, grant, at, 'MCP 按次');
}
export function settlePendingTools(sql: Transaction, at: number) {
  for (const row of sql.all<Call>("SELECT * FROM commerce_tool_calls WHERE status='pending_funds' ORDER BY called_at LIMIT 256")) charge(sql, row, at);
}
type ToolKey = [device: string, session: string, agent: string, native: string];
type Receipt = { called_at: string | null; plan_id: string | null; candidates_json: string | null; result_error: number | null };
const identity = 'device_id=? AND session_id=? AND agent_id=? AND native_id=?';

function matchReceipt(sql: Transaction, key: ToolKey, user: string, runtime: string | undefined, at: number) {
  const row = sql.get<Receipt>('SELECT * FROM commerce_tool_receipts WHERE ' + identity, key);
  if (!row?.called_at || !row.candidates_json) return false;
  if (!sql.get('SELECT 1 FROM commerce_tool_calls WHERE ' + identity, key)) {
    if (!runtime || runtime === 'unknown') return false;
    const candidates = (JSON.parse(row.candidates_json) as ToolPrice[]).filter(r => r.agents.includes(runtime));
    const price = candidates.length === 1 ? candidates[0] : undefined;
    if (!price) return false;
    sql.run(`INSERT INTO commerce_tool_calls(device_id,session_id,agent_id,native_id,release_id,user_id,plan_id,month,fee_milli,status,called_at)
      VALUES(?,?,?,?,?,?,?,?,?,'awaiting_result',?)`, [...key, price.id, user, row.plan_id, commerceMonth(Date.parse(row.called_at)), price.price, row.called_at]);
  }
  if (row.result_error === null) return false;
  const status = row.result_error ? 'failed' : 'pending_funds';
  const update = sql.run("UPDATE commerce_tool_calls SET status=? WHERE source_kind='mcp' AND status='awaiting_result' AND " + identity, [status, ...key]);
  sql.run('DELETE FROM commerce_tool_receipts WHERE ' + identity, key);
  if (!update.changes || row.result_error) return false;
  return charge(sql, sql.get<Call>('SELECT * FROM commerce_tool_calls WHERE ' + identity, key)!, at);
}

export function toolEvent(sql: Transaction, device: string, user: string, row: { session: string; kind: string; at: string; payload: Record<string, unknown> }, at: number): boolean {
  const runtime = sql.get<{ agent: string }>('SELECT agent FROM agent_sessions WHERE id=?', [row.session])?.agent;
  if (row.kind === 'session_start') {
    // Device sequence batches can reach the server out of order, including after transcript erasure.
    const agent = runtime && runtime !== 'unknown' ? runtime : typeof row.payload.agent === 'string' ? row.payload.agent : undefined;
    const prior = sql.all<{ agent_id: string; native_id: string }>('SELECT agent_id,native_id FROM commerce_tool_receipts WHERE device_id=? AND session_id=? AND called_at IS NOT NULL', [device, row.session]);
    let charged = false;
    for (const r of prior) if (matchReceipt(sql, [device, row.session, r.agent_id, r.native_id], user, agent, at)) charged = true;
    return charged;
  }
  if (row.kind !== 'tool_call' && row.kind !== 'tool_result') return false;
  const native = row.payload.tool_call_id, agent = row.payload.agent_id ?? '';
  if (typeof native !== 'string' || !native || native.length > 256 || typeof agent !== 'string' || agent.length > 256) return false;
  const key: ToolKey = [device, row.session, agent, native];
  const call = sql.get<{ status: string; source_kind: string }>('SELECT status,source_kind FROM commerce_tool_calls WHERE ' + identity, key);
  if (call && (call.source_kind !== 'mcp' || call.status !== 'awaiting_result')) return false;
  if (row.kind === 'tool_call') {
    const name = row.payload.tool;
    if (typeof name !== 'string' || !name.startsWith('mcp__')) return false;
    const snapshot = sql.get<{ plan_id: string; tool_prices_json: string }>(`SELECT c.plan_id,c.tool_prices_json FROM commerce_leases c JOIN leases l ON l.id=c.lease_id
      WHERE l.device_id=? AND c.issued_at<=? AND l.expires_at>? AND (c.closed_at IS NULL OR c.closed_at>?) ORDER BY c.issued_at DESC,l.seq DESC LIMIT 1`, [device, row.at, row.at, row.at]);
    if (!snapshot) return false;
    const candidates = (JSON.parse(snapshot.tool_prices_json) as ToolPrice[]).filter(r => {
      const prefix = 'mcp__' + r.name + '__';
      return name.startsWith(prefix) && name.length > prefix.length;
    });
    if (!candidates.length) return false;
    sql.run(`INSERT INTO commerce_tool_receipts(device_id,session_id,agent_id,native_id,called_at,plan_id,candidates_json) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT DO UPDATE SET called_at=excluded.called_at,plan_id=excluded.plan_id,candidates_json=excluded.candidates_json
      WHERE commerce_tool_receipts.called_at IS NULL`, [...key, row.at, snapshot.plan_id, JSON.stringify(candidates)]);
  } else {
    if (!call && !sql.get(`SELECT 1 FROM commerce_leases c JOIN leases l ON l.id=c.lease_id
      WHERE l.device_id=? AND c.issued_at<=? AND c.tool_prices_json!='[]' LIMIT 1`, [device, row.at])) return false;
    sql.run(`INSERT INTO commerce_tool_receipts(device_id,session_id,agent_id,native_id,result_error) VALUES(?,?,?,?,?)
      ON CONFLICT DO UPDATE SET result_error=excluded.result_error WHERE commerce_tool_receipts.result_error IS NULL`, [...key, Number(row.payload.is_error === true)]);
  }
  return matchReceipt(sql, key, user, runtime, at);
}
