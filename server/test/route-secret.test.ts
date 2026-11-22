import { expect, test } from 'bun:test';
import fixture from '../../tests/fixtures/routing/p0-ab.json';
import { compareProjection, openRouteSecret, routeProjectionDigest, routeSecretAad, RouteSecretError, sealRoutePoolConfig, sealRouteSecret,
  x25519PublicKey, type RouteSecretMaterial } from '../src/route-secret';

// Synthetic keys only (contract cross-language vector).
const devicePrivate = new Uint8Array(32).fill(7);
const senderPrivate = new Uint8Array(32).fill(8);
const vectorNonce = Uint8Array.from({ length: 24 }, (_, i) => i);
const device = { tenant_id: 'ten_demo', device_id: 'dev_lin', recipient_public_key: x25519PublicKey(devicePrivate) };
const materials: Record<string, RouteSecretMaterial> = {
  'cred_a@1': { purpose: 'inference', material_class: 'inference', plaintext: Buffer.from('fixture-inference-key') },
  'cred_b@2': { purpose: 'inference', material_class: 'inference', plaintext: Buffer.from('fixture-inference-key-b') },
};
const lookup = (id: string, version: number) => materials[`${id}@${version}`] ?? null;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sealed = () => sealRoutePoolConfig(clone(fixture.wire.config), device, lookup);

test('matches the contract cross-language vector exactly', () => {
  const aad = routeSecretAad({ tenant_id: 'ten_demo', device_id: 'dev_lin', projection_id: 'prj_91', revision: 91, credential_id: 'cred_a', credential_version: 1 });
  expect(aad.toString('utf8')).toBe('["onex-edge-route-secret-v1","ten_demo","dev_lin","prj_91",91,"cred_a",1]');
  const envelope = sealRouteSecret({ recipient_public_key: device.recipient_public_key, material: materials['cred_a@1']!,
    context: { tenant_id: 'ten_demo', device_id: 'dev_lin', projection_id: 'prj_91', revision: 91, credential_id: 'cred_a', credential_version: 1 } },
  { ephemeral_private_key: senderPrivate, nonce: vectorNonce });
  expect(envelope).toEqual({ credential_id: 'cred_a', credential_version: 1, key_id: 'MdSras7slhE3kXA3k25gcW+sVzr+lNnahKgCBEjfwRI=',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX', ciphertext: 'fp1Fke4jFdKim93jA03oMTHhmAJmfFP4SJR5swErN1Rsv1DzXg==' });
  expect(openRouteSecret(devicePrivate, { tenant_id: 'ten_demo', device_id: 'dev_lin', projection_id: 'prj_91', revision: 91 }, envelope).toString())
    .toBe('fixture-inference-key');
});

test('seals one envelope per exact credential reference and keeps the projection digest of the sample', () => {
  const config = sealed();
  expect(config.route_pool.secrets.map(({ credential_id, credential_version }) => [credential_id, credential_version])).toEqual([['cred_a', 1], ['cred_b', 2]]);
  for (const envelope of config.route_pool.secrets) {
    expect(openRouteSecret(devicePrivate, { tenant_id: 'ten_demo', device_id: 'dev_lin', projection_id: 'prj_91', revision: 91 }, envelope))
      .toEqual(Buffer.from(lookup(envelope.credential_id, envelope.credential_version)!.plaintext));
  }
  const { route_pool, ...rest } = config;
  const { secrets: _, ...pool } = route_pool;
  const { route_pool: originalPool, ...original } = clone(fixture.wire.config);
  const { secrets: __, ...originalRest } = originalPool;
  expect(rest).toEqual(original);
  expect(pool).toEqual(originalRest);
  expect(routeProjectionDigest(config)).toBe(routeProjectionDigest(clone(fixture.wire.config)));

  // Two routes sharing a credential version still produce a single envelope.
  const shared = clone(fixture.wire.config);
  shared.routes[1]!.credential_ref = { credential_id: 'cred_a', credential_version: 1 };
  expect(sealRoutePoolConfig(shared, device, lookup).route_pool.secrets.map((row) => row.credential_id)).toEqual(['cred_a']);
});

test('reseal is the same projection; changed identity, content or revocation order is rejected', () => {
  const first = sealed();
  const accepted = compareProjection(null, first);
  expect(accepted.result).toBe('new');
  const previous = accepted.result === 'rejected' ? null : accepted.identity;
  const resealed = { ...sealed(), id: 'cfg91_resend' };
  expect(resealed.route_pool.secrets[0]!.ciphertext).not.toBe(first.route_pool.secrets[0]!.ciphertext);
  expect(resealed.route_pool.secrets[0]!.key_id).not.toBe(first.route_pool.secrets[0]!.key_id);
  expect(compareProjection(previous, resealed).result).toBe('same');

  const otherProjection = sealRoutePoolConfig({ ...clone(fixture.wire.config), route_pool: { ...clone(fixture.wire.config.route_pool), projection_id: 'prj_91b' } }, device, lookup);
  expect(compareProjection(previous, otherProjection)).toEqual({ result: 'rejected', error: { code: 'conflict', detail: { reason: 'projection_changed' } } });

  const rebound = clone(fixture.wire.config);
  rebound.route_pool.bindings[0]!.aliases = ['model-m', 'model-m-*'];
  expect(compareProjection(previous, sealRoutePoolConfig(rebound, device, lookup)))
    .toEqual({ result: 'rejected', error: { code: 'conflict', detail: { reason: 'projection_content_changed' } } });
  const repriced = clone(fixture.wire.config);
  repriced.rates[0]!.input_multiplier_ppm = 5_000_000;
  repriced.rates[0]!.input_milli_per_mtok = 5000;
  expect(compareProjection(previous, sealRoutePoolConfig(repriced, device, lookup)).result).toBe('rejected');
  const rotated = clone(fixture.wire.config);
  rotated.routes[1]!.credential_ref = { credential_id: 'cred_b', credential_version: 3 };
  materials['cred_b@3'] = materials['cred_b@2']!;
  expect(compareProjection(previous, sealRoutePoolConfig(rotated, device, lookup)).result).toBe('rejected');

  const regressed = clone(fixture.wire.config);
  regressed.revision = 92;
  regressed.route_pool.revocation_revision = 2;
  expect(compareProjection(previous, sealRoutePoolConfig(regressed, device, lookup)))
    .toEqual({ result: 'rejected', error: { code: 'invalid_config', detail: { reason: 'revocation_regressed' } } });
  const older = clone(fixture.wire.config);
  older.revision = 90;
  expect(compareProjection(previous, sealRoutePoolConfig(older, device, lookup)))
    .toEqual({ result: 'rejected', error: { code: 'conflict', detail: { reason: 'stale_revision' } } });
  const newer = clone(fixture.wire.config);
  newer.revision = 92;
  expect(compareProjection(previous, sealRoutePoolConfig(newer, device, lookup)).result).toBe('new');
});

test('another device, configuration identity or key cannot open an envelope', () => {
  const envelope = sealed().route_pool.secrets[0]!;
  const target = { tenant_id: 'ten_demo', device_id: 'dev_lin', projection_id: 'prj_91', revision: 91 };
  const fails = (fn: () => unknown) => expect(fn).toThrow(RouteSecretError);
  fails(() => openRouteSecret(devicePrivate, { ...target, device_id: 'dev_other' }, envelope));
  fails(() => openRouteSecret(devicePrivate, { ...target, tenant_id: 'ten_other' }, envelope));
  fails(() => openRouteSecret(devicePrivate, { ...target, projection_id: 'prj_92' }, envelope));
  fails(() => openRouteSecret(devicePrivate, { ...target, revision: 92 }, envelope));
  fails(() => openRouteSecret(devicePrivate, target, { ...envelope, credential_version: 2 }));
  fails(() => openRouteSecret(new Uint8Array(32).fill(9), target, envelope));
  const forOther = clone(fixture.wire.config);
  forOther.policy.device_id = 'dev_other';
  const sealedForOther = sealRoutePoolConfig(forOther, { ...device, device_id: 'dev_other' }, lookup).route_pool.secrets[0]!;
  fails(() => openRouteSecret(devicePrivate, target, sealedForOther));
});

test('refuses to seal a configuration for any target other than its own tenant and device', () => {
  const mismatch = expect.objectContaining({ code: 'invalid_config', reason: 'seal_target_mismatch' });
  expect(() => sealRoutePoolConfig(clone(fixture.wire.config), { ...device, device_id: 'dev_other' }, lookup)).toThrow(mismatch);
  expect(() => sealRoutePoolConfig(clone(fixture.wire.config), { ...device, tenant_id: 'ten_other' }, lookup)).toThrow(mismatch);
  const noPolicy = clone(fixture.wire.config) as Record<string, unknown>;
  delete noPolicy.policy;
  expect(() => sealRoutePoolConfig(noPolicy as never, device, lookup)).toThrow(mismatch);
});

test('the business digest is rebuilt from route credential references, not from the envelopes carried', () => {
  const config = sealed();
  const expected = routeProjectionDigest(config);
  const withSecrets = (secrets: unknown[]) => ({ ...config, route_pool: { ...config.route_pool, secrets } }) as typeof config;
  expect(routeProjectionDigest(withSecrets([]))).toBe(expected);
  expect(routeProjectionDigest(withSecrets([config.route_pool.secrets[0]]))).toBe(expected);
  expect(routeProjectionDigest(withSecrets([...config.route_pool.secrets, ...config.route_pool.secrets,
    { credential_id: 'cred_x', credential_version: 9, key_id: 'x', nonce: 'x', ciphertext: 'x' }]))).toBe(expected);
  expect(routeProjectionDigest(withSecrets([...config.route_pool.secrets].reverse()))).toBe(expected);
  const rotated = clone(fixture.wire.config);
  rotated.routes[0]!.credential_ref = { credential_id: 'cred_a', credential_version: 2 };
  expect(routeProjectionDigest(rotated)).not.toBe(expected);
});

test('management material, missing material and malformed identities are refused', () => {
  const management = (id: string, version: number) => id === 'cred_b' ? { ...lookup(id, version)!, purpose: 'balance', material_class: 'management' } : lookup(id, version);
  expect(() => sealRoutePoolConfig(clone(fixture.wire.config), device, management)).toThrow(expect.objectContaining({ code: 'management_credential_forbidden' }));
  const inferencePurposeOnManagement = (id: string, version: number) => ({ ...lookup(id, version)!, material_class: 'management' });
  expect(() => sealRoutePoolConfig(clone(fixture.wire.config), device, inferencePurposeOnManagement)).toThrow(expect.objectContaining({ code: 'management_credential_forbidden' }));
  expect(() => sealRoutePoolConfig(clone(fixture.wire.config), device, (id) => id === 'cred_a' ? materials['cred_a@1']! : null))
    .toThrow(expect.objectContaining({ code: 'missing_route_credential' }));
  const noRef = clone(fixture.wire.config) as { routes: { credential_ref?: unknown }[] };
  delete noRef.routes[0]!.credential_ref;
  expect(() => sealRoutePoolConfig(noRef as never, device, lookup)).toThrow(expect.objectContaining({ code: 'missing_route_credential' }));
  const context = { tenant_id: 'ten_demo', device_id: 'dev lin', projection_id: 'prj_91', revision: 91, credential_id: 'cred_a', credential_version: 1 };
  expect(() => routeSecretAad(context)).toThrow(expect.objectContaining({ code: 'invalid_config' }));
  expect(() => routeSecretAad({ ...context, device_id: 'dev_lin', revision: 0 })).toThrow(expect.objectContaining({ code: 'invalid_config' }));
  expect(() => sealRouteSecret({ recipient_public_key: 'not-base64', material: materials['cred_a@1']!, context: { ...context, device_id: 'dev_lin' } }))
    .toThrow(expect.objectContaining({ code: 'invalid_config' }));
});
