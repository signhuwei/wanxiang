import { expect, test } from 'bun:test';
import { body, setup } from './routing-fixture';

test('shared channel funding records recharge, observed balance and cost exactly once', async () => {
  const fixture = await setup();
  try {
    await fixture.store.system.write(sql => sql.run("UPDATE provider_accounts SET funding_id='shared' WHERE account_id IN ('acct_a','acct_b')"));
    const ledgerA = '/providers/prv_a/channel-ledger';
    const ledgerB = '/providers/prv_b/channel-ledger';
    const post = (path: string, request: object, key?: string) => fixture.call(fixture.platform, path, request, key);
    const read = async (path = ledgerA) => body(await fixture.call(fixture.platform, path));
    const credit = { account_id: 'acct_a', currency: 'CNY', reference: 'receipt-1', amount_micro: 250_000, note: 'confirmed channel recharge' };
    expect((await fixture.call(fixture.tenant, ledgerA)).status).toBe(403);
    expect((await post(ledgerB + '/recharges', credit)).status).toBe(404);
    expect((await read()).accounts[0].balance_micro).toBeNull();
    expect((await post(ledgerA + '/observations', { account_id: 'acct_a', currency: 'CNY', reference: 'statement-1', balance_micro: 1_000_000, note: 'upstream statement' })).status).toBe(201);
    const created = await post(ledgerA + '/recharges', credit, 'recharge-1');
    expect(created.status).toBe(201);
    const row = await body(created);
    expect(await body(await post(ledgerA + '/recharges', credit, 'recharge-1'))).toEqual(row);
    expect(await body(await post(ledgerB + '/recharges', { ...credit, account_id: 'acct_b' }))).toEqual(row);
    expect((await post(ledgerB + '/recharges', { ...credit, account_id: 'acct_b', amount_micro: 1 })).status).toBe(409);
    expect((await post(ledgerB + '/expenses', { account_id: 'acct_b', currency: 'USD', reference: 'call-1', amount_micro: 50_000, note: 'channel statement' })).status).toBe(409);
    expect((await post(ledgerB + '/expenses', { account_id: 'acct_b', currency: 'CNY', reference: 'call-1', amount_micro: 50_000, note: 'channel statement' })).status).toBe(201);
    for (const path of [ledgerA, ledgerB]) {
      const statement = await read(path);
      expect(statement.accounts[0]).toMatchObject({ funding_id: 'shared', balance_micro: 1_200_000, observed_balance_micro: 1_000_000,
        currency: 'CNY', credited_micro: 250_000, spent_micro: 50_000 });
      expect(statement.items.map((entry: { kind: string }) => entry.kind)).toEqual(['expense', 'recharge', 'balance_observation']);
    }
    const first = await read(ledgerA + '?limit=1');
    expect(first.total).toBe(3);
    expect((await fixture.call(fixture.platform, ledgerB + '?cursor=' + first.next_cursor)).status).toBe(422);
    await expect(fixture.store.system.write(sql => sql.run('DELETE FROM channel_ledger'))).rejects.toThrow('immutable');
  } finally { await fixture.close(); }
});
