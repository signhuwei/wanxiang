import { ApiError, field, invalid } from './api';
import { deviceAllowed, reconcileUsage } from './billing';
import { int } from './management';
import type { Store, Transaction } from './store';

export type IngestSummary = { type: 'session' | 'event' | 'usage' | 'cursor'; session_id?: string; user_id: string; seq: number; kind?: string };
export type PublishSummary = (tenant: string, entries: IngestSummary[]) => void;

export function batchItems(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) invalid('batch');
  return value.map((row): Record<string, unknown> => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('batch');
    return row;
  });
}

export function eventTime(value: unknown) {
  const raw = field(value, 'at', 40);
  const at = Date.parse(raw);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(raw) || !Number.isFinite(at)
    || new Date(at).toISOString().slice(0, 19) !== raw.slice(0, 19)) invalid('at');
  return new Date(at).toISOString();
}

export function ackCursor(sql: Pick<Transaction, 'get'>, device: string) {
  return sql.get<{ ack_seq: number }>('SELECT ack_seq FROM ingest_cursors WHERE device_id = ?', [device])?.ack_seq ?? 0;
}

export function markSequence(sql: Transaction, device: string, seq: number) {
  if (seq <= ackCursor(sql, device)) return false;
  return !!sql.run('INSERT OR IGNORE INTO ingest_sequences (device_id, seq) VALUES (?, ?)', [device, seq]).changes;
}

export function advanceCursor(sql: Transaction, device: string) {
  const previous = ackCursor(sql, device);
  let ack = previous;
  for (;;) {
    const rows = sql.all<{ seq: number }>('SELECT seq FROM ingest_sequences WHERE device_id = ? AND seq > ? ORDER BY seq LIMIT 500', [device, ack]);
    let i = 0;
    while (i < rows.length && rows[i].seq === ack + 1) { ack++; i++; }
    if (i < 500) break;
  }
  if (ack !== previous) {
    sql.run(`INSERT INTO ingest_cursors (device_id, ack_seq) VALUES (?, ?)
      ON CONFLICT (device_id) DO UPDATE SET ack_seq = excluded.ack_seq`, [device, ack]);
    sql.run('DELETE FROM ingest_sequences WHERE device_id = ? AND seq <= ?', [device, ack]);
  }
  return ack;
}

const eventKinds = ['session_start', 'user_message', 'assistant_message', 'system_message', 'tool_call', 'tool_result', 'session_end', 'gap', 'compact'];

export function eventItems(value: unknown) {
  return batchItems(value).map((row) => {
    const kind = field(row.kind, 'kind');
    if (!eventKinds.includes(kind)) invalid('kind');
    const payload = row.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('payload');
    return { seq: int(row.seq, 'seq', 1), session: field(row.session_id, 'session_id'), kind, at: eventTime(row.at),
      offset: row.source_offset == null ? null : int(row.source_offset, 'source_offset'), payload: payload as Record<string, unknown> };
  });
}

export async function ingestEvents(store: Store, tenant: string, device: string, user: string, at: number, live: () => boolean,
  items: ReturnType<typeof eventItems>, publish: PublishSummary) {
  const { ack, summaries } = await store.tenant(tenant).write((sql) => {
    if (!live() || !deviceAllowed(store, sql, tenant, device, at)) throw new ApiError('forbidden');
    const summaries: IngestSummary[] = [];
    for (const row of items) {
      if (!markSequence(sql, device, row.seq)) continue;
      const existing = sql.get<{ device_id: string }>('SELECT device_id FROM agent_sessions WHERE id = ?', [row.session]);
      if (existing && existing.device_id !== device) {
        console.warn('OneX rejected cross-device session event', { tenant_id: tenant, device_id: device, session_id: row.session });
        throw new ApiError('conflict');
      }
      if (!existing) {
        sql.run(`INSERT INTO agent_sessions (id, device_id, user_id, agent, agent_version, started_at, last_event_at)
          VALUES (?, ?, ?, 'unknown', '', ?, ?)`, [row.session, device, user, row.at, row.at]);
        summaries.push({ type: 'session', session_id: row.session, user_id: user, seq: row.seq });
      }
      if (row.kind === 'session_start') {
        const info = (key: string, fallback: string | null) => typeof row.payload[key] === 'string' && row.payload[key].length <= 200
          ? row.payload[key] : fallback;
        sql.run(`UPDATE agent_sessions SET started_seq = ?, started_at = ?, agent = ?, agent_version = ?, model = ?
          WHERE id = ? AND (started_seq IS NULL OR started_seq < ?)`,
          [row.seq, row.at, info('agent', 'unknown'), info('agent_version', ''), info('model', null), row.session, row.seq]);
        sql.run('UPDATE agent_sessions SET ended_at = NULL WHERE id = ? AND ended_seq < ?', [row.session, row.seq]);
      } else if (row.kind === 'session_end') {
        sql.run(`UPDATE agent_sessions SET ended_seq = ?, ended_at = ? WHERE id = ?
          AND (ended_seq IS NULL OR ended_seq < ?) AND (started_seq IS NULL OR started_seq < ?)`,
          [row.seq, row.at, row.session, row.seq, row.seq]);
      }
      sql.run(`INSERT INTO session_events (device_id, seq, session_id, kind, at, payload_json, source_offset)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [device, row.seq, row.session, row.kind, row.at, JSON.stringify(row.payload), row.offset]);
      sql.run(`UPDATE agent_sessions SET event_count = event_count + 1, revision = revision + 1,
        last_event_at = max(coalesce(last_event_at, ''), ?) WHERE id = ?`, [row.at, row.session]);
      summaries.push({ type: 'event', session_id: row.session, user_id: user, seq: row.seq, kind: row.kind });
    }
    const previous = ackCursor(sql, device);
    const ack = advanceCursor(sql, device);
    if (ack > previous) summaries.push({ type: 'cursor', user_id: user, seq: ack });
    return { ack, summaries };
  });
  publish(tenant, summaries);
  return ack;
}

export function usageItems(value: unknown) {
  return batchItems(value).map((row) => {
    const status = field(row.status, 'status');
    if (!/^(ok|upstream_[1-5]\d\d|upstream_error|client_cancelled|lease_exhausted|lease_expired|cutoff)$/.test(status)) invalid('status');
    if (typeof row.complete !== 'boolean') invalid('complete');
    return {
      seq: int(row.seq, 'seq', 1), request: field(row.request_id, 'request_id'),
      session: row.session_id == null ? null : field(row.session_id, 'session_id'),
      lease: row.lease_id == null ? null : field(row.lease_id, 'lease_id'),
      provider: field(row.provider_id, 'provider_id'), model: field(row.model, 'model'),
      modelId: field(row.model_id ?? row.model, row.model_id == null ? 'model' : 'model_id'),
      input: int(row.input_tokens, 'input_tokens'), output: int(row.output_tokens, 'output_tokens'),
      cacheRead: int(row.cache_read_tokens, 'cache_read_tokens'), cacheWrite: int(row.cache_write_tokens, 'cache_write_tokens'),
      cost: int(row.cost_milli, 'cost_milli'), at: eventTime(row.at), complete: row.complete, status,
    };
  });
}

export async function ingestUsage(store: Store, tenant: string, device: string, user: string, at: number, live: () => boolean,
  items: ReturnType<typeof usageItems>, publish: PublishSummary) {
  const { ack, summaries } = await store.tenant(tenant).write((sql) => {
    if (!live() || !deviceAllowed(store, sql, tenant, device, at)) throw new ApiError('forbidden');
    const summaries: IngestSummary[] = [];
    let reconcile = false;
    for (const row of items) {
      if (!markSequence(sql, device, row.seq)) continue;
      const lease = row.lease && sql.get<{ budget_milli: number }>('SELECT budget_milli FROM leases WHERE id = ? AND device_id = ?', [row.lease, device]);
      const leaseId = lease ? row.lease : null;
      const settlement = !row.complete ? 'pending' : leaseId ? 'pending' : 'unverified';
      sql.run(`INSERT INTO usage (device_id, seq, request_id, session_id, lease_id, provider_id, model_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_milli, status, at, complete, settlement_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [device, row.seq, row.request, row.session, leaseId, row.provider, row.modelId, row.model, row.input, row.output, row.cacheRead,
          row.cacheWrite, row.cost, row.status, row.at, Number(row.complete), settlement]);
      if (leaseId && row.complete) reconcile = true;
      if (row.session) {
        sql.run('UPDATE agent_sessions SET revision = revision + 1 WHERE id = ? AND device_id = ?', [row.session, device]);
        summaries.push({ type: 'usage', session_id: row.session, user_id: user, seq: row.seq });
      }
    }
    if (reconcile) reconcileUsage(sql, device);
    const previous = ackCursor(sql, device);
    const ack = advanceCursor(sql, device);
    if (ack > previous) summaries.push({ type: 'cursor', user_id: user, seq: ack });
    return { ack, summaries };
  });
  publish(tenant, summaries);
  return ack;
}
