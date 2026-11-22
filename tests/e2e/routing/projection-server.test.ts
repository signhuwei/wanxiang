import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRouteSecret } from '../../../server/src/route-secret';

const script = join(import.meta.dir, 'projection-server.ts');
const clean: (() => unknown)[] = [];
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); });

async function start(dir: string, extra: string[] = []) {
  // Kept as a handle: the process is ended through it, never by name.
  const child = Bun.spawn(['bun', '--no-env-file', script, '--data-dir', dir, ...extra], { stdout: 'pipe', stderr: 'inherit' });
  clean.push(async () => { child.kill('SIGTERM'); await child.exited; });
  const reader = child.stdout.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('projection server exited early');
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { child, info: JSON.parse(text.split('\n')[0]!) };
}

function edge(info: any, device: string) {
  const ws = new WebSocket(info.ws_url, { headers: { Authorization: `Bearer ${info.devices[device].token}`, 'OneX-Edge-Version': '0.1.0', 'OneX-Protocol': '0' } });
  clean.push(() => ws.close());
  const queue: any[] = [];
  ws.onmessage = event => queue.push(JSON.parse(String(event.data)));
  const opened = new Promise<void>(resolve => { ws.onopen = () => resolve(); });
  async function nextOf(type: string) {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const i = queue.findIndex(frame => frame.type === type);
      if (i >= 0) return queue.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error(`no ${type}`);
      await Bun.sleep(5);
    }
  }
  return { opened, nextOf, send: (frame: unknown) => ws.send(JSON.stringify(frame)), close: () => ws.close() };
}

test('the joint-check server serves sealed v91, records the receipt, and resends the same identity after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onex-projection-joint-test-'));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  let { child, info } = await start(dir);
  expect(info).toMatchObject({ data_dir: dir, devices: { dev_lin: { registered: true, config_revision: 91 } } });
  let device = edge(info, 'dev_lin');
  await device.opened;
  device.send({ type: 'hello', id: 'h1', edge_version: '0.1.0', os: 'darwin', arch: 'arm64', config_revision: 90, outbox_last_seq: 0, lease_id: null, ...info.hello });
  expect(await device.nextOf('welcome')).toMatchObject({ capabilities: ['route_pool.v1'], tenant_id: info.tenant_id });
  const config = await device.nextOf('config');
  expect([config.revision, config.route_pool.projection_id, config.rates[0].input_multiplier_ppm]).toEqual([91, 'prj_91', 4000000]);
  const key = Buffer.from(info.device_private_key_hex, 'hex');
  const opened = (frame: any) => frame.route_pool.secrets.map((envelope: any) => openRouteSecret(key, { tenant_id: info.tenant_id, device_id: 'dev_lin',
    projection_id: frame.route_pool.projection_id, revision: frame.revision }, envelope).toString());
  expect(opened(config)).toEqual([info.inference_plaintext['cred_a@1'], info.inference_plaintext['cred_b@2']]);
  device.send({ type: 'config_applied', id: 'ca91', config_revision: 91, policy_revision: config.policy.policy_revision, projection_id: 'prj_91', result: 'applied' });
  expect(await device.nextOf('ack')).toEqual({ type: 'ack', re: 'ca91', ok: true });
  // Without --lease-gate the isolated session keeps route_pool_lease_pending.
  expect(info.lease_gate).toBe(false);
  device.send({ type: 'lease_request', id: 'lr0', op_id: 'lr0' });
  expect(await device.nextOf('ack')).toMatchObject({ re: 'lr0', ok: false, error: { code: 'forbidden', detail: { reason: 'route_pool_lease_pending' } } });
  const ledger = await (await fetch(info.ledger[0], { headers: { authorization: `Bearer ${info.platform_session}` } })).json() as any;
  expect(ledger.items).toMatchObject([{ device_id: 'dev_lin', target_config_revision: 91, applied_config_revision: 91, state: 'applied' }]);

  device.close();
  child.kill('SIGTERM');
  expect(await child.exited).toBe(0);
  ({ child, info } = await start(dir));
  device = edge(info, 'dev_lin');
  await device.opened;
  device.send({ type: 'hello', id: 'h2', edge_version: '0.1.0', os: 'darwin', arch: 'arm64', config_revision: 91, outbox_last_seq: 0, lease_id: null, ...info.hello });
  const resent = await device.nextOf('config');
  expect([resent.revision, resent.route_pool.projection_id]).toEqual([91, 'prj_91']);
  expect(resent.route_pool.secrets[0].nonce).not.toBe(config.route_pool.secrets[0].nonce);
  expect(opened(resent)).toEqual(opened(config));
  device.send({ type: 'config_applied', id: 'ca91', config_revision: 91, policy_revision: config.policy.policy_revision, projection_id: 'prj_91', result: 'applied' });
  expect(await device.nextOf('ack')).toEqual({ type: 'ack', re: 'ca91', ok: true });
  // Later restart with a moved clock: dev_fix's unapplied v6 target has lapsed, dev_lin's applied one stays applied,
  // and dev_lin's row in the v6 rollout is superseded by the active v7 head.
  device.close();
  child.kill('SIGTERM');
  expect(await child.exited).toBe(0);
  ({ child, info } = await start(dir, ['--now', '2026-11-22T02:11:00Z']));
  expect(info.server_time).toBe('2026-11-22T02:11:00.000Z');
  const rows = async (url: string) => (await (await fetch(url, { headers: { authorization: `Bearer ${info.platform_session}` } })).json() as any).items;
  expect(await rows(info.ledger[1])).toMatchObject([
    { device_id: 'dev_fix', state: 'offline', reason: 'target_expired', target_config_revision: 92 },
    { device_id: 'dev_lin', state: 'superseded', reason: 'pool_superseded' }]);
  expect(await rows(info.ledger[0])).toMatchObject([{ device_id: 'dev_lin', state: 'applied', applied_config_revision: 91 }]);
}, 30_000);

test('--lease-gate: no lease before the applied receipt, a bound lease after it, settlement on renew, reaffirmed after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onex-projection-joint-gate-'));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  let { child, info } = await start(dir, ['--lease-gate']);
  expect(info.lease_gate).toBe(true);
  let device = edge(info, 'dev_lin');
  await device.opened;
  device.send({ type: 'hello', id: 'h1', edge_version: '0.1.0', os: 'darwin', arch: 'arm64', config_revision: 90, outbox_last_seq: 0, lease_id: null, ...info.hello });
  const config = await device.nextOf('config');
  device.send({ type: 'lease_request', id: 'lr1', op_id: 'lr1' });
  expect(await device.nextOf('ack')).toMatchObject({ re: 'lr1', ok: false, error: { code: 'forbidden', detail: { reason: 'projection_not_applied' } } });
  device.send({ type: 'config_applied', id: 'ca91', config_revision: 91, policy_revision: config.policy.policy_revision, projection_id: 'prj_91', result: 'applied' });
  expect(await device.nextOf('ack')).toEqual({ type: 'ack', re: 'ca91', ok: true });
  device.send({ type: 'lease_request', id: 'lr2', op_id: 'lr2' });
  const lease = await device.nextOf('lease');
  expect(lease).toMatchObject({ re: 'lr2', signature_id: 'sig_1', config_revision: 91, projection_id: 'prj_91' });
  const used = (n: number) => lease.model_budgets ? Object.fromEntries(Object.keys(lease.model_budgets).map((m, i) => [m, i ? 0 : n])) : undefined;
  device.send({ type: 'lease_renew', id: 'rn1', op_id: 'rn1', lease_id: lease.lease_id, used_milli: 3, model_used_milli: used(3) });
  const successor = await device.nextOf('lease');
  expect(successor).toMatchObject({ re: 'rn1', settled_lease_id: lease.lease_id, config_revision: 91, projection_id: 'prj_91' });

  device.close();
  child.kill('SIGTERM');
  expect(await child.exited).toBe(0);
  ({ child, info } = await start(dir, ['--lease-gate']));
  device = edge(info, 'dev_lin');
  await device.opened;
  device.send({ type: 'hello', id: 'h2', edge_version: '0.1.0', os: 'darwin', arch: 'arm64', config_revision: 91, outbox_last_seq: 0, lease_id: successor.lease_id, ...info.hello });
  await device.nextOf('config');
  device.send({ type: 'lease_request', id: 'lr3', op_id: 'lr3' });
  expect(await device.nextOf('lease')).toMatchObject({ re: 'lr3', lease_id: successor.lease_id, config_revision: 91 });
  // The lost renew reply replays the same successor without a second settlement.
  device.send({ type: 'lease_renew', id: 'rn1b', op_id: 'rn1', lease_id: lease.lease_id, used_milli: 3, model_used_milli: used(3) });
  expect(await device.nextOf('lease')).toMatchObject({ re: 'rn1b', lease_id: successor.lease_id, settled_lease_id: lease.lease_id });
}, 30_000);
