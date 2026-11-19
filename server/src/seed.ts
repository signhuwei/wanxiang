import { ulid } from 'ulid';
import { day, hash, iso, normalizedTarget, randomToken } from './credentials';
import { indexInvite, indexMember, Store, type Transaction } from './store';

export type User = { id: string; email: string | null; phone: string | null; name: string; created_at: string; revision: number };

export function findUser(sql: Pick<Transaction, 'get'>, target: NonNullable<ReturnType<typeof normalizedTarget>>) {
  return sql.get<User>(`SELECT u.* FROM identities i JOIN platform_users u ON u.id = i.user_id
    WHERE i.kind = ? AND i.value = ?`, [target.kind, target.value]);
}

export function ensureUser(sql: Transaction, target: NonNullable<ReturnType<typeof normalizedTarget>>, now: number): User {
  const existing = findUser(sql, target);
  if (existing) return existing;
  const user = {
    id: `usr_${ulid()}`, email: target.kind === 'email' ? target.value : null,
    phone: target.kind === 'phone' ? target.value : null, name: target.value, created_at: iso(now), revision: 1,
  };
  sql.run('INSERT INTO platform_users (id, email, phone, name, created_at) VALUES (?, ?, ?, ?, ?)',
    [user.id, user.email, user.phone, user.name, user.created_at]);
  sql.run('INSERT INTO identities (user_id, kind, value) VALUES (?, ?, ?)', [user.id, target.kind, target.value]);
  return user;
}

export function insertInitialContract(sql: Transaction, owner: string, seats: number, now: number) {
  sql.run(`INSERT INTO contract (revision, seat_limit, allowed_agents_json, allowed_models_json, visibility_json, updated_by, updated_at)
    VALUES (1, ?, '["claude-code"]', '[]', '{}', ?, ?)`, [seats, owner, iso(now)]);
}

export async function seedTenant(store: Store, opts: { target: string; name?: string; seats?: number; maxUses?: number; now?: number; platformAdmin?: boolean }) {
  const target = normalizedTarget(opts.target);
  const seats = opts.seats ?? 10;
  const maxUses = opts.maxUses ?? 10;
  if (!target || !Number.isSafeInteger(seats) || seats < 1 || !Number.isSafeInteger(maxUses) || maxUses < 1) throw new Error('Invalid seed options');
  const now = opts.now ?? Date.now();
  const tenantId = `ten_${ulid()}`;
  const inviteCode = randomToken();
  const inviteHash = hash(inviteCode);
  const user = await store.system.write((sql) => ensureUser(sql, target, now));
  const member = { user_id: user.id, role: 'owner', status: 'active' };
  await store.tenant(tenantId, true).write((sql) => {
    sql.run('INSERT INTO members (user_id, role, status) VALUES (?, ?, ?)', [user.id, member.role, member.status]);
    insertInitialContract(sql, user.id, seats, now);
    sql.run(`INSERT INTO invites (id, code_hash, role, max_uses, expires_at, created_by) VALUES (?, ?, 'member', ?, ?, ?)`,
      [`inv_${ulid()}`, inviteHash, maxUses, iso(now + 7 * day), user.id]);
  });
  await store.system.write((sql) => {
    sql.run(`INSERT INTO tenants (id, name, owner_user_id, status, db_file, created_at) VALUES (?, ?, ?, 'active', ?, ?)`,
      [tenantId, opts.name ?? 'OneX Dev', user.id, `tenant-${tenantId}.sqlite`, iso(now)]);
    indexMember(sql, tenantId, member);
    indexInvite(sql, tenantId, inviteHash);
    if (opts.platformAdmin) sql.run('INSERT OR IGNORE INTO platform_admins (user_id) VALUES (?)', [user.id]);
  });
  return { tenantId, userId: user.id, inviteCode, inviteHash };
}

if (import.meta.main) {
  if (process.env.NODE_ENV === 'production') throw new Error('Development seed is disabled in production');
  const args = Bun.argv.slice(2);
  const platformAdmin = args.includes('--platform-admin');
  const [target, seats, name] = args.filter((arg) => arg !== '--platform-admin');
  if (!target) throw new Error('Usage: bun run seed <owner-email-or-phone> [seat-limit] [tenant-name] [--platform-admin]');
  const store = new Store(process.env.ONEX_DATA_DIR ?? '.local', 2);
  try {
    const { tenantId, userId, inviteCode } = await seedTenant(store, { target, name, seats: seats === undefined ? undefined : Number(seats), platformAdmin });
    console.log(JSON.stringify({ tenant_id: tenantId, owner_user_id: userId, invite_code: inviteCode }));
  } finally {
    store.close();
  }
}
