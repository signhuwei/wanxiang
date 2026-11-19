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
const status = { 401: error('凭据无效或已过期'), 403: error('无权限或租户已满'), 409: error('幂等键已用于不同请求'), 422: error('参数无效'), 500: error('内部错误') };
const bearer = [{ SessionToken: [] }];
const headers = [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string', minLength: 1, maxLength: 128 }, description: '在记录有效期内重放成功结果。' }];
const requestBody = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });

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
        404: error('邀请码无效或已用完'), ...status } } },
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
