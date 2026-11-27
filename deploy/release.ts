import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createReadStream, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commitPattern, isDockerManifest, isManifest, signManifest, type ServerManifest } from '../server/src/release-package';
import { desktopUpdateBytes, desktopUpdateKind } from '../server/src/desktop-update-signature';

process.umask(0o077);
const repo = resolve(import.meta.dir, '..');
const [command, ...args] = process.argv.slice(2);

async function run(argv: string[], output = false) {
  const child = Bun.spawn(argv, { cwd: repo, stdout: 'pipe', stderr: 'inherit' });
  const captured = child.stdout ? await new Response(child.stdout).text() : '';
  if (!output && captured) process.stderr.write(captured);
  if (await child.exited !== 0) throw new Error(`${argv[0]} failed`);
  return captured.trim();
}

async function digest(path: string) {
  const sha = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) { sha.update(chunk); size += chunk.length; }
  return { sha256: sha.digest('hex'), size };
}

function setting(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

async function packServer(output: string, revision = 'HEAD') {
  const key = createPrivateKey(readFileSync(setting('ONEX_RELEASE_PRIVATE_KEY')));
  const commit = await run(['git', 'rev-parse', '--verify', '--end-of-options', revision + '^{commit}'], true);
  if (!commitPattern.test(commit)) throw new Error('Use a full Git commit');
  const timestamp = await run(['git', 'show', '-s', '--format=%ct', commit], true);
  const dir = resolve(output);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(dir, '.onex-build.'));
  try {
    const tree = join(temp, 'tree');
    mkdirSync(tree, { mode: 0o700 });
    await run(['git', 'archive', '--format=tar', `--output=${join(temp, 'source.tar')}`, commit, 'server', 'deploy']);
    await run(['tar', '-xf', join(temp, 'source.tar'), '-C', tree]);
    await run([process.execPath, 'install', '--cwd', join(tree, 'server'), '--frozen-lockfile', '--production', '--ignore-scripts', '--os=linux', '--cpu=x64']);
    const duckdb = join(tree, 'server/node_modules/@duckdb/node-bindings-linux-x64');
    if (!await Bun.file(join(duckdb, 'duckdb.node')).exists() || !await Bun.file(join(duckdb, 'libduckdb.so')).exists()) {
      throw new Error('Package requires the Linux x64 DuckDB bindings');
    }
    const bundle = join(temp, 'bundle.tar.gz');
    await run(['python3', join(import.meta.dir, 'server-release-pack.py'), tree, bundle, timestamp]);
    const manifest = signManifest(key, { commit, ...await digest(bundle) });
    if (!isManifest(manifest)) throw new Error('Package exceeds the Server release size limit');
    const archive = join(dir, `${commit}.tar.gz`);
    const manifestPath = join(dir, `${commit}.json`);
    const stagingManifest = join(temp, 'manifest.json');
    writeFileSync(stagingManifest, JSON.stringify(manifest) + '\n', { mode: 0o600 });
    renameSync(bundle, archive);
    renameSync(stagingManifest, manifestPath);
    return { commit, archive, manifest: manifestPath, size: manifest.size, sha256: manifest.sha256 };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`HTTP ${status}: ${code}`); }
}
async function connect(origin: string, artifactTimeoutMs = 130_000) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Use the OneX base URL');
  }
  let session = '';
  const request = async (path: string, method = 'GET', body?: object | Blob, key?: string, extraHeaders?: HeadersInit) => {
    const headers = new Headers(extraHeaders);
    headers.set('Accept', 'application/json');
    if (session) headers.set('Authorization', `Bearer ${session}`);
    if (body) headers.set('Content-Type', body instanceof Blob ? 'application/octet-stream' : 'application/json');
    if (key) headers.set('Idempotency-Key', key);
    const response = await fetch(new URL('/v1' + path, base), { method, headers, redirect: 'error',
      body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(body instanceof Blob ? artifactTimeoutMs : 8_000) });
    const value = await response.json().catch(() => null) as any;
    if (!response.ok) throw new RequestError(response.status, value?.error?.detail?.reason || value?.error?.code || 'request_failed');
    return value;
  };
  const loginFile = process.env.ONEX_RELEASE_LOGIN_TOKEN_FILE;
  if (loginFile) {
    const { token } = await request('/auth/token-login', 'POST', { token: readFileSync(loginFile, 'utf8').trim() });
    session = token;
  } else {
    session = readFileSync(setting('ONEX_RELEASE_TOKEN_FILE'), 'utf8').trim();
  }
  return request;
}
type Request = Awaited<ReturnType<typeof connect>>;

async function verifyBundle(manifestPath: string, archive: string): Promise<ServerManifest> {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest || !isManifest(manifest)) throw new Error('Invalid Server release manifest');
  const actual = await digest(archive);
  if (actual.size !== manifest.size || actual.sha256 !== manifest.sha256) throw new Error('Archive does not match its manifest');
  return manifest;
}

async function waitForRollout(api: Request, id: string) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    let row;
    try { row = await api('/platform/server-rollouts/' + encodeURIComponent(id)); }
    catch (error) {
      if (error instanceof RequestError && error.status < 500) throw error;
    }
    if (row?.status === 'failed' || row?.status === 'succeeded') {
      if (row.status === 'failed') process.exitCode = 1;
      return row;
    }
    await Bun.sleep(2000);
  }
  process.exitCode = 1;
  return { id, status: 'pending', error_code: 'wait_timeout' };
}

async function publishServer(origin: string, manifestPath: string, archive: string) {
  const manifest = await verifyBundle(manifestPath, archive);
  const api = await connect(origin, isDockerManifest(manifest) ? 600_000 : undefined);
  const base = '/platform/server-releases';
  const maintenance = await api('/platform/maintenance');
  const expected_commit = process.env.ONEX_EXPECTED_COMMIT ?? maintenance.active_commit;
  const release = await api(base, 'POST', manifest);
  const path = base + '/' + release.commit;
  if (!release.uploaded_at) await api(path + '/artifact', 'PUT', Bun.file(archive));
  const requestKey = process.env.ONEX_RELEASE_REQUEST_ID ?? `deploy-${manifest.commit}-${expected_commit}`;
  const job = await api(path + '/deploy', 'POST', { expected_commit }, requestKey);
  return waitForRollout(api, job.id);
}

function edgeUpdateSigningKey() {
  const key = createPrivateKey(readFileSync(setting('ONEX_EDGE_UPDATE_PRIVATE_KEY')));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Use an Ed25519 Edge update signing key');
  return key;
}

async function publishEdge(origin: string, os: string, version: string, archive: string, updateArchive?: string) {
  const arch = os === 'darwin' ? 'arm64' : os === 'windows' ? 'x64' : null;
  if (!arch) throw new Error('Choose darwin or windows');
  const file = await digest(archive);
  const updateFile = updateArchive ? await digest(updateArchive) : null;
  const updateKey = updateFile ? edgeUpdateSigningKey() : null;
  const api = await connect(origin);
  const base = '/platform/desktop-releases';
  const query = new URLSearchParams({ q: `${version} ${os} ${arch}` });
  const page = await api(base + '?' + query);
  const identity = { version, os, arch };
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  let release = page.items.find((row: any) => row.version === version && row.os === os && row.arch === arch);
  release ??= await api(base, 'POST', identity, 'edge-create-' + key);
  const path = base + '/' + release.id;
  if (release.status === 'draft' && (release.sha256 !== file.sha256 || release.size !== file.size)) {
    release = await api(path + '/artifact?revision=' + release.revision, 'PUT', Bun.file(archive));
  }
  if (release.sha256 !== file.sha256 || release.size !== file.size) throw new Error('Release already has a different artifact');
  if (updateArchive && updateFile && updateKey) {
    const manifest = { ...identity, ...updateFile, id: release.id, kind: desktopUpdateKind(os) };
    const signature = sign(null, desktopUpdateBytes(manifest), updateKey).toString('base64url');
    release = await api(path);
    if (release.status === 'draft' && (release.update?.sha256 !== updateFile.sha256 || release.update?.signature !== signature)) {
      release = await api(path + '/update-artifact?revision=' + release.revision, 'PUT', Bun.file(updateArchive), undefined,
        { 'X-OneX-Update-Signature': signature });
    }
    if (release.update?.sha256 !== updateFile.sha256 || release.update?.size !== updateFile.size || release.update?.signature !== signature) {
      throw new Error('Release already has a different signed update or was published without one');
    }
  }
  if (release.status === 'draft') return api(path + '/publish', 'POST', { revision: release.revision }, 'edge-publish-' + key + '-' + release.revision);
  if (release.status !== 'published') throw new Error('Choose a new version for an unlisted installer');
  return release;
}

try {
  const version = readFileSync(join(import.meta.dir, 'bun-version'), 'utf8').trim();
  if (Bun.version !== version) throw new Error(`Run with Bun ${version}`);
  let result;
  if (command === 'pack-server' && (args.length === 1 || args.length === 2)) result = await packServer(args[0], args[1]);
  else if (command === 'publish-server' && args.length === 3) result = await publishServer(args[0], args[1], args[2]);
  else if (command === 'publish-edge' && (args.length === 4 || args.length === 5)) result = await publishEdge(args[0], args[1], args[2], args[3], args[4]);
  else if (command === 'edge-update-public-key' && args.length === 0) result = createPublicKey(edgeUpdateSigningKey()).export({ format: 'jwk' }).x;
  else if (command === 'rollout' && args.length === 2) result = await waitForRollout(await connect(args[0]), args[1]);
  else throw new Error('Usage: release.ts pack-server DIR [COMMIT] | publish-server URL MANIFEST ARCHIVE | publish-edge URL OS VERSION INSTALLER [UPDATE] | edge-update-public-key | rollout URL ID');
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : 'release_failed' }));
  process.exitCode = 1;
}
