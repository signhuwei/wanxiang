import pkg from '../package.json';

const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const revision = { type: 'integer', minimum: 1 };
const actions = { type: 'array', items: text };
const kind = { type: 'string', enum: ['web', 'desktop'] };
const role = { type: 'string', enum: ['owner', 'admin', 'group_admin', 'member'] };
const token = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const tenantId = { type: 'string', pattern: '^ten_[0-9A-HJKMNP-TV-Z]{26}$' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required });
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
const listOf = (schema: object) => ({ security: bearer, parameters: listParams, responses: { 200: response('分页结果',
  object({ items: { type: 'array', items: schema }, total: sequence, next_cursor: nullableText })), 401: status[401], 403: status[403], 422: status[422] } });
const detailOf = (schema: object, hasId = true) => ({ security: bearer, ...(hasId && { parameters: [idPath] }),
  responses: { 200: response('详情', schema), 401: status[401], 403: status[403], 404: error('对象不存在') } });
const write = (input: object, output: object, mode: 'create' | 'update' | 'upsert', hasId = false) => ({
  security: bearer, parameters: hasId ? [idPath, ...headers] : headers, requestBody: requestBody(input), responses: {
    ...(mode !== 'update' && { 201: response('已创建', output) }), ...(mode !== 'create' && { 200: response('已更新', output) }),
    404: error('对象不存在'), ...status,
  },
});
const models = { id: text, provider_id: text, upstream_name: text, display_name: text, context_window: sequence, status: text };
const providers = { id: text, name: text, protocol: { type: 'string', enum: ['anthropic', 'openai_chat', 'openai_responses'] }, base_url: text, status: text };
const releases = { id: text, agent: text, version: text, os: text, arch: text, url: text, sha256: text, size: sequence, status: text };
const tenantFields = { id: tenantId, name: text, owner_user_id: text, status: { type: 'string', enum: ['active', 'suspended'] } };
const rates = { model_id: text, effective_from: { ...text, format: 'date-time' }, input_milli_per_mtok: sequence,
  output_milli_per_mtok: sequence, cache_read_milli_per_mtok: sequence, cache_write_milli_per_mtok: sequence };
const memberInput = { user_id: text, role, group_id: nullableText, status: text, quota_milli: { type: ['integer', 'null'], minimum: 0 } };
const member = managed({ id: text, name: text, email: nullableText, phone: nullableText, ...memberInput });
const groupInput = { name: text, parent_id: nullableText, quota_milli: memberInput.quota_milli };
const group = managed({ id: text, ...groupInput });
const contractInput = { seat_limit: sequence, allowed_agents: { type: 'array', items: text }, allowed_models: { type: 'array', items: text },
  lease_minutes: sequence, lease_budget_milli: sequence, visibility: { type: 'object' } };
const contract = managed({ ...contractInput, updated_by: text, updated_at: text });
const inviteInput = { role, group_id: nullableText, max_uses: sequence, expires_in_ms: sequence };
const invite = object({ id: text, role, group_id: nullableText, max_uses: sequence, used: sequence, expires_at: text,
  created_by: text, revision, actions, code_returned: { type: 'boolean' }, invite_code: text },
['id', 'role', 'group_id', 'max_uses', 'used', 'expires_at', 'created_by', 'revision', 'actions', 'code_returned']);

function platformPaths(path: string, fields: Record<string, unknown>, required: string[], additionalInput = {}, additionalOutput = {}) {
  const result = managed({ ...fields, ...additionalOutput });
  const input = { ...fields, ...additionalInput, revision };
  const item = write(object(input, ['revision']), result, 'update', true);
  return {
    [path]: { get: listOf(result), post: { ...write({ oneOf: [{ ...object(input, required), not: { required: ['id'] } }, object(input, ['id', 'revision'])] }, result, 'upsert'),
      description: '新建时不传 id；更新已有对象时传 id 和 revision。' } },
    [`${path}/{id}`]: { post: item, patch: item },
  };
}

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
      responses: { 200: response('全局令牌', object({ token, user: ref('User'), tenants: { type: 'array', items: ref('Tenant') } })),
        404: error('邀请码无效或已用完'), 429: error('验证码暂时锁定'), ...status } } },
    '/v1/auth/select-tenant': { post: { summary: '签发租户范围令牌', security: bearer, parameters: headers,
      requestBody: requestBody(object({ tenant_id: tenantId, kind }, ['tenant_id'])), responses: { 200: response('租户令牌', object({ token })), ...status } } },
    '/v1/auth/logout': { post: { summary: '吊销当前会话令牌', security: bearer, parameters: headers,
      responses: { 204: response('退出成功'), 401: status[401], 422: status[422], 500: status[500] } } },
    '/v1/me': { get: { summary: '当前用户与权限范围', security: bearer, responses: {
      200: response('用户与当前租户', object({ user: ref('User'), tenant: { anyOf: [ref('Tenant'), { type: 'null' }] },
        role: { anyOf: [role, { type: 'null' }] }, agents: { type: 'array', items: text } })), 401: status[401], 403: status[403], 500: status[500],
    } } },
    '/v1/devices': { post: { summary: '注册设备，需要租户令牌', security: bearer, parameters: headers,
      requestBody: requestBody(object({ name: { ...text, maxLength: 128 }, os: { ...text, maxLength: 32 }, arch: { ...text, maxLength: 32 },
        public_key: { ...text, contentEncoding: 'base64', description: '32 字节 X25519 公钥' } })),
      responses: { 201: response('设备令牌', object({ device_id: text, device_token: token })), ...status } } },
    '/v1/members': { get: listOf(member), post: write(object(memberInput, ['user_id']), member, 'create') },
    '/v1/members/{id}': { get: detailOf(member), ...Object.fromEntries(['post', 'patch'].map((method) =>
      [method, write(object({ ...memberInput, revision }, ['revision']), member, 'update', true)])) },
    '/v1/groups': { get: listOf(group), post: write(object(groupInput, ['name']), group, 'create') },
    '/v1/groups/{id}': { get: detailOf(group), ...Object.fromEntries(['post', 'patch'].map((method) =>
      [method, write(object({ ...groupInput, revision }, ['revision']), group, 'update', true)])) },
    '/v1/invites': { post: { ...write(object(inviteInput, ['role', 'max_uses', 'expires_in_ms']), invite, 'create'),
      description: '首次成功返回邀请码；幂等重放返回 code_returned:false 且不再披露邀请码。' } },
    '/v1/contract': { get: detailOf(contract, false), put: write(object({ ...contractInput, revision: sequence }), contract, 'update') },
    ...platformPaths('/v1/platform/tenants', tenantFields, ['name', 'owner_user_id'], { seat_limit: sequence }, { created_at: text }),
    ...platformPaths('/v1/platform/providers', providers, ['name', 'protocol', 'base_url', 'secret'], { secret: { ...text, writeOnly: true } }),
    ...platformPaths('/v1/platform/models', models, ['provider_id', 'upstream_name', 'display_name', 'context_window']),
    ...platformPaths('/v1/platform/agent-releases', releases, ['agent', 'version', 'os', 'arch', 'url', 'sha256', 'size']),
    '/v1/platform/rates': { get: listOf(managed(rates)), post: write(object({ ...rates, revision }, Object.keys(rates)), managed(rates), 'upsert') },
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
