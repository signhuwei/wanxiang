// Prints the shared p0 config with real route_pool.secrets sealed by the Server sealer, for Edge staging checks.
// Synthetic keys only: device private key 0x07 x32 (contract vector). Never use with production material.
//   bun tests/e2e/routing/seal-sample.ts > /tmp/p0-config-91.sealed.json
import fixture from '../../fixtures/routing/p0-ab.json';
import { sealRoutePoolConfig, x25519PublicKey } from '../../../server/src/route-secret';

const devicePrivate = new Uint8Array(32).fill(7);
const plaintext: Record<string, string> = { 'cred_a@1': 'fixture-inference-key', 'cred_b@2': 'fixture-inference-key-b' };
const config = sealRoutePoolConfig(JSON.parse(JSON.stringify(fixture.wire.config)),
  { tenant_id: fixture.wire.welcome.tenant_id, device_id: fixture.wire.welcome.device_id, recipient_public_key: x25519PublicKey(devicePrivate) },
  (id, version) => {
    const value = plaintext[`${id}@${version}`];
    return value ? { purpose: 'inference', material_class: 'inference', plaintext: Buffer.from(value) } : null;
  });
console.log(JSON.stringify({ device_private_key_hex: Buffer.from(devicePrivate).toString('hex'), device_public_key: x25519PublicKey(devicePrivate),
  plaintext, config }, null, 2));
