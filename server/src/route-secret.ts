import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { canonical, digest } from './routing-http';

/**
 * Route-pool inference secret envelopes (routing-pricing-and-staging.md, device staging).
 * X25519 sender ephemeral key in `key_id`, empty HKDF salt, 32-byte HKDF-SHA256 key, 24-byte nonce,
 * XChaCha20-Poly1305 with the 16-byte tag appended, RFC 4648 standard base64.
 * Not wired to the live WS path: route_pool.v1 stays unnegotiated until the activation batch.
 */
export const ROUTE_SECRET_INFO = 'onex-edge-route-secret-v1';
const spki = Buffer.from('302a300506032b656e032100', 'hex');
const pkcs8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const asciiId = /^[A-Za-z0-9_.-]{1,128}$/;

export type RouteSecretContext = {
  tenant_id: string; device_id: string; projection_id: string; revision: number; credential_id: string; credential_version: number;
};
export type RouteSecretEnvelope = { credential_id: string; credential_version: number; key_id: string; nonce: string; ciphertext: string };
export type RouteSecretMaterial = { purpose: string; material_class: string; plaintext: Uint8Array };

export class RouteSecretError extends Error {
  constructor(readonly code: 'invalid_config' | 'missing_route_credential' | 'management_credential_forbidden', readonly reason: string,
    readonly detail: Record<string, unknown> = {}) { super(reason); }
}

function context(value: RouteSecretContext) {
  for (const key of ['tenant_id', 'device_id', 'projection_id', 'credential_id'] as const) {
    if (typeof value[key] !== 'string' || !asciiId.test(value[key])) throw new RouteSecretError('invalid_config', `invalid_${key}`);
  }
  for (const key of ['revision', 'credential_version'] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new RouteSecretError('invalid_config', `invalid_${key}`);
  }
  return value;
}

/** Compact UTF-8 JSON array; revision and version are JSON numbers. */
export function routeSecretAad(value: RouteSecretContext) {
  const c = context(value);
  return Buffer.from(JSON.stringify([ROUTE_SECRET_INFO, c.tenant_id, c.device_id, c.projection_id, c.revision, c.credential_id, c.credential_version]), 'utf8');
}

function publicKey(raw: string | Uint8Array): KeyObject {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'base64') : Buffer.from(raw);
  if (bytes.length !== 32 || (typeof raw === 'string' && bytes.toString('base64') !== raw)) throw new RouteSecretError('invalid_config', 'invalid_public_key');
  return createPublicKey({ key: Buffer.concat([spki, bytes]), format: 'der', type: 'spki' });
}
function privateKey(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new RouteSecretError('invalid_config', 'invalid_private_key');
  return createPrivateKey({ key: Buffer.concat([pkcs8, Buffer.from(raw)]), format: 'der', type: 'pkcs8' });
}
export function x25519PublicKey(privateRaw: Uint8Array) {
  return createPublicKey(privateKey(privateRaw)).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
}
function derive(own: KeyObject, peer: KeyObject) {
  const shared = diffieHellman({ privateKey: own, publicKey: peer });
  try { return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(ROUTE_SECRET_INFO, 'utf8'), 32)); }
  finally { shared.fill(0); }
}

/** Seals one inference secret for one device configuration identity. Management material is refused. */
export function sealRouteSecret(input: { recipient_public_key: string; context: RouteSecretContext; material: RouteSecretMaterial },
  test: { ephemeral_private_key?: Uint8Array; nonce?: Uint8Array } = {}): RouteSecretEnvelope {
  const { material } = input;
  if (material.purpose !== 'inference' || material.material_class !== 'inference') {
    throw new RouteSecretError('management_credential_forbidden', 'non_inference_material',
      { credential_id: input.context.credential_id, credential_version: input.context.credential_version });
  }
  const aad = routeSecretAad(input.context);
  const ephemeral = test.ephemeral_private_key ? privateKey(test.ephemeral_private_key) : generateKeyPairSync('x25519').privateKey;
  const nonce = test.nonce ? Buffer.from(test.nonce) : randomBytes(24);
  if (nonce.length !== 24) throw new RouteSecretError('invalid_config', 'invalid_nonce');
  const key = derive(ephemeral, publicKey(input.recipient_public_key));
  try {
    const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(material.plaintext);
    return {
      credential_id: input.context.credential_id, credential_version: input.context.credential_version,
      key_id: createPublicKey(ephemeral).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
      nonce: nonce.toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64'),
    };
  } finally { key.fill(0); }
}

/** Test and staging counterpart: opens an envelope with the device private key, or throws. */
export function openRouteSecret(recipientPrivateKey: Uint8Array, value: Omit<RouteSecretContext, 'credential_id' | 'credential_version'>,
  envelope: RouteSecretEnvelope) {
  const aad = routeSecretAad({ ...value, credential_id: envelope.credential_id, credential_version: envelope.credential_version });
  const nonce = Buffer.from(envelope.nonce, 'base64');
  if (nonce.length !== 24 || nonce.toString('base64') !== envelope.nonce) throw new RouteSecretError('invalid_config', 'invalid_nonce');
  const key = derive(privateKey(recipientPrivateKey), publicKey(envelope.key_id));
  try {
    return Buffer.from(xchacha20poly1305(key, nonce, aad).decrypt(Buffer.from(envelope.ciphertext, 'base64')));
  } catch (error) {
    if (error instanceof RouteSecretError) throw error;
    throw new RouteSecretError('missing_route_credential', 'envelope_open_failed', { credential_id: envelope.credential_id });
  } finally { key.fill(0); }
}

type RouteConfig = {
  revision: number; id?: string; policy?: { tenant_id?: string; device_id?: string };
  routes: { credential_ref?: { credential_id: string; credential_version: number } }[];
  route_pool: { projection_id: string; revocation_revision: number; secrets: RouteSecretEnvelope[] } & Record<string, unknown>;
} & Record<string, unknown>;

/** Distinct (credential_id, credential_version) referenced by routes, in a stable order. */
function routeCredentialRefs(config: RouteConfig) {
  const refs = new Map<string, { credential_id: string; credential_version: number }>();
  for (const route of config.routes) {
    const ref = route.credential_ref;
    if (!ref) throw new RouteSecretError('missing_route_credential', 'route_without_credential_ref');
    refs.set(JSON.stringify([ref.credential_id, ref.credential_version]), { credential_id: ref.credential_id, credential_version: ref.credential_version });
  }
  return [...refs.values()].sort((a, b) => a.credential_id < b.credential_id ? -1 : a.credential_id > b.credential_id ? 1
    : a.credential_version - b.credential_version);
}

/**
 * Seals exactly one envelope per distinct (credential_id, credential_version) referenced by routes.
 * The configuration's own tenant and device must be the sealing target. A missing or non-inference
 * material rejects the whole configuration.
 */
export function sealRoutePoolConfig<T extends RouteConfig>(config: T, target: { tenant_id: string; device_id: string; recipient_public_key: string },
  material: (credential_id: string, credential_version: number) => RouteSecretMaterial | null): T {
  if (config.policy?.tenant_id !== target.tenant_id || config.policy?.device_id !== target.device_id) {
    throw new RouteSecretError('invalid_config', 'seal_target_mismatch', { tenant_id: target.tenant_id, device_id: target.device_id });
  }
  const secrets = routeCredentialRefs(config).map((ref) => {
    const found = material(ref.credential_id, ref.credential_version);
    if (!found) throw new RouteSecretError('missing_route_credential', 'missing_material', ref);
    return sealRouteSecret({ recipient_public_key: target.recipient_public_key, material: found,
      context: { tenant_id: target.tenant_id, device_id: target.device_id, projection_id: config.route_pool.projection_id, revision: config.revision, ...ref } });
  });
  return { ...config, route_pool: { ...config.route_pool, secrets } };
}

/**
 * Business digest of a projection. The secrets list is rebuilt from the routes' distinct credential
 * references, so the frame id and the actual envelopes (count, key_id, nonce, ciphertext) never affect it;
 * whether envelopes are complete is checked separately when staging.
 */
export function routeProjectionDigest(config: RouteConfig) {
  const { id: _, ...rest } = config;
  return digest(canonical({ ...rest, route_pool: { ...config.route_pool, secrets: routeCredentialRefs(config) } }));
}

export type ProjectionIdentity = { revision: number; projection_id: string; digest: string; revocation_revision: number };
export type ProjectionDecision =
  | { result: 'new' | 'same'; identity: ProjectionIdentity }
  | { result: 'rejected'; error: { code: 'conflict' | 'invalid_config'; detail: { reason: string } } };

/** Compares an incoming projection with the last one accepted for the same device. */
export function compareProjection(previous: ProjectionIdentity | null, config: RouteConfig): ProjectionDecision {
  const identity = { revision: config.revision, projection_id: config.route_pool.projection_id, digest: routeProjectionDigest(config),
    revocation_revision: config.route_pool.revocation_revision };
  const reject = (code: 'conflict' | 'invalid_config', reason: string): ProjectionDecision => ({ result: 'rejected', error: { code, detail: { reason } } });
  if (!previous) return { result: 'new', identity };
  if (identity.revision < previous.revision) return reject('conflict', 'stale_revision');
  if (identity.revocation_revision < previous.revocation_revision) return reject('invalid_config', 'revocation_regressed');
  if (identity.revision === previous.revision) {
    if (identity.projection_id !== previous.projection_id) return reject('conflict', 'projection_changed');
    if (identity.digest !== previous.digest) return reject('conflict', 'projection_content_changed');
    return { result: 'same', identity };
  }
  return { result: 'new', identity };
}
