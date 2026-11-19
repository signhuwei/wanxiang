import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomToken, hash, day, iso } from '../../server/src/credentials';
import { MemoryPresence } from '../../server/src/presence';
import { seedTenant } from '../../server/src/seed';
import { createServer } from '../../server/src/server';
import { indexDevice } from '../../server/src/store';
import { randomUUID } from 'node:crypto';

const duration = Number(Bun.argv[2] ?? 60);
if (!Number.isInteger(duration) || duration < 1 || duration > 600) throw new Error('Usage: bun tests/e2e/ingest-load.ts [seconds:1–600]');
const clients = 50;
const rate = 20;
const dir = mkdtempSync(join(tmpdir(), 'onex-ingest-load-'));
const latencies: number[] = [];
const sockets: WebSocket[] = [];
let sqliteBusy = false;
const reportError = console.error;
console.error = (...args) => {
  sqliteBusy ||= args.some((arg) => arg && typeof arg === 'object' && arg.code === 'SQLITE_BUSY');
  reportError(...args);
};
try {
  const app = await createServer({ dataDir: dir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 1,
    heartbeatMs: 15_000, commit: 'ingest-load', codeSecret: randomToken(), presence: new MemoryPresence() });
  try {
    const { tenantId, userId } = await seedTenant(app.store, { target: 'ingest@example.test' });
    const devices = Array.from({ length: clients }, () => ({ id: `load_${randomUUID()}`, token: randomToken(), session: randomUUID() }));
    const records = devices.map(({ id, token }) => ({ id, token_hash: hash(token) }));
    await app.store.tenant(tenantId).write((sql) => {
      for (const row of records) sql.run(`INSERT INTO devices (id, user_id, name, os, arch, public_key, token_hash, token_expires_at, status)
        VALUES (?, ?, 'Load Edge', 'darwin', 'arm64', '', ?, ?, 'active')`, [row.id, userId, row.token_hash, iso(Date.now() + day)]);
    });
    await app.store.system.write((sql) => { for (const row of records) indexDevice(sql, tenantId, row); });
    const total = duration * rate;
    const edges = devices.map(({ token, session }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/v1/edge/ws`, {
        headers: { Authorization: `Bearer ${token}`, 'OneX-Edge-Version': '0.1.0', 'OneX-Protocol': '0' },
      });
      sockets.push(ws);
      const send = (msg: unknown) => ws.send(JSON.stringify(msg));
      const welcome = Promise.withResolvers<void>();
      const written = Promise.withResolvers<void>();
      void welcome.promise.catch(() => {});
      void written.promise.catch(() => {});
      const pending = new Map<number, number>();
      let ack = 0;
      const fail = (reason: string) => { const error = new Error(reason); welcome.reject(error); written.reject(error); };
      ws.onopen = () => send({ type: 'hello', id: 'load-hello', edge_version: '0.1.0', os: 'darwin', arch: 'arm64', config_revision: 0, outbox_last_seq: 0 });
      ws.onclose = (e) => { if (ack < total) fail(`Edge closed before final ACK: ${e.code} ${e.reason}`); };
      ws.onerror = () => fail('WebSocket error');
      ws.onmessage = ({ data }) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'welcome') welcome.resolve();
        if (msg.type === 'ping') send({ type: 'pong', re: msg.id });
        if (msg.type === 'ack' && !msg.ok) fail(`ACK error: ${JSON.stringify(msg.error)}`);
        if (msg.type !== 'events_ack') return;
        const now = performance.now();
        while (ack < msg.ack_seq) {
          ack++;
          const sent = pending.get(ack);
          if (sent === undefined) { fail('ACK exceeded the sent sequence'); return; }
          latencies.push(now - sent);
          pending.delete(ack);
        }
        if (ack >= total) written.resolve();
      };
      return { ready: welcome.promise, done: written.promise, event(seq: number) {
        pending.set(seq, performance.now());
        send({ type: 'events', id: `load-${seq}`, batch: [{ seq, session_id: session, source_offset: seq, at: iso(Date.now()),
          kind: seq === 1 ? 'session_start' : 'user_message', payload: seq === 1 ? { agent: 'claude-code', agent_version: 'load' }
            : { content: 'synthetic content '.repeat(16) } }] });
      } };
    });
    const timeout = setTimeout(() => { for (const ws of sockets) ws.close(1000, 'load timeout'); }, (duration + 15) * 1000);
    try {
      await Promise.all(edges.map(({ ready }) => ready));
      const start = performance.now();
      for (let seq = 1; seq <= total; seq++) {
        const delay = start + (seq - 1) * (1000 / rate) - performance.now();
        if (delay > 0) await Bun.sleep(delay);
        for (const edge of edges) edge.event(seq);
      }
      await Promise.all(edges.map(({ done }) => done));
    } finally { clearTimeout(timeout); }
    const persisted = app.store.tenant(tenantId).get<{ n: number }>('SELECT count(*) AS n FROM session_events')!.n;
    if (persisted !== clients * total || latencies.length !== persisted) throw new Error(`Expected ${clients * total} events; persisted ${persisted}, acknowledged ${latencies.length}`);
    latencies.sort((a, b) => a - b);
    const percentile = (fraction: number) => Number(latencies[Math.ceil(latencies.length * fraction) - 1].toFixed(3));
    console.log(JSON.stringify({ clients, events_per_client_per_second: rate, seconds: duration, events: persisted,
      p50_ack_ms: percentile(0.50), p99_ack_ms: percentile(0.99), sqlite_busy: sqliteBusy }, null, 2));
    if (sqliteBusy) process.exitCode = 1;
  } finally {
    for (const ws of sockets) ws.close();
    await app.close();
  }
} catch (error) {
  reportError('Ingest load failed', { sqlite_busy: sqliteBusy, error });
  process.exitCode = 1;
} finally {
  console.error = reportError;
  rmSync(dir, { recursive: true, force: true });
}
