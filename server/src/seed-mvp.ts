import { ulid } from 'ulid';
import { iso, normalizedTarget } from './credentials';
import { encryptProviderSecret, masterKeyFromEnv } from './provider-secret';
import { ensureUser, insertInitialContract } from './seed';
import { indexMember, Store } from './store';

const provider_id = 'prv_mvp_local_qwen';
const model_id = 'mod_mvp_local_qwen';
const model = 'Qwen3.8-27B';
const base_url = 'http://192.168.3.212:11516/v1';
const amount_milli = 1_000_000;

export async function seedMvp(store: Store, opts: { owner: string; employee: string; masterKey: Uint8Array; now?: number }) {
  const owner = normalizedTarget(opts.owner);
  const employee = normalizedTarget(opts.employee);
  if (!owner || !employee || owner.value === employee.value) throw new Error('Use two distinct email addresses or phone numbers');
  if (opts.masterKey.length !== 32) throw new Error('A 32-byte master key is required');
  const now = opts.now ?? Date.now();
  const at = iso(now);
  const existing = store.system.get<{ tenant_id: string; owner_user_id: string; employee_user_id: string }>('SELECT tenant_id, owner_user_id, employee_user_id FROM mvp_seed WHERE id = 1');
  const result = (row: { tenant_id: string; owner_user_id: string; employee_user_id: string }) => ({
    ...row, owner_target: owner.value, employee_target: employee.value, provider_id, model_id, model, amount_milli,
  });
  if (existing) {
    const identities = [owner, employee].map((target) => store.system.get<{ user_id: string }>(
      'SELECT user_id FROM identities WHERE kind = ? AND value = ?', [target.kind, target.value])?.user_id);
    if (identities[0] !== existing.owner_user_id || identities[1] !== existing.employee_user_id) throw new Error('MVP seed already belongs to different accounts');
    return result(existing);
  }
  const tenant_id = `ten_${ulid()}`;
  const [owner_user_id, employee_user_id] = await store.system.write((sql) => [ensureUser(sql, owner, now).id, ensureUser(sql, employee, now).id]);
  const members = [{ user_id: owner_user_id, role: 'owner', status: 'active' }, { user_id: employee_user_id, role: 'member', status: 'active' }];
  await store.tenant(tenant_id, true).write((sql) => {
    for (const member of members) sql.run('INSERT INTO members (user_id, role, status) VALUES (?, ?, ?)', [member.user_id, member.role, member.status]);
    insertInitialContract(sql, owner_user_id, 2, now);
    sql.run('UPDATE contract SET allowed_models_json = ? WHERE revision = 1', [JSON.stringify([model_id])]);
    sql.run(`INSERT INTO ledger (id, kind, amount_milli, "by", at, note) VALUES (?, 'topup', ?, ?, ?, 'MVP initial balance')`,
      [`led_${ulid()}`, amount_milli, owner_user_id, at]);
  });
  return store.system.write((sql) => {
    sql.run(`INSERT INTO providers (id, name, protocol, base_url, secret_ciphertext, status, auth, proxy)
      VALUES (?, 'local qwen', 'openai_chat', ?, ?, 'active', 'bearer', 'none')`,
    [provider_id, base_url, encryptProviderSecret(opts.masterKey, provider_id, 'oneX-local-no-auth')]);
    sql.run(`INSERT INTO models (id, provider_id, upstream_name, display_name, context_window, status, route_model)
      VALUES (?, ?, ?, ?, 32768, 'active', '*')`, [model_id, provider_id, model, model]);
    sql.run(`INSERT INTO rates (model_id, input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok,
      cache_write_milli_per_mtok, effective_from) VALUES (?, 1000, 4000, 0, 0, ?)`, [model_id, at]);
    sql.run(`INSERT INTO tenants (id, name, owner_user_id, status, db_file, created_at) VALUES (?, 'OneX MVP', ?, 'active', ?, ?)`,
      [tenant_id, owner_user_id, `tenant-${tenant_id}.sqlite`, at]);
    for (const member of members) indexMember(sql, tenant_id, member);
    sql.run('INSERT OR IGNORE INTO platform_admins (user_id) VALUES (?)', [owner_user_id]);
    sql.run('INSERT INTO mvp_seed (id, tenant_id, owner_user_id, employee_user_id) VALUES (1, ?, ?, ?)', [tenant_id, owner_user_id, employee_user_id]);
    return result({ tenant_id, owner_user_id, employee_user_id });
  });
}

if (import.meta.main) {
  if (process.env.NODE_ENV === 'production') throw new Error('MVP seed is for development mode only');
  const [owner, employee] = Bun.argv.slice(2);
  const masterKey = masterKeyFromEnv(process.env.ONEX_MASTER_KEY);
  if (!owner || !employee || !masterKey) throw new Error('Set ONEX_MASTER_KEY and run: bun run seed:mvp <owner-email-or-phone> <employee-email-or-phone>');
  const store = new Store(process.env.ONEX_DATA_DIR ?? '.local', 2);
  try { console.log(JSON.stringify(await seedMvp(store, { owner, employee, masterKey }))); }
  finally { store.close(); }
}
