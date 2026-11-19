import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { day, hash, iso, randomToken } from '../../server/src/credentials';
import { MemoryPresence } from '../../server/src/presence';
import { encryptProviderSecret } from '../../server/src/provider-secret';
import { seedTenant } from '../../server/src/seed';
import { createServer } from '../../server/src/server';
import { indexDevice } from '../../server/src/store';

const [directory, upstream] = Bun.argv.slice(2);
const url = upstream && URL.parse(upstream);
if (!directory || !url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) {
  throw new Error('Usage: bun tests/e2e/lease-server.ts <empty-data-dir> <http://127.0.0.1:port>');
}
const data_dir = resolve(directory);
if (readdirSync(data_dir).length) throw new Error('Use a new empty test directory');
const masterKey = randomBytes(32);
const app = await createServer({ dataDir: data_dir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 1,
  heartbeatMs: 15_000, commit: 'lease-test', codeSecret: randomToken(), masterKey, presence: new MemoryPresence() });
try {
  const { tenantId: tenant_id, userId } = await seedTenant(app.store, { target: 'lease@example.test' });
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const device_private_key = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');
  const device_id = 'dev_lease_fixture';
  const device_token = randomToken();
  const token_hash = hash(device_token);
  const provider_id = 'prv_lease_fixture';
  const model_id = 'mod_lease_fixture';
  const model = 'fixture-model';
  const at = iso(Date.now());
  await app.store.system.write((sql) => {
    sql.run(`INSERT INTO providers (id, name, protocol, base_url, secret_ciphertext, status, proxy)
      VALUES (?, 'fake', 'anthropic', ?, ?, 'active', 'none')`, [provider_id, url.href, encryptProviderSecret(masterKey, provider_id, 'fake-key')]);
    sql.run(`INSERT INTO models (id, provider_id, upstream_name, display_name, context_window, status)
      VALUES (?, ?, ?, ?, 100000, 'active')`, [model_id, provider_id, model, model]);
    sql.run(`INSERT INTO rates (model_id, input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok,
      cache_write_milli_per_mtok, effective_from) VALUES (?, 1000000, 1000000, 0, 0, ?)`, [model_id, at]);
  });
  await app.store.tenant(tenant_id).write((sql) => {
    sql.run(`UPDATE contract SET allowed_models_json = ?, lease_budget_milli = 100 WHERE revision = 1`, [JSON.stringify([model_id])]);
    sql.run(`INSERT INTO ledger (id, kind, amount_milli, at) VALUES ('led_fixture', 'topup', 10000, ?)`, [at]);
    sql.run(`INSERT INTO devices (id, user_id, name, os, arch, public_key, token_hash, token_expires_at, status)
      VALUES (?, ?, 'Fixture Edge', 'darwin', 'arm64', ?, ?, ?, 'active')`,
    [device_id, userId, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'), token_hash, iso(Date.now() + day)]);
  });
  await app.store.system.write((sql) => indexDevice(sql, tenant_id, { id: device_id, token_hash }));
  const quit = () => { void app.close(); };
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  console.log(JSON.stringify({ port: app.server.port, tenant_id, device_id, device_token, device_private_key, model_id, model, data_dir }));
} catch (error) {
  await app.close();
  throw error;
}
