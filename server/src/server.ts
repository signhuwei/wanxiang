import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { websocket } from 'hono/bun';
import { ulid } from 'ulid';
import pkg from '../package.json';
import { ApiError } from './api';
import { authRoutes } from './auth';
import { edgeGateway } from './edge';
import { openapi } from './openapi';
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
  deliverCode?: (target: string, code: string) => void;
  now?: () => number;
  presence: Presence;
};

export async function createServer(opts: Options) {
  const store = new Store(opts.dataDir, opts.tenantCacheSize);
  const now = opts.now ?? Date.now;
  try {
    await store.rebuildIndexes();
    const app = new Hono();
    app.use('/v1/*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-store');
    });
    app.use('/v1/*', bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: new ApiError('invalid', { fields: ['body'] }).body() }, 422) }));
    app.onError((error, c) => {
      if (error instanceof ApiError) return c.json({ error: error.body() }, error.status);
      const trace_id = `trc_${ulid()}`;
      console.error('OneX request failed', { trace_id, name: error.name });
      return c.json({ error: new ApiError('internal', { trace_id }).body() }, 500);
    });
    app.notFound((c) => c.json({ error: new ApiError('not_found').body() }, 404));
    app.get('/v1/healthz', (c) => c.json({ status: 'ok', version: pkg.version, commit: opts.commit }));
    app.get('/v1/openapi.json', (c) => c.json(openapi));
    authRoutes(app, store, { ...opts, now });
    edgeGateway(app, store, opts.presence, now, opts.heartbeatMs);
    const server = Bun.serve({ hostname: opts.hostname, port: opts.port,
      fetch: app.fetch, websocket: { ...websocket, maxPayloadLength: 64 * 1024, idleTimeout: 0, sendPings: false },
    });
    return {
      server, store,
      close() {
        void server.stop(true);
        opts.presence.close?.();
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
