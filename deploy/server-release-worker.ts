import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdtempSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeRollout, openReleaseStore, releasePaths, type Rollout, type ServerRelease } from '../server/src/release-store';
import { commitPattern, isManifest, releaseKey, verifyManifest } from '../server/src/release-package';

const [, , home] = process.argv;
if (!home || !/^\/[a-zA-Z0-9_./-]+$/.test(home)) throw new Error('Invalid OneX home');
const dataDir = join(home, 'data/server');
const run = join(home, 'run');
const db = openReleaseStore(dataDir);
const key = releaseKey(join(home, 'secrets/server-release.pub'));
if (!key) throw new Error('OneX Server release public key is missing');

function linkedCommit() {
  try {
    const target = /^releases\/([0-9a-f]{40})$/.exec(readlinkSync(join(home, 'current')));
    return target?.[1] ?? null;
  } catch { return null; }
}
async function healthyCommit() {
  const address = process.env.ONEX_HOST ?? '127.0.0.1';
  const port = process.env.ONEX_PORT ?? '18700';
  if (!/^[a-zA-Z0-9.:_-]+$/.test(address) || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return null;
  const host = address === '0.0.0.0' ? '127.0.0.1' : address.includes(':') ? `[${address === '::' ? '::1' : address}]` : address;
  try {
    // Use the direct local probe regardless of host proxy settings.
    const probe = Bun.spawnSync(['/usr/bin/curl', '--noproxy', '*', '-fsS', '--max-time', '3', `http://${host}:${port}/v1/healthz`],
      { stderr: 'ignore' });
    if (probe.exitCode !== 0) return null;
    const result = JSON.parse(probe.stdout.toString());
    return result.status === 'ok' && typeof result.commit === 'string' && commitPattern.test(result.commit) ? result.commit : null;
  } catch { return null; }
}

function finish(job: Rollout, error: string | null, observed: string | null) {
  db.run('UPDATE server_rollouts SET status = ?, error_code = ?, observed_commit = ?, finished_at = ? WHERE id = ? AND status = ?',
    [error ? 'failed' : 'succeeded', error, observed, new Date().toISOString(), job.id, 'running']);
  console.log(JSON.stringify({ rollout_id: job.id, status: error ? 'failed' : 'succeeded', error_code: error, observed_commit: observed }));
}

function heartbeat() {
  const temp = join(run, '.release-worker-heartbeat');
  writeFileSync(temp, '', { mode: 0o600 });
  renameSync(temp, join(run, 'release-worker-heartbeat'));
}
function command(args: string[]) {
  return Bun.spawnSync(args, { cwd: import.meta.dir, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ONEX_HOME: home } }).exitCode === 0;
}

try {
  heartbeat();
  const job = db.transaction(() => {
    const row = activeRollout(db);
    if (row?.status === 'queued') db.run("UPDATE server_rollouts SET status = 'running', started_at = ? WHERE id = ?",
      [new Date().toISOString(), row.id]);
    return row;
  }).immediate();
  if (job) {
    const observed = await healthyCommit();
    if (job.status === 'running') {
      // A prior process stopped before recording its result. Check the real running commit.
      finish(job, observed === job.commit && linkedCommit() === job.commit ? null : 'interrupted', observed);
    } else if (observed !== job.expected_commit || linkedCommit() !== job.expected_commit) {
      finish(job, 'active_commit_changed', observed);
    } else {
      let error: string | null = 'invalid_artifact';
      let stage: string | undefined;
      try {
        const row = db.query<ServerRelease, [string]>('SELECT * FROM server_releases WHERE "commit" = ?').get(job.commit);
        if (row?.uploaded_at && isManifest(row) && verifyManifest(key, row)) {
          const artifact = releasePaths(dataDir).artifact(row.commit);
          const info = lstatSync(artifact, { throwIfNoEntry: false });
          if (info?.isFile() && info.size === row.size) {
            const digest = createHash('sha256');
            for await (const chunk of createReadStream(artifact)) digest.update(chunk);
            if (digest.digest('hex') === row.sha256) {
              stage = mkdtempSync(join(home, 'releases', '.incoming.'));
              if (command(['/usr/bin/python3', join(import.meta.dir, 'server-release-extract.py'), artifact, stage])) {
                error = 'activation_failed';
                if (job.commit === observed || command(['/bin/bash', join(import.meta.dir, 'remote-release.sh'), 'deploy', row.commit, stage, job.expected_commit])) {
                  error = await healthyCommit() === job.commit && linkedCommit() === job.commit ? null : 'health_check_failed';
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('OneX rollout failed', { rollout_id: job.id, stage: error, name: err instanceof Error ? err.name : 'unknown' });
      } finally {
        if (stage) rmSync(stage, { recursive: true, force: true });
      }
      finish(job, error, await healthyCommit());
    }
  }
  heartbeat();
} finally {
  db.close();
}
