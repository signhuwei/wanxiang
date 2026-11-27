import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const tables = [
  { table: 'desktop_releases', key: 'id' },
  { table: 'desktop_release_updates', key: 'release_id' },
] as const;
type Artifact = { id: string; artifact_path: string; size: number; sha256: string };

function absolute(path: string) {
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path || path.includes('\0')) {
    throw new Error('Expected a canonical absolute path.');
  }
  return path;
}

function regularDirectory(path: string) {
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) {
    throw new Error('Expected a directory without symbolic links.');
  }
}

async function verify(path: string, row: Artifact) {
  if (!Number.isSafeInteger(row.size) || row.size <= 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) {
    throw new Error('Invalid Desktop artifact metadata.');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== row.size) throw new Error('Desktop artifact size mismatch.');
    const digest = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
    if (digest.digest('hex') !== row.sha256) throw new Error('Desktop artifact SHA-256 mismatch.');
  } finally { await file.close(); }
}

export async function relocateNativeDesktop(sourceDirectory: string, targetData: string) {
  absolute(sourceDirectory);
  regularDirectory(absolute(targetData));
  const targetDirectory = join(targetData, 'desktop-releases');
  const system = join(targetData, 'system.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const stat = lstatSync(system + suffix, { throwIfNoEntry: suffix === '' });
    if (stat && !stat.isFile()) throw new Error('Expected a regular SQLite database or sidecar.');
  }

  const db = new Database(system, { strict: true });
  try {
    db.exec('BEGIN IMMEDIATE');
    const changes: { row: Artifact; target: string; table: typeof tables[number] }[] = [];
    let verified = 0;
    for (const table of tables) {
      const rows = db.query<Artifact, []>(
        `SELECT ${table.key} AS id, artifact_path, size, sha256 FROM ${table.table}
         WHERE artifact_path IS NOT NULL OR size IS NOT NULL OR sha256 IS NOT NULL`,
      ).all();
      for (const row of rows) {
        if (verified === 0) regularDirectory(targetDirectory);
        if (typeof row.artifact_path !== 'string') throw new Error('Missing Desktop artifact path.');
        const directory = dirname(absolute(row.artifact_path));
        if (directory !== sourceDirectory && directory !== targetDirectory) {
          throw new Error('Desktop artifact path is outside the expected directories.');
        }
        const target = join(targetDirectory, basename(row.artifact_path));
        await verify(target, row);
        verified++;
        if (target !== row.artifact_path) changes.push({ row, target, table });
      }
    }
    for (const { row, target, table } of changes) {
      db.run(`UPDATE ${table.table} SET artifact_path = ? WHERE ${table.key} = ?`, [target, row.id]);
    }
    db.exec('COMMIT');
    return { verified, relocated: changes.length };
  } finally { db.close(); }
}

if (import.meta.main) {
  const [sourceDirectory, targetData, ...extra] = process.argv.slice(2);
  if (!sourceDirectory || !targetData || extra.length) {
    console.error('Usage: bun relocate-native-desktop.ts SOURCE_DESKTOP_DIRECTORY TARGET_DATA_DIRECTORY');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await relocateNativeDesktop(sourceDirectory, targetData))); }
    catch {
      console.error('Desktop artifact relocation failed. Check the offline database, source path, and restored artifacts.');
      process.exitCode = 1;
    }
  }
}
