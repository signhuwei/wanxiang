import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MAX_RELEASE_BYTES = 256 * 1024 * 1024;
export const DOCKER_RELEASE_FORMAT = 'docker-archive-age-v1';
export const DOCKER_RELEASE_PLATFORM = 'linux/arm64';
export const commitPattern = /^[0-9a-f]{40}$/;
export const digestPattern = /^[0-9a-f]{64}$/;
export const imageIdPattern = /^sha256:[0-9a-f]{64}$/;
export type ServerReleaseFormat = typeof DOCKER_RELEASE_FORMAT;

type ReleaseArtifact = { commit: string; sha256: string; size: number };
type LegacyReleaseArtifact = ReleaseArtifact & { format?: null; platform?: null; image_id?: null };
type DockerReleaseArtifact = ReleaseArtifact & {
  format: ServerReleaseFormat;
  platform: typeof DOCKER_RELEASE_PLATFORM;
  image_id: string;
};
type UnsignedServerManifest = LegacyReleaseArtifact | DockerReleaseArtifact;
export type DockerServerManifest = DockerReleaseArtifact & { signature: string };
export type ServerManifest = UnsignedServerManifest & { signature: string };

export function manifestBytes(manifest: UnsignedServerManifest) {
  const { commit, sha256, size } = manifest;
  if (manifest.format === DOCKER_RELEASE_FORMAT) {
    const { format, platform, image_id } = manifest;
    return Buffer.from(`onex-server-release-v2\n${commit}\n${sha256}\n${size}\n${format}\n${platform}\n${image_id}\n`);
  }
  return Buffer.from(`onex-server-release-v1\n${commit}\n${sha256}\n${size}\n`);
}

export function isManifest(value: unknown): value is ServerManifest {
  if (value === null || typeof value !== 'object') return false;
  const { commit, sha256, size, signature, format, platform, image_id } = value as Record<string, unknown>;
  if (typeof commit !== 'string' || !commitPattern.test(commit)
    || typeof sha256 !== 'string' || !digestPattern.test(sha256)
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_RELEASE_BYTES
    || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  if (format == null) return platform == null && image_id == null;
  return format === DOCKER_RELEASE_FORMAT && platform === DOCKER_RELEASE_PLATFORM
    && typeof image_id === 'string' && imageIdPattern.test(image_id);
}

export function isDockerManifest(value: unknown): value is DockerServerManifest {
  return isManifest(value) && value.format === DOCKER_RELEASE_FORMAT;
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

export function signManifest<T extends UnsignedServerManifest>(key: KeyObject, manifest: T): T & { signature: string } {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Use an Ed25519 Server release signing key');
  return { ...manifest, signature: sign(null, manifestBytes(manifest), key).toString('base64url') };
}
