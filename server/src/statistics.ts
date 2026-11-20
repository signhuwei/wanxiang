import type { Context, Hono } from 'hono';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ulid } from 'ulid';
import { ApiError, invalid } from './api';
import { iso } from './credentials';
import { tenantActor } from './management';
import { observedAgents, summaryPeople } from './observe';
import type { ObjectStorage } from './object-storage';
import type { PendingWork } from './pending';
import type { Store } from './store';

const day = 86_400_000;
const shanghai = 8 * 3_600_000;
const snapshotTtl = 60_000;
const firstDay = (epoch: number) => Math.floor((epoch + shanghai) / day) * day;
const dayLabel = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);
const allAgents = [...observedAgents, 'unknown'] as readonly string[];
const workerPath = join(import.meta.dir, 'statistics-worker.ts');

type Actor = ReturnType<typeof tenantActor>;
type Snapshot = { path: string; asOf: number; until: number };

function dateParam(value: string | undefined, fallback: number, field: string) {
  if (value === undefined) return fallback;
  const parsed = Date.parse(value + 'T00:00:00.000Z');
  if (!/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(parsed) || dayLabel(parsed) !== value) invalid(field);
  return parsed;
}

function queryParameters(c: Context, timestamp: number) {
  const today = firstDay(timestamp);
  const to = dateParam(c.req.query('to'), today, 'to');
  const from = dateParam(c.req.query('from'), to - 29 * day, 'from');
  if (to > today || from < today - 89 * day || to < from || to - from >= 30 * day) invalid('date_range');
  const agent = c.req.query('agent') || null;
  if (agent && !allAgents.includes(agent)) invalid('agent');
  return { from: dayLabel(from), to: dayLabel(to), agent };
}

export function statisticsRoutes(app: Hono, store: Store, opts: { dataDir: string; now: () => number; objectStorage?: ObjectStorage; pending: PendingWork }) {
  const root = resolve(opts.dataDir, 'statistics');
  const snapshots = new Map<string, Snapshot>();
  const generating = new Map<string, Promise<Snapshot>>();
  let inFlight = 0;
  async function run(command: Record<string, unknown>) {
    if (inFlight >= 8) throw new ApiError('rate_limited');
    const worker = Bun.spawn([process.execPath, '--no-env-file', workerPath], {
      stdin: new Blob([JSON.stringify(command)]), stdout: 'pipe', stderr: 'ignore',
      env: Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'SystemRoot'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])),
    });
    inFlight++;
    const timeout = setTimeout(() => worker.kill('SIGKILL'), 30_000);
    try {
      const output = await new Response(worker.stdout).text();
      if (await worker.exited !== 0) throw new Error('Statistics worker failed');
      return JSON.parse(output) as Record<string, unknown>;
    } finally { clearTimeout(timeout); inFlight--; }
  }

  function snapshot(tenantId: string) {
    const now = opts.now();
    const today = firstDay(now);
    const cached = snapshots.get(tenantId);
    if (cached && cached.until > now && firstDay(cached.asOf) === today) return Promise.resolve(cached);
    const pending = generating.get(tenantId);
    if (pending) return pending;
    const build = (async () => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const tmp = mkdtempSync(join(root, '.snapshot-'));
      const output = join(tmp, 'facts.parquet');
      try {
        await run({ operation: 'snapshot', database: resolve(opts.dataDir, `tenant-${tenantId}.sqlite`), output,
          start: iso(today - 89 * day - shanghai), end: iso(today + day - shanghai) });
        const path = join(root, `${tenantId}.parquet`);
        await rename(output, path);
        const row = { path, asOf: now, until: now + snapshotTtl };
        snapshots.set(tenantId, row);
        return row;
      } finally { await rm(tmp, { recursive: true, force: true }); }
    })().finally(() => generating.delete(tenantId));
    generating.set(tenantId, build);
    return build;
  }

  function checkScope(c: Context, original: Actor, people: string[] | null) {
    const current = tenantActor(store, c, opts.now());
    if (current.id !== original.id || current.userId !== original.userId
      || JSON.stringify(summaryPeople(current)) !== JSON.stringify(people)) throw new ApiError('forbidden');
    return current;
  }

  app.get('/v1/observe/statistics', async c => {
    const actor = tenantActor(store, c, opts.now());
    const parameters = queryParameters(c, opts.now());
    const people = summaryPeople(actor);
    const data = await snapshot(actor.id);
    const result = await run({ operation: 'query', snapshot: data.path, people, ...parameters });
    checkScope(c, actor, people);
    return c.json({ ...parameters, ...result, as_of: iso(data.asOf), actions: ['read', 'export_parquet'] });
  });

  app.get('/v1/observe/statistics/parquet', async c => {
    const actor = tenantActor(store, c, opts.now());
    const parameters = queryParameters(c, opts.now());
    const people = summaryPeople(actor);
    const data = await snapshot(actor.id);
    const temporary = mkdtempSync(join(root, '.export-'));
    try {
      const output = join(temporary, 'export.parquet');
      await run({ operation: 'query', snapshot: data.path, people, output, ...parameters });
      const bytes = await Bun.file(output).arrayBuffer();
      await actor.db.write(sql => {
        checkScope(c, actor, people);
        sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
          [`aud_${ulid()}`, actor.userId, 'observe.statistics.export', actor.id, JSON.stringify(parameters), iso(opts.now())]);
      });
      return new Response(bytes, { headers: { 'content-type': 'application/vnd.apache.parquet',
        'content-disposition': `attachment; filename="OneX-statistics-${parameters.from}-${parameters.to}.parquet"`,
        'x-content-type-options': 'nosniff' } });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  let stopped = false;
  let refreshing = false;
  const refresh = async () => {
    refreshing = true;
    try {
      const tenants = store.system.all<{ id: string }>("SELECT id FROM tenants WHERE status = 'active' ORDER BY id");
      for (const { id } of tenants) {
        if (stopped) break;
        // Opening through Store applies pending migrations before spawning the read-only worker.
        try {
          store.tenant(id);
          const { path } = await snapshot(id);
          await opts.objectStorage!.put(`statistics/${id}/facts.parquet`, new Uint8Array(await Bun.file(path).arrayBuffer()),
            'application/vnd.apache.parquet');
        }
        catch { console.warn('OneX could not refresh a statistics snapshot', { tenant_id: id }); }
      }
    } finally { refreshing = false; }
  };
  const refreshTimer = opts.objectStorage ? setInterval(() => {
    if (!refreshing && !stopped) void opts.pending.track(refresh());
  }, 15 * 60_000) : undefined;
  refreshTimer?.unref();
  return () => { stopped = true; if (refreshTimer) clearInterval(refreshTimer); };
}
