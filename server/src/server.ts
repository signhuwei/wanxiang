import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic, websocket } from 'hono/bun';
import { ulid } from 'ulid';
import pkg from '../package.json';
import { ApiError } from './api';
import { authRoutes } from './auth';
import { billingRoutes } from './billing';
import { deviceRoutes, diagRoutes, DIAG_UPLOAD_PATH, sweepExpiredJobs } from './diag';
import { edgeGateway } from './edge';
import { configPublisher } from './edge-config';
import { openapi } from './openapi';
import { observationRoutes } from './observe';
import type { ObjectStorage } from './object-storage';
import { PendingWork } from './pending';
import { platformRoutes } from './platform-management';
import { tenantRoutes } from './tenant-management';
import type { Presence } from './presence';
import { Store } from './store';

type Options = {
  dataDir: string;
  hostname: string;
  port: number;
  tenantCacheSize: number;
  heartbeatMs: number;
  commit: string;
  codeSecret: string;
  masterKey?: Uint8Array;
  deliverCode?: (target: string, code: string) => void;
  now?: () => number;
  presence: Presence;
  /** 诊断日志包的对象存储；缺省时诊断功能对外报 `not_found`（见 diag.ts）。 */
  objectStorage?: ObjectStorage;
};

export async function createServer(opts: Options) {
  const store = new Store(opts.dataDir, opts.tenantCacheSize);
  const now = opts.now ?? Date.now;
  try {
    await store.rebuildIndexes();
    const app = new Hono();
    const web = serveStatic({ root: `${import.meta.dir}/../web`, rewriteRequestPath: (path) => path === '/' ? '/index.html' : path });
    app.get('/', web);
    app.get('/:asset{[a-zA-Z0-9_-]+\\.(js|css)}', web);
    app.get('/mock/:asset{[a-zA-Z0-9_-]+\\.(js|txt)}', web);
    app.use('/v1/*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-store');
    });
    const smallBody = bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: new ApiError('invalid', { fields: ['body'] }).body() }, 422) });
    // The diagnostic route checks the device and job before reading its bounded body.
    app.use('/v1/*', (c, next) => c.req.method === 'PUT' && DIAG_UPLOAD_PATH.test(c.req.path) ? next() : smallBody(c, next));
    app.onError((error, c) => {
      if (error instanceof ApiError) return c.json({ error: error.body() }, error.status);
      const trace_id = `trc_${ulid()}`;
      console.error('OneX request failed', { trace_id, name: error.name });
      return c.json({ error: new ApiError('internal', { trace_id }).body() }, 500);
    });
    app.notFound((c) => c.json({ error: new ApiError('not_found').body() }, 404));
    app.get('/v1/healthz', (c) => c.json({ status: 'ok', version: pkg.version, commit: opts.commit }));
    app.get('/v1/openapi.json', (c) => c.json(openapi));
    const pending = new PendingWork();
    const config = configPublisher(store, now, opts.masterKey);
    const management = { ...opts, now, onConfigChange: (id?: string) => { void pending.track(config.changed(id)); } };
    authRoutes(app, store, management);
    tenantRoutes(app, store, management);
    platformRoutes(app, store, management);
    billingRoutes(app, store, management);
    const observation = observationRoutes(app, store, now);
    const diag = diagRoutes(app, store, management, opts.objectStorage);
    deviceRoutes(app, store, management, diag);
    const closeSockets = edgeGateway(app, store, opts.presence, now, opts.heartbeatMs, config, pending, observation.publish, diag);
    let shuttingDown = false;
    const server = Bun.serve({ hostname: opts.hostname, port: opts.port,
      fetch: (request, server) => shuttingDown ? new Response(null, { status: 503 }) : pending.track(Promise.resolve(app.fetch(request, server))),
      websocket: { ...websocket, maxPayloadLength: 4 * 1024 * 1024, idleTimeout: 0, sendPings: false },
    });
    let sweeping = false;
    const expire = () => {
      if (!opts.objectStorage || sweeping || shuttingDown) return;
      sweeping = true;
      void pending.track(sweepExpiredJobs(store, opts.objectStorage, now())
        .catch(() => console.warn('OneX could not finish diagnostic retention cleanup'))
        .finally(() => { sweeping = false; }));
    };
    const retention = opts.objectStorage ? setInterval(expire, 3_600_000) : undefined;
    retention?.unref();
    expire();
    let closing: Promise<void> | undefined;
    return {
      server, store,
      close() {
        return closing ??= (async () => {
          shuttingDown = true;
          if (retention) clearInterval(retention);
          // Bun 1.3.5 can retain the WS count after a server-initiated close.
          void server.stop().catch(() => {});
          observation.close();
          await closeSockets();
          await pending.drain();
          await store.drain();
          opts.presence.close?.();
          store.close();
        })();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
