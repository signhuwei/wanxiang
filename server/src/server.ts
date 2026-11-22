import { purgeExpiredContent } from './session-governance';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic, websocket } from 'hono/bun';
import { ulid } from 'ulid';
import pkg from '../package.json';
import { ApiError } from './api';
import { agentArtifactRoutes, AGENT_ARTIFACT_DOWNLOAD_PATH, AGENT_ARTIFACT_UPLOAD_PATH } from './agent-artifacts';
import { authRoutes } from './auth';
import { billingRoutes } from './billing';
import { capabilityRoutes } from './capability-contracts';
import { deviceRoutes, diagRoutes, DIAG_UPLOAD_PATH, sweepExpiredJobs } from './diag';
import { DESKTOP_ARTIFACT_DOWNLOAD_PATH, DESKTOP_ARTIFACT_MAX_BYTES, DESKTOP_ARTIFACT_UPLOAD_PATH, desktopReleaseRoutes } from './desktop-releases';
import { edgeGateway } from './edge';
import { configPublisher } from './edge-config';
import { openapi } from './openapi';
import { observationRoutes } from './observe';
import type { ObjectStorage } from './object-storage';
import { PendingWork } from './pending';
import { SERVER_ARTIFACT_UPLOAD_PATH, serverReleaseRoutes, type ReleaseRuntime } from './server-releases';
import { personalLoginTokenRoutes } from './personal-login-tokens';
import { platformRoutes } from './platform-management';
import { modelPoolRoutes } from './model-pool';
import { procurementRoutes } from './procurement';
import { inputMultiplierRoutes } from './input-multiplier';
import { policyDiscountRoutes, settleUnclosedDiscountMonths } from './policy-discounts';
import { commerceRoutes } from './commerce';
import { upstreamRoutes } from './tenant-upstreams';
import { policyRoutes } from './policy-routes';
import { tenantRoutes } from './tenant-management';
import { TOOL_ARTIFACT_DOWNLOAD_PATH, TOOL_ARTIFACT_UPLOAD_PATH, toolReleaseRoutes } from './tool-releases';
import type { Presence } from './presence';
import { routingProjector, type RoutingProjectionInputs } from './route-projection';
import { rolloutRoutes } from './route-rollouts';
import { Store } from './store';
import { statisticsRoutes } from './statistics';

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
  releaseRuntime?: ReleaseRuntime;
  /** Isolated route_pool.v1 stage only: tests inject grants and synthetic credential versions. Production never sets it. */
  routingProjection?: RoutingProjectionInputs;
};

export async function createServer(opts: Options) {
  if (opts.routingProjection?.executionTest && (opts.hostname !== '127.0.0.1' || !opts.routingProjection.leaseGate)) {
    throw new Error('The routing execution fixture requires a loopback server and the lease gate');
  }
  const store = new Store(opts.dataDir, opts.tenantCacheSize);
  const now = opts.now ?? Date.now;
  let closeStatistics: (() => void) | undefined;
  let closeReleases: (() => void) | undefined;
  try {
    await store.rebuildIndexes();
    const app = new Hono();
    const web = serveStatic({ root: `${import.meta.dir}/../web`, rewriteRequestPath: (path) => path === '/' ? '/index.html' : path });
    app.get('/', web);
    app.get('/:asset{[a-zA-Z0-9_-]+\\.(js|css)}', web);
    app.get('/mock/:asset{[a-zA-Z0-9_-]+\\.(js|txt)}', web);
    app.use('/v1/*', async (c, next) => {
      if (c.req.method === 'GET' && (DESKTOP_ARTIFACT_DOWNLOAD_PATH.test(c.req.path)
        || AGENT_ARTIFACT_DOWNLOAD_PATH.test(c.req.path) || TOOL_ARTIFACT_DOWNLOAD_PATH.test(c.req.path))) {
        // Mutating headers after the handler converts a BunFile into a chunked response.
        c.header('Cache-Control', 'no-store');
        return next();
      }
      await next();
      c.header('Cache-Control', 'no-store');
    });
    const limitedBody = (maxSize: number) => bodyLimit({ maxSize,
      onError: (c) => c.json({ error: new ApiError('invalid', { fields: ['body'] }).body() }, 422) });
    const smallBody = limitedBody(8192);
    const capabilityBody = limitedBody(65536);
    const capabilityWrite = /^\/v1\/(?:contract\/configuration(?:\/preview)?|platform\/(?:contract-templates|capability-contracts\/[^/]+(?:\/preview)?))$/;
    // Artifact upload routes check authorization before reading their own bounded body.
    const isRawUpload = (c: { req: { method: string; path: string } }) => c.req.method === 'PUT'
      && (DIAG_UPLOAD_PATH.test(c.req.path) || DESKTOP_ARTIFACT_UPLOAD_PATH.test(c.req.path)
        || SERVER_ARTIFACT_UPLOAD_PATH.test(c.req.path) || AGENT_ARTIFACT_UPLOAD_PATH.test(c.req.path)
        || TOOL_ARTIFACT_UPLOAD_PATH.test(c.req.path));
    app.use('/v1/*', (c, next) => {
      if (isRawUpload(c)) return next();
      const isWrite = c.req.method === 'POST' || c.req.method === 'PUT';
      return isWrite && (capabilityWrite.test(c.req.path) || /^\/v1\/(?:platform\/)?policy\//.test(c.req.path)) ? capabilityBody(c, next) : smallBody(c, next);
    });
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
    const config = configPublisher(store, opts.dataDir, now, opts.masterKey);
    const projection = opts.routingProjection ? routingProjector(store, opts.routingProjection, now) : undefined;
    const management = { ...opts, now,
      onConfigChange: (id?: string) => { void pending.track(config.changed(id)); },
      onBalanceChange: (id: string) => { void pending.track(config.balanceChanged(id)); },
    };
    authRoutes(app, store, management);
    personalLoginTokenRoutes(app, store, management);
    tenantRoutes(app, store, management);
    platformRoutes(app, store, management);
    modelPoolRoutes(app, store, management);
    procurementRoutes(app, store, management);
    inputMultiplierRoutes(app, store, management);
    rolloutRoutes(app, store, management, opts.presence);
    capabilityRoutes(app, store, management);
    policyRoutes(app, store, management);
    upstreamRoutes(app,store,management);
    commerceRoutes(app,store,management);
    policyDiscountRoutes(app, store, management);
    agentArtifactRoutes(app, store, management);
    toolReleaseRoutes(app, store, management);
    billingRoutes(app, store, management);
    const observation = observationRoutes(app, store, now);
    closeStatistics = statisticsRoutes(app, store, { ...opts, now, pending });
    const diag = diagRoutes(app, store, management, opts.objectStorage);
    deviceRoutes(app, store, management, diag);
    desktopReleaseRoutes(app, store, management);
    closeReleases = serverReleaseRoutes(app, store, management);
    const closeSockets = edgeGateway(app, store, opts.presence, now, opts.heartbeatMs, config, pending, observation.publish, diag, projection);
    let shuttingDown = false;
    const server = Bun.serve({ hostname: opts.hostname, port: opts.port,
      fetch: (request, server) => shuttingDown ? new Response(null, { status: 503 }) : pending.track(Promise.resolve(app.fetch(request, server))),
      websocket: { ...websocket, maxPayloadLength: 4 * 1024 * 1024, idleTimeout: 0, sendPings: false },
      // Each raw upload route applies its own cap. Other routes remain limited to small JSON requests.
      maxRequestBodySize: DESKTOP_ARTIFACT_MAX_BYTES,
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
    let settlingDiscounts = false;
    const closeDiscounts = () => {
      if (settlingDiscounts || shuttingDown) return;
      settlingDiscounts = true;
      const at = now();
      void pending.track((async () => {
        for (const { id } of store.system.all<{ id: string }>('SELECT id FROM tenants ORDER BY id')) {
          if (shuttingDown) break;
          try {
            await store.tenant(id).write(sql=>purgeExpiredContent(sql,at));
            if (await settleUnclosedDiscountMonths(store, id, at)) await config.balanceChanged(id);
          } catch {
            console.warn('OneX could not close monthly policy discounts', { tenant_id: id });
          }
        }
      })().finally(() => { settlingDiscounts = false; }));
    };
    const discountInterval = setInterval(closeDiscounts, 3_600_000);
    discountInterval.unref();
    closeDiscounts();
    let closing: Promise<void> | undefined;
    return {
      server, store, projection,
      close() {
        return closing ??= (async () => {
          shuttingDown = true;
          if (retention) clearInterval(retention);
          clearInterval(discountInterval);
          // Bun 1.3.5 can retain the WS count after a server-initiated close.
          void server.stop().catch(() => {});
          observation.close();
          await closeSockets();
          closeStatistics?.();
          await pending.drain();
          await store.drain();
          opts.presence.close?.();
          closeReleases?.();
          store.close();
        })();
      },
    };
  } catch (error) {
    closeStatistics?.();
    closeReleases?.();
    store.close();
    throw error;
  }
}
