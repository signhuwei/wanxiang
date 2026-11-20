import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server';
import { seedTenant } from '../src/seed';
import { MemoryPresence } from '../src/presence';

type DeviceReply = { device_id: string; device_token: string };

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); });

async function fixture(testTime?: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-quota-'));
  clean.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const codes = new Map<string, string>();
  const presence = new MemoryPresence();
  let time = testTime ?? Date.now();
  const service = await createServer({
    dataDir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 2, heartbeatMs: 15_000, commit: 'test',
    codeSecret: 'test-only-secret', masterKey: Buffer.alloc(32, 41), deliverCode: (target, code) => { codes.set(target, code); },
    now: () => time, presence,
  });
  clean.push(() => service.close());
  const owner = 'owner@example.test';
  const seeded = await seedTenant(service.store, { target: owner, seats: 10, maxUses: 10, now: time });
  function request(path: string, body?: Record<string, unknown>, token?: string, key?: string, method = body ? 'POST' : 'GET') {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (key) headers.set('idempotency-key', key);
    if (body) headers.set('content-type', 'application/json');
    return fetch(new URL(`/v1${path}`, service.server.url), { method, headers, body: body && JSON.stringify(body) });
  }
  async function code(target: string) {
    const response = await request('/auth/code', { target });
    expect(response.status).toBe(202);
    return codes.get(target)!;
  }
  async function login(target = owner, kind: 'web' | 'desktop' = 'desktop', inviteCode?: string) {
    const response = await request('/auth/login', { target, code: await code(target), kind, invite_code: inviteCode });
    expect(response.status).toBe(200);
    return (await response.json() as { token: string; user: { id: string } });
  }
  async function select(token: string) {
    const response = await request('/auth/select-tenant', { tenant_id: seeded.tenantId }, token);
    expect(response.status).toBe(200);
    return (await response.json() as { token: string }).token;
  }
  async function joinTenant(target: string) {
    const result = await login(target, 'desktop', seeded.inviteCode);
    const scoped = await select(result.token);
    return { userId: result.user.id, scoped, global: result.token };
  }
  async function fund(ownerToken: string, amount: number) {
    await service.store.system.write((sql) => sql.run('INSERT OR IGNORE INTO platform_admins VALUES (?)', [seeded.userId]));
    const body = { tenant_id: seeded.tenantId, amount_milli: amount };
    const res = await request('/platform/ledger/topup', body, ownerToken, `fund-${amount}-${Math.random()}`);
    expect(res.status).toBe(201);
  }
  const publicKey = Buffer.alloc(32, 5).toString('base64');
  async function registerDevice(scoped: string, name = 'Mac') {
    const res = await request('/devices', { name, os: 'darwin', arch: 'arm64', public_key: publicKey }, scoped, `device-${name}-${Math.random()}`);
    expect(res.status).toBe(201);
    return await res.json() as DeviceReply;
  }
  return {
    ...service, ...seeded, owner, presence, request, code, login, select, join: joinTenant, fund, registerDevice,
    advance: (ms: number) => { time += ms; }, now: () => time,
  };
}

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 1_500;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for WebSocket state');
    await Bun.sleep(5);
  }
}

function connect(f: Awaited<ReturnType<typeof fixture>>, token: string) {
  const ws = new WebSocket(`ws://${f.server.hostname}:${f.server.port}/v1/edge/ws`, {
    headers: { Authorization: `Bearer ${token}`, 'OneX-Edge-Version': '0.1.0', 'OneX-Protocol': '0' },
  });
  clean.push(() => ws.close());
  const queue: any[] = [];
  ws.onmessage = (event) => queue.push(JSON.parse(String(event.data)));
  const opened = new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
  const closed = new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });
  async function next() {
    await until(() => queue.length > 0);
    return queue.shift();
  }
  function send(message: unknown) { ws.send(JSON.stringify(message)); }
  function hello(leaseId?: string) { send({ type: 'hello', id: 'edge-hello', edge_version: '0.1.0', os: 'darwin', arch: 'arm64', config_revision: 0, outbox_last_seq: 0, lease_id: leaseId }); }
  async function nextOf(type: string) {
    for (;;) {
      const message = await next();
      if (message.type === type) return message;
      if (message.type !== 'config' && message.type !== 'secret') throw new Error(`Expected ${type}, received ${message.type}`);
    }
  }
  return { ws, opened, closed, next, nextOf, send, hello };
}

async function linkedEdge(f: Awaited<ReturnType<typeof fixture>>, scoped: string, name = 'Mac') {
  const token = await f.registerDevice(scoped, name);
  const edge = connect(f, token.device_token);
  expect(await edge.opened).toBe(true);
  edge.hello();
  expect(await edge.next()).toMatchObject({ type: 'welcome' });
  return { ...edge, ...token };
}

test('a member-level quota caps the lease below the lease budget and cuts off at exhaustion', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('member-quota@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 3 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  // 余额充裕（1000），lease_budget_milli 默认 2000，5% 下限也远大于 3：配额本人剩余 3 才是约束
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 3 });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 3 });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota', re: 'renew-1' });
});

test('a group quota binds a member with no personal quota, and an ancestor group binds tighter than its child', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const parent = await (await f.request('/groups', { name: 'Parent', quota_milli: 5 }, owner)).json() as { id: string };
  const child = await (await f.request('/groups', { name: 'Child', parent_id: parent.id, quota_milli: 100 }, owner)).json() as { id: string };
  const member = await f.join('group-quota@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, group_id: child.id }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  // 本人不限；子组配额 100 远大于祖先组配额 5：祖先组先到
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 5 });
  const usage = await f.request(`/quota/usage?scope=group&id=${parent.id}`, undefined, owner);
  expect(await usage.json()).toMatchObject({ scope: 'group', id: parent.id, quota_milli: 5, used_milli: 0, reserved_milli: 5, remaining_milli: 0 });
});

test('a null quota at every level leaves the member unlimited by quota', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 40);
  const group = await (await f.request('/groups', { name: 'Unlimited group' }, owner)).json() as { id: string };
  const member = await f.join('no-quota@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, group_id: group.id }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  // 没有任何配额约束：取 lease_budget_milli、余额 5% 的常规裁决（余额 40，5% 下限是 2）
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 2 });
  // 不限时仍展示本人用量（含这份 active 租约的预留 2），quota_milli/remaining_milli/limited_by 都是 null
  expect(await (await f.request('/me', undefined, member.scoped)).json()).toMatchObject({
    quota: { quota_milli: null, remaining_milli: null, limited_by: null, month_used_milli: 2 },
  });
});

test('lowering a quota does not disturb an outstanding lease; the next renewal is judged by the new value', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('lower-quota@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 100 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 50 }); // 余额 5% 下限先到（1000/20=50），配额 100 还够
  // 配额调低到 1（已低于这份租约已预留的 50），旧租约照常可用
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 2, quota_milli: 1 }, owner)).status).toBe(200);
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 10 });
  // 旧租约按它自己的额度（50）正常结算，差额释放；下一次签发才按新值（1）裁决，且本月已用 10 < 1，立即 quota cutoff
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota', re: 'renew-1' });
  expect(f.store.tenant(f.tenantId).get("SELECT amount_milli FROM ledger WHERE kind = 'settle' AND lease_id = ?", [lease.lease_id]))
    .toEqual({ amount_milli: 10 });
});

test('a new calendar month resets quota usage for the next renewal', async () => {
  const f = await fixture(Date.parse('2027-02-27T20:00:00.000Z')); // 2027-02-28 04:00 Asia/Shanghai（2027 年 2 月没有 29 日）
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('month-boundary@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 5 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 5 });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 5 });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota', re: 'renew-1' });
  f.advance(21 * 60 * 60_000); // 2027-02-28 04:00 -> 2027-03-01 01:00 Asia/Shanghai，跨入下个月
  // 用一条新连接代替重连，更贴近 Edge 断线恢复的实际路径
  const reconnected = connect(f, edge.device_token);
  expect(await reconnected.opened).toBe(true);
  reconnected.hello();
  expect(await reconnected.next()).toMatchObject({ type: 'welcome' });
  expect(await reconnected.next()).toMatchObject({ type: 'lease', budget_milli: 5 });
});

test('two devices for the same member cannot together reserve more than the quota', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('concurrent-quota@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 5 }, owner)).status).toBe(200);
  const [a, b] = await Promise.all([linkedEdge(f, member.scoped, 'A'), linkedEdge(f, member.scoped, 'B')]);
  const [la, lb] = await Promise.all([a.next(), b.next()]);
  expect(la).toMatchObject({ type: 'lease', budget_milli: 5 });
  // 第一台已经把本人月配额全部预留，第二台的签发在同一张表里立即看到，直接 cutoff
  expect(lb).toMatchObject({ type: 'cutoff', reason: 'quota' });
});

test('a replayed op_id for a quota-bound renewal does not double charge the month', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('replay-quota@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 4 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 4 });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 4 });
  const first = await edge.nextOf('cutoff');
  expect(first).toMatchObject({ type: 'cutoff', reason: 'quota' }); // 本人配额 4 已刚好用完，剩余 0
  edge.send({ type: 'lease_renew', id: 'renew-replay', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 4 });
  const replay = await edge.nextOf('cutoff');
  expect(replay).toEqual({ ...first, re: 'renew-replay' });
  expect(f.store.tenant(f.tenantId).get("SELECT count(*) AS n FROM ledger WHERE kind = 'settle' AND lease_id = ?", [lease.lease_id])).toEqual({ n: 1 });
});

test('/quota/usage remaining_milli can go negative when overage pushed settle past the quota', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('negative-remaining@example.test');
  // 配额 2，但这份租约的额度被余额/合约裁决成 5（lease_budget_milli 默认 2000，5% 下限 50，配额本来会把它压到 2，
  // 这里先不设配额签发，再调低配额，制造"已预留/已结算超过新配额"的场景）
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 50 });
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 2 }, owner)).status).toBe(200);
  // 诚实上报用满这份已签发的额度 50，超过新配额 2 一大截；租户按额度 50 实扣（配额不追溯旧租约）
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 50 });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota' });
  const usage = await (await f.request(`/quota/usage?scope=member&id=${member.userId}`, undefined, owner)).json();
  // used_milli 50（settle）> quota_milli 2，没有活跃租约（已 cutoff），remaining 为负，不钳制到 0
  expect(usage).toMatchObject({ scope: 'member', id: member.userId, quota_milli: 2, used_milli: 50, reserved_milli: 0, remaining_milli: -48 });
});

test('balance and quota exhausted together still report balance', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1); // 余额极小，立刻会被预留耗尽
  const member = await f.join('balance-first@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 1 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 1 });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 1 });
  // 配额和余额同时耗尽：报 balance
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'balance', re: 'renew-1' });
});

test('/quota/usage enforces owner/admin/group_admin/member scoping and 404s on an unknown object', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 100);
  const group = await (await f.request('/groups', { name: 'Scoped group', quota_milli: 50 }, owner)).json() as { id: string };
  const other = await (await f.request('/groups', { name: 'Other group', quota_milli: 50 }, owner)).json() as { id: string };
  const groupAdminAccount = await f.join('group-admin@example.test');
  expect((await f.request(`/members/${groupAdminAccount.userId}`, { role: 'group_admin', revision: 1, group_id: group.id }, owner)).status).toBe(200);
  const memberAccount = await f.join('plain-member@example.test');
  expect((await f.request(`/members/${memberAccount.userId}`, { role: 'member', revision: 1, group_id: group.id, quota_milli: 10 }, owner)).status).toBe(200);

  expect((await f.request(`/quota/usage?scope=member&id=${memberAccount.userId}`, undefined, owner)).status).toBe(200);
  expect((await f.request(`/quota/usage?scope=group&id=${group.id}`, undefined, owner)).status).toBe(200);
  expect((await f.request(`/quota/usage?scope=member&id=${memberAccount.userId}`, undefined, groupAdminAccount.scoped)).status).toBe(200);
  expect((await f.request(`/quota/usage?scope=group&id=${group.id}`, undefined, groupAdminAccount.scoped)).status).toBe(200);
  expect((await f.request(`/quota/usage?scope=group&id=${other.id}`, undefined, groupAdminAccount.scoped)).status).toBe(403);
  expect((await f.request(`/quota/usage?scope=member&id=${memberAccount.userId}`, undefined, memberAccount.scoped)).status).toBe(200);
  expect((await f.request(`/quota/usage?scope=member&id=${groupAdminAccount.userId}`, undefined, memberAccount.scoped)).status).toBe(403);
  expect((await f.request(`/quota/usage?scope=group&id=${group.id}`, undefined, memberAccount.scoped)).status).toBe(403);
  expect((await f.request(`/quota/usage?scope=member&id=nonexistent`, undefined, owner)).status).toBe(404);
  expect((await f.request(`/quota/usage?scope=group&id=nonexistent`, undefined, owner)).status).toBe(404);
});
