import { createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ulid } from 'ulid';
import { iso } from './credentials';
import { decryptProviderSecret } from './provider-secret';
import type { Store } from './store';

const prefix = Buffer.from('302a300506032b656e032100', 'hex');
const info = Buffer.from('onex-edge-secret-v1');
type Subscription = { tenant: string; live: () => boolean; send: (value: Record<string, unknown>) => void };
type RouteRow = { model_id: string; route_model: string | null; upstream_model: string; provider_id: string; protocol: string;
  base_url: string; auth: string | null; proxy: string | null };
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

export function configPublisher(store: Store, now: () => number, masterKey?: Uint8Array) {
  const online = new Map<string, Subscription>();
  async function publish(device: string, sub: Subscription) {
    const revision = await store.system.write((sql) => sql.get<{ revision: number }>(
      'UPDATE edge_config_counter SET revision = revision + 1 WHERE id = 1 RETURNING revision')!.revision);
    if (online.get(device) !== sub || !sub.live()) return;
    const tenantActive = store.system.get<{ active: number }>("SELECT 1 AS active FROM tenants WHERE id = ? AND status = 'active'", [sub.tenant]);
    const db = store.tenant(sub.tenant);
    const participant = tenantActive && db.get<Participant>(`SELECT d.os, d.arch, d.public_key FROM devices d JOIN members m ON m.user_id = d.user_id
      WHERE d.id = ? AND d.status = 'active' AND d.token_expires_at > ? AND m.status = 'active'`, [device, iso(now())]);
    const contract = participant && db.get<{ allowed_models_json: string; allowed_agents_json: string; lease_budget_milli: number }>(
      'SELECT allowed_models_json, allowed_agents_json, lease_budget_milli FROM contract ORDER BY revision DESC LIMIT 1');
    if (!participant) {
      sub.send({ type: 'cutoff', id: `msg_${ulid()}`, reason: 'disabled' });
      return;
    }
    const allowedModels = contract && contract.lease_budget_milli > 0 ? contract.allowed_models_json : '[]';
    const allowedAgents = contract && contract.lease_budget_milli > 0 ? contract.allowed_agents_json : '[]';
    const at = iso(now());
    const candidates = store.system.all<RouteRow>(`SELECT m.id AS model_id, m.route_model, m.upstream_name AS upstream_model,
      p.id AS provider_id, p.protocol, p.base_url, p.auth, p.proxy FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.status = 'active' AND p.status = 'active' AND p.protocol = 'anthropic'
      AND m.id IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM rates r WHERE r.model_id = m.id AND r.effective_from <= ?) ORDER BY m.id`, [allowedModels, at]);
    const routes = candidates.map(({ route_model, auth, proxy, ...row }) => ({ ...row, model: route_model ?? row.upstream_model,
      auth: auth ?? 'x_api_key', ...(proxy && { proxy }) }));
    const rates = routes.map(({ model_id }) => store.system.get(`SELECT model_id, input_milli_per_mtok, output_milli_per_mtok,
      cache_read_milli_per_mtok, cache_write_milli_per_mtok, effective_from FROM rates WHERE model_id = ? AND effective_from <= ?
      ORDER BY effective_from DESC LIMIT 1`, [model_id, at])!);
    const agents = store.system.all(`SELECT id, agent, version, os, arch, url, sha256, size FROM agent_releases
      WHERE status = 'active' AND os = ? AND arch = ? AND agent IN (SELECT value FROM json_each(?)) ORDER BY id`,
      [participant.os, participant.arch, allowedAgents]);
    sub.send({ type: 'config', id: `msg_${ulid()}`, revision, routes, rates, agents });
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
