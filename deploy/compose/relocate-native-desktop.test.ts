import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relocateNativeDesktop } from './relocate-native-desktop';

const source = '/native/one-x/data/server/desktop-releases';

function fixture() {
  const target = realpathSync(mkdtempSync(join(tmpdir(), 'onex-native-desktop-')));
  const directory = join(target, 'desktop-releases');
  mkdirSync(directory);
  const database = new Database(join(target, 'system.sqlite'));
  database.exec(`
    CREATE TABLE desktop_releases(id TEXT PRIMARY KEY, artifact_path TEXT, size INTEGER, sha256 TEXT);
    CREATE TABLE desktop_release_updates(release_id TEXT PRIMARY KEY, artifact_path TEXT, size INTEGER, sha256 TEXT);
    CREATE TABLE unrelated(path TEXT);
    INSERT INTO desktop_releases(id) VALUES ('draft');
  `);
  database.run('INSERT INTO unrelated VALUES (?)', [join(source, 'external.bin')]);

  function artifact(table: 'desktop_releases' | 'desktop_release_updates', name: string, original: string) {
    const body = `artifact:${name}`;
    const path = join(directory, name);
    writeFileSync(path, body);
    database.run(`INSERT INTO ${table} VALUES (?, ?, ?, ?)`,
      [name, original, Buffer.byteLength(body), createHash('sha256').update(body).digest('hex')]);
    return path;
  }

  const installer = artifact('desktop_releases', 'installer.bin', join(source, 'installer.bin'));
  const update = artifact('desktop_release_updates', 'update.bin', join(source, 'update.bin'));
  assertNoChange();

  function assertNoChange() {
    expect(database.query('SELECT artifact_path FROM desktop_releases WHERE id = ?').get('installer.bin'))
      .toEqual({ artifact_path: join(source, 'installer.bin') });
  }

  return {
    target, directory, installer, update, database, assertNoChange,
    finish() { database.close(); rmSync(target, { recursive: true, force: true }); },
  };
}

test('checks both Desktop tables and preserves paths on retry', async () => {
  const f = fixture();
  try {
    await expect(relocateNativeDesktop(source, f.target)).resolves.toEqual({ verified: 2, relocated: 2 });
    expect(f.database.query('SELECT artifact_path FROM desktop_releases ORDER BY id').all())
      .toEqual([{ artifact_path: null }, { artifact_path: f.installer }]);
    expect(f.database.query('SELECT artifact_path FROM desktop_release_updates').get())
      .toEqual({ artifact_path: f.update });
    expect(f.database.query('SELECT path FROM unrelated').get()).toEqual({ path: join(source, 'external.bin') });
    await expect(relocateNativeDesktop(source, f.target)).resolves.toEqual({ verified: 2, relocated: 0 });
  } finally { f.finish(); }
});

test('keeps both tables unchanged if a later artifact has wrong bytes', async () => {
  const f = fixture();
  try {
    writeFileSync(f.update, 'short');
    await expect(relocateNativeDesktop(source, f.target)).rejects.toThrow('size mismatch');
    f.assertNoChange();
    writeFileSync(f.update, 'artifact:updatf.bin');
    await expect(relocateNativeDesktop(source, f.target)).rejects.toThrow('SHA-256 mismatch');
    f.assertNoChange();
    expect(f.database.query('SELECT artifact_path FROM desktop_release_updates').get())
      .toEqual({ artifact_path: join(source, 'update.bin') });
  } finally { f.finish(); }
});

test('rejects noncanonical recorded paths and symbolic links', async () => {
  const f = fixture();
  try {
    f.database.run('UPDATE desktop_release_updates SET artifact_path = ?', [`${source}/../desktop-releases/update.bin`]);
    await expect(relocateNativeDesktop(source, f.target)).rejects.toThrow('canonical absolute path');
    f.assertNoChange();

    f.database.run('UPDATE desktop_release_updates SET artifact_path = ?', [join(source, 'update.bin')]);
    rmSync(f.update);
    symlinkSync(f.installer, f.update);
    await expect(relocateNativeDesktop(source, f.target)).rejects.toThrow();
    f.assertNoChange();
  } finally { f.finish(); }
});
