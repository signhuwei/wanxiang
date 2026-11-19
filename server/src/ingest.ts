import { ApiError, field, invalid } from './api';
import { deviceAllowed, reconcileUsage } from './billing';
import { int } from './management';
import type { Store, Transaction } from './store';

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

export function usageItems(value: unknown) {
  return batchItems(value).map((row) => {
    const status = field(row.status, 'status');
    if (!/^(ok|upstream_[1-5]\d\d|upstream_error|client_cancelled)$/.test(status)) invalid('status');
    if (typeof row.complete !== 'boolean') invalid('complete');
    return {
      seq: int(row.seq, 'seq', 1), request: field(row.request_id, 'request_id'),
      session: row.session_id == null ? null : field(row.session_id, 'session_id'),
      lease: row.lease_id == null ? null : field(row.lease_id, 'lease_id'),
      provider: field(row.provider_id, 'provider_id'), model: field(row.model, 'model'),
      input: int(row.input_tokens, 'input_tokens'), output: int(row.output_tokens, 'output_tokens'),
      cacheRead: int(row.cache_read_tokens, 'cache_read_tokens'), cacheWrite: int(row.cache_write_tokens, 'cache_write_tokens'),
      cost: int(row.cost_milli, 'cost_milli'), at: eventTime(row.at), complete: row.complete, status,
    };
  });
}

export function ingestUsage(store: Store, tenant: string, device: string, at: number, live: () => boolean, items: ReturnType<typeof usageItems>) {
  return store.tenant(tenant).write((sql) => {
    if (!live() || !deviceAllowed(store, sql, tenant, device, at)) throw new ApiError('forbidden');
    const leases = new Set<string>();
    for (const row of items) {
      if (!markSequence(sql, device, row.seq)) continue;
      const lease = row.lease && sql.get<{ budget_milli: number }>('SELECT budget_milli FROM leases WHERE id = ? AND device_id = ?', [row.lease, device]);
      const leaseId = lease ? row.lease : null;
      const settlement = !row.complete ? 'pending' : leaseId ? 'pending' : 'unverified';
      sql.run(`INSERT INTO usage (device_id, seq, request_id, session_id, lease_id, provider_id, model_id, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_milli, status, at, complete, settlement_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [device, row.seq, row.request, row.session, leaseId, row.provider, row.model, row.input, row.output, row.cacheRead,
          row.cacheWrite, row.cost, row.status, row.at, Number(row.complete), settlement]);
      if (leaseId) leases.add(leaseId);
    }
    for (const id of leases) reconcileUsage(sql, id);
    return advanceCursor(sql, device);
  });
}
