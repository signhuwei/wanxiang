import { createHash, createPrivateKey } from 'node:crypto';
import { createReadStream, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { commitPattern, DOCKER_RELEASE_FORMAT, DOCKER_RELEASE_PLATFORM, MAX_RELEASE_BYTES, signManifest } from '../../server/src/release-package';

const root = resolve(import.meta.dir, '../..');
const composePath = 'deploy/compose';
const serverImage = (commit: string) => `onex-server-docker:${commit}`;
const workerImage = (commit: string) => `onex-release-runner:${commit}`;

function setting(name: string) {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`${command.slice(0, 2).join(' ')} failed`);
}

async function capture(command: string[]) {
  const child = Bun.spawn(command, { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`${command.slice(0, 2).join(' ')} failed`);
  return output.trim();
}

async function extractCommit(commit: string, directory: string) {
  const git = Bun.spawn(['git', 'archive', commit, 'server', composePath], {
    cwd: root, stdout: 'pipe', stderr: 'inherit',
  });
  const tar = Bun.spawn(['tar', '-xf', '-', '-C', directory], { stdin: git.stdout, stderr: 'inherit' });
  if ((await Promise.all([git.exited, tar.exited])).some(status => status !== 0)) throw new Error('Could not extract Git commit');
}

async function build(directory: string, target: string, image: string, commit: string) {
  const args = ['docker', 'buildx', 'build', '--platform', DOCKER_RELEASE_PLATFORM, '--load', '--target', target,
    '--build-arg', `ONEX_REVISION=${commit}`, '-f', `${composePath}/Dockerfile`, '-t', image];
  for (const name of ['BUN_IMAGE', 'DOCKER_CLI_IMAGE'] as const) {
    if (Bun.env[name]) args.push('--build-arg', `${name}=${Bun.env[name]}`);
  }
  await run([...args, '.'], directory);
}

async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), size: Bun.file(path).size };
}

async function saveImages(images: string[], destination: string) {
  const save = Bun.spawn(['docker', 'image', 'save', ...images], { stdout: 'pipe', stderr: 'inherit' });
  const gzip = Bun.spawn(['gzip', '-n'], { stdin: save.stdout, stdout: Bun.file(destination), stderr: 'inherit' });
  if ((await Promise.all([save.exited, gzip.exited])).some(status => status !== 0)) throw new Error('Could not export Docker images');
}

async function packUpgrade(commit: string, directory: string, staging: string) {
  const recipient = setting('ONEX_RELEASE_RECIPIENT');
  if (!/^age1[0-9a-z]+$/.test(recipient)) throw new Error('ONEX_RELEASE_RECIPIENT must be an age public recipient');
  const key = createPrivateKey(readFileSync(setting('ONEX_RELEASE_PRIVATE_KEY')));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 release signing key');
  const image = serverImage(commit);
  await build(directory, 'server', image, commit);
  const imageId = await capture(['docker', 'image', 'inspect', '--format', '{{.Id}}', image]);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Missing Docker image ID');
  const plaintext = join(directory, 'server.tar.gz');
  const encrypted = join(staging, 'server.tar.gz.age');
  await saveImages([image], plaintext);
  try {
    await run(['age', '-r', recipient, '-o', encrypted, plaintext]);
  } finally {
    rmSync(plaintext, { force: true });
  }
  const artifact = await digest(encrypted);
  if (artifact.size > MAX_RELEASE_BYTES) throw new Error(`Encrypted image exceeds ${MAX_RELEASE_BYTES} bytes`);
  const manifest = signManifest(key, {
    commit, ...artifact, format: DOCKER_RELEASE_FORMAT, platform: DOCKER_RELEASE_PLATFORM, image_id: imageId,
  });
  writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function publicOrigin() {
  const input = setting('ONEX_PUBLIC_ORIGIN');
  const origin = new URL(input);
  if (!['http:', 'https:'].includes(origin.protocol) || ![origin.origin, `${origin.origin}/`].includes(input)) {
    throw new Error('ONEX_PUBLIC_ORIGIN must be an HTTP or HTTPS origin');
  }
  return origin.origin;
}

async function packBootstrap(commit: string, directory: string, staging: string) {
  const origin = publicOrigin();
  const server = serverImage(commit);
  const worker = workerImage(commit);
  const valkey = Bun.env.ONEX_VALKEY_IMAGE ?? 'valkey/valkey:8.1.5';
  const rustfs = Bun.env.ONEX_RUSTFS_IMAGE ?? 'rustfs/rustfs:1.0.6';
  for (const image of [valkey, rustfs]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:/@._-]+$/.test(image)) throw new Error('Invalid sidecar image reference');
  }
  await build(directory, 'server', server, commit);
  await build(directory, 'release-worker', worker, commit);
  for (const image of [valkey, rustfs]) {
    await run(['docker', 'pull', '--platform', DOCKER_RELEASE_PLATFORM, image]);
  }
  const archive = join(staging, 'images.tar.gz');
  await saveImages([server, worker, valkey, rustfs], archive);
  writeFileSync(join(staging, 'images.sha256'), `${(await digest(archive)).sha256}\n`);
  for (const file of ['compose.yaml', 'bootstrap.sh']) {
    copyFileSync(join(directory, composePath, file), join(staging, file));
  }
  writeFileSync(join(staging, 'deployment.env'), [
    'ONEX_PROJECT_NAME=onex', `ONEX_PUBLIC_ORIGIN=${origin}`, 'ONEX_HOST_PORT=18700',
    `ONEX_SERVER_IMAGE=${server}`, `ONEX_WORKER_IMAGE=${worker}`,
    `ONEX_VALKEY_IMAGE=${valkey}`, `ONEX_RUSTFS_IMAGE=${rustfs}`, '',
  ].join('\n'));
}

async function main() {
  const [mode, output, revision = 'HEAD', ...rest] = process.argv.slice(2);
  if ((mode !== 'bootstrap' && mode !== 'upgrade') || !output || rest.length) {
    throw new Error('Usage: bun deploy/compose/pack.ts <bootstrap|upgrade> OUTPUT_DIR [COMMIT]');
  }
  const pinnedBun = readFileSync(join(root, 'deploy/bun-version'), 'utf8').trim();
  if (Bun.version !== pinnedBun) throw new Error(`Run with Bun ${pinnedBun}`);
  const commit = await capture(['git', 'rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
  if (!commitPattern.test(commit)) throw new Error('Invalid Git commit');
  const destination = join(resolve(output), `${mode}-${commit}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (existsSync(destination)) throw new Error(`Release already exists. Reuse the existing artifact at ${destination}`);
  const scratch = mkdtempSync(join(dirname(destination), '.onex-image-build.'));
  const directory = join(scratch, 'source');
  const staging = join(scratch, 'output');
  mkdirSync(directory);
  mkdirSync(staging, { mode: 0o700 });
  try {
    await extractCommit(commit, directory);
    if (mode === 'bootstrap') await packBootstrap(commit, directory, staging);
    else await packUpgrade(commit, directory, staging);
    renameSync(staging, destination);
    console.log(JSON.stringify({ commit, bundle: destination }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
