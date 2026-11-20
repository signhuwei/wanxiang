import { createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ulid } from 'ulid';
import { iso } from './credentials';
import { allowedAgentReleases, artifactDownloadPath, hasPinnedAgentTarget } from './agent-catalog';
import { decryptProviderSecret } from './provider-secret';
import type { Store } from './store';

const prefix = Buffer.from('302a300506032b656e032100', 'hex');
const info = Buffer.from('onex-edge-secret-v1');
type Subscription = { tenant: string; agentCache: boolean; live: () => boolean; send: (value: Record<string, unknown>) => void };
type RouteRow = { model_id: string; route_model: string | null; upstream_model: string; provider_id: string; protocol: string;
  base_url: string; auth: string | null; proxy: string | null; name: string;
  input_milli_per_mtok: number; output_milli_per_mtok: number; cache_read_milli_per_mtok: number;
  cache_write_milli_per_mtok: number; effective_from: string };
type Participant = { os: string; arch: string; public_key: string | null };

export function encryptEdgeSecret(publicKey: string, providerId: string, plaintext: Uint8Array) {
  // The wire key_id is the sender's ephemeral X25519 public key.
  const raw = Buffer.from(publicKey, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== publicKey) throw new Error('Invalid X25519 public key');
  const remote = createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: remote });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
  try {
    const nonce = randomBytes(24);
    const ciphertext = xchacha20poly1305(key, nonce, Buffer.from(providerId)).encrypt(plaintext);
    return {
      key_id: ephemeral.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
      nonce: nonce.toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64'),
    };
  } finally {
    shared.fill(0);
    key.fill(0);
  }
}

export function effectiveModelConfig(store: Store, contract: { allowed_models_json: string; lease_budget_milli: number } | null, now: number) {
  const allowed = contract && contract.lease_budget_milli > 0 ? contract.allowed_models_json : '[]';
  const rows = store.system.all<RouteRow>(`SELECT m.id AS model_id, m.route_model, m.upstream_name AS upstream_model,
    m.display_name AS name, p.id AS provider_id, p.protocol, p.base_url, p.auth, p.proxy,
    r.input_milli_per_mtok, r.output_milli_per_mtok, r.cache_read_milli_per_mtok, r.cache_write_milli_per_mtok, r.effective_from
    FROM models m JOIN providers p ON p.id = m.provider_id
    JOIN rates r ON r.model_id = m.id AND r.effective_from = (
      SELECT max(r2.effective_from) FROM rates r2 WHERE r2.model_id = m.id AND r2.effective_from <= ?
    ) WHERE m.status = 'active' AND p.status = 'active' AND p.protocol IN ('anthropic', 'openai_chat')
    AND m.id IN (SELECT value FROM json_each(?)) ORDER BY m.id`, [iso(now), allowed]);
  const routes = rows.map(({ model_id, route_model, upstream_model, provider_id, protocol, base_url, auth, proxy }) =>
    ({ model_id, model: route_model ?? upstream_model, upstream_model, provider_id, protocol, base_url,
      auth: auth ?? (protocol === 'anthropic' ? 'x_api_key' : 'bearer'), ...(proxy && { proxy }) }));
  const rates = rows.map(({ model_id, input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok,
    cache_write_milli_per_mtok, effective_from }) =>
    ({ model_id, input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok, cache_write_milli_per_mtok, effective_from }));
  const models = rows.map((row, i) => ({ model_id: row.model_id, name: row.name, model: routes[i]!.model,
    provider_id: row.provider_id, protocol: row.protocol, rate: rates[i]! }));
  return { routes, rates, models };
}

export function configPublisher(store: Store, dataDir: string, now: () => number, masterKey?: Uint8Array) {
  const online = new Map<string, Subscription>();
  async function publish(device: string, sub: Subscription) {
    const revision = await store.system.write((sql) => sql.get<{ revision: number }>(
      'UPDATE edge_config_counter SET revision = revision + 1 WHERE id = 1 RETURNING revision')!.revision);
    if (online.get(device) !== sub || !sub.live()) return;
    const tenantActive = store.system.get<{ active: number }>("SELECT 1 AS active FROM tenants WHERE id = ? AND status = 'active'", [sub.tenant]);
    const db = store.tenant(sub.tenant);
    const participant = tenantActive && db.get<Participant>(`SELECT d.os, d.arch, d.public_key FROM devices d JOIN members m ON m.user_id = d.user_id
      WHERE d.id = ? AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`, [device, iso(now())]);
    const contract = participant && db.get<{ allowed_models_json: string; allowed_agents_json: string; agent_release_pins_json: string; lease_budget_milli: number }>(
      'SELECT allowed_models_json, allowed_agents_json, agent_release_pins_json, lease_budget_milli FROM contract ORDER BY revision DESC LIMIT 1');
    if (!participant) {
      sub.send({ type: 'cutoff', id: `msg_${ulid()}`, reason: 'disabled' });
      return;
    }
    if (!sub.agentCache && hasPinnedAgentTarget(contract || null, participant.os, participant.arch)) {
      // Legacy Edge permits launching an arbitrary local Claude. A fixed version requires a client that enforces it.
      sub.send({ type: 'config', id: `msg_${ulid()}`, revision, routes: [], rates: [], agents: [] });
      sub.send({ type: 'cutoff', id: `msg_${ulid()}`, reason: 'contract' });
      return;
    }
    const { routes, rates } = effectiveModelConfig(store, contract || null, now());
    const agents = allowedAgentReleases(store, dataDir, contract || null, participant.os, participant.arch, sub.agentCache)
      .map(({ id, agent, version, os, arch, url, sha256, size }) => ({
        id, agent, version, os, arch, url: sub.agentCache ? artifactDownloadPath(id) : url, sha256, size,
      }));
    sub.send({ type: 'config', id: `msg_${ulid()}`, revision, routes, rates, agents, ...(sub.agentCache && { agent_cache: true }) });
    if (!contract || contract.lease_budget_milli <= 0) sub.send({ type: 'cutoff', id: `msg_${ulid()}`, reason: 'contract' });
    if (!participant.public_key || !masterKey) return;
    for (const providerId of new Set(routes.map((route) => route.provider_id))) {
      const provider = store.system.get<{ secret_ciphertext: Uint8Array }>('SELECT secret_ciphertext FROM providers WHERE id = ?', [providerId])!;
      let plaintext: Buffer | undefined;
      try {
        plaintext = decryptProviderSecret(masterKey, providerId, provider.secret_ciphertext);
        sub.send({ type: 'secret', id: `msg_${ulid()}`, provider_id: providerId, ...encryptEdgeSecret(participant.public_key, providerId, plaintext) });
      } catch {
        console.warn('OneX could not envelope a provider secret', { provider_id: providerId, device_id: device });
      } finally { plaintext?.fill(0); }
    }
  }

  function send(device: string, sub: Subscription) {
    return publish(device, sub).catch(() => { console.error('OneX could not publish Edge configuration', { device_id: device }); });
  }
  return {
    connect(device: string, sub: Subscription) { online.set(device, sub); return send(device, sub); },
    disconnect(device: string, sub: Subscription) { if (online.get(device) === sub) online.delete(device); },
    async changed(tenant?: string) {
      await Promise.all([...online].filter(([, sub]) => !tenant || sub.tenant === tenant).map(([device, sub]) => send(device, sub)));
    },
  };
}

export type ConfigPublisher = ReturnType<typeof configPublisher>;
