import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, json, operation } from './api';
import { iso } from './credentials';
import { int, platformActor, type ManagementOptions } from './management';
import { boundPage, conflict, currencyCode, replay, requirePlatformAdmin, routeId, strictObject } from './routing-http';
import type { Store, Transaction } from './store';

type Reader = Pick<Transaction, 'get' | 'all'>;
type Kind = 'recharge' | 'balance_observation' | 'expense';
type Account = { account_id: string; label: string; funding_id: string; status: string };
type Entry = { id: string; funding_id: string; account_id: string; currency: string; kind: Kind; amount_micro: number;
  reference: string; note: string; recorded_at: string };
type Draft = Pick<Entry, 'currency' | 'kind' | 'amount_micro' | 'reference' | 'note'>;
const actions = ['read', 'recharge', 'record_balance', 'record_expense'] as const;
const entryColumns = `l.id, l.funding_id, l.account_id, w.currency, l.kind, l.amount_micro, l.reference, l.note, l.recorded_at`;
const accountColumns = 'account_id, name AS label, coalesce(funding_id,account_id) AS funding_id, status';

function readAccount(sql: Reader, providerId: string, accountId: string) {
  const account = sql.get<Account>(`SELECT ${accountColumns} FROM provider_accounts WHERE provider_id = ? AND account_id = ?`, [providerId, accountId]);
  if (!account) throw new ApiError('not_found');
  return account;
}

function wallet(sql: Reader, funding: string) {
  const currency = sql.get<{ currency: string }>('SELECT currency FROM channel_wallets WHERE funding_id = ?', [funding])?.currency ?? null;
  const observed = sql.get<{ seq: number; amount_micro: number; recorded_at: string }>(`SELECT seq, amount_micro, recorded_at
    FROM channel_ledger WHERE funding_id = ? AND kind = 'balance_observation' ORDER BY seq DESC LIMIT 1`, [funding]);
  const totals = sql.get<{ credited_micro: number; spent_micro: number; since_credit: number; since_expense: number }>(`SELECT
    coalesce(sum(amount_micro) FILTER (WHERE kind='recharge'), 0) AS credited_micro,
    coalesce(sum(amount_micro) FILTER (WHERE kind='expense'), 0) AS spent_micro,
    coalesce(sum(amount_micro) FILTER (WHERE kind='recharge' AND seq>?), 0) AS since_credit,
    coalesce(sum(amount_micro) FILTER (WHERE kind='expense' AND seq>?), 0) AS since_expense
    FROM channel_ledger WHERE funding_id = ?`, [observed?.seq ?? 0, observed?.seq ?? 0, funding])!;
  const balance = observed ? observed.amount_micro + (totals.since_credit - totals.since_expense) : null;
  if (!Number.isSafeInteger(totals.credited_micro) || !Number.isSafeInteger(totals.spent_micro) ||
      (balance !== null && !Number.isSafeInteger(balance))) throw conflict('wallet_total_out_of_range');
  return { currency, balance_micro: balance, observed_balance_micro: observed?.amount_micro ?? null,
    observed_at: observed?.recorded_at ?? null, credited_micro: totals.credited_micro, spent_micro: totals.spent_micro };
}

/** Shared by manual channel bookkeeping and a verified procurement charge. No funds are transferred here. */
export function appendChannelEntry(sql: Transaction, providerId: string, accountId: string, actor: string, at: number, draft: Draft) {
  const account = readAccount(sql, providerId, accountId);
  const currency = currencyCode(draft.currency, 'currency');
  const amount = int(draft.amount_micro, 'amount_micro', draft.kind === 'expense' || draft.kind === 'balance_observation' ? 0 : 1);
  const previous = sql.get<Entry>(`SELECT ${entryColumns} FROM channel_ledger l JOIN channel_wallets w ON w.funding_id=l.funding_id
    WHERE l.funding_id=? AND l.kind=? AND l.reference=?`, [account.funding_id, draft.kind, draft.reference]);
  if (previous) {
    if (previous.currency !== currency || previous.amount_micro !== amount || previous.note !== draft.note) throw conflict('channel_reference_reused');
    return { entry: previous, created: false };
  }
  const now = iso(at);
  sql.run('INSERT OR IGNORE INTO channel_wallets (funding_id,currency,created_at) VALUES (?,?,?)', [account.funding_id, currency, now]);
  if (sql.get<{ currency: string }>('SELECT currency FROM channel_wallets WHERE funding_id=?', [account.funding_id])?.currency !== currency) {
    throw conflict('channel_currency_mismatch');
  }
  const entry = { ...draft, id: `cle_${ulid()}`, funding_id: account.funding_id, account_id: accountId, recorded_at: now };
  sql.run(`INSERT INTO channel_ledger (id,funding_id,account_id,kind,amount_micro,reference,note,recorded_by,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, [entry.id, entry.funding_id, entry.account_id, entry.kind, entry.amount_micro, entry.reference, entry.note, actor, now]);
  wallet(sql, account.funding_id);
  sql.run('INSERT INTO platform_audit (id,actor,action,target,detail_json,at) VALUES (?,?,?,?,?,?)',
    [`aud_${ulid()}`, actor, `channel_ledger.${draft.kind}`, entry.id, JSON.stringify({ provider_id: providerId, account_id: accountId,
      funding_id: account.funding_id, currency, amount_micro: amount, reference: draft.reference }), now]);
  return { entry, created: true };
}

export function channelLedgerRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const base = '/v1/platform/providers/:provider_id/channel-ledger';
  const providerId = (c: Context) => routeId(c.req.param('provider_id'), 'provider_id');
  app.get(base, (c) => {
    const actor = platformActor(store, c, opts.now());
    const provider = providerId(c);
    if (!store.system.get('SELECT 1 FROM providers WHERE id=?', [provider])) throw new ApiError('not_found');
    const filter = c.req.query('account_id');
    const accounts = filter === undefined
      ? store.system.all<Account>(`SELECT ${accountColumns} FROM provider_accounts WHERE provider_id=? ORDER BY account_id`, [provider])
      : [readAccount(store.system, provider, routeId(filter, 'account_id'))];
    const fundings = JSON.stringify([...new Set(accounts.map(({ funding_id }) => funding_id))]);
    const page = boundPage(c, opts.codeSecret, actor, { provider, account_id: filter ?? null });
    const where = 'WHERE l.funding_id IN (SELECT value FROM json_each(?))';
    const join = 'FROM channel_ledger l JOIN channel_wallets w ON w.funding_id=l.funding_id';
    const total = store.system.get<{ n: number }>(`SELECT count(*) AS n FROM channel_ledger l ${where}`, [fundings])!.n;
    const entries = store.system.all<Entry>(`SELECT ${entryColumns} ${join} ${where} ORDER BY l.seq DESC LIMIT ? OFFSET ?`,
      [fundings, page.limit, page.offset]);
    const balances = new Map<string, ReturnType<typeof wallet>>();
    const result = accounts.map((account) => {
      if (!balances.has(account.funding_id)) balances.set(account.funding_id, wallet(store.system, account.funding_id));
      return { ...account, ...balances.get(account.funding_id)!, actions };
    });
    return c.json({ accounts: result, ...page.page(entries, total, accounts.length ? actions : ['read']) });
  });

  const write = (kind: Kind) => async (c: Context) => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const provider = providerId(c);
    const amountField = kind === 'balance_observation' ? 'balance_micro' : 'amount_micro';
    const body = strictObject(await json(c), 'body', ['account_id', 'currency', amountField, 'reference', 'note']);
    const account = routeId(body.account_id, 'account_id');
    const draft = { kind, currency: currencyCode(body.currency, 'currency'), amount_micro: int(body[amountField], amountField, kind === 'balance_observation' ? 0 : 1),
      reference: field(body.reference, 'reference', 128), note: field(body.note, 'note', 512) };
    const op = operation(c, opts.codeSecret, at, actor, [account, draft]);
    return store.system.write((sql) => {
      requirePlatformAdmin(sql, actor);
      const cached = replay(op, sql);
      if (cached) return cached;
      const { entry, created } = appendChannelEntry(sql, provider, account, actor, at, draft);
      return op.complete(sql, { status: created ? 201 : 200, payload: entry });
    });
  };
  app.post(base + '/recharges', write('recharge'));
  app.post(base + '/observations', write('balance_observation'));
  app.post(base + '/expenses', write('expense'));
}
