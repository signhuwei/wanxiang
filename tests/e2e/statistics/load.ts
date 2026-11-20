import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../../../server/src/server';
import { MemoryPresence } from '../../../server/src/presence';
import { seedTenant } from '../../../server/src/seed';

const directory = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'onex-statistics-'));
const target = 'statistics-owner@example.test';
let now = Date.parse('2026-11-20T10:00:00Z');
let code = '';
const app = await createServer({ dataDir: directory, hostname: '127.0.0.1', port: 0, tenantCacheSize: 2,
  heartbeatMs: 15_000, commit: 'statistics-benchmark', codeSecret: 'statistics-fixture', presence: new MemoryPresence(),
  now: () => now, deliverCode: (_, value) => { code = value; } });
try {
  const { tenantId } = await seedTenant(app.store, { target, seats: 101, now });
  async function post(path: string, body: object, token?: string) {
    const response = await fetch(new URL('/v1' + path, app.server.url), { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) } });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.json() as Promise<any>;
  }
  await post('/auth/code', { target });
  const { token: global } = await post('/auth/login', { target, code });
  const { token } = await post('/auth/select-tenant', { tenant_id: tenantId }, global);
  const data = app.store.tenant(tenantId);
  await data.write(sql => {
    for (let person = 0; person < 100; person++) {
      const user = `stats-user-${person}`;
      const device = `stats-device-${person}`;
      sql.run("INSERT INTO members(user_id,role,status) VALUES (?,'member','active')", [user]);
      sql.run(`INSERT INTO devices(id,user_id,name,os,arch,public_key,token_hash,token_expires_at,status)
        VALUES (?,?,'Fixture','darwin','arm64','',?,'2099-01-01T00:00:00.000Z','active')`, [device, user, device]);
      let seq = 0;
      for (let day = 0; day < 30; day++) for (let n = 0; n < 10; n++) {
        const id = `${user}-${day}-${n}`;
        const at = new Date(now - 86_400_000 * day).toISOString();
        const agent = ['claude-code', 'codex', 'kimi-code', 'workbuddy', 'deepseek-desktop'][n % 5];
        sql.run("INSERT INTO agent_sessions(id,device_id,user_id,agent,agent_version,started_at) VALUES (?,?,?,?,'fixture',?)",
          [id, device, user, agent, at]);
        for (const kind of ['user_message', 'assistant_message']) sql.run(`INSERT INTO session_events(session_id,device_id,seq,kind,at,payload_json)
          VALUES (?,?,?,?,?,'{}')`, [id, device, ++seq, kind, at]);
        for (let request = 0; request < 4; request++) sql.run(`INSERT INTO usage(device_id,seq,request_id,session_id,model_id,input_tokens,
          output_tokens,cache_read_tokens,cache_write_tokens,cost_milli,status,at,complete,settlement_status)
          VALUES (?,?,?,?,'fixture-model',100,30,15,0,1,'ok',?,1,'reconciled')`, [device, ++seq, `${id}-${request}`, id, at]);
      }
      sql.run('INSERT INTO ingest_cursors(device_id,ack_seq) VALUES (?,?)', [device, seq]);
    }
  });
  const warm: number[] = [], cold: number[] = [];
  for (let iteration = 0; iteration < 30; iteration++) {
    const refresh = iteration % 3 === 0;
    if (refresh) now += 61_000;
    const start = performance.now();
    const response = await fetch(new URL('/v1/observe/statistics', app.server.url), { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    (refresh ? cold : warm).push(performance.now() - start);
    assert.equal(result.totals.active_people, 100);
    assert.equal(result.totals.sessions, 30_000);
    assert.equal(result.totals.events, 60_000);
    assert.equal(result.totals.requests, 120_000);
  }
  const p95 = (values: number[]) => Math.round(values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]);
  const receipt = { people: 100, days: 30, sessions: 30_000, events: 60_000, requests: 120_000, warm_p95_ms: p95(warm), cold_p95_ms: p95(cold) };
  console.log(JSON.stringify(receipt));
  assert.ok(receipt.warm_p95_ms < 1_000 && receipt.cold_p95_ms < 1_000);
} finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
