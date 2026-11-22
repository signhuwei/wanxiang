import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { balanceAdapters, balanceOrigin, balanceUserId, noBalance, observeRelayBalance, type BalanceAdapter } from './channel-balance-upstream';
import type { ProviderChannelFetch } from './channel-catalog-upstream';
import { appendChannelEntry } from './channel-ledger';
import { iso } from './credentials';
import { enumField, int, platformActor, type ManagementOptions } from './management';
import { decryptProviderSecret, encryptProviderSecret } from './provider-secret';
import { boundPage, conflict, currencyCode, replay, requirePlatformAdmin, routeId, strictObject } from './routing-http';
import type { Store, Transaction } from './store';

type Reader = Pick<Transaction, 'get' | 'all'>;
type Scope = { provider_id: string; account_id: string; funding_id: string; endpoint_id: string; endpoint_revision: number; source_origin: string };
type Target = Omit<Scope, 'source_origin' | 'endpoint_id' | 'endpoint_revision'> & {
  endpoint_id: string | null; endpoint_revision: number | null; base_url: string | null; proxy: string | null;
  active: number | null; balance_mode: string; inference_ciphertext: Uint8Array;
};
type Profile = Scope & { profile_revision: number; adapter: BalanceAdapter; expected_user_id: string; currency: string;
  quota_per_unit: number | null; sync_wallet: 0 | 1; credential_ciphertext: Uint8Array | null };
type Observation = Pick<Profile, 'account_id' | 'provider_id' | 'funding_id' | 'profile_revision' | 'adapter' | 'source_origin' | 'currency'> & {
  id: string; scope: 'account_balance' | 'account_quota'; status: 'ok' | 'exhausted' | 'unknown' | 'stale';
  reason_code: string | null; amount_micro: number | null; quota_units: number | null; wallet_synced: boolean;
  observed_at: string; valid_until: string | null;
};
type StoredObservation = Omit<Observation, 'wallet_synced'> & { wallet_synced: 0 | 1 };
const accountPath = '/v1/platform/providers/:provider_id/accounts/:account_id';
const profilePath = `${accountPath}/balance-profile`;
const validForMs = 15 * 60_000;

function targetFor(db: Reader, provider: string, account: string) {
  const target = db.get<Target>(`SELECT p.id AS provider_id, a.account_id, coalesce(a.funding_id,a.account_id) AS funding_id,
      p.proxy, a.balance_mode, p.secret_ciphertext AS inference_ciphertext, d.endpoint_id,
      e.current_revision AS endpoint_revision, er.base_url,
      (p.status='active' AND a.status='active' AND e.status='active' AND ae.state='enabled') AS active
    FROM provider_accounts a JOIN providers p ON p.id=a.provider_id
    LEFT JOIN provider_channel_defaults d ON d.provider_id=p.id AND d.account_id=a.account_id
    LEFT JOIN provider_endpoints e ON e.endpoint_id=d.endpoint_id
    LEFT JOIN provider_endpoint_revisions er ON er.endpoint_id=e.endpoint_id AND er.endpoint_revision=e.current_revision
    LEFT JOIN provider_account_endpoints ae ON ae.account_id=a.account_id AND ae.endpoint_id=e.endpoint_id
    WHERE p.id=? AND a.account_id=?`, [provider, account]);
  if (!target) throw new ApiError('not_found');
  return target;
}

function scopeFor(target: Target): Scope | null {
  const origin = balanceOrigin(target.base_url);
  if (!origin || !target.endpoint_id || target.endpoint_revision === null || (target.proxy && target.proxy !== 'none')) return null;
  return { provider_id: target.provider_id, account_id: target.account_id, funding_id: target.funding_id,
    endpoint_id: target.endpoint_id, endpoint_revision: target.endpoint_revision, source_origin: origin };
}

function credentialScope(scope: Scope, adapter: BalanceAdapter, userId: string) {
  return JSON.stringify(['provider_account_balance', scope.provider_id, scope.account_id, scope.funding_id,
    scope.endpoint_id, scope.endpoint_revision, scope.source_origin, adapter, userId]);
}

function savedScope(profile: Profile) {
  return credentialScope(profile, profile.adapter, profile.expected_user_id);
}

function profileFor(db: Reader, target: Target) {
  return db.get<Profile>('SELECT * FROM provider_balance_profiles WHERE account_id=?', [target.account_id]);
}

function usable(target: Target, profile: Profile) {
  const scope = scopeFor(target);
  return Boolean(scope && profile.credential_ciphertext && savedScope(profile) === credentialScope(scope, profile.adapter, profile.expected_user_id));
}

function profileView(target: Target, profile: Profile | null, keyAvailable: boolean) {
  const canConfigure = keyAvailable && Boolean(scopeFor(target));
  const actions = ['read'];
  if (canConfigure) actions.push('configure');
  if (!profile?.credential_ciphertext) return { profile: null, adapters: balanceAdapters, actions };
  const credentialUsable = keyAvailable && usable(target, profile);
  if (target.active && credentialUsable) actions.push('probe_balance');
  actions.push('clear_balance_profile');
  return { profile: { profile_revision: profile.profile_revision, adapter: profile.adapter, expected_user_id: profile.expected_user_id,
    currency: profile.currency, quota_per_unit: profile.quota_per_unit, sync_wallet: Boolean(profile.sync_wallet),
    credential_configured: true, credential_usable: credentialUsable, source_origin: profile.source_origin }, adapters: balanceAdapters, actions };
}

function observationView(row: Observation | StoredObservation | null, at: string, profileRevision: number | null) {
  if (!row) return null;
  const { id, status, reason_code, scope, amount_micro, currency, quota_units, observed_at, valid_until, profile_revision, adapter, source_origin } = row;
  const outdated = valid_until && (profile_revision !== profileRevision ? 'profile_scope_changed' : valid_until <= at ? 'observation_expired' : null);
  return { id, status: outdated ? 'stale' : status, reason_code: outdated || reason_code, scope, amount_micro, currency, quota_units,
    observed_at, valid_until, profile_revision, wallet_synced: Boolean(row.wallet_synced), source: { adapter, origin: source_origin } };
}

function walletSequence(db: Reader, funding: string) {
  return db.get<{ seq: number }>('SELECT coalesce(max(seq),0) AS seq FROM channel_ledger WHERE funding_id=?', [funding])!.seq;
}

function syncWallet(db: Transaction, target: Target, reading: Observation, expectedSeq: number, at: number) {
  if (target.balance_mode !== 'prepaid') return 'not_prepaid_wallet';
  const accounts = db.get<{ count: number }>('SELECT count(*) AS count FROM provider_accounts WHERE coalesce(funding_id,account_id)=?', [target.funding_id])!;
  if (accounts.count !== 1) return 'shared_wallet_requires_verification';
  const wallet = db.get<{ currency: string }>('SELECT currency FROM channel_wallets WHERE funding_id=?', [target.funding_id]);
  if (wallet && wallet.currency !== reading.currency) return 'wallet_currency_mismatch';
  if (walletSequence(db, target.funding_id) !== expectedSeq) return 'wallet_changed';
  appendChannelEntry(db, target.provider_id, target.account_id, 'system:balance', at, {
    currency: reading.currency, kind: 'balance_observation', amount_micro: reading.amount_micro!,
    reference: reading.id, note: 'Sub2API 账户余额验证',
  });
  return null;
}

export function channelBalanceRoutes(app: Hono, store: Store, opts: ManagementOptions & { providerChannelFetch?: ProviderChannelFetch }) {
  const resolve = (c: Context, db: Reader) => targetFor(db, routeId(c.req.param('provider_id'), 'provider_id'), routeId(c.req.param('account_id'), 'account_id'));
  const probes = new Set<string>();
  const keyAvailable = Boolean(opts.masterKey);

  app.get(profilePath, c => {
    platformActor(store, c, opts.now());
    const target = resolve(c, store.system);
    return c.json(profileView(target, profileFor(store.system, target), keyAvailable));
  });

  app.post(profilePath, async c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const body = strictObject(await json(c), 'body', ['expected_profile_revision', 'adapter', 'expected_user_id', 'currency', 'quota_per_unit', 'sync_wallet', 'credential']);
    const expected = int(body.expected_profile_revision, 'expected_profile_revision');
    const adapter = enumField(body.adapter, 'adapter', balanceAdapters);
    const expectedUser = balanceUserId(body.expected_user_id);
    if (!expectedUser || typeof body.expected_user_id !== 'string') invalid('expected_user_id');
    const currency = currencyCode(body.currency, 'currency');
    const quota = adapter === 'new_api' ? int(body.quota_per_unit, 'quota_per_unit', 1) : null;
    if (adapter === 'sub2api' && body.quota_per_unit != null) invalid('quota_per_unit');
    if (adapter === 'sub2api' && currency !== 'USD') invalid('currency');
    if (typeof body.sync_wallet !== 'boolean' || (adapter === 'new_api' && body.sync_wallet)) invalid('sync_wallet');
    const credential = body.credential === undefined ? undefined : field(body.credential, 'credential', 4096);
    if (credential !== undefined && !/^[\x21-\x7e]+$/.test(credential)) invalid('credential');
    const op = operation(c, opts.codeSecret, at, actor, body);
    return store.system.write(db => {
      requirePlatformAdmin(db, actor);
      const cached = replay(op, db);
      if (cached) return cached;
      const target = resolve(c, db);
      const current = profileFor(db, target);
      const actual = current?.credential_ciphertext ? current.profile_revision : 0;
      if (actual !== expected) throw conflict('profile_revision_changed', actual);
      const scope = scopeFor(target);
      if (!scope) throw conflict('balance_endpoint_unavailable');
      if (!opts.masterKey) throw conflict('management_key_unavailable');
      if (body.sync_wallet && db.get(`SELECT 1 FROM provider_balance_profiles WHERE adapter=? AND source_origin=? AND expected_user_id=?
        AND account_id<>? AND sync_wallet=1 AND credential_ciphertext IS NOT NULL`, [adapter, scope.source_origin, expectedUser, target.account_id])) {
        throw conflict('account_wallet_already_bound');
      }
      const aad = credentialScope(scope, adapter, expectedUser);
      let encrypted = current?.credential_ciphertext;
      if (credential !== undefined) {
        const inference = decryptProviderSecret(opts.masterKey, target.provider_id, target.inference_ciphertext).toString('utf8');
        if (inference === credential) throw conflict('separate_management_credential_required');
        encrypted = encryptProviderSecret(opts.masterKey, aad, credential);
      } else if (!current || !encrypted || aad !== savedScope(current)) {
        throw conflict('separate_management_credential_required');
      }
      const revision = (current?.profile_revision ?? 0) + 1;
      db.run(`INSERT INTO provider_balance_profiles (provider_id,account_id,funding_id,endpoint_id,endpoint_revision,source_origin,
          profile_revision,adapter,expected_user_id,currency,quota_per_unit,sync_wallet,credential_ciphertext)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET funding_id=excluded.funding_id,
          endpoint_id=excluded.endpoint_id,endpoint_revision=excluded.endpoint_revision,source_origin=excluded.source_origin,
          profile_revision=excluded.profile_revision,adapter=excluded.adapter,expected_user_id=excluded.expected_user_id,
          currency=excluded.currency,quota_per_unit=excluded.quota_per_unit,sync_wallet=excluded.sync_wallet,credential_ciphertext=excluded.credential_ciphertext`,
      [scope.provider_id, scope.account_id, scope.funding_id, scope.endpoint_id, scope.endpoint_revision, scope.source_origin,
        revision, adapter, expectedUser, currency, quota, Number(body.sync_wallet), encrypted]);
      const profile = profileFor(db, target);
      audit(db, actor, 'channel.balance_profile.save', target.account_id, revision, at);
      return op.complete(db, { status: 200, payload: profileView(target, profile, keyAvailable) });
    });
  });

  app.post(`${profilePath}/clear`, async c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const body = strictObject(await json(c), 'body', ['expected_profile_revision']);
    const expected = int(body.expected_profile_revision, 'expected_profile_revision', 1);
    const op = operation(c, opts.codeSecret, at, actor, body);
    return store.system.write(db => {
      requirePlatformAdmin(db, actor);
      const cached = replay(op, db);
      if (cached) return cached;
      const target = resolve(c, db);
      const current = profileFor(db, target);
      const actual = current?.credential_ciphertext ? current.profile_revision : 0;
      if (actual !== expected) throw conflict('profile_revision_changed', actual);
      db.run('UPDATE provider_balance_profiles SET profile_revision=profile_revision+1,credential_ciphertext=NULL WHERE account_id=?', [target.account_id]);
      audit(db, actor, 'channel.balance_profile.clear', target.account_id, actual + 1, at);
      return op.complete(db, { status: 200, payload: profileView(target, null, keyAvailable) });
    });
  });

  app.get(`${accountPath}/balance-observations`, c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const target = resolve(c, store.system);
    const profile = profileFor(store.system, target);
    const current = profile && usable(target, profile) ? profile.profile_revision : null;
    const page = boundPage(c, opts.codeSecret, actor, { account: target.account_id });
    const select = 'SELECT * FROM provider_balance_observations WHERE account_id=?';
    const filter = [target.account_id];
    const total = store.system.get<{ count: number }>('SELECT count(*) AS count FROM provider_balance_observations WHERE account_id=?', filter)!.count;
    const items = store.system.all<StoredObservation>(`${select} ORDER BY seq DESC LIMIT ? OFFSET ?`, [...filter, page.limit, page.offset]);
    const latest = store.system.get<StoredObservation>(`${select} ORDER BY seq DESC LIMIT 1`, filter);
    const successful = store.system.get<StoredObservation>(`${select} AND status IN ('ok','exhausted') ORDER BY seq DESC LIMIT 1`, filter);
    const view = (row: StoredObservation | null) => observationView(row, iso(at), current);
    return c.json({ ...page.page(items.map(view), total, profileView(target, profile, keyAvailable).actions.filter(action => action === 'read' || action === 'probe_balance')),
      latest: view(latest), last_success: view(successful) });
  });

  app.post(`${accountPath}/balance-probes`, async c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const body = strictObject(await json(c), 'body', ['profile_revision']);
    const revision = int(body.profile_revision, 'profile_revision', 1);
    const op = operation(c, opts.codeSecret, at, actor, body);
    if (!op.key) invalid('Idempotency-Key');
    const cached = replay(op, store.system);
    if (cached) return cached;
    const target = resolve(c, store.system);
    const profile = profileFor(store.system, target);
    if (!profile?.credential_ciphertext) throw conflict('missing_credential');
    if (profile.profile_revision !== revision) throw conflict('profile_revision_changed', profile.profile_revision);
    if (!target.active) throw conflict('provider_inactive');
    if (probes.has(target.account_id)) throw conflict('probe_in_progress');
    probes.add(target.account_id);
    try {
      const baseline = walletSequence(store.system, target.funding_id);
      let reading = noBalance('credential_scope_changed');
      if (!opts.masterKey) reading = noBalance('missing_credential');
      else if (usable(target, profile)) {
        let token: string | null = null;
        try { token = decryptProviderSecret(opts.masterKey, savedScope(profile), profile.credential_ciphertext).toString('utf8'); }
        catch { reading = noBalance('credential_unavailable'); }
        if (token) reading = await observeRelayBalance(profile, token, opts.providerChannelFetch);
      }
      const completed = opts.now();
      return await store.system.write(db => {
        requirePlatformAdmin(db, actor);
        const done = replay(op, db);
        if (done) return done;
        const currentTarget = resolve(c, db);
        const currentProfile = profileFor(db, currentTarget);
        const stillCurrent = currentTarget.active && currentProfile?.profile_revision === revision && usable(currentTarget, currentProfile);
        const row: Observation = { id: `bobs_${ulid()}`, provider_id: target.provider_id, account_id: target.account_id,
          funding_id: profile.funding_id, profile_revision: revision, adapter: profile.adapter, source_origin: profile.source_origin,
          currency: profile.currency, scope: profile.adapter === 'sub2api' ? 'account_balance' : 'account_quota',
          status: reading.amount_micro === null ? 'unknown' : !stillCurrent ? 'stale' : reading.exhausted ? 'exhausted' : 'ok',
          reason_code: reading.reason_code ?? (!stillCurrent ? 'profile_scope_changed' : null), amount_micro: reading.amount_micro,
          quota_units: reading.quota_units, observed_at: iso(completed), valid_until: reading.amount_micro === null ? null : iso(completed + validForMs),
          wallet_synced: false };
        if (stillCurrent && profile.sync_wallet && row.scope === 'account_balance' && row.amount_micro !== null) {
          row.reason_code = syncWallet(db, currentTarget, row, baseline, completed);
          row.wallet_synced = row.reason_code === null;
        }
        db.run(`INSERT INTO provider_balance_observations (id,provider_id,account_id,funding_id,profile_revision,adapter,source_origin,scope,
            status,reason_code,currency,amount_micro,quota_units,observed_at,valid_until,wallet_synced,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.id,row.provider_id,row.account_id,row.funding_id,row.profile_revision,row.adapter,row.source_origin,row.scope,
          row.status,row.reason_code,row.currency,row.amount_micro,row.quota_units,row.observed_at,row.valid_until,Number(row.wallet_synced),actor]);
        audit(db, actor, 'channel.balance.probe', row.id, revision, completed);
        return op.complete(db, { status: 202, payload: observationView(row, iso(completed), stillCurrent ? revision : null)! });
      });
    } finally {
      probes.delete(target.account_id);
    }
  });
}

function audit(db: Transaction, actor: string, action: string, target: string, revision: number, at: number) {
  db.run('INSERT INTO platform_audit (id,actor,action,target,detail_json,at) VALUES (?,?,?,?,?,?)',
    [`aud_${ulid()}`, actor, action, target, JSON.stringify({ profile_revision: revision }), iso(at)]);
}
