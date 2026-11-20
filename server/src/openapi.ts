import pkg from '../package.json';
import { personalLoginTokenPattern } from './credentials';
import { observedAgents } from './observe';
import { commitPattern, digestPattern, MAX_RELEASE_BYTES } from './release-package';

const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const revision = { type: 'integer', minimum: 1 };
const actions = { type: 'array', items: text };
const kind = { type: 'string', enum: ['web', 'desktop'] };
const role = { type: 'string', enum: ['owner', 'admin', 'group_admin', 'member'] };
const token = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const personalToken = { type: 'string', pattern: personalLoginTokenPattern.source };
const tenantId = { type: 'string', pattern: '^ten_[0-9A-HJKMNP-TV-Z]{26}$' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const loginResponse = object({ token, user: ref('User'), tenants: { type: 'array', items: ref('Tenant') } });
const response = (description: string, schema?: object) => ({ description, ...(schema && { content: { 'application/json': { schema } } }) });
const error = (description: string) => response(description, ref('Error'));
const status = { 401: error('凭据无效或已过期'), 403: error('无权限或租户已满'), 409: error('版本不一致或幂等键已用于不同请求'), 422: error('参数无效'), 500: error('内部错误') };
const bearer = [{ SessionToken: [] }];
const headers = [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string', minLength: 1, maxLength: 128 }, description: '在记录有效期内重放成功结果。' }];
const requestBody = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });
const sequence = { type: 'integer', minimum: 0 };
const listParams = [
  { name: 'q', in: 'query', schema: text }, { name: 'cursor', in: 'query', schema: text },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
];
const idPath = { name: 'id', in: 'path', required: true, schema: text };
const managed = (properties: Record<string, unknown>) => object({ ...properties, revision, actions });
const tokenName = { ...text, minLength: 1, maxLength: 128 };
const timestamp = { ...text, format: 'date-time' };
const nullableTimestamp = { ...nullableText, format: 'date-time' };
const personalTokenRecord = managed({ id: text, name: tokenName, created_at: timestamp, expires_at: timestamp,
  last_used_at: nullableTimestamp, revoked_at: nullableTimestamp });
const listOf = (schema: object, parameters: object[] = []) => ({ security: bearer, parameters: [...listParams, ...parameters], responses: { 200: response('分页结果',
  object({ items: { type: 'array', items: schema }, total: sequence, next_cursor: nullableText, actions })), 401: status[401], 403: status[403], 422: status[422] } });
const detailOf = (schema: object, hasId = true) => ({ security: bearer, ...(hasId && { parameters: [idPath] }),
  responses: { 200: response('详情', schema), 401: status[401], 403: status[403], 404: error('对象不存在') } });
const write = (input: object, output: object, mode: 'create' | 'update' | 'upsert', hasId = false) => ({
  security: bearer, parameters: hasId ? [idPath, ...headers] : headers, requestBody: requestBody(input), responses: {
    ...(mode !== 'update' && { 201: response('已创建', output) }), ...(mode !== 'create' && { 200: response('已更新', output) }),
    404: error('对象不存在'), ...status,
  },
});
const models = { id: text, provider_id: text, upstream_name: text, route_model: nullableText, display_name: text, context_window: sequence, status: text };
const providers = { id: text, name: text, protocol: { type: 'string', enum: ['anthropic', 'openai_chat', 'openai_responses'] }, base_url: text,
  status: text, auth: { enum: ['x_api_key', 'bearer', null] }, proxy: nullableText };
const releases = { id: text, agent: text, version: text, os: text, arch: text, url: text, sha256: text, size: sequence, status: text };
const commitId = { ...text, pattern: commitPattern.source };
const releaseDigest = { ...text, pattern: digestPattern.source };
const releaseSize = { type: 'integer', minimum: 1, maximum: MAX_RELEASE_BYTES };
const commitPath = { name: 'commit', in: 'path', required: true, schema: commitId };
const releaseManifest = object({ commit: commitId, sha256: releaseDigest, size: releaseSize,
  signature: { ...text, pattern: '^[A-Za-z0-9_-]{86}$' } });
const rollout = object({ id: text, commit: commitId, expected_commit: commitId, observed_commit: nullableText, actor_id: text,
  status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed'] },
  error_code: nullableText, created_at: timestamp, started_at: nullableTimestamp, finished_at: nullableTimestamp });
const optionalRollout = { anyOf: [rollout, { type: 'null' }] };
const serverRelease = object({ id: commitId, commit: commitId, size: releaseSize, sha256: releaseDigest, created_at: timestamp,
  uploaded_at: nullableTimestamp, active: { type: 'boolean' }, last_rollout: optionalRollout, actions });
const desktopOs = { type: 'string', enum: ['darwin', 'windows'] };
const desktopArch = { type: 'string', enum: ['arm64', 'x64'] };
const desktopRelease = managed({ id: text, version: text, os: desktopOs, arch: desktopArch,
  status: { type: 'string', enum: ['draft', 'published', 'unlisted'] }, size: { type: ['integer', 'null'], minimum: 0 },
  sha256: nullableText, published_at: nullableText });
const publicDesktopRelease = object({ id: text, version: text, os: desktopOs, arch: desktopArch,
  size: { type: 'integer', minimum: 0 }, sha256: text, published_at: text, download_url: text });
const tenantFields = { id: tenantId, name: text, owner_user_id: text, status: { type: 'string', enum: ['active', 'suspended'] } };
const rates = { model_id: text, effective_from: { ...text, format: 'date-time' }, input_milli_per_mtok: sequence,
  output_milli_per_mtok: sequence, cache_read_milli_per_mtok: sequence, cache_write_milli_per_mtok: sequence };
const memberInput = { user_id: text, role, group_id: nullableText, status: text, quota_milli: { type: ['integer', 'null'], minimum: 0 } };
const member = managed({ id: text, name: text, email: nullableText, phone: nullableText, month_used_milli: sequence, ...memberInput });
const groupInput = { name: text, parent_id: nullableText, quota_milli: memberInput.quota_milli };
const group = managed({ id: text, month_used_milli: sequence, ...groupInput });
const quotaUsage = object({ scope: { type: 'string', enum: ['member', 'group'] }, id: text, quota_milli: { type: ['integer', 'null'], minimum: 0 },
  used_milli: sequence, reserved_milli: sequence, remaining_milli: { type: ['integer', 'null'] }, actions });
const meQuota = object({ quota_milli: { type: ['integer', 'null'], minimum: 0 }, month_used_milli: sequence,
  remaining_milli: { type: ['integer', 'null'] }, limited_by: { type: ['string', 'null'] } });
const contractInput = { seat_limit: sequence, allowed_agents: { type: 'array', items: text }, allowed_models: { type: 'array', items: text },
  lease_minutes: sequence, lease_budget_milli: sequence, visibility: { type: 'object' } };
const contract = managed({ ...contractInput, updated_by: text, updated_at: text });
const audit = managed({ id: text, actor: text, action: text, target: text, at: { ...text, format: 'date-time' } });
const inviteInput = { role, group_id: nullableText, max_uses: sequence, expires_in_ms: sequence };
const invite = object({ id: text, role, group_id: nullableText, max_uses: sequence, used: sequence, expires_at: text,
  created_by: text, revision, actions, code_returned: { type: 'boolean' }, invite_code: text },
['id', 'role', 'group_id', 'max_uses', 'used', 'expires_at', 'created_by', 'revision', 'actions', 'code_returned']);

function platformPaths(path: string, fields: Record<string, unknown>, required: string[], additionalInput = {}, additionalOutput = {}) {
  const result = managed({ ...fields, ...additionalOutput });
  const input = { ...fields, ...additionalInput, revision };
  const item = write(object(input, ['revision']), result, 'update', true);
  return {
    [path]: { get: listOf(result, path.endsWith('/models') ? [{ name: 'provider_id', in: 'query', schema: text }] : []), post: { ...write({ oneOf: [{ ...object(input, required), not: { required: ['id'] } }, object(input, ['id', 'revision'])] }, result, 'upsert'),
      description: '新建时不传 id；更新已有对象时传 id 和 revision。' } },
    [`${path}/{id}`]: { post: item, patch: item },
  };
}

const ledger = managed({ id: text, kind: text, amount_milli: { type: 'integer' }, user_id: nullableText, lease_id: nullableText,
  request_ref: nullableText, by: nullableText, at: text, note: nullableText });
const staleLease = managed({ id: text, device_id: text, user_id: text, budget_milli: sequence, used_milli: sequence,
  expires_at: text, status: text, seq: sequence, last_seen_at: nullableText });
const device = managed({ id: text, user_id: text, name: text, os: text, arch: text, edge_version: nullableText,
  status: text, last_seen_at: nullableText, online: { type: 'boolean' } });
const diagJob = managed({ id: text, device_id: text, kind: { type: 'string', enum: ['logs', 'status'] },
  status: { type: 'string', enum: ['pending', 'ready', 'failed', 'expired'] }, requested_by: text, at: text,
  expires_at: nullableText, download_url: nullableText });

export const openapi = {
  openapi: '3.1.0',
  info: { title: 'OneX Server', version: pkg.version },
  paths: {
    '/v1/healthz': { get: { summary: '健康检查', responses: { 200: response('正常', object({ status: { const: 'ok' }, version: text, commit: text })) } } },
    '/v1/openapi.json': { get: { summary: '接口文档', responses: { 200: response('OpenAPI 文档', { type: 'object' }) } } },
    '/v1/auth/code': { post: { summary: '请求验证码', parameters: headers, requestBody: requestBody(object({ target: text })),
      responses: { 202: response('已受理', object({})), 403: error('未启用验证码发送'), 409: status[409], 422: status[422], 429: error('发送过快'), 500: status[500] } } },
    '/v1/auth/login': { post: { summary: '使用验证码登录，可同时接受邀请', parameters: headers,
      requestBody: requestBody(object({ target: text, code: { type: 'string', pattern: '^[0-9]{6}$' }, invite_code: text, kind: { ...kind, default: 'web' } }, ['target', 'code'])),
      responses: { 200: response('全局令牌', loginResponse),
        404: error('邀请码无效或已用完'), 429: error('验证码暂时锁定'), ...status } } },
    '/v1/auth/token-login': { post: { summary: '使用个人登录令牌换取 Web 会话',
      requestBody: requestBody(object({ token: personalToken })),
      responses: { 200: response('Web 全局会话令牌', loginResponse), 401: status[401], 422: status[422], 500: status[500] } } },
    '/v1/auth/personal-tokens': {
      get: { ...listOf(personalTokenRecord), summary: '当前账户的个人登录令牌台账' },
      post: { ...write(object({ name: tokenName }), { ...personalTokenRecord,
        properties: { ...personalTokenRecord.properties, token: personalToken } }, 'create'),
        summary: '为当前账户创建个人登录令牌，需要 Web 会话',
        description: '令牌有效期七天，每账户最多十枚有效令牌。明文只在首次创建时返回，幂等重放仅返回记录。' },
    },
    '/v1/auth/personal-tokens/{id}/revoke': { post: { summary: '撤销当前账户的个人登录令牌及其会话',
      security: bearer, parameters: [idPath, ...headers], requestBody: requestBody(object({ revision })),
      responses: { 204: response('已撤销'), 401: status[401], 404: error('令牌不存在或不属于当前账户'),
        409: status[409], 422: status[422], 500: status[500] } } },
    '/v1/auth/select-tenant': { post: { summary: '签发租户范围令牌', security: bearer, parameters: headers,
      requestBody: requestBody(object({ tenant_id: tenantId, kind }, ['tenant_id'])), responses: { 200: response('租户令牌', object({ token })), ...status } } },
    '/v1/auth/logout': { post: { summary: '吊销当前会话令牌', security: bearer, parameters: headers,
      responses: { 204: response('退出成功'), 401: status[401], 422: status[422], 500: status[500] } } },
    '/v1/me': { get: { summary: '当前用户与权限范围', security: bearer, responses: {
      200: response('用户与当前租户', object({ user: ref('User'), tenant: { anyOf: [ref('Tenant'), { type: 'null' }] },
        role: { anyOf: [role, { type: 'null' }] }, agents: { type: 'array', items: text }, is_platform_admin: { type: 'boolean' }, actions, quota: meQuota })), 401: status[401], 403: status[403], 500: status[500],
    } } },
    '/v1/devices': { post: { summary: '注册设备，需要租户令牌', security: bearer, parameters: headers,
      requestBody: requestBody(object({ name: { ...text, maxLength: 128 }, os: { ...text, maxLength: 32 }, arch: { ...text, maxLength: 32 },
        public_key: { ...nullableText, contentEncoding: 'base64', description: '32 字节 X25519 公钥，缺少公钥时不下发密钥' } }, ['name', 'os', 'arch'])),
      responses: { 201: response('设备令牌', object({ device_id: text, device_token: token })), ...status } },
      get: { ...listOf(device), summary: '设备台账，仅 owner/admin 可见' } },
    '/v1/devices/{id}': { get: { ...detailOf(device), summary: '设备详情' } },
    '/v1/devices/{id}/diag': { post: { summary: '对指定设备下发诊断指令', security: bearer, parameters: [idPath, ...headers],
      requestBody: requestBody(object({ kind: { type: 'string', enum: ['logs', 'status'] } }, ['kind'])),
      responses: { 201: response('已创建诊断任务', diagJob), 404: error('设备不存在'), 429: error('同设备十分钟内已有一次诊断任务'), ...status },
      description: '仅 owner、admin 或平台管理员可调用；设备离线时任务立即标记失败。' } },
    '/v1/diag/{id}': { get: { summary: '诊断任务状态与下载地址', security: bearer, parameters: [idPath],
      responses: { 200: response('任务状态', diagJob), 401: status[401], 403: status[403], 404: error('任务不存在或无权查看') } } },
    '/v1/diag/{id}/upload': { put: { summary: 'Edge 回传日志包', security: [{ DeviceToken: [] }], parameters: [idPath],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      responses: { 204: response('已存档'), 401: status[401], 404: error('任务不存在或不是待上传状态'), 500: status[500] },
      description: '不是预签名 URL：Edge 用设备令牌直接 PUT 到这个同源路径，Server 代为写入 RustFS。' } },
    '/v1/diag/{id}/download': { get: { summary: '下载诊断日志包', security: bearer, parameters: [idPath],
      responses: { 200: { description: '日志包二进制', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        401: status[401], 403: status[403], 404: error('任务未完成、无权查看或保留期已过') } } },
    '/v1/members': { get: listOf(member, [{ name: 'role', in: 'query', schema: role },
      { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'disabled'] } }]), post: write(object(memberInput, ['user_id']), member, 'create') },
    '/v1/members/{id}': { get: detailOf(member), ...Object.fromEntries(['post', 'patch'].map((method) =>
      [method, write(object({ ...memberInput, revision }, ['revision']), member, 'update', true)])) },
    '/v1/groups': { get: listOf(group), post: write(object(groupInput, ['name']), group, 'create') },
    '/v1/groups/{id}': { get: detailOf(group), ...Object.fromEntries(['post', 'patch'].map((method) =>
      [method, write(object({ ...groupInput, revision }, ['revision']), group, 'update', true)])) },
    '/v1/invites': { post: { ...write(object(inviteInput, ['role', 'max_uses', 'expires_in_ms']), invite, 'create'),
      description: '首次成功返回邀请码；幂等重放返回 code_returned:false 且不再披露邀请码。' } },
    '/v1/contract': { get: detailOf(contract, false), put: write(object({ ...contractInput, revision: sequence }), contract, 'update') },
    '/v1/balance': { get: detailOf(managed({ balance_milli: sequence, reserved_milli: sequence, month_used_milli: sequence }), false) },
    '/v1/quota/usage': { get: { summary: '本月配额用量', security: bearer,
      parameters: [{ name: 'scope', in: 'query', required: true, schema: { type: 'string', enum: ['member', 'group'] } },
        { name: 'id', in: 'query', required: true, schema: text }],
      responses: { 200: response('配额用量', quotaUsage), 401: status[401], 403: status[403], 404: error('对象不存在'), 422: status[422] },
      description: 'owner、admin 可查全部；group_admin 只能查本组及子组；member 只能查自己。' } },
    '/v1/ledger': { get: listOf(ledger) },
    '/v1/audit': { get: { ...listOf(audit, [{ name: 'action', in: 'query', schema: text, description: '动作精确匹配。' }]),
      summary: '本租户审计台账，仅限本租户 owner', description: 'q 在动作、操作者和目标上按字面搜索。按 at、id 依次倒序排列。' } },
    '/v1/platform/ledger/topup': { post: write(object({ tenant_id: tenantId, amount_milli: { ...sequence, minimum: 1 }, note: text },
      ['tenant_id', 'amount_milli']), { allOf: [ledger, object({ tenant_id: tenantId })] }, 'create') },
    '/v1/observe/people': { get: listOf(managed({ user_id: text, name: text, session_count: sequence, cost_milli: sequence,
      month_cost_milli: sequence, last_active_at: nullableText, last_agent: nullableText,
      quota_milli: memberInput.quota_milli, month_used_milli: sequence })) },
    '/v1/observe/sessions': { get: listOf(managed({ id: text, device_id: text, user_id: text, agent: text, agent_version: text, model: nullableText,
      started_at: text, ended_at: nullableText, event_count: sequence, turn_count: sequence, cost_milli: sequence, input_tokens: sequence, output_tokens: sequence,
      cache_read_tokens: sequence, cache_write_tokens: sequence, pending_usage_count: sequence }), [
      { name: 'user_id', in: 'query', schema: text },
      { name: 'agent', in: 'query', schema: { ...text, enum: observedAgents } }]) },
    '/v1/observe/sessions/{id}/events': { get: { ...listOf(managed({ device_id: text, seq: sequence, session_id: text, kind: text,
      at: text, source_offset: { type: ['integer', 'null'] }, payload: { type: 'object' } }), [idPath, { name: 'after_seq', in: 'query', schema: sequence }]),
      description: '按序号读取正文；每次成功读取审计。' } },
    '/v1/observe/stream': { get: { security: bearer, summary: '实时监察摘要（不含正文）', responses: {
      200: { description: '会话、事件和用量摘要流', content: { 'text/event-stream': { schema: text } } }, 401: status[401], 403: status[403],
    } } },
    '/v1/observe/stale-leases': { get: { ...listOf(staleLease), description: '超过 24 小时未回连，仍保留预留额度的过期租约。' } },
    ...platformPaths('/v1/platform/tenants', tenantFields, ['name', 'owner_user_id'], { seat_limit: sequence }, { created_at: text }),
    ...platformPaths('/v1/platform/providers', providers, ['name', 'protocol', 'base_url', 'secret'], { secret: { ...text, writeOnly: true } }),
    ...platformPaths('/v1/platform/models', models, ['provider_id', 'upstream_name', 'display_name', 'context_window']),
    ...platformPaths('/v1/platform/agent-releases', releases, ['agent', 'version', 'os', 'arch', 'url', 'sha256', 'size']),
    '/v1/platform/maintenance': { get: { ...detailOf(object({ active_commit: text, runner_ready: { type: 'boolean' },
      active_rollout: optionalRollout, actions }), false), summary: '平台维护状态' } },
    '/v1/platform/server-releases': { get: listOf(serverRelease), post: { summary: '登记签名的 Server 发布包',
      security: bearer, requestBody: requestBody(releaseManifest), responses: { ...status, 200: response('既有发布', serverRelease),
        201: response('已登记', serverRelease) } } },
    '/v1/platform/server-releases/{commit}': { get: { ...detailOf(serverRelease, false), parameters: [commitPath] } },
    '/v1/platform/server-releases/{commit}/artifact': { put: { summary: '上传签名清单对应的 tar.gz',
      security: bearer, parameters: [commitPath],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      responses: { ...status, 200: response('大小与摘要通过校验', serverRelease), 404: error('对象不存在'), 413: error('文件超限') } } },
    '/v1/platform/server-releases/{commit}/deploy': { post: { summary: '提交 Server 部署',
      security: bearer, parameters: [commitPath, { ...headers[0], required: true }],
      requestBody: requestBody(object({ expected_commit: commitId })), responses: { ...status, 202: response('持久化部署任务', rollout),
        404: error('对象不存在') } } },
    '/v1/platform/server-rollouts/{id}': { get: { ...detailOf(rollout), summary: '查询部署任务及实际生效版本' } },
    '/v1/platform/desktop-releases': { get: listOf(desktopRelease), post: { ...write(object({ version: text, os: desktopOs, arch: desktopArch }, ['version', 'os', 'arch']), desktopRelease, 'create'),
      description: '新建草稿；同一 os/arch/version 已存在时返回 409。' } },
    '/v1/platform/desktop-releases/{id}': { get: { ...detailOf(desktopRelease), description: '上传结果未知时用来重新确认当前修订与摘要。' } },
    '/v1/platform/desktop-releases/{id}/artifact': { put: { summary: '上传安装包原始字节', security: bearer,
      parameters: [idPath, { name: 'revision', in: 'query', required: true, schema: revision }],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      responses: { ...status, 200: response('校验通过的草稿，带字节数和摘要', desktopRelease), 404: error('对象不存在'),
        409: error('不是草稿状态或 revision 已过期'), 413: error('超出单包大小上限'), 422: error('格式或参数无效') },
      description: '仅平台管理员；S2 单包上限 256 MiB，校验实际字节数和 XAR/PE 格式后才改草稿元数据。' } },
    '/v1/platform/desktop-releases/{id}/publish': { post: { summary: '发布草稿为当前版本', security: bearer, parameters: [idPath, ...headers],
      requestBody: requestBody(object({ revision })), responses: { 200: response('已发布', desktopRelease), 404: error('对象不存在'), ...status },
      description: '要求草稿已校验（size/sha256 非空）；同一 os/arch 原来的当前版本在同一事务内转为 unlisted。' } },
    '/v1/platform/desktop-releases/{id}/unpublish': { post: { summary: '下架当前版本', security: bearer, parameters: [idPath, ...headers],
      requestBody: requestBody(object({ revision })), responses: { 200: response('已下架', desktopRelease), 404: error('对象不存在'), ...status } } },
    '/v1/desktop-releases': { get: { summary: '员工入口：当前已发布的安装包列表', description: '无需登录；只含当前已发布版本，不回退到历史记录。',
      responses: { 200: response('列表', object({ items: { type: 'array', items: publicDesktopRelease } })) } } },
    '/v1/desktop-releases/{id}/download': { get: { summary: '员工入口：下载安装包', parameters: [idPath],
      responses: { 200: { description: '安装包二进制', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        404: error('未发布或不存在') }, description: '无需登录；同源附件下载，固定文件名。' } },
    '/v1/platform/rates': { get: listOf(managed(rates), [{ name: 'model_id', in: 'query', schema: text }]), post: write(object({ ...rates, revision }, Object.keys(rates)), managed(rates), 'upsert') },
    '/v1/edge/ws': { get: { summary: 'Edge WebSocket 握手', description: '升级后先发送 hello，收到 welcome 后进行 ping/pong。',
      security: [{ DeviceToken: [] }], parameters: [
        { name: 'OneX-Edge-Version', in: 'header', required: true, schema: text },
        { name: 'OneX-Protocol', in: 'header', required: true, schema: { type: 'string', const: '0' } },
        { name: 'Upgrade', in: 'header', required: true, schema: { type: 'string', const: 'websocket' } },
      ], responses: { 101: response('WebSocket 已连接'), 401: status[401], 422: status[422], 500: status[500] } } },
  },
  components: {
    securitySchemes: { SessionToken: { type: 'http', scheme: 'bearer' }, DeviceToken: { type: 'http', scheme: 'bearer' } },
    schemas: {
      User: object({ id: text, email: nullableText, phone: nullableText, name: text, created_at: { ...text, format: 'date-time' }, revision, actions }),
      Tenant: object({ id: tenantId, name: text, status: { const: 'active' }, role, revision, actions }),
      Error: object({ error: object({ code: text, message: text, detail: { type: 'object' } }, ['code', 'message']) }),
    },
  },
};
