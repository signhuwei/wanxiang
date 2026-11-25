import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { seedTenant } from '../src/seed';
import { legacyPolicyRetired, readContract } from '../src/capability-data';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(capacity = 2) {
  const path = mkdtempSync(join(tmpdir(), 'onex-store-'));
  roots.push(path);
  return new Store(path, capacity);
}

test('migrations persist version, WAL mode and independent tenant databases', async () => {
  const db = store(1);
  try {
    const a = await seedTenant(db, { target: 'a@example.test', platformAdmin: true });
    const b = await seedTenant(db, { target: 'b@example.test' });
    expect(db.system.all('SELECT user_id FROM platform_admins')).toEqual([{ user_id: a.userId }]);
    const first = db.tenant(a.tenantId);
    expect(first.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    expect(first.get('PRAGMA user_version')).toEqual({ user_version: 24 });
    // 006_lease_overage：整表重建后索引还在，CHECK 放开到包含 overage_pending 但仍拒绝别的字符串
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ledger_by_kind_and_at'"))
      .toEqual({ name: 'ledger_by_kind_and_at' });
    await db.tenant(a.tenantId).write((sql) => {
      sql.run("INSERT INTO ledger (id, kind, amount_milli, at) VALUES ('led_x', 'overage_pending', 1, '2026-01-01T00:00:00.000Z')");
      expect(() => sql.run("INSERT INTO ledger (id, kind, amount_milli, at) VALUES ('led_y', 'bogus', 1, '2026-01-01T00:00:00.000Z')")).toThrow();
    });
    expect(db.tenant(b.tenantId).get('SELECT user_id FROM members')).toEqual({ user_id: b.userId });
    expect(() => first.get('SELECT 1')).toThrow();
    expect(db.tenant(a.tenantId).get('SELECT user_id FROM members')).toEqual({ user_id: a.userId });
    expect(db.system.get('PRAGMA user_version')).toEqual({ user_version: 26 });
    const starter = db.system.get<{ entries_json: string }>(
      "SELECT entries_json FROM policy_templates WHERE id = 'team' AND version = 1")!;
    const choices = Object.fromEntries((JSON.parse(starter.entries_json) as { clause_ref: { id: string }; value: unknown }[])
      .map(({ clause_ref, value }) => [clause_ref.id, value]));
    expect(choices).toMatchObject({ 'seats.limit': 50, 'lease.budget': 0, 'access.agents': [], 'access.models': [], 'quota.distribution': true });
  } finally {
    db.close();
  }
});

test('closing a store finalizes queries beyond the statement cache', () => {
  const db = store();
  try {
    for (let n = 0; n < 24; n++) {
      expect(db.system.get(`SELECT ${n} AS n`)).toEqual({ n });
    }
  } finally {
    db.close();
  }
});

test('existing contract rows migrate intact without becoming signed entitlements', () => {
  const path = mkdtempSync(join(tmpdir(), 'onex-contract-migration-'));
  roots.push(path);
  const tenantId = 'ten_00000000000000000000000001';
  const legacy = new Database(join(path, `tenant-${tenantId}.sqlite`));
  try {
    const migrationDir = join(import.meta.dir, '../migrations/tenant');
    for (const name of readdirSync(migrationDir).filter(name => /^00[1-9]_/.test(name)).sort()) {
      legacy.exec(readFileSync(join(migrationDir, name), 'utf8'));
    }
    legacy.exec(`PRAGMA user_version = 9;
      INSERT INTO contract (revision, seat_limit, allowed_agents_json, allowed_models_json, visibility_json, updated_by, updated_at)
      VALUES (2, 34, '["codex"]', '["old_model"]', '{}', 'usr_old', '2026-11-20T00:00:00Z');`);
  } finally { legacy.close(); }
  const db = new Store(path, 1);
  try {
    const tenant = db.tenant(tenantId);
    expect(tenant.get('SELECT revision, seat_limit, allowed_models_json, platform_revision, tenant_revision, quota_distribution FROM contract'))
      .toEqual({ revision: 2, seat_limit: 34, allowed_models_json: '["old_model"]', platform_revision: 0, tenant_revision: 0, quota_distribution: 1 });
    expect(tenant.all('SELECT revision FROM platform_contracts')).toEqual([]);
    expect(tenant.all('SELECT revision FROM tenant_configurations')).toEqual([]);
    expect(tenant.all('SELECT revision FROM policy_signatures')).toEqual([]);
    expect(tenant.all('SELECT policy_revision FROM policy_head')).toEqual([]);
    expect(legacyPolicyRetired(tenant)).toBe(true);
    expect(readContract(tenant)).toBeNull();
    expect(tenant.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' });
  } finally { db.close(); }
});

test('concurrent writes survive eviction pressure and a failing write rolls back only its savepoint', async () => {
  const db = store(1);
  try {
    const a = await seedTenant(db, { target: 'a@example.test' });
    const b = await seedTenant(db, { target: 'b@example.test' });
    const jobs = Array.from({ length: 1_200 }, (_, i) => db.tenant(i % 2 ? a.tenantId : b.tenantId).write((sql) => {
      sql.run('INSERT INTO groups (id, name) VALUES (?, ?)', [String(i), 'parallel']);
    }));
    const failed = db.tenant(a.tenantId).write((sql) => {
      sql.run("INSERT INTO groups (id, name) VALUES ('rollback', 'temporary')");
      sql.run("INSERT INTO groups (id, name) VALUES ('rollback', 'duplicate')");
    });
    await Promise.all([Promise.all(jobs), expect(failed).rejects.toThrow()]);
    for (const id of [a.tenantId, b.tenantId]) {
      expect(db.tenant(id).get('SELECT count(*) AS n FROM groups')).toEqual({ n: 600 });
    }
  } finally {
    db.close();
  }
});

test('rebuilds routing indexes and repairs misses from tenant authorities', async () => {
  const db = store();
  try {
    const a = await seedTenant(db, { target: 'a@example.test' });
    await db.system.write((sql) => sql.run('DELETE FROM memberships'));
    expect(await db.tenantIdsForUser(a.userId)).toEqual([a.tenantId]);
    await db.system.write((sql) => sql.run('DELETE FROM invite_directory'));
    expect(await db.tenantForInvite(a.inviteHash)).toBe(a.tenantId);
    await db.system.write((sql) => sql.run('DELETE FROM memberships'));
    await db.rebuildIndexes();
    expect(db.system.get('SELECT tenant_id FROM memberships')).toEqual({ tenant_id: a.tenantId });
  } finally {
    db.close();
  }
});
