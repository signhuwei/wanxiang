import { createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const prefix = Buffer.from('302a300506032b656e032100', 'hex');
const info = Buffer.from('onex-edge-secret-v1');

export function encryptEdgeSecret(publicKey: string, context: string, plaintext: Uint8Array) {
  // The wire key_id is the sender's ephemeral X25519 public key.
  const raw = Buffer.from(publicKey, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== publicKey) throw new Error('Invalid X25519 public key');
  const remote = createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: remote });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
  try {
    const nonce = randomBytes(24);
    const ciphertext = xchacha20poly1305(key, nonce, Buffer.from(context)).encrypt(plaintext);
    return {
      key_id: ephemeral.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
      nonce: nonce.toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64'),
    };
  } finally {
    shared.fill(0);
    key.fill(0);
  }
}
