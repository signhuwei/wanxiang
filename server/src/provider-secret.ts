import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function masterKeyFromEnv(value: string | undefined) {
  if (value === undefined) return;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('ONEX_MASTER_KEY must be 32 bytes in standard base64');
  return key;
}

export function encryptProviderSecret(key: Uint8Array, providerId: string, value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(providerId));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptProviderSecret(key: Uint8Array, providerId: string, value: Uint8Array) {
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
  decipher.setAAD(Buffer.from(providerId));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
}
