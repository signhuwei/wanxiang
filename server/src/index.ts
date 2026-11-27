import { randomToken } from './credentials';
import { RustfsObjectStorage } from './object-storage';
import { MemoryPresence, ValkeyPresence } from './presence';
import { createServer } from './server';
import { masterKeyFromEnv } from './provider-secret';
import { configuredRoutePoolDevices } from './route-production';
import { DOCKER_RELEASE_FORMAT } from './release-package';

const env = process.env;
const dev = env.NODE_ENV !== 'production';
const releaseFormat = env.ONEX_RELEASE_FORMAT || undefined;
if (releaseFormat !== undefined && releaseFormat !== DOCKER_RELEASE_FORMAT) throw new Error('Invalid ONEX_RELEASE_FORMAT');
function integer(name: string, fallback: number, min: number, max: number) {
  const val = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(val) || val < min || val > max) throw new Error(`Invalid ${name}`);
  return val;
}

const configuredSecret = env.ONEX_AUTH_SECRET;
if (configuredSecret !== undefined && configuredSecret.length < 32) throw new Error('ONEX_AUTH_SECRET must contain at least 32 characters');
const masterKey = masterKeyFromEnv(env.ONEX_MASTER_KEY);
if (!dev && (!configuredSecret || !env.ONEX_VALKEY_URL || !masterKey)) throw new Error('Production requires ONEX_AUTH_SECRET, ONEX_VALKEY_URL and ONEX_MASTER_KEY');
const codeSecret = configuredSecret ?? randomToken();
const presence = env.ONEX_VALKEY_URL ? new ValkeyPresence(env.ONEX_VALKEY_URL) : new MemoryPresence();
// RustFS 只绑回环，Server 和它同机：诊断日志的实际字节都经本进程转发，见 diag.ts 顶部注释。
// deploy/run-service.sh 从既有的 secrets/rustfs.key 读取访问凭据注入这三个变量，不打印明文。
const objectStorage = env.ONEX_RUSTFS_ENDPOINT && env.ONEX_RUSTFS_ACCESS_KEY && env.ONEX_RUSTFS_SECRET_KEY
  ? new RustfsObjectStorage({ endpoint: env.ONEX_RUSTFS_ENDPOINT, bucket: env.ONEX_RUSTFS_BUCKET ?? 'onex-diag',
    accessKeyId: env.ONEX_RUSTFS_ACCESS_KEY, secretAccessKey: env.ONEX_RUSTFS_SECRET_KEY })
  : undefined;
// CONTRACT-PENDING: diagnostics is new; unlike Valkey/the master key this is not yet a hard production
// requirement so an existing deployment without RustFS env vars still starts. Diag requests fail with
// `internal` (see diag.ts) until ONEX_RUSTFS_* is set.
if (!objectStorage) console.warn('OneX: no RustFS configured; device diagnostics will report an internal error');
try {
  if (presence instanceof ValkeyPresence) await presence.connect();
  else console.warn('OneX: development-only in-memory presence; set ONEX_VALKEY_URL for Valkey');
  const app = await createServer({
    dataDir: env.ONEX_DATA_DIR ?? '.local', hostname: env.ONEX_HOST ?? '127.0.0.1',
    port: integer('ONEX_PORT', 3000, 0, 65_535), tenantCacheSize: integer('ONEX_TENANT_CACHE_SIZE', 16, 1, 1_000),
    heartbeatMs: 15_000, commit: env.ONEX_COMMIT ?? 'unknown', codeSecret, masterKey, presence, objectStorage,
    routePoolDevices: configuredRoutePoolDevices(env.ONEX_ROUTE_POOL_DEVICES),
    releaseRuntime: env.ONEX_RELEASE_PUBLIC_KEY && env.ONEX_RELEASE_HEARTBEAT
      ? { publicKeyPath: env.ONEX_RELEASE_PUBLIC_KEY, heartbeatPath: env.ONEX_RELEASE_HEARTBEAT, format: releaseFormat } : undefined,
    releaseMaintenanceFile: releaseFormat === DOCKER_RELEASE_FORMAT ? env.ONEX_RELEASE_MAINTENANCE_FILE : undefined,
    deliverCode: dev ? (target, code) => console.info(`[onex-dev] login code for ${target}: ${code}`) : undefined,
  });
  const shutdown = () => {
    void app.close().catch((error) => { console.error('OneX shutdown failed', error); process.exitCode = 1; });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.info(`OneX Server listening on ${app.server.url}`);
} catch (error) {
  presence.close();
  throw error;
}
