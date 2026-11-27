import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, chown, copyFile, lstat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitPattern, imageIdPattern, isDockerManifest, releaseKey, verifyManifest, type DockerServerManifest } from '../../server/src/release-package';
import { activeRollout, openReleaseStore, releasePaths, type Rollout, type ServerRelease } from '../../server/src/release-store';

const dataDir = '/data/server';
const composeFile = '/opt/onex/deploy/compose/compose.yaml';
const healthUrl = 'http://server:18700/v1/healthz';
const releaseTagPrefix = 'onex-server-docker:';
const dbFilePattern = /^(?:system|tenant-[a-zA-Z0-9_-]+)\.sqlite(?:-(?:wal|shm))?$/;
const jobIdPattern = /^roll_[0-9A-HJKMNP-TV-Z]{26}$/;

type Phase = 'prepared' | 'switching' | 'restoring' | 'committed' | 'rolled_back';
type Journal = {
  jobId: string;
  previousImage: string;
  targetImage: string;
  phase: Phase;
  error?: string;
};

function syncDirectory(path: string) {
  const handle = openSync(path, 'r');
  try { fsyncSync(handle); } finally { closeSync(handle); }
}

function writeAtomic(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    const handle = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(handle, content);
      fsyncSync(handle);
    } finally { closeSync(handle); }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
}

function removeFile(path: string) {
  if (existsSync(path)) {
    unlinkSync(path);
    syncDirectory(dirname(path));
  }
}

function databaseFiles(path: string) {
  return readdirSync(path).filter(name => dbFilePattern.test(name)).sort();
}

async function copyDatabase(source: string, target: string) {
  const info = await lstat(source);
  if (!info.isFile()) throw new Error('SQLite path is not a regular file');
  await copyFile(source, target, constants.COPYFILE_EXCL);
  const copied = await lstat(target);
  if (info.uid !== copied.uid || info.gid !== copied.gid) await chown(target, info.uid, info.gid);
  await chmod(target, info.mode & 0o777);
  const handle = await open(target, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// Only the business databases belong to the activation snapshot. The release queue stays live
// in the separate maintenance volume even while Server is replaced or its schema is restored.
export async function snapshotDatabases(source: string, backup: string) {
  const files = databaseFiles(source);
  if (!files.includes('system.sqlite')) throw new Error('System SQLite database is missing');
  const staging = `${backup}.incoming`;
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const name of files) await copyDatabase(join(source, name), join(staging, name));
    syncDirectory(staging);
    renameSync(staging, backup);
    syncDirectory(dirname(backup));
    syncDirectory(dirname(dirname(backup)));
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export async function restoreDatabases(backup: string, target: string) {
  const files = new Set(databaseFiles(backup));
  if (!files.has('system.sqlite')) throw new Error('System SQLite snapshot is missing');
  const previous = databaseFiles(target);
  for (const name of files) {
    const temporary = join(target, `.onex-restore-${name}`);
    rmSync(temporary, { force: true });
    try {
      await copyDatabase(join(backup, name), temporary);
      renameSync(temporary, join(target, name));
    } finally { rmSync(temporary, { force: true }); }
  }
  // Candidate migrations can leave a different WAL or create a new tenant database. Never
  // attach these files to a database snapshot from before the candidate was started.
  for (const name of previous) if (!files.has(name)) unlinkSync(join(target, name));
  syncDirectory(target);
}

async function command(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(args, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (status !== 0) throw new Error(`${args[0]} exited with ${status}`);
  return output.trim();
}

function docker(args: string[], env?: NodeJS.ProcessEnv) {
  return command(['docker', '--host', 'unix:///var/run/docker.sock', ...args], env);
}

function compose(project: string, args: string[], image?: string) {
  return docker(['compose', '--project-name', project, '--file', composeFile, ...args],
    image ? { ...process.env, ONEX_SERVER_IMAGE: image } : undefined);
}

function runningContainers(project: string) {
  return docker(['container', 'ls', '--quiet',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=server',
    '--filter', 'label=com.docker.compose.oneoff=False']);
}

async function runningImage(project: string) {
  const container = await runningContainers(project);
  if (!container) return null;
  if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Expected one running Server container');
  const image = await docker(['container', 'inspect', '--format', '{{.Image}}', container]);
  if (!imageIdPattern.test(image)) throw new Error('Invalid running image ID');
  return image;
}

async function healthyCommit() {
  try {
    const health = JSON.parse(await command(['curl', '--noproxy', '*', '-fsS', '--max-time', '3', healthUrl]));
    return health.status === 'ok' && typeof health.commit === 'string' && commitPattern.test(health.commit)
      ? health.commit : null;
  } catch { return null; }
}

async function waitHealthy(project: string, image: string, commit: string) {
  const deadline = Date.now() + 90_000;
  do {
    if (await healthyCommit() === commit && await runningImage(project) === image) return;
    await Bun.sleep(1_000);
  } while (Date.now() < deadline);
  throw new Error('Server did not become healthy');
}

async function stopServer(project: string, image: string) {
  await compose(project, ['stop', 'server'], image);
  if (await runningContainers(project)) throw new Error('Server did not stop');
}

function recreateServer(project: string, image: string) {
  return compose(project, ['up', '--detach', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'server'], image);
}

async function loadImage(artifact: string, manifest: DockerServerManifest, identity: string) {
  const file = lstatSync(artifact);
  if (!file.isFile() || file.size !== manifest.size) throw new Error('Unexpected release artifact');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  if (hash.digest('hex') !== manifest.sha256) throw new Error('Release artifact digest mismatch');

  const temporary = mkdtempSync(join(tmpdir(), 'onex-release-'));
  try {
    const archive = join(temporary, 'server.tar.gz');
    await command(['age', '--decrypt', '--identity', identity, '--output', archive, artifact]);
    await docker(['image', 'load', '--input', archive]);
    const expected = `${manifest.image_id} ${manifest.platform} ${manifest.commit}`;
    const actual = await docker(['image', 'inspect', '--format',
      '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}',
      `${releaseTagPrefix}${manifest.commit}`]);
    if (actual !== expected) throw new Error('Loaded image does not match signed manifest');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function readJournal(path: string): Journal | null {
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (!state || typeof state.jobId !== 'string' || !jobIdPattern.test(state.jobId)
    || typeof state.previousImage !== 'string' || !imageIdPattern.test(state.previousImage)
    || typeof state.targetImage !== 'string' || !imageIdPattern.test(state.targetImage)
    || !['prepared', 'switching', 'restoring', 'committed', 'rolled_back'].includes(state.phase)
    || (state.error !== undefined && !['interrupted', 'activation_failed', 'health_check_failed'].includes(state.error))) {
    throw new Error('Invalid Docker rollout journal');
  }
  return state;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function runWorker() {
  const project = requiredEnv('ONEX_PROJECT_NAME');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('Invalid Compose project name');
  const guard = requiredEnv('ONEX_RELEASE_MAINTENANCE_FILE');
  const heartbeat = requiredEnv('ONEX_RELEASE_HEARTBEAT');
  const identity = requiredEnv('ONEX_RELEASE_DECRYPTION_KEY_FILE');
  const key = releaseKey(requiredEnv('ONEX_RELEASE_PUBLIC_KEY'));
  if (!key || !lstatSync(identity).isFile()) throw new Error('OneX release identity or public key is missing');
  const publicKey = key;
  const paths = releasePaths(dataDir);
  const journalPath = join(paths.dir, '.docker-rollout.json');
  const activeImage = join(paths.dir, 'active-image');
  const db = openReleaseStore(dataDir);
  const backup = (jobId: string) => join(paths.dir, '.docker-rollout-backups', jobId);

  function setState(state: Journal, phase: Phase, error?: string) {
    const next = { ...state, phase, error };
    writeAtomic(journalPath, `${JSON.stringify(next)}\n`);
    return next;
  }

  function guardWrites(job: Rollout) {
    if (existsSync(guard)) {
      if (readFileSync(guard, 'utf8').trim() !== job.id) throw new Error('Another maintenance guard is active');
    } else writeAtomic(guard, `${job.id}\n`);
  }

  function finish(job: Rollout, error: string | null, observed: string | null) {
    const status = error ? 'failed' : 'succeeded';
    const result = db.run('UPDATE server_rollouts SET status = ?, error_code = ?, observed_commit = ?, finished_at = ? WHERE id = ? AND status = ?',
      [status, error, observed, new Date().toISOString(), job.id, 'running']);
    if (result.changes) console.log(JSON.stringify({ rollout_id: job.id, status, error_code: error, observed_commit: observed }));
  }

  function complete(job: Rollout, state: Journal) {
    const committed = state.phase === 'committed';
    if (existsSync(guard) && readFileSync(guard, 'utf8').trim() !== job.id) throw new Error('Another maintenance guard is active');
    writeAtomic(activeImage, `${committed ? state.targetImage : state.previousImage}\n`);
    finish(job, committed ? null : state.error ?? 'interrupted', committed ? job.commit : job.expected_commit);
    removeFile(guard);
    removeFile(journalPath);
    rmSync(`${backup(job.id)}.incoming`, { recursive: true, force: true });
    if (committed) rmSync(backup(job.id), { recursive: true, force: true });
  }

  async function recover(job: Rollout, state: Journal, failure = 'interrupted') {
    if (state.phase === 'committed' || state.phase === 'rolled_back') {
      complete(job, state);
      return;
    }
    guardWrites(job);
    if (state.phase === 'switching' || state.phase === 'restoring') {
      state = setState(state, 'restoring', state.error ?? failure);
      await stopServer(project, state.previousImage);
      await restoreDatabases(backup(job.id), dataDir);
      await recreateServer(project, state.previousImage);
      await waitHealthy(project, state.previousImage, job.expected_commit);
    } else if (await healthyCommit() !== job.expected_commit || await runningImage(project) !== state.previousImage) {
      await stopServer(project, state.previousImage);
      await recreateServer(project, state.previousImage);
      await waitHealthy(project, state.previousImage, job.expected_commit);
    }
    complete(job, setState(state, 'rolled_back', state.error ?? failure));
  }

  async function deploy(job: Rollout) {
    let error = 'invalid_artifact';
    try {
      if (!jobIdPattern.test(job.id) || !commitPattern.test(job.commit) || !commitPattern.test(job.expected_commit)) {
        throw new Error('Invalid Docker rollout job');
      }
      if (existsSync(guard)) throw new Error('Maintenance guard already active');
      const observed = await healthyCommit();
      const previousImage = await runningImage(project);
      if (observed !== job.expected_commit || !previousImage) {
        finish(job, 'active_commit_changed', observed);
        return;
      }
      const manifest = db.query<ServerRelease, [string]>('SELECT * FROM server_releases WHERE "commit" = ?').get(job.commit);
      if (!manifest?.uploaded_at || !isDockerManifest(manifest) || !verifyManifest(publicKey, manifest)) {
        throw new Error('Invalid signed Docker manifest');
      }
      await loadImage(paths.artifact(manifest.commit, manifest.format), manifest, identity);
      if (await healthyCommit() !== job.expected_commit || await runningImage(project) !== previousImage) {
        finish(job, 'active_commit_changed', await healthyCommit());
        return;
      }
      if (previousImage === manifest.image_id && job.commit === job.expected_commit) {
        writeAtomic(activeImage, `${previousImage}\n`);
        finish(job, null, job.commit);
        return;
      }

      error = 'activation_failed';
      let state = setState({ jobId: job.id, previousImage, targetImage: manifest.image_id, phase: 'prepared' }, 'prepared');
      guardWrites(job);
      await stopServer(project, previousImage);
      await snapshotDatabases(dataDir, backup(job.id));
      state = setState(state, 'switching');
      await recreateServer(project, manifest.image_id);
      error = 'health_check_failed';
      await waitHealthy(project, manifest.image_id, job.commit);
      complete(job, setState(state, 'committed'));
    } catch (cause) {
      console.error(JSON.stringify({ rollout_id: job.id, phase: error, error: cause instanceof Error ? cause.message : 'Unknown error' }));
      const state = readJournal(journalPath);
      if (state) await recover(job, state, error);
      else finish(job, error, await healthyCommit());
    }
  }

  const claim = db.transaction(() => {
    const job = activeRollout(db);
    if (job?.status === 'queued') db.run("UPDATE server_rollouts SET status = 'running', started_at = ? WHERE id = ?",
      [new Date().toISOString(), job.id]);
    return job;
  });

  function publishHeartbeat() { writeAtomic(heartbeat, ''); }
  publishHeartbeat();
  const timer = setInterval(() => {
    try { publishHeartbeat(); } catch { console.error('Could not publish release worker heartbeat'); }
  }, 5_000);
  let terminating = false;
  process.once('SIGINT', () => { terminating = true; });
  process.once('SIGTERM', () => { terminating = true; });
  try {
    while (!terminating) {
      try {
        const state = readJournal(journalPath);
        if (state) {
          const job = db.query<Rollout, [string]>('SELECT * FROM server_rollouts WHERE id = ?').get(state.jobId);
          if (!job) throw new Error('Docker rollout journal has no corresponding job');
          await recover(job, state);
        } else {
          const job = claim.immediate();
          if (job?.status === 'queued') await deploy(job);
          else if (job) finish(job, 'interrupted', await healthyCommit());
        }
      } catch (cause) {
        console.error(JSON.stringify({ error: cause instanceof Error ? cause.message : 'Unknown release worker error' }));
      }
      await Bun.sleep(2_000);
    }
  } finally {
    clearInterval(timer);
    db.close();
  }
}

if (import.meta.main) await runWorker();
