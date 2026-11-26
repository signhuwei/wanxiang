import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { MemoryPresence } from '../src/presence';
import { seedTenant } from '../src/seed';
import { createServer } from '../src/server';

const base = '/platform/tool-releases';
const metadata = { name: 'release-checklist', version: '1.0.0', kind: 'skill', agents: ['claude-code', 'codex'] };
const entry = '---\nname: release-checklist\ndescription: Check release evidence\n---\n';
const bundle = (files: Record<string, string>) => JSON.stringify({ files: Object.entries(files).map(([path, text]) => ({ path, data: Buffer.from(text).toString('base64') })) });
type Tool = { id: string; status: string; revision: number; sha256: string; size: number; actions: string[] };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'onex-tool-releases-'));
  cleanup.push(() => rmSync(dataDir, { force: true, recursive: true }));
  const codes = new Map<string, string>();
  const service = await createServer({ dataDir, hostname: '127.0.0.1', port: 0, tenantCacheSize: 4, heartbeatMs: 15_000,
    commit: 'test', codeSecret: 'tool-release-test', presence: new MemoryPresence(), deliverCode: (target, code) => { codes.set(target, code); } });
  cleanup.push(() => service.close());
  const request = (path: string, token?: string, body?: object | string, method = body === undefined ? 'GET' : 'POST', key?: string) => {
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (key) headers.set('Idempotency-Key', key);
    return fetch(new URL(`/v1${path}`, service.server.url), { method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  };
  async function tenant(target: string, platformAdmin = false) {
    const { tenantId, userId } = await seedTenant(service.store, { target, platformAdmin, now: Date.now() });
    expect((await request('/auth/code', undefined, { target })).status).toBe(202);
    const session = await request('/auth/login', undefined, { target, code: codes.get(target), kind: 'desktop' });
    expect(session.status).toBe(200);
    const { token } = await session.json() as { token: string };
    const selected = await request('/auth/select-tenant', token, { tenant_id: tenantId });
    expect(selected.status).toBe(200);
    const scoped = (await selected.json() as { token: string }).token;
    return { tenantId, userId, token, scoped };
  }
  async function device(scoped: string, os: 'darwin' | 'win32', arch: 'arm64' | 'x64') {
    const response = await request('/devices', scoped, { name: `${os}/${arch}`, os, arch });
    expect(response.status).toBe(201);
    return response.json() as Promise<{ device_id: string; device_token: string }>;
  }
  const upload = (id: string, revision: number, token: string, raw: string) =>
    request(`${base}/${id}/artifact?revision=${revision}`, token, raw, 'PUT');
  async function publish(token: string, tool: Tool, raw: string) {
    const uploaded = await upload(tool.id, tool.revision, token, raw);
    expect(uploaded.status).toBe(200);
    const { revision } = await uploaded.json() as Tool;
    const published = await request(`${base}/${tool.id}/publish`, token, { revision });
    expect(published.status).toBe(200);
    return published.json() as Promise<Tool>;
  }
  async function contract(tenantId: string, token: string, ids: string[], agents: string[]) {
    const path = '/platform/policy/contracts/' + tenantId;
    const head = await (await request(path, token)).json() as { platform_revision: number; policy_revision: number };
    return request(path + '/signatures', token, {
      expected_platform_revision: head.platform_revision, expected_policy_revision: head.policy_revision,
      base_revision: head.platform_revision || null, reason: 'Tool policy fixture',
      entries: Object.entries({ 'access.agents': agents, 'access.tools': ids, 'seats.limit': 5 })
        .map(([id, adjustment]) => ({ clause_ref: { id, version: 1 }, template_ref: null, adjustment })),
    }, 'POST', ulid());
  }
  async function config(deviceToken: string, v2: boolean) {
    const ws = new WebSocket(`ws://${service.server.hostname}:${service.server.port}/v1/edge/ws`, {
      headers: { Authorization: `Bearer ${deviceToken}`, 'OneX-Edge-Version': '0.1.0', 'OneX-Protocol': '0' },
    });
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No device configuration received')), 1500);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', id: 'tools-policy-hello', edge_version: '0.1.0',
          os: 'darwin', arch: 'arm64', config_revision: 0, outbox_last_seq: 0, agent_cache: true, capability_policy_v2: v2 }));
        ws.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === 'config') {
            clearTimeout(timer);
            resolve(message);
          }
        };
        ws.onclose = () => {
          clearTimeout(timer);
          reject(new Error('Device connection closed before configuration'));
        };
      });
    } finally {
      ws.close();
    }
  }
  return { ...service, dataDir, tenant, device, request, upload, publish, contract, config };
}

test('platform tool release is audited, immutable and served only for fresh eligible device authorization', async () => {
  const f = await fixture();
  const first = await f.tenant('platform@example.test', true);
  const second = await f.tenant('other@example.test');
  expect((await f.request(base)).status).toBe(401);
  expect((await f.request(base, first.scoped)).status).toBe(403);
  expect((await f.request(base, second.token, metadata)).status).toBe(403);
  const createdResponse = await f.request(base, first.token, metadata, 'POST', 'create-skill');
  expect(createdResponse.status).toBe(201);
  const draft = await createdResponse.json() as Tool;
  expect(draft).toMatchObject({ ...metadata, status: 'draft', sha256: null, size: null, revision: 1, actions: ['read', 'upload', 'disable'] });
  expect(await (await f.request(base, first.token, metadata, 'POST', 'create-skill')).json()).toEqual(draft);
  expect((await f.request(base, first.token, metadata)).status).toBe(409);
  expect((await f.request(`${base}/${draft.id}/publish`, first.token, { revision: draft.revision })).status).toBe(409);

  const mac = await f.device(first.scoped, 'darwin', 'arm64');
  const otherTenant = await f.device(second.scoped, 'darwin', 'arm64');
  const artifact = `/edge/tool-artifacts/${draft.id}`;
  const raw = `\n${bundle({ 'SKILL.md': entry, 'docs/check.md': '# Checks' })}\n`;
  expect((await f.contract(first.tenantId, first.token, [draft.id], ['claude-code'])).status).toBe(422);
  expect((await f.request(artifact, mac.device_token)).status).toBe(404);
  const uploaded = await f.upload(draft.id, 1, first.token, raw);
  expect(uploaded.status).toBe(200);
  const upload = await uploaded.json() as Tool;
  expect(upload).toMatchObject({ sha256: createHash('sha256').update(raw).digest('hex'), size: Buffer.byteLength(raw),
    revision: 2, status: 'draft', actions: ['read', 'publish', 'disable'] });
  expect((await f.upload(draft.id, 2, first.token, raw)).status).toBe(409);
  const published = await f.request(`${base}/${draft.id}/publish`, first.token, { revision: 2 });
  expect(published.status).toBe(200);
  expect(await published.json()).toMatchObject({ revision: 3, status: 'published', actions: ['read', 'disable'] });
  expect((await f.request(artifact, first.token)).status).toBe(401);
  expect((await f.request(artifact, otherTenant.device_token)).status).toBe(404);
  expect((await f.request(artifact, mac.device_token)).status).toBe(404);
  expect((await f.contract(first.tenantId, first.token, [draft.id, draft.id], ['claude-code'])).status).toBe(422);
  expect((await f.contract(first.tenantId, first.token, [draft.id], ['claude-code'])).status).toBe(201);
  expect(await (await f.request('/policy/catalog/tools', first.scoped)).json()).toMatchObject({items:[{id:draft.id,label:'release-checklist · 1.0.0 · skill · claude-code, codex'}]});
  const legacy = await f.device(first.scoped, 'darwin', 'arm64');
  expect(await f.config(legacy.device_token, false)).not.toHaveProperty('tools');
  expect(await f.config(mac.device_token, true)).toMatchObject({ tools: [{ id: draft.id, version: '1.0.0',
    sha256: upload.sha256, size: upload.size, agents: ['claude-code'] }], policy: { policy_revision: 1 } });
  const artifactResponse = await f.request(artifact, mac.device_token);
  expect(artifactResponse.status).toBe(200);
  expect(artifactResponse.headers.get('content-length')).toBe(String(upload.size));
  expect(await artifactResponse.text()).toBe(raw);
  expect((await f.contract(first.tenantId, first.token, [draft.id], ['kimi-code'])).status).toBe(201);
  const target = '/policy/targets/' + first.userId + '?os=darwin&arch=arm64';
  expect(await (await f.request(target, first.scoped)).json()).toMatchObject({
    unavailable: expect.arrayContaining([{ resource_id: draft.id, reason: 'tool_agent_denied' }])
  });
  expect((await f.request(artifact, mac.device_token)).status).toBe(404);
  expect((await f.contract(first.tenantId, first.token, [], ['claude-code'])).status).toBe(201);
  expect((await f.request(artifact, mac.device_token)).status).toBe(404);
  expect((await f.contract(first.tenantId, first.token, [draft.id], ['claude-code'])).status).toBe(201);
  const memberProfile = '/policy/configurations/member/' + first.userId;
  const head = { expected_platform_revision: 4, template_ref: null };
  const narrowed = await f.request(memberProfile, first.scoped, { ...head, expected_policy_revision: 4,
    selections: [{ clause_ref: { id: 'access.tools', version: 1 }, value: [] }],
  }, 'PUT', 'narrow-tools');
  expect(narrowed.status).toBe(200);
  expect((await f.request(artifact, mac.device_token)).status).toBe(404);
  expect(await f.config(mac.device_token, true)).toMatchObject({ tools: [], policy: { policy_revision: 5 } });
  expect((await f.request(memberProfile, first.scoped, { ...head, expected_policy_revision: 5, selections: [] }, 'PUT', 'restore-tools')).status).toBe(200);
  expect((await f.request(artifact, mac.device_token)).status).toBe(200);
  expect((await f.request(`${base}/${draft.id}/disable`, first.token, { revision: 3 })).status).toBe(200);
  expect((await f.request(`${base}/${draft.id}/publish`, first.token, { revision: 4 })).status).toBe(409);
  expect((await f.request(artifact, mac.device_token)).status).toBe(404);
  expect(f.store.system.all<{ action: string }>('SELECT action FROM platform_audit WHERE target = ? ORDER BY id', [draft.id]).map(row => row.action).sort())
    .toEqual(['tool_release.create', 'tool_release.disable', 'tool_release.publish', 'tool_release.upload']);
  const page = await f.request(`${base}?q=release&limit=1`, first.token);
  expect(await page.json()).toMatchObject({ total: 1, items: [{ id: draft.id, status: 'disabled' }], actions: ['create_tool_release'] });
});

test('contains a stored malformed tool ID without dropping the signed device policy', async () => {
  const f = await fixture();
  const { tenantId, userId, token, scoped } = await f.tenant('tool-import@example.test', true);
  const created = await f.request(base, token, metadata);
  expect(created.status).toBe(201);
  const valid = await f.publish(token, await created.json() as Tool, bundle({ 'SKILL.md': entry }));
  const mac = await f.device(scoped, 'darwin', 'arm64');
  expect((await f.contract(tenantId, token, [valid.id], ['claude-code'])).status).toBe(201);

  // Simulate a legacy import bypassing both catalog registration and signature validation.
  const malformed = 'tool_0123456789ABCDEF';
  await f.store.system.write(sql => sql.run(`INSERT INTO tool_releases
    (id,name,version,kind,agents_json,args_json,sha256,size,status,delivery,revision,created_at)
    SELECT ?, 'imported-skill', version, kind, agents_json, args_json, sha256, size, status, 'system', 1, created_at
    FROM tool_releases WHERE id = ?`, [malformed, valid.id]));
  const ids = JSON.stringify([valid.id, malformed]);
  await f.store.tenant(tenantId).write(sql => sql.run(`UPDATE policy_effective
    SET document_json = json_set(document_json, '$.hot.tool_release_ids_json', ?)
    WHERE scope = 'member' AND subject_id = ?`, [ids, userId]));

  const config = await f.config(mac.device_token, true);
  expect(config).toMatchObject({ policy: { policy_revision: 1 } });
  expect(config.tools).toEqual([expect.objectContaining({ id: valid.id })]);
  const target = await f.request('/policy/targets/' + userId + '?os=darwin&arch=arm64', scoped);
  expect(await target.json()).toMatchObject({
    unavailable: expect.arrayContaining([{ resource_id: malformed, reason: 'tool_release_unavailable' }]),
  });
  expect((await f.request('/edge/tool-artifacts/' + malformed, mac.device_token)).status).toBe(404);
  expect((await f.request('/edge/tool-artifacts/' + valid.id, mac.device_token)).status).toBe(200);
});

test('rejects ambiguous tool packages and keeps malformed bytes out of storage', async () => {
  const f = await fixture();
  const { token } = await f.tenant('platform@example.test', true);
  expect((await f.request(base, token, { ...metadata, name: 'con' })).status).toBe(422);
  expect((await f.request(base, token, { ...metadata, version: '1.0+build' })).status).toBe(422);
  const created = await f.request(base, token, metadata);
  expect(created.status).toBe(201);
  const { id, revision } = await created.json() as Tool;
  const files = ['../outside', '/absolute', 'bad\\Windows', 'dir/COM1.txt', 'dir/final.', 'x:name', 'dir//double', 'trail '];
  const badBodies = [
    ...files.map(path => bundle({ 'SKILL.md': entry, [path]: 'x' })),
    bundle({ 'skill.md': entry }), bundle({ 'SKILL.md': ' ' }), bundle({ 'SKILL.md': '' }),
    bundle({ 'SKILL.md': entry, 'X.txt': 'x', 'x.TXT': 'y' }),
    bundle({ 'SKILL.md': entry, dir: 'x', 'DIR/a': 'y' }),
    bundle({ 'SKILL.md': entry, 'folder/file': 'y', folder: 'x' }),
    bundle({ 'SKILL.md': entry, 'folder/file': 'y', 'Folder/another': 'x' }),
    '{"files":[{"path":"SKILL.md","data":"eA"}]}',
    '{"files":[{"path":"SKILL.md","path":"SKILL.md","data":"eA=="}]}',
    '{"files":[],"files":[{"path":"SKILL.md","data":"eA=="}]}',
    JSON.stringify({ files: [{ path: 'SKILL.md', data: '//4=' }] }),
    bundle(Object.fromEntries([['SKILL.md', entry], ...Array.from({ length: 256 }, (_, i) => [`file-${i}`, 'a'])])),
  ];
  for (const raw of badBodies) expect((await f.upload(id, revision, token, raw)).status).toBe(422);
  const expanded = bundle({ 'SKILL.md': entry, 'file.dat': 'x'.repeat(16 * 1024 * 1024) });
  expect((await f.upload(id, revision, token, expanded)).status).toBe(413);
  const oversized = ' '.repeat(24 * 1024 * 1024) + bundle({ 'SKILL.md': entry });
  expect((await f.upload(id, revision, token, oversized)).status).toBe(413);
  expect(readdirSync(join(f.dataDir, 'tool-artifacts'))).toEqual([]);
  expect(await (await f.request(`${base}/${id}`, token)).json()).toMatchObject({ revision, sha256: null, size: null });
}, 20_000);

test('MCP download matches platform and arch, and fails for a disabled member', async () => {
  const f = await fixture();
  const { token, scoped, tenantId } = await f.tenant('platform@example.test', true);
  const mcp = { kind: 'mcp', agents: ['codex'], name: 'portable-helper', version: '2.0', os: 'windows', arch: 'x64' };
  expect((await f.request(base, token, { ...mcp, entrypoint: 'bin/run' })).status).toBe(422);
  const created = await f.request(base, token, { ...mcp, entrypoint: 'bin/run.exe', args: ['--fixture'] });
  expect(created.status).toBe(201);
  const draft = await created.json() as Tool;
  expect((await f.upload(draft.id, 1, token, bundle({ 'bin/Run.exe': 'not this exact path' }))).status).toBe(422);
  const published = await f.publish(token, draft, bundle({ 'bin/run.exe': 'fixture bytes' }));
  expect((await f.contract(tenantId, token, [published.id], ['codex'])).status).toBe(201);
  const path = `/edge/tool-artifacts/${published.id}`;
  const mac = await f.device(scoped, 'darwin', 'arm64');
  const windows = await f.device(scoped, 'win32', 'x64');
  const armWindows = await f.device(scoped, 'win32', 'arm64');
  expect((await f.request(path, mac.device_token)).status).toBe(404);
  expect((await f.request(path, armWindows.device_token)).status).toBe(404);
  expect((await f.request(path, windows.device_token)).status).toBe(200);
  await f.store.tenant(tenantId).write(sql => sql.run('UPDATE members SET status = ? WHERE user_id IN (SELECT user_id FROM devices WHERE id = ?)',
    ['disabled', windows.device_id]));
  expect((await f.request(path, windows.device_token)).status).toBe(401);
});

test('published Claude PostToolUse hook is scoped to its authorized agent and architecture', async () => {
  const f=await fixture();
  const owner=await f.tenant('hooks@example.test',true);
  const metadata={kind:'hook',name:'after-tool',version:'1',agents:['claude-code'],os:'macos',arch:'arm64',entrypoint:'bin/observe'};
  for (const change of [{agents:['codex']},{args:['x']},{os:'windows',entrypoint:'observe.exe'}]) {
    expect((await f.request(base,owner.token,{...metadata,...change})).status).toBe(422);
  }
  const created=await f.request(base,owner.token,metadata);
  expect(created.status).toBe(201);
  const hook=await f.publish(owner.token,await created.json() as Tool,bundle({'bin/observe':'fixture'}));
  expect((await f.contract(owner.tenantId,owner.token,[hook.id],['claude-code'])).status).toBe(201);
  const mac=await f.device(owner.scoped,'darwin','arm64');
  const win=await f.device(owner.scoped,'win32','x64');
  expect((await f.request('/edge/tool-artifacts/'+hook.id,mac.device_token)).status).toBe(200);
  expect((await f.request('/edge/tool-artifacts/'+hook.id,win.device_token)).status).toBe(404);
});
