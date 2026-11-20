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
    // Idempotency-Key 不接受空格；设备名允许带空格，所以键单独生成，不拼进 name。
    const res = await request('/devices', { name, os: 'darwin', arch: 'arm64', public_key: publicKey }, scoped, `device-${Math.random()}`);
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

test('/quota/usage enforces owner/admin/group_admin/member scoping, hiding both unauthorized and unknown objects behind 404', async () => {
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
  // v0.13：无权查看一个真实存在的对象也回 404，不借由 403/404 的区别探测 id 是否存在
  expect((await f.request(`/quota/usage?scope=group&id=${other.id}`, undefined, groupAdminAccount.scoped)).status).toBe(404);
  expect((await f.request(`/quota/usage?scope=member&id=${memberAccount.userId}`, undefined, memberAccount.scoped)).status).toBe(200);
  expect((await f.request(`/quota/usage?scope=member&id=${groupAdminAccount.userId}`, undefined, memberAccount.scoped)).status).toBe(404);
  expect((await f.request(`/quota/usage?scope=group&id=${group.id}`, undefined, memberAccount.scoped)).status).toBe(404);
  expect((await f.request(`/quota/usage?scope=member&id=nonexistent`, undefined, owner)).status).toBe(404);
  expect((await f.request(`/quota/usage?scope=group&id=nonexistent`, undefined, owner)).status).toBe(404);
});

test('a one-milli remaining quota issues a one-milli lease instead of a cutoff', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('boundary-one@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 1 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  // 配额剩余正好是 1（> 0）：按额度签发一份 budget_milli=1 的租约，不是 cutoff
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 1 });
  // 用满这 1 之后，剩余才真正到 0，下一次续租才 cutoff
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 1 });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota', re: 'renew-1' });
});

test('reassigning a member to another group moves their settled usage with them immediately', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const oldGroup = await (await f.request('/groups', { name: 'Old group', quota_milli: 100 }, owner)).json() as { id: string };
  const newGroup = await (await f.request('/groups', { name: 'New group', quota_milli: 100 }, owner)).json() as { id: string };
  const member = await f.join('reassigned@example.test');
  // 本人配额刚好等于首租约的额度：结清后本人剩余归零，续租直接 cutoff，不会再留一份预留混进这个断言
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, group_id: oldGroup.id, quota_milli: 50 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 50 });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: lease.budget_milli });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota' });
  // 本月已经结算了 lease.budget_milli，没有活跃租约再预留；这笔用量按当前归属（旧组）算
  expect(await (await f.request(`/quota/usage?scope=group&id=${oldGroup.id}`, undefined, owner)).json())
    .toMatchObject({ used_milli: lease.budget_milli });
  expect(await (await f.request(`/quota/usage?scope=group&id=${newGroup.id}`, undefined, owner)).json())
    .toMatchObject({ used_milli: 0 });
  // 换组：usage 的归属口径是 members 当前的 group_id，不是历史快照，所以已结算的用量立刻跟着member转移到新组，
  // 旧组立刻归零（members.group_id 改变后，data-model.md 配额一节的"本月已用"按当前归属重新计算，不保留按组切分的历史）
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 2, group_id: newGroup.id }, owner)).status).toBe(200);
  expect(await (await f.request(`/quota/usage?scope=group&id=${oldGroup.id}`, undefined, owner)).json())
    .toMatchObject({ used_milli: 0 });
  expect(await (await f.request(`/quota/usage?scope=group&id=${newGroup.id}`, undefined, owner)).json())
    .toMatchObject({ used_milli: lease.budget_milli });
});

// S2B-Q3（v0.13）：断流后的恢复与账务口径

test('a cutoff that settled the old lease carries settled_lease_id, and a replay returns the identical result', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('settled-cutoff@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 4 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 4 });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 4 });
  const first = await edge.nextOf('cutoff');
  // 旧租约已经在这次续租里结清：cutoff 带 settled_lease_id 指向它
  expect(first).toMatchObject({ type: 'cutoff', reason: 'quota', settled_lease_id: lease.lease_id, re: 'renew-1' });
  edge.send({ type: 'lease_renew', id: 'renew-replay', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 4 });
  const replay = await edge.nextOf('cutoff');
  expect(replay).toEqual({ ...first, re: 'renew-replay' });
});

test('a disabled cutoff before settlement never carries settled_lease_id', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('disabled-cutoff@example.test');
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  // 停用成员：deviceAllowed() 在结清前就判定失败。这一步本身先触发一次配置推送的主动 cutoff（没有 re），
  // 排干它，再看这次 lease_renew 真正的回复。
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, status: 'disabled' }, owner)).status).toBe(200);
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'disabled' });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 1 });
  const result = await edge.nextOf('cutoff');
  expect(result).toMatchObject({ type: 'cutoff', reason: 'disabled', re: 'renew-1' });
  expect(result).not.toHaveProperty('settled_lease_id');
  // 旧租约没有被结清，仍然是 active
  expect(f.store.tenant(f.tenantId).get('SELECT status FROM leases WHERE id = ?', [lease.lease_id])).toEqual({ status: 'active' });
});

test('lease_request: disabled device, an outstanding lease, and a fresh issue', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('lease-request@example.test');
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  // 已有 active 租约：直接回这份租约（leaseView() 每次都生成新的消息 id，只比对租约本身的字段）
  edge.send({ type: 'lease_request', id: 'req-outstanding' });
  expect(await edge.nextOf('lease')).toMatchObject({ re: 'req-outstanding', lease_id: lease.lease_id, budget_milli: lease.budget_milli, seq: lease.seq });
  // 结清掉这份租约，让设备没有租约：这时请求走签发规则
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 1 });
  await edge.nextOf('lease');
  edge.send({ type: 'lease_request', id: 'req-fresh' });
  const fresh = await edge.nextOf('lease');
  expect(fresh).toMatchObject({ type: 'lease', re: 'req-fresh' });
  // 设备不可用：回 disabled，不带 settled_lease_id。停用成员这一步本身也会让配置推送主动发一次 cutoff（没有 re），
  // 和这次 lease_request 的回复是两条独立的消息，先排干前者再找带 re 的那条。
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, status: 'disabled' }, owner)).status).toBe(200);
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'disabled' });
  edge.send({ type: 'lease_request', id: 'req-disabled' });
  const disabled = await edge.nextOf('cutoff');
  expect(disabled).toMatchObject({ type: 'cutoff', reason: 'disabled', re: 'req-disabled' });
  expect(disabled).not.toHaveProperty('settled_lease_id');
});

test('lease_request does not write lease_operations, so the same op_id can be resent freely', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('lease-request-idempotent@example.test');
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 1 });
  await edge.nextOf('lease');
  edge.send({ type: 'lease_request', id: 'first' });
  const a = await edge.nextOf('lease');
  edge.send({ type: 'lease_request', id: 'second' });
  const b = await edge.nextOf('lease');
  // 每次都重新裁决：同一活跃租约被原样返回（忽略各自新生成的消息 id），不走 lease_operations 缓存
  expect(b).toMatchObject({ lease_id: a.lease_id, budget_milli: a.budget_milli, seq: a.seq, re: 'second' });
  expect(f.store.tenant(f.tenantId).get("SELECT count(*) AS n FROM lease_operations WHERE lease_id = ?", [a.lease_id])).toEqual({ n: 0 });
});

test('after balance exhaustion, a top-up lets lease_request issue a fresh lease', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1);
  const member = await f.join('balance-recovers@example.test');
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 1 });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 1 });
  const cut = await edge.nextOf('cutoff');
  expect(cut).toMatchObject({ type: 'cutoff', reason: 'balance', settled_lease_id: lease.lease_id });
  edge.send({ type: 'lease_request', id: 'before-topup' });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'balance' });
  await f.fund(ownerToken, 1000);
  edge.send({ type: 'lease_request', id: 'after-topup' });
  expect(await edge.nextOf('lease')).toMatchObject({ type: 'lease', re: 'after-topup' });
});

test('after quota exhaustion, raising the quota lets lease_request issue a fresh lease', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('quota-recovers@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 2 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 2 });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 2 });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota', settled_lease_id: lease.lease_id });
  edge.send({ type: 'lease_request', id: 'before-raise' });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota' });
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 2, quota_milli: 100 }, owner)).status).toBe(200);
  edge.send({ type: 'lease_request', id: 'after-raise' });
  // 余额结清 2 后剩 998，5% 下限 floor(998/20)=49，比新配额剩余 98 更紧
  expect(await edge.nextOf('lease')).toMatchObject({ type: 'lease', re: 'after-raise', budget_milli: 49 });
});

test('a new calendar month lets lease_request recover without a top-up or quota change', async () => {
  const f = await fixture(Date.parse('2027-02-27T20:00:00.000Z')); // 2027-02-28 04:00 Asia/Shanghai
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('month-recovers@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 5 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 5 });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 5 });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota' });
  edge.send({ type: 'lease_request', id: 'still-february' });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota' });
  f.advance(21 * 60 * 60_000); // 跨入 2027-03-01 Asia/Shanghai
  edge.send({ type: 'lease_request', id: 'next-month' });
  expect(await edge.nextOf('lease')).toMatchObject({ type: 'lease', re: 'next-month', budget_milli: 5 });
});

test('/balance.month_used_milli rolls over at Asia/Shanghai midnight, not UTC midnight', async () => {
  // UTC 2027-01-31T16:30 是上海 2027-02-01T00:30：已经跨入二月，这笔结算不该算进一月
  const f = await fixture(Date.parse('2027-01-31T15:00:00.000Z')); // 上海 2027-01-31 23:00
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const member = await f.join('shanghai-midnight@example.test');
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  edge.send({ type: 'lease_renew', id: 'renew-before', op_id: 'op-before', lease_id: lease.lease_id, used_milli: lease.budget_milli });
  const next = await edge.nextOf('lease');
  expect(await (await f.request('/balance', undefined, owner)).json()).toMatchObject({ month_used_milli: lease.budget_milli });
  f.advance(Date.parse('2027-01-31T16:30:00.000Z') - f.now()); // 上海 2027-02-01 00:30，跨入二月
  edge.send({ type: 'lease_renew', id: 'renew-after', op_id: 'op-after', lease_id: next.lease_id, used_milli: next.budget_milli });
  await edge.nextOf('lease');
  // 一月结算的那一笔已经不算进这个新的（二月）自然月
  expect(await (await f.request('/balance', undefined, owner)).json()).toMatchObject({ month_used_milli: next.budget_milli });
});

test('limited_by breaks ties in favor of the member, then the nearest group', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1000);
  const parent = await (await f.request('/groups', { name: 'Tie parent', quota_milli: 5 }, owner)).json() as { id: string };
  const child = await (await f.request('/groups', { name: 'Tie child', quota_milli: 5 }, owner)).json() as { id: string };
  const member = await f.join('tie-break@example.test');
  // 本人、子组、祖先组配额都是 5，剩余并列：/me.quota.limited_by 应该先取本人
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, group_id: child.id, quota_milli: 5 }, owner)).status).toBe(200);
  expect(await (await f.request('/me', undefined, member.scoped)).json()).toMatchObject({ quota: { limited_by: 'member' } });
  // 去掉本人配额：并列的子组和祖先组之间，取离成员最近的（子组）
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 2, quota_milli: null }, owner)).status).toBe(200);
  expect(await (await f.request('/me', undefined, member.scoped)).json()).toMatchObject({ quota: { limited_by: `group:${child.id}` } });
});

// 复核独立验收草稿（coord/reports/s2/quota-review.test.ts）里和 Server 相关的用例，用自己的 fixture 重放确认。

test('a lease issued last month and still active counts as this month reserve; its settle lands in this month', async () => {
  const f = await fixture(Date.parse('2026-11-30T15:55:00.000Z')); // 上海 11 月 30 日 23:55
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1_000_000);
  const member = await f.join('prior-month-lease@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 3000 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  expect(lease).toMatchObject({ type: 'lease', budget_milli: 2000 }); // 合约 lease_budget_milli 默认 2000 更紧
  f.advance(15 * 60_000); // 上海 12 月 1 日 00:10，跨月但这份租约仍 active
  expect(await (await f.request(`/quota/usage?scope=member&id=${member.userId}`, undefined, owner)).json())
    .toMatchObject({ used_milli: 0, reserved_milli: 2000, remaining_milli: 1000 });
  edge.send({ type: 'lease_renew', id: 'renew-1', op_id: 'op-1', lease_id: lease.lease_id, used_milli: 1500 });
  expect(await edge.nextOf('lease')).toMatchObject({ type: 'lease', budget_milli: 1500 });
  // settle 落在新月份（12 月），不是租约签发时的 11 月
  expect(await (await f.request(`/quota/usage?scope=member&id=${member.userId}`, undefined, owner)).json())
    .toMatchObject({ used_milli: 1500, reserved_milli: 1500, remaining_milli: 0 });
});

test('lowering a quota with two outstanding leases can be overshot by both leases together', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1_000_000);
  const member = await f.join('two-leases@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 10_000 }, owner)).status).toBe(200);
  const [e1, e2] = await Promise.all([linkedEdge(f, member.scoped, 'D1'), linkedEdge(f, member.scoped, 'D2')]);
  const [l1, l2] = await Promise.all([e1.next(), e2.next()]);
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 2, quota_milli: 1000 }, owner)).status).toBe(200);
  e1.send({ type: 'lease_renew', id: 'r1', op_id: 'r1', lease_id: l1.lease_id, used_milli: l1.budget_milli });
  expect(await e1.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota' });
  e2.send({ type: 'lease_renew', id: 'r2', op_id: 'r2', lease_id: l2.lease_id, used_milli: l2.budget_milli });
  expect(await e2.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota' });
  // 两份都结清后，合计超出的是两份租约的额度之和（l1.budget_milli + l2.budget_milli），不是单份
  expect(await (await f.request(`/quota/usage?scope=member&id=${member.userId}`, undefined, owner)).json())
    .toMatchObject({ used_milli: l1.budget_milli + l2.budget_milli, reserved_milli: 0, remaining_milli: 1000 - l1.budget_milli - l2.budget_milli });
});

test('overage_pending and the released remainder do not count toward the quota', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1_000_000);
  const member = await f.join('overage-not-quota@example.test');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: 5000 }, owner)).status).toBe(200);
  const edge = await linkedEdge(f, member.scoped);
  const l1 = await edge.nextOf('lease');
  expect(l1).toMatchObject({ type: 'lease', budget_milli: 2000 }); // 合约默认额度 2000 比配额剩余 5000 更紧
  // 实报超过这份额度：按额度 2000 实扣，差额 600 单列 overage_pending，不计入配额已用
  edge.send({ type: 'lease_renew', id: 'r1', op_id: 'r1', lease_id: l1.lease_id, used_milli: 2600 });
  const l2 = await edge.nextOf('lease');
  expect(l2).toMatchObject({ type: 'lease', budget_milli: 2000 });
  expect(await (await f.request(`/quota/usage?scope=member&id=${member.userId}`, undefined, owner)).json())
    .toMatchObject({ used_milli: 2000, reserved_milli: 2000, remaining_milli: 1000 });
  edge.send({ type: 'lease_renew', id: 'r2', op_id: 'r2', lease_id: l2.lease_id, used_milli: 300 });
  // settle 2300、release 1700；剩余 2700，合约 2000 仍更紧
  const l3 = await edge.nextOf('lease');
  expect(l3).toMatchObject({ type: 'lease', budget_milli: 2000 });
  edge.send({ type: 'lease_renew', id: 'r3', op_id: 'r3', lease_id: l3.lease_id, used_milli: 2600 });
  // settle 累计 4300，剩 700 → 新租约只能是 700；这次的 overage 600 同样不计
  const l4 = await edge.nextOf('lease');
  expect(l4).toMatchObject({ type: 'lease', budget_milli: 700 });
  edge.send({ type: 'lease_renew', id: 'r4', op_id: 'r4', lease_id: l4.lease_id, used_milli: 900 });
  expect(await edge.nextOf('cutoff')).toMatchObject({ type: 'cutoff', reason: 'quota' });
  expect(await (await f.request(`/quota/usage?scope=member&id=${member.userId}`, undefined, owner)).json())
    .toMatchObject({ used_milli: 5000, reserved_milli: 0, remaining_milli: 0 });
  expect(f.store.tenant(f.tenantId).get("SELECT sum(amount_milli) AS n FROM ledger WHERE kind = 'overage_pending'")).toEqual({ n: 1400 });
  const row = (await (await f.request('/members', undefined, owner)).json() as { items: { id: string; month_used_milli: number }[] })
    .items.find((item) => item.id === member.userId);
  expect(row?.month_used_milli).toBe(5000);
});

test('/balance.month_used_milli uses Asia/Shanghai even while /members already rolled over', async () => {
  const f = await fixture(Date.parse('2026-10-31T16:30:00.000Z')); // 上海 11 月 1 日 00:30
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 1_000_000);
  const member = await f.join('balance-shanghai@example.test');
  const edge = await linkedEdge(f, member.scoped);
  const lease = await edge.nextOf('lease');
  edge.send({ type: 'lease_renew', id: 'r1', op_id: 'r1', lease_id: lease.lease_id, used_milli: 1500 });
  await edge.nextOf('lease');
  // /members 的 month_used_milli 是配额口径（结算 + 预留），已经按上海 11 月计：结算 1500 + 新租约预留 2000
  const members = (await (await f.request('/members', undefined, owner)).json() as { items: { id: string; month_used_milli: number }[] }).items;
  expect(members.find((item) => item.id === member.userId)?.month_used_milli).toBe(3500);
  // /balance.month_used_milli 只含 settle（不含预留），同样按 Asia/Shanghai：这笔 10 月底发生、上海已跨月的结算算进了新的自然月
  expect(await (await f.request('/balance', undefined, owner)).json()).toMatchObject({ month_used_milli: 1500 });
});

test('quota_milli rejects negative, fractional, non-numeric and unsafe-integer values on members and groups', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  const member = await f.join('validation@example.test');
  for (const bad of [-1, 1.5, '100', Number.MAX_SAFE_INTEGER + 2]) {
    expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, quota_milli: bad as never }, owner)).status).toBe(422);
  }
  for (const bad of [-1, 1.5, '100']) {
    expect((await f.request('/groups', { name: `bad-${bad}`, quota_milli: bad as never }, owner)).status).toBe(422);
  }
});

test('a disabled member is dropped at hello time and never reaches a quota or balance cutoff', async () => {
  const f = await fixture();
  const ownerToken = (await f.login()).token;
  const owner = await f.select(ownerToken);
  await f.fund(ownerToken, 40); // 5% 下限是 2，不影响这个用例关心的停用判定
  const member = await f.join('disabled-at-hello@example.test');
  const token = await f.registerDevice(member.scoped, 'Disabled device');
  expect((await f.request(`/members/${member.userId}`, { role: 'member', revision: 1, status: 'disabled' }, owner)).status).toBe(200);
  // /v1/edge/ws 升级前就要求成员 active（deviceQuery 里的 m.status = 'active'）：停用成员的设备连不上，
  // 根本不会走到 hello，更不会先收到任何 lease 或 cutoff。
  const edge = connect(f, token.device_token);
  expect(await edge.opened).toBe(false);
});
