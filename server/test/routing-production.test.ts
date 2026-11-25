import { expect, test } from 'bun:test';
import { startOneChain } from '../../tests/e2e/routing/one-chain-server';
import { iso } from '../src/credentials';
import { configuredRoutePoolDevices } from '../src/route-production';
import { openRouteSecret, x25519PublicKey } from '../src/route-secret';
import { applied, connectDeviceSocket } from './routing-ws-fixture';

const capabilities = ['route_pool.v1', 'route_pool.exec.v1'];

test('the runtime cohort parses only explicit tenant and device IDs and boots from persisted contracts', async () => {
  expect(configuredRoutePoolDevices('')).toEqual([]);
  expect(() => configuredRoutePoolDevices('tenant=any')).toThrow('tenant ID and device ID pairs');
  const fixture = await startOneChain({ production: true });
  const { info, api, service } = fixture;
  const scope = `${info.tenant_id}:${info.device_id}`;
  expect(configuredRoutePoolDevices(scope)).toEqual([{ tenantId: info.tenant_id, deviceId: info.device_id }]);
  expect(() => configuredRoutePoolDevices(`${scope},${scope}`)).toThrow('duplicate device');
  const sockets: ReturnType<typeof connectDeviceSocket>[] = [];
  function socket(token = info.device_token) {
    const edge = connectDeviceSocket(info.ws_url, token);
    sockets.push(edge);
    return edge;
  }
  try {
    const legacy = socket();
    expect(await legacy.hello()).not.toHaveProperty('capabilities');
    expect(await legacy.nextOf('ack')).toMatchObject({ ok: false, error: { detail: { reason: 'route_pool_required' } } });
    legacy.close();

    const ordinary = await api('/devices', { name: 'another device', os: 'darwin', arch: 'arm64',
      public_key: x25519PublicKey(Buffer.alloc(32, 8)) }, undefined, info.owner_session);
    const outside = socket(ordinary.device_token);
    expect(await outside.hello({ capabilities })).not.toHaveProperty('capabilities');
    expect(await outside.nextOf('lease')).toMatchObject({ budget_milli: 20_375 });
    outside.close();

    await api(`/platform/policy/contracts/${info.tenant_id}/recharges`, { amount_milli: 20_375 }, 'projected-device-funds');
    const edge = socket();
    expect(await edge.hello({ capabilities })).toMatchObject({ capabilities });
    const config = await edge.nextOf('config');
    expect(config.routes).toHaveLength(2);
    expect(config.agents.map((agent: { id: string }) => agent.id)).toEqual([info.agent_release_id]);
    expect(config.route_pool.bindings[0].aliases).toEqual([info.model_id]);
    const material = config.route_pool.secrets.map((envelope: Parameters<typeof openRouteSecret>[2]) =>
      openRouteSecret(Buffer.from(info.device_private_key_hex,'hex'), { tenant_id: info.tenant_id, device_id: info.device_id,
        projection_id: info.projection_id, revision: info.config_revision }, envelope).toString());
    expect(material.toSorted()).toEqual(['fixture-channel-a','fixture-channel-b']);
    expect(JSON.stringify(config)).not.toContain('fixture-channel');
    expect(JSON.stringify(config)).not.toContain('quote_id');
    expect(await edge.call({ type: 'lease_request', id: 'before', op_id: 'before' })).toMatchObject({ ok: false,
      error: { detail: { reason: 'projection_not_applied' } } });
    expect(await edge.call({ ...applied('applied', info.config_revision, info.projection_id), policy_revision: config.policy.policy_revision })).toMatchObject({ ok: true });
    const lease = await edge.call({ type: 'lease_request', id: 'request', op_id: 'request' });
    expect(lease).toMatchObject({ type: 'lease', budget_milli: 20_375, config_revision: info.config_revision, projection_id: info.projection_id });
    const route = config.routes.find((item: { deployment_id: string }) => item.deployment_id === info.backup_deployment_id);
    const item = { seq: 1, request_id: 'req_fixture', session_id: null, lease_id: lease.lease_id, provider_id: route.provider_id,
      model: info.model_id, model_id: info.model_id, deployment_id: route.deployment_id, deployment_revision: route.deployment_revision,
      rate_version_id: config.rates[0].rate_version_id, config_revision: info.config_revision, projection_id: info.projection_id,
      attempt_id: 'att_fixture', attempts: [{ attempt_id: 'att_fixture', deployment_id: route.deployment_id,
        deployment_revision: route.deployment_revision, outcome: 'completed' }], input_tokens: 10_000, output_tokens: 2_000,
      cache_read_tokens: 0, cache_write_tokens: 0, cost_milli: 64, at: iso(Date.now()), complete: true, status: 'ok', measurement_basis: 'upstream_usage' };
    expect(await edge.call({ type: 'usage', id: 'forged', batch: [{ ...item, cost_milli: 2 }] })).toMatchObject({ ok: false,
      error: { detail: { reason: 'route_usage_cost_mismatch' } } });
    expect(await edge.call({ type: 'usage', id: 'invalid-cache', batch: [{ ...item, cache_write_tokens: 1 }] })).toMatchObject({ ok: false,
      error: { detail: { fields: ['cache_write_tokens'] } } });
    expect(await edge.call({ type: 'usage', id: 'measured', batch: [item] })).toMatchObject({ type: 'events_ack', ack_seq: 1 });
    const renew = { type: 'lease_renew', id: 'settle', op_id: 'settle', lease_id: lease.lease_id, used_milli: 64,
      ...(lease.model_budgets && { model_used_milli: { [info.model_id]: 64 } }), usage_through_seq: 1 };
    expect(await edge.call(renew)).toMatchObject({ settled_lease_id: lease.lease_id });
    const db = service.store.tenant(info.tenant_id);
    expect(db.get("SELECT count(*) n, sum(amount_milli) amount FROM ledger WHERE kind='settle' AND lease_id=?", [lease.lease_id]))
      .toEqual({ n: 1, amount: 64 });
    const channel = await api(info.backup_channel);
    expect(channel.accounts[0]).toMatchObject({ currency: 'USD', spent_micro: 6667 });
  } finally {
    for (const edge of sockets) edge.close();
    await fixture.close();
  }
});

test('a deployment with an incompatible procurement wallet is excluded before credential delivery', async () => {
  const { info, close } = await startOneChain({ production: true, backupWalletCurrency: 'EUR' });
  const edge = connectDeviceSocket(info.ws_url, info.device_token);
  try {
    await edge.hello({ capabilities });
    const config = await edge.nextOf('config');
    expect(config.routes.map((route: { deployment_id: string }) => route.deployment_id)).toEqual([info.primary_deployment_id]);
    expect(config.route_pool.secrets).toHaveLength(1);
    expect(config.route_pool.bindings[0].deployment_ids).toEqual([info.primary_deployment_id]);
  } finally {
    edge.close();
    await close();
  }
});
