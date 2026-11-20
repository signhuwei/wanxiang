import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MAX_RELEASE_BYTES = 256 * 1024 * 1024;
export const commitPattern = /^[0-9a-f]{40}$/;
export const digestPattern = /^[0-9a-f]{64}$/;
export type ServerManifest = { commit: string; sha256: string; size: number; signature: string };

export function manifestBytes({ commit, sha256, size }: Omit<ServerManifest, 'signature'>) {
  return Buffer.from(`onex-server-release-v1\n${commit}\n${sha256}\n${size}\n`);
}

export function isManifest(value: Record<string, unknown>): value is ServerManifest {
  return typeof value.commit === 'string' && commitPattern.test(value.commit)
    && typeof value.sha256 === 'string' && digestPattern.test(value.sha256)
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_RELEASE_BYTES
    && typeof value.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value.signature);
}

export function releaseKey(path: string | undefined) {
  if (!path) return;
  try {
    const key = createPublicKey(readFileSync(path));
    if (key.asymmetricKeyType === 'ed25519') return key;
  } catch { /* a missing or invalid deployment key leaves upgrades disabled */ }
}

export function verifyManifest(key: KeyObject, manifest: ServerManifest) {
  return verify(null, manifestBytes(manifest), key, Buffer.from(manifest.signature, 'base64url'));
}

export function signManifest(key: KeyObject, manifest: Omit<ServerManifest, 'signature'>): ServerManifest {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Use an Ed25519 Server release signing key');
  return { ...manifest, signature: sign(null, manifestBytes(manifest), key).toString('base64url') };
}
