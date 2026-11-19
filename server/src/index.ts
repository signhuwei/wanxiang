import { randomToken } from './credentials';
import { MemoryPresence, ValkeyPresence } from './presence';
import { createServer } from './server';
import { masterKeyFromEnv } from './provider-secret';

const env = process.env;
const dev = env.NODE_ENV !== 'production';
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
try {
  if (presence instanceof ValkeyPresence) await presence.connect();
  else console.warn('OneX: development-only in-memory presence; set ONEX_VALKEY_URL for Valkey');
  const app = await createServer({
    dataDir: env.ONEX_DATA_DIR ?? '.local', hostname: env.ONEX_HOST ?? '127.0.0.1',
    port: integer('ONEX_PORT', 3000, 0, 65_535), tenantCacheSize: integer('ONEX_TENANT_CACHE_SIZE', 16, 1, 1_000),
    heartbeatMs: 15_000, commit: env.ONEX_COMMIT ?? 'unknown', codeSecret, masterKey, presence,
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
