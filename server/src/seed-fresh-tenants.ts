import { lstatSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { day, hash, iso, personalLoginTokenPattern } from './credentials';
import { indexMember, Store, type Member } from './store';
import { hashLoginPassword, normalizeLoginName, validLoginPassword } from './tenant-passwords';

type LoginAccount = { username: string; usernameKey: string; password: string; role: 'owner' | 'member' };
type NewTenant = { name: string; shortName: string; shortNameKey: string; owner: LoginAccount; employees: LoginAccount[] };

function account(value: unknown, role: LoginAccount['role']): LoginAccount {
  const fields = value as { username?: unknown; password?: unknown } | null;
  const username = normalizeLoginName(fields?.username);
  const password = fields?.password;
  if (!username || !validLoginPassword(password) || password.length < 16) throw new Error('Invalid bootstrap account');
  return { username: username.display, usernameKey: username.key, password, role };
}

function tenant(value: unknown): NewTenant {
  const fields = value as { name?: unknown; short_name?: unknown; owner?: unknown; employees?: unknown } | null;
  const shortName = normalizeLoginName(fields?.short_name);
  const name = fields?.name;
  if (!shortName || typeof name !== 'string' || !name.trim() || name.length > 128 || !Array.isArray(fields?.employees)) {
    throw new Error('Invalid bootstrap tenant');
  }
  const owner = account(fields.owner, 'owner');
  const employees = fields.employees.map((row) => account(row, 'member'));
  if (new Set([owner, ...employees].map(({ usernameKey }) => usernameKey)).size !== employees.length + 1) {
    throw new Error('Duplicate bootstrap username within one tenant');
  }
  return { name: name.trim(), shortName: shortName.display, shortNameKey: shortName.key, owner, employees };
}

process.umask(0o077);
if (process.argv.length !== 3) throw new Error('Usage: bun --no-env-file server/src/seed-fresh-tenants.ts EMPTY_DATA_DIRECTORY < credentials.json');
const dataDir = resolve(process.argv[2]!);
const directory = lstatSync(dataDir);
if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || readdirSync(dataDir).length !== 0) {
  throw new Error('Seeding requires an empty private directory');
}
const input = await Bun.stdin.json() as { master_token?: unknown; tenants?: unknown } | null;
if (typeof input?.master_token !== 'string' || !personalLoginTokenPattern.test(input.master_token) ||
  !Array.isArray(input.tenants) || input.tenants.length === 0) throw new Error('Invalid fresh deployment input');

const tenants = input.tenants.map(tenant);
const master = `usr_${ulid()}`;
const masterHash = hash(input.master_token);
const now = Date.now();
const store = new Store(dataDir, 2);
try {
  await store.system.write((sql) => {
    sql.run('INSERT INTO platform_users (id, name, created_at) VALUES (?, ?, ?)', [master, 'master', iso(now)]);
    sql.run('INSERT INTO platform_admins (user_id) VALUES (?)', [master]);
    sql.run(`INSERT INTO personal_login_tokens (id, user_id, name, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [`pat_${ulid()}`, master, 'Fresh deployment master', masterHash, iso(now), iso(now + 30 * day)]);
  });

  const provisioned = [];
  for (const entry of tenants) {
    const id = `ten_${ulid()}`;
    const accounts: (LoginAccount & { userId: string; passwordHash: string })[] = [];
    for (const login of [entry.owner, ...entry.employees]) {
      accounts.push({ ...login, userId: `usr_${ulid()}`, passwordHash: await hashLoginPassword(login.password) });
    }
    const members: Member[] = accounts.map((login) => ({ user_id: login.userId, role: login.role, status: 'active' }));
    await store.tenant(id, true).write((sql) => {
      for (const member of members) {
        sql.run('INSERT INTO members (user_id, role, status) VALUES (?, ?, ?)', [member.user_id, member.role, member.status]);
      }
    });
    await store.system.write((sql) => {
      for (const login of accounts) {
        sql.run('INSERT INTO platform_users (id, name, created_at) VALUES (?, ?, ?)', [login.userId, login.username, iso(now)]);
      }
      sql.run(`INSERT INTO tenants (id, name, owner_user_id, status, db_file, created_at, short_name, short_name_key)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`, [id, entry.name, accounts[0]!.userId, `tenant-${id}.sqlite`, iso(now), entry.shortName, entry.shortNameKey]);
      for (const member of members) indexMember(sql, id, member);
      for (const login of accounts) {
        sql.run(`INSERT INTO tenant_login_accounts (tenant_id, username, username_key, user_id, password_hash)
          VALUES (?, ?, ?, ?, ?)`, [id, login.username, login.usernameKey, login.userId, login.passwordHash]);
      }
    });
    provisioned.push({ tenant_id: id, short_name: entry.shortName, accounts: accounts.map(({ username, role }) => ({ username, role })) });
  }
  console.log(JSON.stringify({ tenants: provisioned }));
} finally {
  store.close();
}
