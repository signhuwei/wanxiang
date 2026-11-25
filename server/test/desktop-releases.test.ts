import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server';
import { receiveArtifact } from '../src/artifact-upload';
import { DESKTOP_ARTIFACT_MAX_BYTES } from '../src/desktop-releases';
import { desktopUpdateBytes } from '../src/desktop-update-signature';
import { seedTenant } from '../src/seed';
import { MemoryPresence } from '../src/presence';

// Every HTTP client we tried (fetch, node:http) recomputes Content-Length from the real body it was
// given, so the only way to make a server actually see a declared length that outruns the real bytes
// is to write the request line and headers onto a raw TCP socket ourselves.
function rawPut(base: URL, path: string, token: string, declaredLength: number, body: Uint8Array, truncate = false) {
  return new Promise<number | null>((resolve, reject) => {
    const socket = connect(Number(base.port), base.hostname, () => {
      socket.write(`PUT ${path} HTTP/1.1\r\nHost: ${base.hostname}\r\nAuthorization: Bearer ${token}\r\n` +
        `Content-Type: application/octet-stream\r\nContent-Length: ${declaredLength}\r\nConnection: close\r\n\r\n`);
      if (truncate) socket.end(body);
      else socket.write(body);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString('latin1'); });
    socket.setTimeout(3_000, () => socket.destroy(new Error('Raw upload socket timed out')));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // A server can reset the peer after receiving an incomplete HTTP request.
      if (!truncate || error.code !== 'ECONNRESET') reject(error);
    });
    socket.on('close', () => {
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1];
      resolve(status ? Number(status) : null);
    });
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Release = { id: string; version: string; os: string; arch: string; status: string; size: number | null;
  sha256: string | null; published_at: string | null; revision: number; actions: string[] };

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); });

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-desktop-releases-'));
  clean.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const codes = new Map<string, string>();
  const presence = new MemoryPresence();
  let time = Date.now();
  const service = await createServer({
    dataDir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 4, heartbeatMs: 15_000, commit: 'test',
    codeSecret: 'test-only-secret', masterKey: Buffer.alloc(32, 41), deliverCode: (target, code) => { codes.set(target, code); },
    now: () => time, presence,
  });
  clean.push(() => service.close());
  function request(path: string, body?: Record<string, unknown>, token?: string, key?: string, method = body ? 'POST' : 'GET') {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (key) headers.set('idempotency-key', key);
    if (body) headers.set('content-type', 'application/json');
    const full = path.startsWith('/v1/') || path.startsWith('/download') ? path : `/v1${path}`;
    return fetch(new URL(full, service.server.url), { method, headers, body: body && JSON.stringify(body) });
  }
  async function putArtifact(id: string, revision: number, bytes: Uint8Array | ReadableStream<Uint8Array>, token?: string) {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    headers.set('content-type', 'application/octet-stream');
    return fetch(new URL(`/v1/platform/desktop-releases/${id}/artifact?revision=${revision}`, service.server.url),
      { method: 'PUT', headers, body: bytes });
  }
  async function admin(target: string) {
    const seeded = await seedTenant(service.store, { target, now: time, platformAdmin: true });
    const codeRes = await request('/auth/code', { target });
    expect(codeRes.status).toBe(202);
    const loginRes = await request('/auth/login', { target, code: codes.get(target)!, kind: 'desktop' });
    expect(loginRes.status).toBe(200);
    const { token } = await loginRes.json() as { token: string };
    return { ...seeded, token };
  }
  function codeFor(target: string) {
    const code = codes.get(target);
    if (!code) throw new Error(`No code was issued for ${target}`);
    return code;
  }
  return { ...service, dataDir, request, putArtifact, admin, codeFor, advance: (ms: number) => { time += ms; }, now: () => time };
}

// A minimal, structurally valid XAR header: magic + 28-byte fixed header whose toc_length_compressed
// leaves exactly `extra` bytes of "body" after the header, matching the file's actual total length.
function xarBytes(extra = 16) {
  const buf = Buffer.alloc(28 + extra);
  buf.write('xar!', 0, 'ascii');
  buf.writeUInt16BE(28, 4); // header size
  buf.writeUInt16BE(1, 6); // version
  buf.writeBigUInt64BE(BigInt(extra), 8); // toc_length_compressed
  buf.writeBigUInt64BE(BigInt(extra), 16); // toc_length_uncompressed
  buf.writeUInt32BE(1, 24); // checksum algorithm
  buf.fill(0xab, 28);
  return new Uint8Array(buf);
}

// A minimal, structurally valid PE: "MZ" stub, e_lfanew pointing right after the stub, and a `PE\0\0`
// signature there. The NSIS stub this emulates is routinely 32-bit even for an x64 payload, which is
// exactly why checkFormat never inspects the COFF machine type.
function peBytes(extra = 64, machine = 0x14c) {
  const stubSize = 0x80;
  const buf = Buffer.alloc(stubSize + 24 + extra);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(stubSize, 0x3c); // e_lfanew
  buf.write('PE\0\0', stubSize, 'ascii');
  buf.writeUInt16LE(machine, stubSize + 4);
  buf.fill(0xcd, stubSize + 24);
  return new Uint8Array(buf);
}

test('full lifecycle: draft, upload, publish swaps the old current to unlisted, then unpublish', async () => {
  const f: Fixture = await fixture();
  const a = await f.admin('admin-lifecycle@example.test');
  const create = await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'darwin', arch: 'arm64' }, a.token, 'create-1');
  expect(create.status).toBe(201);
  const draft = await create.json() as Release;
  expect(draft).toMatchObject({ status: 'draft', size: null, sha256: null, revision: 1, actions: ['read', 'upload_artifact'] });

  const bytes = xarBytes();
  const upload = await f.putArtifact(draft.id, draft.revision, bytes, a.token);
  expect(upload.status).toBe(200);
  const uploaded = await upload.json() as Release;
  expect(uploaded.size).toBe(bytes.length);
  expect(uploaded.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(uploaded.revision).toBe(2);
  expect(uploaded.actions).toEqual(['read', 'upload_artifact', 'publish']);

  const publish = await f.request(`/platform/desktop-releases/${draft.id}/publish`, { revision: uploaded.revision }, a.token, 'publish-1');
  expect(publish.status).toBe(200);
  const published = await publish.json() as Release;
  expect(published.status).toBe('published');
  expect(published.published_at).not.toBeNull();
  expect(published.actions).toEqual(['read', 'unpublish']);

  // Publishing a second draft for the same platform must demote the first to unlisted in the same
  // transaction, and the public endpoint must only ever show the new current version.
  const create2 = await f.request('/platform/desktop-releases', { version: '1.1.0', os: 'darwin', arch: 'arm64' }, a.token, 'create-2');
  const draft2 = await create2.json() as Release;
  const bytes2 = xarBytes(32);
  const uploaded2 = await (await f.putArtifact(draft2.id, draft2.revision, bytes2, a.token)).json() as Release;
  const publish2 = await f.request(`/platform/desktop-releases/${draft2.id}/publish`, { revision: uploaded2.revision }, a.token, 'publish-2');
  expect(publish2.status).toBe(200);

  const oldDetail = await (await f.request(`/platform/desktop-releases/${draft.id}`, undefined, a.token)).json() as Release;
  expect(oldDetail.status).toBe('unlisted');
  expect(oldDetail.actions).toEqual(['read']);

  const publicList = await (await f.request('/desktop-releases')).json() as { items: { id: string; version: string }[] };
  expect(publicList.items).toHaveLength(1);
  expect(publicList.items[0]).toMatchObject({ id: draft2.id, version: '1.1.0' });

  // The old (now unlisted) version's download link must stop working; no fallback to history.
  expect((await f.request(`/desktop-releases/${draft.id}/download`)).status).toBe(404);
  const download = await f.request(`/desktop-releases/${draft2.id}/download`);
  expect(download.status).toBe(200);
  expect(download.headers.get('cache-control')).toBe('no-store');
  expect(download.headers.get('x-content-type-options')).toBe('nosniff');
  expect(download.headers.get('content-length')).toBe(String(bytes2.length));
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes2);

  // Unpublish takes it off the public list too.
  const unpublish = await f.request(`/platform/desktop-releases/${draft2.id}/unpublish`, { revision: uploaded2.revision + 1 }, a.token, 'unpublish-1');
  expect(unpublish.status).toBe(200);
  expect(await (await f.request('/desktop-releases')).json()).toEqual({ items: [] });
  const replaced = f.store.system.get<{ detail_json: string }>(
    "SELECT detail_json FROM platform_audit WHERE action = 'desktop_release.unpublish' AND target = ?", [draft.id]);
  expect(JSON.parse(replaced!.detail_json)).toMatchObject({ superseded_by: draft2.id });
});

test('a signed update is served only for its published release and leaves the normal installer intact', async () => {
  const f = await fixture();
  const a = await f.admin('updates@example.com');
  const release = { version: '1.2.0-rc3', os: 'darwin', arch: 'arm64' };
  const draft = await (await f.request('/platform/desktop-releases', release, a.token, 'draft-update')).json() as Release;
  const pkg = xarBytes();
  const normal = await (await f.putArtifact(draft.id, draft.revision, pkg, a.token)).json() as Release;
  const updatePath = new URL('/v1/platform/desktop-releases/' + draft.id + '/update-artifact?revision=' + normal.revision, f.server.url);
  const filename = '/desktop-releases/' + draft.id;
  const manifestPath = '/desktop-updates/darwin/arm64';
  const manifest = { ...release, id: draft.id, kind: 'macos-pkg-keep-daemon', size: pkg.length,
    sha256: new Bun.CryptoHasher('sha256').update(pkg).digest('hex') };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, desktopUpdateBytes(manifest), privateKey).toString('base64url');
  const upload = (sig: string) => fetch(updatePath, { method: 'PUT',
    headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/octet-stream', 'x-onex-update-signature': sig },
    body: pkg });
  expect((await upload('invalid')).status).toBe(422);
  const uploaded = await upload(signature);
  expect(uploaded.status).toBe(200);
  expect(await uploaded.json()).toMatchObject({ revision: normal.revision + 1, sha256: normal.sha256, update: { ...manifest, signature } });
  expect((await f.request(manifestPath)).status).toBe(404);
  expect((await f.request(filename + '/update-download')).status).toBe(404);
  expect((await f.request('/platform' + filename + '/publish', { revision: normal.revision + 1 }, a.token, 'publish-update')).status).toBe(200);
  const feed = await f.request(manifestPath);
  expect(feed.status).toBe(200);
  expect(feed.headers.get('cache-control')).toBe('no-store');
  const entry = await feed.json() as typeof manifest & { signature: string };
  expect(entry).toEqual({ ...manifest, signature });
  expect(verify(null, desktopUpdateBytes(entry), publicKey, Buffer.from(entry.signature, 'base64url'))).toBe(true);
  const download = await f.request(filename + '/update-download');
  expect(download.status).toBe(200);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(pkg);
  expect((await f.request(filename + '/download')).status).toBe(200);
  expect((await f.request('/platform' + filename + '/unpublish', { revision: normal.revision + 2 }, a.token, 'remove-update')).status).toBe(200);
  expect((await f.request(manifestPath)).status).toBe(404);
  expect((await f.request(filename + '/update-download')).status).toBe(404);
});

test('Windows publishes a signed Desktop, CLI and daemon bundle separately from the NSIS installer', async () => {
  const f = await fixture();
  const admin = await f.admin('windows-updates@example.test');
  const release = { version: '1.2.0-rc4', os: 'windows', arch: 'x64' };
  const draft = await (await f.request('/platform/desktop-releases', release, admin.token, 'windows-draft')).json() as Release;
  const installer = peBytes();
  const normalResponse = await f.putArtifact(draft.id, draft.revision, installer, admin.token);
  expect(normalResponse.status).toBe(200);
  const normal = await normalResponse.json() as Release;
  const updatePath = new URL('/v1/platform/desktop-releases/' + draft.id + '/update-artifact?revision=' + normal.revision, f.server.url);
  const desktop = peBytes(50, 0x8664);
  const cli = peBytes(60, 0x8664);
  const daemon = peBytes(70, 0x8664);
  const header = Buffer.alloc(32);
  header.write('ONEXWUP1', 0, 'ascii');
  header.writeBigUInt64LE(BigInt(desktop.length), 8);
  header.writeBigUInt64LE(BigInt(cli.length), 16);
  header.writeBigUInt64LE(BigInt(daemon.length), 24);
  const binary = Buffer.concat([header, desktop, cli, daemon]);
  const entry = { ...release, id: draft.id, kind: 'windows-edge-bundle', size: binary.length,
    sha256: new Bun.CryptoHasher('sha256').update(binary).digest('hex') };
  const { privateKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, desktopUpdateBytes(entry), privateKey).toString('base64url');
  const upload = (body: Uint8Array) => fetch(updatePath, { method: 'PUT',
    headers: { authorization: 'Bearer ' + admin.token, 'content-type': 'application/octet-stream', 'x-onex-update-signature': signature },
    body });

  const wrongMagic = Buffer.from(binary);
  wrongMagic[0] = wrongMagic[0]! | 0x80;
  const hugeMember = Buffer.from(binary);
  hugeMember.writeBigUInt64LE((1n << 64n) - 1n, 16);
  const x86Cli = Buffer.concat([header, desktop, peBytes(60), daemon]);
  for (const malformed of [desktop, wrongMagic, hugeMember, x86Cli, binary.subarray(0, -1), Buffer.concat([binary, Buffer.alloc(1)])]) {
    expect((await upload(malformed)).status).toBe(422);
  }

  const uploaded = await upload(binary);
  expect(uploaded.status).toBe(200);
  expect(await uploaded.json()).toMatchObject({ revision: normal.revision + 1, sha256: normal.sha256, update: { ...entry, signature } });
  const path = '/desktop-releases/' + draft.id;
  expect((await f.request('/platform' + path + '/publish', { revision: normal.revision + 1 }, admin.token, 'windows-publish')).status).toBe(200);
  expect(await (await f.request('/desktop-updates/windows/x64')).json()).toEqual({ ...entry, signature });
  expect(new Uint8Array(await (await f.request(path + '/update-download')).arrayBuffer())).toEqual(new Uint8Array(binary));
  expect(new Uint8Array(await (await f.request(path + '/download')).arrayBuffer())).toEqual(installer);
});

test('rejects a connection that is cut short of its declared Content-Length, leaving the draft untouched', async () => {
  const f: Fixture = await fixture();
  const a = await f.admin('admin-mismatch@example.test');
  const draft = await (await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'darwin', arch: 'arm64' }, a.token, 'c1')).json() as Release;
  const bytes = xarBytes();
  const fragment = bytes.subarray(0, bytes.length - 5);
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(fragment); controller.close(); },
  });
  // Assert the upload handler rejects and removes a partial file even when an HTTP runtime
  // discards an incomplete request before it reaches the route.
  const stage = join(f.dataDir, 'truncated-upload');
  await expect(receiveArtifact({ body, headers: new Headers({ 'content-length': String(bytes.length) }) },
    stage, DESKTOP_ARTIFACT_MAX_BYTES)).rejects.toMatchObject({ code: 'invalid' });
  expect(existsSync(stage)).toBe(false);

  const status = await rawPut(f.server.url, `/v1/platform/desktop-releases/${draft.id}/artifact?revision=${draft.revision}`,
    a.token, bytes.length, fragment, true);
  expect([null, 400, 422]).toContain(status);
  const after = await (await f.request(`/platform/desktop-releases/${draft.id}`, undefined, a.token)).json() as Release;
  expect(after).toMatchObject({ status: 'draft', size: null, sha256: null, revision: 1 });
});

test('rejects an upload over the 256 MiB cap with 413, and rejects bad XAR/PE formats with 422', async () => {
  const f: Fixture = await fixture();
  const a = await f.admin('admin-format@example.test');
  const draft = await (await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'darwin', arch: 'arm64' }, a.token, 'c1')).json() as Release;
  // `Content-Length` is a forbidden header for fetch(), which always recomputes it from the real body
  // — no browser or spec-compliant fetch client can lie about it. A raw HTTP client (curl, a buggy or
  // hostile Edge build) can, so this goes around fetch with node:http to send a true oversized header
  // over a real socket and confirm the route rejects it before reading any bytes.
  const oversizedDeclared = DESKTOP_ARTIFACT_MAX_BYTES + 1;
  const tooBig = await rawPut(f.server.url, `/v1/platform/desktop-releases/${draft.id}/artifact?revision=${draft.revision}`,
    a.token, oversizedDeclared, new Uint8Array(1));
  expect(tooBig).toBe(413);

  const garbage = await f.putArtifact(draft.id, draft.revision, new TextEncoder().encode('not an installer'), a.token);
  expect(garbage.status).toBe(422);

  // A Windows draft must accept a PE whose own DOS stub is 32-bit even though arch is x64 — the
  // contract is explicit this is normal for NSIS and must not be rejected.
  const winDraft = await (await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'windows', arch: 'x64' }, a.token, 'c2')).json() as Release;
  const pe = peBytes();
  const peUpload = await f.putArtifact(winDraft.id, winDraft.revision, pe, a.token);
  expect(peUpload.status).toBe(200);
  expect((await peUpload.json() as Release).size).toBe(pe.length);

  // A macOS draft must reject a PE payload (wrong format for that platform).
  const wrongFormat = await f.putArtifact(draft.id, draft.revision, pe, a.token);
  expect(wrongFormat.status).toBe(422);
});

test('rejects platform combinations and version strings outside the contract', async () => {
  const f: Fixture = await fixture();
  const a = await f.admin('admin-platform@example.test');
  expect((await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'darwin', arch: 'x64' }, a.token, 'bad-combo')).status).toBe(422);
  expect((await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'windows', arch: 'arm64' }, a.token, 'bad-combo-2')).status).toBe(422);
  expect((await f.request('/platform/desktop-releases', { version: 'not-semver', os: 'darwin', arch: 'arm64' }, a.token, 'bad-version')).status).toBe(422);
  expect((await f.request('/platform/desktop-releases', { version: '01.2.3', os: 'darwin', arch: 'arm64' }, a.token)).status).toBe(422);
  expect((await f.request('/platform/desktop-releases', { version: '1.2.3-beta.01', os: 'darwin', arch: 'arm64' }, a.token)).status).toBe(422);
  expect((await f.request('/platform/desktop-releases', { version: '1.2.3-beta.1', os: 'darwin', arch: 'arm64' }, a.token, 'good-prerelease')).status).toBe(201);
  expect((await f.request('/platform/desktop-releases', { version: '1.2.3+win.01', os: 'windows', arch: 'x64' }, a.token)).status).toBe(201);
});

test('a stale revision on upload or publish is rejected and never disturbs the already-verified draft', async () => {
  const f: Fixture = await fixture();
  const a = await f.admin('admin-stale@example.test');
  const draft = await (await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'darwin', arch: 'arm64' }, a.token, 'c1')).json() as Release;
  const bytes = xarBytes();
  const uploaded = await (await f.putArtifact(draft.id, draft.revision, bytes, a.token)).json() as Release;
  expect(uploaded.revision).toBe(2);

  // Retrying the upload at the now-stale original revision must fail without touching the verified draft.
  const stale = await f.putArtifact(draft.id, 1, xarBytes(99), a.token);
  expect(stale.status).toBe(409);
  const afterStale = await (await f.request(`/platform/desktop-releases/${draft.id}`, undefined, a.token)).json() as Release;
  expect(afterStale).toMatchObject({ size: bytes.length, sha256: uploaded.sha256, revision: 2 });

  // Publishing with a stale revision is also rejected.
  expect((await f.request(`/platform/desktop-releases/${draft.id}/publish`, { revision: 1 }, a.token, 'pub-stale')).status).toBe(409);
  // A duplicate (os, arch, version) draft is a conflict, not a new record.
  expect((await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'darwin', arch: 'arm64' }, a.token, 'dup')).status).toBe(409);
});

test('a losing concurrent upload cannot delete the identical artifact committed by the winner', async () => {
  const f = await fixture();
  const admin = await f.admin('concurrent-upload@example.test');
  const response = await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'darwin', arch: 'arm64' }, admin.token, 'race-draft');
  expect(response.status).toBe(201);
  const draft = await response.json() as Release;
  const bytes = xarBytes();
  const directory = join(f.dataDir, 'desktop-releases');
  mkdirSync(directory, { mode: 0o700 });

  const bodies = [new TransformStream<Uint8Array>(), new TransformStream<Uint8Array>()];
  const writers = bodies.map(body => body.writable.getWriter());
  const uploads = Promise.all(bodies.map(body => f.putArtifact(draft.id, draft.revision, body.readable, admin.token)));
  await Promise.all(writers.map(writer => writer.write(bytes.subarray(0, 1))));
  // Each temp file is opened only after the server accepts that request's starting revision.
  const deadline = Date.now() + 2500;
  let waitingUploads = 0;
  try {
    while (Date.now() < deadline) {
      waitingUploads = readdirSync(directory).filter(name => name.endsWith('.part')).length;
      if (waitingUploads === 2) break;
      await Bun.sleep(10);
    }
  } finally {
    await Promise.all(writers.map(async writer => { await writer.write(bytes.subarray(1)); await writer.close(); }));
  }
  expect(waitingUploads).toBe(2);
  const results = await uploads;
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const winner = await results.find(result => result.ok)!.json() as Release;
  const publish = await f.request(`/platform/desktop-releases/${draft.id}/publish`, { revision: winner.revision }, admin.token, 'race-publish');
  expect(publish.status).toBe(200);
  const download = await f.request(`/desktop-releases/${draft.id}/download`);
  expect(download.status).toBe(200);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
});

test('publish is refused before the artifact is verified, and unpublish is refused on a draft', async () => {
  const f: Fixture = await fixture();
  const a = await f.admin('admin-unverified@example.test');
  const draft = await (await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'darwin', arch: 'arm64' }, a.token, 'c1')).json() as Release;
  expect((await f.request(`/platform/desktop-releases/${draft.id}/publish`, { revision: draft.revision }, a.token, 'pub-early')).status).toBe(409);
  expect((await f.request(`/platform/desktop-releases/${draft.id}/unpublish`, { revision: draft.revision }, a.token, 'unpub-early')).status).toBe(409);
});

test('upload re-sent after a prior successful upload replaces the summary with the new bytes', async () => {
  const f: Fixture = await fixture();
  const a = await f.admin('admin-replace@example.test');
  const draft = await (await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'darwin', arch: 'arm64' }, a.token, 'c1')).json() as Release;
  const first = xarBytes(16);
  const firstUploaded = await (await f.putArtifact(draft.id, draft.revision, first, a.token)).json() as Release;
  const second = xarBytes(48);
  const secondRes = await f.putArtifact(draft.id, firstUploaded.revision, second, a.token);
  expect(secondRes.status).toBe(200);
  const secondUploaded = await secondRes.json() as Release;
  expect(secondUploaded.size).toBe(second.length);
  expect(secondUploaded.sha256).not.toBe(firstUploaded.sha256);
  const download = await f.request(`/desktop-releases/${draft.id}/download`);
  // Not published yet, so the public endpoint can't see it regardless of upload history.
  expect(download.status).toBe(404);
});

test('an authenticated tenant member who is not a platform admin cannot touch desktop releases', async () => {
  const f: Fixture = await fixture();
  const a = await f.admin('admin-for-contrast@example.test');
  const draft = await (await f.request('/platform/desktop-releases', { version: '1.0.0', os: 'darwin', arch: 'arm64' }, a.token, 'c1')).json() as Release;

  const target = 'tenant-only@example.test';
  const seeded = await seedTenant(f.store, { target, now: f.now() });
  const codeRes = await f.request('/auth/code', { target });
  expect(codeRes.status).toBe(202);
  const loginRes = await f.request('/auth/login', { target, code: f.codeFor(target), kind: 'desktop' });
  expect(loginRes.status).toBe(200);
  const { token: global } = await loginRes.json() as { token: string };
  const selectRes = await f.request('/auth/select-tenant', { tenant_id: seeded.tenantId }, global);
  expect(selectRes.status).toBe(200);
  const { token: memberToken } = await selectRes.json() as { token: string };

  expect((await f.request('/platform/desktop-releases', { version: '2.0.0', os: 'darwin', arch: 'arm64' }, memberToken, 'c2')).status).toBe(403);
  expect((await f.request(`/platform/desktop-releases/${draft.id}`, undefined, memberToken)).status).toBe(403);
  expect((await f.putArtifact(draft.id, draft.revision, xarBytes(), memberToken)).status).toBe(403);
  expect((await f.request(`/platform/desktop-releases/${draft.id}/publish`, { revision: draft.revision }, memberToken, 'pub')).status).toBe(403);

  // No credentials at all is unauthenticated, not forbidden.
  expect((await f.request('/platform/desktop-releases', { version: '3.0.0', os: 'darwin', arch: 'arm64' })).status).toBe(401);
});
