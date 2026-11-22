import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sqliteTransaction } from './sqlite-transaction';

type Params = SQLQueryBindings[];
type Reader = {
  get<T>(sql: string, params?: Params): T | null;
  all<T>(sql: string, params?: Params): T[];
};
export type Transaction = Reader & { run(sql: string, params?: Params): { changes: number } };
type Job = { execute: (sql: Transaction) => unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void };
const statementCacheSize = 20;

export class QueuedDatabase implements Reader {
  private readonly db: Database;
  private readonly tx: Transaction;
  private readonly statements = new Map<string, Statement<unknown, Params>>();
  private jobs: Job[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private readonly drained = new Set<() => void>();

  constructor(file: string, kind: 'system' | 'tenant', private readonly idle: () => void = () => {}) {
    this.db = new Database(file, { create: true, strict: true });
    this.tx = {
      get: (sql, params = []) => this.withStatement(sql, (statement) => statement.get(...params)) as never,
      all: (sql, params = []) => this.withStatement(sql, (statement) => statement.all(...params)) as never,
      run: (sql, params = []) => this.withStatement(sql, (statement) => statement.run(...params)),
    };
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      const dir = join(import.meta.dir, '../migrations', kind);
      const files = readdirSync(dir).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
      const latest = Number(files.at(-1)?.split('_')[0]);
      let { user_version: version } = this.get<{ user_version: number }>('PRAGMA user_version')!;
      if (!latest || version > latest) throw new Error(`Unsupported database version: ${version}`);
      for (const name of files) {
        const next = Number(name.split('_')[0]);
        if (next <= version) continue;
        if (next !== version + 1) throw new Error(`Missing migration ${version + 1}`);
        sqliteTransaction(this.db, () => {
          this.db.exec(readFileSync(join(dir, name), 'utf8'));
          this.db.exec(`PRAGMA user_version = ${next}`);
        });
        version = next;
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private withStatement<T>(sql: string, execute: (statement: Statement<unknown, Params>) => T): T {
    const cached = this.statements.get(sql);
    if (cached) return execute(cached);
    // Bun 1.3.5 leaves queries beyond its cache limit to garbage collection.
    if (this.statements.size >= statementCacheSize) {
      using statement = this.db.prepare<unknown, Params>(sql);
      return execute(statement);
    }
    const statement = this.db.prepare<unknown, Params>(sql);
    this.statements.set(sql, statement);
    return execute(statement);
  }

  get<T>(sql: string, params?: Params) { return this.tx.get<T>(sql, params); }
  all<T>(sql: string, params?: Params) { return this.tx.all<T>(sql, params); }
  get busy() { return this.jobs.length !== 0; }
  drain() { return this.busy ? new Promise<void>((resolve) => this.drained.add(resolve)) : Promise.resolve(); }

  write<T>(execute: (sql: Transaction) => T extends PromiseLike<unknown> ? never : T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ execute, resolve: (value) => resolve(value as T), reject });
      if (this.jobs.length >= 500) {
        this.flush();
      } else {
        this.timer ??= setTimeout(() => this.flush(), 0);
      }
    });
  }

  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.jobs.splice(0);
    try {
      const results = sqliteTransaction(this.db, () => batch.map((job) => {
        try { return { ok: true as const, value: sqliteTransaction(this.db, () => job.execute(this.tx)) }; }
        catch (error) { return { ok: false as const, error }; }
      }));
      results.forEach((result, i) => result.ok ? batch[i].resolve(result.value) : batch[i].reject(result.error));
    } catch (error) {
      for (const job of batch) job.reject(error);
    } finally {
      for (const resolve of this.drained) resolve();
      this.drained.clear();
      this.idle();
    }
  }

  close() {
    if (this.busy) throw new Error('Cannot close a SQLite queue with outstanding writes');
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    this.db.close(true);
  }
}

export type Member = { user_id: string; role: string; status: string };
export type Device = { id: string; user_id: string; token_hash: string; token_expires_at: string; status: string };

export class Store {
  readonly system: QueuedDatabase;
  private readonly tenants = new Map<string, QueuedDatabase>();

  constructor(private readonly dir: string, private readonly capacity: number) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.system = new QueuedDatabase(join(dir, 'system.sqlite'), 'system');
  }

  tenant(id: string, create = false): QueuedDatabase {
    if (!/^ten_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error('Invalid tenant ID');
    let db = this.tenants.get(id);
    if (db) this.tenants.delete(id);
    else {
      const path = join(this.dir, `tenant-${id}.sqlite`);
      if (!create && !statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing database for ${id}`);
      db = new QueuedDatabase(path, 'tenant', () => this.trim(id));
    }
    this.tenants.set(id, db);
    this.trim(id);
    return db;
  }

  private trim(keep: string) {
    for (const [id, db] of this.tenants) {
      if (this.tenants.size <= this.capacity) break;
      if (id === keep || db.busy) continue;
      db.close();
      this.tenants.delete(id);
    }
  }

  private tenantIds() {
    return this.system.all<{ id: string }>('SELECT id FROM tenants ORDER BY id').map(({ id }) => id);
  }

  async rebuildIndexes() {
    await this.system.write((sql) => {
      sql.run('DELETE FROM memberships');
      sql.run('DELETE FROM invite_directory');
      sql.run('DELETE FROM device_directory');
    });
    for (const id of this.tenantIds()) {
      const db = this.tenant(id);
      const members = db.all<Member>('SELECT user_id, role, status FROM members');
      const invites = db.all<{ code_hash: string }>('SELECT code_hash FROM invites');
      const devices = db.all<Pick<Device, 'id' | 'token_hash'>>('SELECT id, token_hash FROM devices');
      await this.system.write((sql) => {
        for (const member of members) indexMember(sql, id, member);
        for (const invite of invites) indexInvite(sql, id, invite.code_hash);
        for (const device of devices) indexDevice(sql, id, device);
      });
    }
  }

  async tenantIdsForUser(user: string) {
    const indexed = this.system.all<{ tenant_id: string }>('SELECT tenant_id FROM memberships WHERE user_id = ? ORDER BY tenant_id', [user]);
    const matches: string[] = [];
    const checked = new Set<string>();
    const check = async (id: string) => {
      checked.add(id);
      if ((await this.member(id, user))?.status === 'active') matches.push(id);
    };
    for (const row of indexed) await check(row.tenant_id);
    if (matches.length === 0) for (const id of this.tenantIds()) if (!checked.has(id)) await check(id);
    return matches;
  }

  async member(id: string, user: string) {
    const member = this.tenant(id).get<Member>('SELECT user_id, role, status FROM members WHERE user_id = ?', [user]);
    const index = this.system.get<Member>('SELECT user_id, role, status FROM memberships WHERE tenant_id = ? AND user_id = ?', [id, user]);
    if (member && (member.role !== index?.role || member.status !== index?.status)) {
      await this.system.write((sql) => indexMember(sql, id, member));
    } else if (!member && index) {
      await this.system.write((sql) => sql.run('DELETE FROM memberships WHERE tenant_id = ? AND user_id = ?', [id, user]));
    }
    return member;
  }

  private async lookup<T>(directory: 'invite_directory' | 'device_directory', field: 'code_hash' | 'token_hash', hash: string,
    find: (id: string) => T | null, index: (sql: Transaction, id: string, value: T) => void) {
    const hit = this.system.get<{ tenant_id: string }>(`SELECT tenant_id FROM ${directory} WHERE ${field} = ?`, [hash]);
    if (hit) {
      const value = find(hit.tenant_id);
      if (value) return { id: hit.tenant_id, value };
      await this.system.write((sql) => sql.run(`DELETE FROM ${directory} WHERE ${field} = ? AND tenant_id = ?`, [hash, hit.tenant_id]));
    }
    for (const id of this.tenantIds()) {
      if (id === hit?.tenant_id) continue;
      const value = find(id);
      if (!value) continue;
      await this.system.write((sql) => index(sql, id, value));
      return { id, value };
    }
    return null;
  }

  async tenantForInvite(hash: string) {
    const match = await this.lookup('invite_directory', 'code_hash', hash,
      (id) => this.tenant(id).get('SELECT 1 FROM invites WHERE code_hash = ?', [hash]),
      (sql, id) => indexInvite(sql, id, hash));
    return match?.id ?? null;
  }

  async device(hash: string) {
    return this.lookup('device_directory', 'token_hash', hash,
      (id) => this.tenant(id).get<Device>('SELECT id, user_id, token_hash, token_expires_at, status FROM devices WHERE token_hash = ?', [hash]),
      indexDevice);
  }

  async drain() {
    while (this.system.busy || [...this.tenants.values()].some((db) => db.busy)) {
      await Promise.all([this.system, ...this.tenants.values()].map((db) => db.drain()));
    }
  }

  close() {
    for (const db of this.tenants.values()) db.close();
    this.system.close();
    this.tenants.clear();
  }
}

export function indexMember(sql: Transaction, id: string, member: Member) {
  sql.run(`INSERT INTO memberships (tenant_id, user_id, role, status) VALUES (?, ?, ?, ?)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = excluded.role, status = excluded.status`, [id, member.user_id, member.role, member.status]);
}

export function indexInvite(sql: Transaction, id: string, hash: string) {
  sql.run('INSERT INTO invite_directory VALUES (?, ?) ON CONFLICT (code_hash) DO UPDATE SET tenant_id = excluded.tenant_id', [hash, id]);
}

export function indexDevice(sql: Transaction, id: string, device: Pick<Device, 'id' | 'token_hash'>) {
  sql.run(`INSERT INTO device_directory (device_id, token_hash, tenant_id) VALUES (?, ?, ?)
    ON CONFLICT (device_id) DO UPDATE SET token_hash = excluded.token_hash, tenant_id = excluded.tenant_id`, [device.id, device.token_hash, id]);
}
