import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { receiveArtifact } from '../src/artifact-upload';
import { MemoryPresence } from '../src/presence';
import { DOCKER_RELEASE_FORMAT, DOCKER_RELEASE_PLATFORM, manifestBytes, signManifest } from '../src/release-package';
import { releasePaths } from '../src/release-store';
import { createServer } from '../src/server';
import { seedTenant } from '../src/seed';

const active = 'a'.repeat(40);
const candidate = 'b'.repeat(40);

test('a stalled upload expires at its configured deadline and removes the partial artifact', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-release-timeout-'));
  const path = join(dataDir, 'artifact');
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
  });
  try {
    await expect(receiveArtifact({ body, headers: new Headers() }, path, 2, undefined, 25))
      .rejects.toMatchObject({ detail: { reason: 'upload_timed_out' } });
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

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

test('Docker release records gate formats and keep rollout status available during maintenance', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-docker-release-test-'));
  const paths = releasePaths(dataDir);
  mkdirSync(paths.dir);
  const keyPath = join(dataDir, 'release.pub');
  const heartbeatPath = join(paths.dir, 'runner');
  const maintenanceFile = join(paths.dir, '.rollout-maintenance');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(heartbeatPath, '');

  const legacyCommit = 'c'.repeat(40);
  const legacy = signManifest(privateKey, {
    commit: legacyCommit, size: 6, sha256: createHash('sha256').update('legacy').digest('hex'),
  });
  expect(manifestBytes(legacy).toString()).toBe(`onex-server-release-v1\n${legacy.commit}\n${legacy.sha256}\n6\n`);
  const legacyDb = new Database(paths.database, { create: true });
  legacyDb.exec(`CREATE TABLE server_releases (
    "commit" TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, signature TEXT NOT NULL,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL, uploaded_at TEXT
  )`);
  const created = new Date().toISOString();
  legacyDb.run('INSERT INTO server_releases VALUES (?, ?, ?, ?, ?, ?, ?)',
    [legacy.commit, legacy.sha256, legacy.size, legacy.signature, created, 'legacy-admin', created]);
  legacyDb.close();
  writeFileSync(paths.artifact(legacyCommit), 'legacy');

  let code = '';
  const boot = (format?: typeof DOCKER_RELEASE_FORMAT) => createServer({
    commit: active, dataDir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 2, heartbeatMs: 15_000,
    codeSecret: 'release-test-secret', presence: new MemoryPresence(), deliverCode: (_, value) => { code = value; },
    releaseRuntime: { publicKeyPath: keyPath, heartbeatPath, format },
    releaseMaintenanceFile: format ? maintenanceFile : undefined,
  });
  let app = await boot(DOCKER_RELEASE_FORMAT);
  try {
    let auth = '';
    const call = (path: string, method = 'GET', body?: object | Blob, token = auth, idempotencyKey?: string) => {
      const headers = new Headers();
      if (token) headers.set('authorization', `Bearer ${token}`);
      if (body) headers.set('content-type', body instanceof Blob ? 'application/octet-stream' : 'application/json');
      if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
      return fetch(new URL(path, app.server.url), { method, headers, body: body instanceof Blob ? body : body && JSON.stringify(body) });
    };
    const target = 'docker-platform@example.test';
    const tenant = await seedTenant(app.store, { target, platformAdmin: true });
    await call('/v1/auth/code', 'POST', { target });
    const login = await (await call('/v1/auth/login', 'POST', { target, code, kind: 'web' })).json() as { token: string };
    auth = login.token;
    const { token: scoped } = await (await call('/v1/auth/select-tenant', 'POST', { tenant_id: tenant.tenantId, kind: 'web' })).json() as { token: string };

    const releases = '/v1/platform/server-releases';
    const legacyDetail = releases + '/' + legacyCommit;
    const detail = releases + '/' + candidate;
    expect(await (await call('/v1/platform/maintenance')).json()).toMatchObject({ release_format: DOCKER_RELEASE_FORMAT, runner_ready: true });
    expect(await (await call(legacyDetail)).json()).toMatchObject({ commit: legacyCommit, uploaded_at: created, actions: ['read'] });
    expect((await call(legacyDetail + '/artifact', 'PUT', new Blob(['legacy']))).status).toBe(409);
    expect(await (await call(legacyDetail + '/deploy', 'POST', { expected_commit: active }, auth, 'legacy')).json())
      .toMatchObject({ error: { code: 'conflict', detail: { reason: 'artifact_format_incompatible' } } });

    const encrypted = 'age-encryption.org/v1\nfixture ciphertext';
    const image_id = 'sha256:' + 'd'.repeat(64);
    const artifact = {
      commit: candidate, sha256: createHash('sha256').update(encrypted).digest('hex'), size: encrypted.length,
      format: DOCKER_RELEASE_FORMAT, platform: DOCKER_RELEASE_PLATFORM, image_id,
    } as const;
    const manifest = signManifest(privateKey, artifact);
    expect((await call(releases, 'POST', { ...manifest, platform: 'linux/amd64' })).status).toBe(422);
    expect((await call(releases, 'POST', { ...manifest, image_id: 'sha256:' + 'e'.repeat(64) })).status).toBe(422);
    expect((await call(releases, 'POST', manifest)).status).toBe(201);
    expect((await call(releases, 'POST', manifest)).status).toBe(200);
    expect((await call(releases, 'POST', signManifest(privateKey, { ...artifact, image_id: 'sha256:' + 'e'.repeat(64) }))).status).toBe(409);
    expect((await call(detail + '/artifact', 'PUT', new Blob(['wrong'.repeat(8)]))).status).toBe(422);
    const uploaded = await call(detail + '/artifact', 'PUT', new Blob([encrypted]));
    expect(await uploaded.json()).toMatchObject({ format: DOCKER_RELEASE_FORMAT, platform: DOCKER_RELEASE_PLATFORM, image_id, actions: ['read', 'deploy'] });
    expect(await Bun.file(paths.artifact(candidate, DOCKER_RELEASE_FORMAT)).text()).toBe(encrypted);
    expect(existsSync(paths.artifact(candidate))).toBe(false);

    const plaintext = 'unchanged signed plaintext';
    const signedPlaintext = signManifest(privateKey, { ...artifact, commit: 'f'.repeat(40),
      sha256: createHash('sha256').update(plaintext).digest('hex'), size: plaintext.length });
    expect((await call(releases, 'POST', signedPlaintext)).status).toBe(201);
    expect((await call(releases + '/' + signedPlaintext.commit + '/artifact', 'PUT', new Blob([plaintext]))).status).toBe(422);
    expect(existsSync(paths.artifact(signedPlaintext.commit, DOCKER_RELEASE_FORMAT))).toBe(false);

    const queued = await call(detail + '/deploy', 'POST', { expected_commit: active }, auth, 'docker-install');
    expect(queued.status).toBe(202);
    const { id } = await queued.json() as { id: string };
    const rollout = '/v1/platform/server-rollouts/' + id;
    writeFileSync(maintenanceFile, '');
    expect((await call('/v1/healthz')).status).toBe(200);
    expect((await call('/v1/healthz', 'HEAD')).status).toBe(200);
    expect(await (await call(rollout)).json()).toMatchObject({ id, status: 'queued' });
    expect((await call(rollout, 'GET', undefined, '')).status).toBe(401);
    expect((await call(rollout, 'GET', undefined, scoped)).status).toBe(403);
    expect((await call('/')).status).toBe(503);
    expect((await call(releases, 'POST', manifest)).status).toBe(503);
    expect((await fetch(new URL('/v1/edge/ws', app.server.url), {
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    })).status).toBe(503);
    unlinkSync(maintenanceFile);
    expect((await call(releases)).status).toBe(200);

    await app.close();
    app = await boot();
    expect((await call(releases, 'POST', manifest)).status).toBe(409);
    expect(await (await call(detail)).json()).toMatchObject({ commit: candidate, format: DOCKER_RELEASE_FORMAT, actions: ['read'] });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
