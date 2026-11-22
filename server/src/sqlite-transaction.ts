import type { Database } from 'bun:sqlite';

// Bun 1.3.5 leaves its transaction controller's prepared statements alive after close().
// These fixed statements use the query cache, which Bun finalizes on close.
export function sqliteTransaction<T>(db: Database, execute: () => T): T {
  const nested = db.inTransaction;
  const finish = nested ? 'RELEASE onex_write' : 'COMMIT';
  db.query(nested ? 'SAVEPOINT onex_write' : 'BEGIN IMMEDIATE').run();
  try {
    const result = execute();
    db.query(finish).run();
    return result;
  } catch (error) {
    if (db.inTransaction) {
      db.query(nested ? 'ROLLBACK TO onex_write' : 'ROLLBACK').run();
      if (nested) db.query(finish).run();
    }
    throw error;
  }
}
