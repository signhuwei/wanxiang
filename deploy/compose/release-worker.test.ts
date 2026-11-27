import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreDatabases, snapshotDatabases } from './release-worker';

test('Docker rollback restores SQLite and sidecars without reverting the release queue or file artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onex-release-db-'));
  try {
    const data = join(root, 'server');
    const maintenance = join(data, 'maintenance');
    const backup = join(maintenance, '.backups', 'rollout');
    mkdirSync(maintenance, { recursive: true });
    writeFileSync(join(data, 'system.sqlite'), 'old system', { mode: 0o640 });
    writeFileSync(join(data, 'system.sqlite-wal'), 'old system WAL');
    writeFileSync(join(data, 'tenant-t_123.sqlite'), 'old tenant');
    writeFileSync(join(maintenance, 'releases.sqlite'), 'old queue');
    writeFileSync(join(data, 'desktop.pkg'), 'artifact');

    await snapshotDatabases(data, backup);
    expect(readdirSync(backup).sort()).toEqual(['system.sqlite', 'system.sqlite-wal', 'tenant-t_123.sqlite']);

    writeFileSync(join(data, 'system.sqlite'), 'candidate schema');
    writeFileSync(join(data, 'system.sqlite-wal'), 'candidate WAL');
    writeFileSync(join(data, 'tenant-t_123.sqlite-shm'), 'candidate SHM');
    writeFileSync(join(data, 'tenant-t_456.sqlite'), 'candidate tenant');
    writeFileSync(join(maintenance, 'releases.sqlite'), 'active rollback job');

    // A process interrupted during restore can apply the same snapshot again.
    await restoreDatabases(backup, data);
    await restoreDatabases(backup, data);
    expect(readdirSync(data).sort()).toEqual([
      'desktop.pkg', 'maintenance', 'system.sqlite', 'system.sqlite-wal', 'tenant-t_123.sqlite',
    ]);
    expect(readFileSync(join(data, 'system.sqlite'), 'utf8')).toBe('old system');
    expect(statSync(join(data, 'system.sqlite')).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(data, 'system.sqlite-wal'), 'utf8')).toBe('old system WAL');
    expect(readFileSync(join(maintenance, 'releases.sqlite'), 'utf8')).toBe('active rollback job');
    expect(readFileSync(join(data, 'desktop.pkg'), 'utf8')).toBe('artifact');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Docker snapshot rejects a linked database instead of copying an external file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onex-release-db-'));
  try {
    const data = join(root, 'server');
    mkdirSync(data);
    const unrelated = join(root, 'unrelated');
    writeFileSync(unrelated, 'outside the database directory');
    symlinkSync(unrelated, join(data, 'system.sqlite'));
    await expect(snapshotDatabases(data, join(root, 'snapshot'))).rejects.toThrow('not a regular file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
