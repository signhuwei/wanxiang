import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MemoryPresence } from '../src/presence';
import { signManifest } from '../src/release-package';
import { createServer } from '../src/server';
import { seedTenant } from '../src/seed';

const active = 'a'.repeat(40);
const candidate = 'b'.repeat(40);

test('only platform admins can queue signed immutable releases; state and request identity survive restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-release-test-'));
  const keyPath = join(dataDir, 'release.pub');
  const heartbeatPath = join(dataDir, 'runner');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(heartbeatPath, '');
  let code = '';
  const boot = (commit: string) => createServer({
    commit, dataDir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 2, heartbeatMs: 15_000,
    codeSecret: 'release-test-secret', presence: new MemoryPresence(), deliverCode: (_, value) => { code = value; },
    releaseRuntime: { publicKeyPath: keyPath, heartbeatPath },
  });
  let app = await boot(active);
  try {
    async function call(path: string, token = '', method = 'GET', body?: object | Blob, idempotencyKey?: string) {
      const headers = new Headers();
      if (token) headers.set('authorization', `Bearer ${token}`);
      if (body) headers.set('content-type', body instanceof Blob ? (body.type || 'application/octet-stream') : 'application/json');
      if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
      return fetch(new URL('/v1' + path, app.server.url), {
        method, headers, body: body instanceof Blob ? body : body && JSON.stringify(body),
      });
    }
    const target = 'platform@example.test';
    const tenant = await seedTenant(app.store, { target, platformAdmin: true });
    await call('/auth/code', '', 'POST', { target });
    const { token } = await (await call('/auth/login', '', 'POST', { target, code, kind: 'web' })).json() as { token: string };
    const { token: scoped } = await (await call('/auth/select-tenant', token, 'POST', { tenant_id: tenant.tenantId, kind: 'web' })).json() as { token: string };
    expect((await call('/platform/maintenance')).status).toBe(401);
    expect((await call('/platform/maintenance', scoped)).status).toBe(403);
    expect(await (await call('/platform/maintenance', token)).json()).toMatchObject({ runner_ready: true, active_commit: active });

    const blob = new Blob(['signed fixture']);
    const manifest = signManifest(privateKey, { commit: candidate, size: blob.size, sha256: createHash('sha256').update('signed fixture').digest('hex') });
    const releases = '/platform/server-releases';
    expect((await call(releases, token, 'POST', { ...manifest, sha256: '0'.repeat(64) })).status).toBe(422);
    expect((await call(releases, token, 'POST', manifest)).status).toBe(201);
    expect((await call(releases, token, 'POST', manifest)).status).toBe(200);
    const detail = releases + '/' + candidate;
    const deploy = (expected_commit: string, key = 'rollout-test') => call(detail + '/deploy', token, 'POST', { expected_commit }, key);
    expect((await deploy(active)).status).toBe(409);
    expect((await call(detail + '/artifact', token, 'PUT', new Blob(['tamper fixture']))).status).toBe(422);
    expect(await (await call(detail, token)).json()).toMatchObject({ uploaded_at: null });
    expect(await (await call(detail + '/artifact', token, 'PUT', blob)).json()).toMatchObject({ actions: ['read', 'deploy'] });
    expect((await deploy('c'.repeat(40))).status).toBe(409);
    const accepted = await deploy(active);
    expect(accepted.status).toBe(202);
    const job = await accepted.json() as { id: string; status: string };
    expect(job.status).toBe('queued');
    expect((await deploy(active, 'another-request')).status).toBe(409);

    const digest = createHash('sha256').update('approved bytes').digest('hex');
    const release = await call('/platform/agent-releases', token, 'POST', {
      agent: 'claude-code', version: '2.1.311', os: 'darwin', arch: 'arm64', url: 'https://example.test/claude',
      sha256: digest, size: 'approved bytes'.length,
    });
    expect(release.status).toBe(201);
    const { id } = await release.json() as { id: string };
    const upload = '/platform/agent-releases/' + id + '/artifact';
    const download = '/agent-artifacts/' + digest;
    expect((await call(download, token)).status).toBe(404);
    expect((await call(upload, scoped, 'PUT', new Blob(['approved bytes']))).status).toBe(403);
    expect((await call(upload, token, 'PUT', new Blob(['tampered bytes']))).status).toBe(422);
    expect((await call(download, token)).status).toBe(404);
    expect((await call(upload, token, 'PUT', new Blob(['not gzip'], { type: 'application/gzip' }))).status).toBe(422);
    const compressed = new Blob([gzipSync('approved bytes')], { type: 'application/gzip' });
    expect((await call(upload, token, 'PUT', compressed)).status).toBe(200);
    expect((await call(download)).status).toBe(401);
    const cachedArtifact = await call(download, token);
    expect(cachedArtifact.headers.get('content-length')).toBe('14');
    expect(await cachedArtifact.text()).toBe('approved bytes');
    expect((await call('/platform/agent-releases/' + id, token, 'PATCH', { status: 'disabled', revision: 1 })).status).toBe(200);
    expect((await call(download, token)).status).toBe(404);

    await app.close();
    app = await boot(candidate);
    expect(await (await deploy(active)).json()).toMatchObject({ id: job.id });
    expect((await deploy(candidate)).status).toBe(409);
    expect(await (await call('/platform/server-rollouts/' + job.id, token)).json()).toMatchObject({ id: job.id, status: 'queued' });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
