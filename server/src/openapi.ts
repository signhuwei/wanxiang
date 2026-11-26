import pkg from '../package.json';
import { personalLoginTokenPattern } from './credentials';
import { INPUT_MULTIPLIER_BASIS } from './input-multiplier';
import { observedAgents } from './observe';
import { quoteDimensions } from './procurement';
import { commitPattern, digestPattern, MAX_RELEASE_BYTES } from './release-package';
import toolTargetCatalog from './tool-targets.json';

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
const boolean = { type: 'boolean' };
const loginResponse = object({ token, user: ref('User'), tenants: { type: 'array', items: ref('Tenant') } });
const response = (description: string, schema?: object) => ({ description, ...(schema && { content: { 'application/json': { schema } } }) });
const error = (description: string) => response(description, ref('Error'));
const statisticsParameters = [
  { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
  { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
  { name: 'agent', in: 'query', schema: { type: 'string', enum: [...observedAgents, 'unknown'] } },
];
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
const models = { id: text, provider_id: text, upstream_name: text, route_model: nullableText, display_name: text,
  context_window: revision, max_output_tokens: { type: ['integer', 'null'], minimum: 1,
    description: '签约型号的最大输出 Token，不得超过上下文窗口。更新时省略保留原值，传 null 清空。' }, status: text };
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
const desktopUpdate = object({ id: text, version: text, os: desktopOs, arch: desktopArch, size: releaseSize,
  sha256: releaseDigest, signature: { type: 'string', pattern: '^[A-Za-z0-9_-]{86}$' },
  kind: { type: 'string', enum: ['macos-pkg-keep-daemon', 'windows-edge-bundle'] } });
const desktopRelease = managed({ id: text, version: text, os: desktopOs, arch: desktopArch,
  status: { type: 'string', enum: ['draft', 'published', 'unlisted'] }, size: { type: ['integer', 'null'], minimum: 0 },
  sha256: nullableText, published_at: nullableText });
const publicDesktopRelease = object({ id: text, version: text, os: desktopOs, arch: desktopArch,
  size: { type: 'integer', minimum: 0 }, sha256: text, published_at: text, download_url: text });
const toolId = { ...text, pattern: '^tool_[0-9A-HJKMNP-TV-Z]{26}$' };
const toolFields = { name: text, version: text, kind: { ...text, enum: ['skill', 'mcp', 'hook', 'http_search'] },
  agents: { type: 'array', minItems: 1, uniqueItems: true, items: { ...text, enum: Object.keys(toolTargetCatalog) } },
  os: { enum: ['macos', 'windows', null] }, arch: { enum: ['arm64', 'x64', null] },
  entrypoint: nullableText, args: { type: 'array', items: text } };
const toolDelivery = { ...text, enum: ['system', 'direct', 'selected'] };
const toolReleaseBase = managed({ id: toolId, ...toolFields, status: { ...text, enum: ['draft', 'published', 'disabled'] },
  created_at: timestamp, artifact_cached: boolean, sha256: nullableText, size: { type: ['integer', 'null'], minimum: 1 } });
const toolRelease = { ...toolReleaseBase, properties: { ...toolReleaseBase.properties, delivery: toolDelivery, endpoint: { ...text, format: 'uri' }, has_key: boolean } };
const searchReceipt = object({
  call_id: text, release_id: toolId, session_id: text, plan_id: text, fee_milli: sequence, package_used_milli: sequence,
  status: { ...text, enum: ['awaiting_result', 'charged', 'failed'] },
  called_at: timestamp, settled_at: nullableTimestamp, ledger_id: nullableText, outcome: nullableText,
});
const searchReply = object({ receipt: searchReceipt, results: { type: 'array', items: object({ url: text, title: text, snippet: text }) } }, ['receipt']);
const toolBundle = object({ files: { type: 'array', minItems: 1, maxItems: 256, items: object({
  path: { ...text, maxLength: 240 }, data: { ...text, contentEncoding: 'base64' },
}) } });
const shortName = { ...nullableText, maxLength: 64, description: '可用作登录选择器的租户简称，允许多个租户使用相同简称。' };
const tenantFields = { id: tenantId, name: text, short_name: shortName, owner_user_id: text, status: { type: 'string', enum: ['active', 'suspended'] } };
const rates = { model_id: text, effective_from: { ...text, format: 'date-time' }, input_milli_per_mtok: sequence,
  output_milli_per_mtok: sequence, cache_read_milli_per_mtok: sequence, cache_write_milli_per_mtok: sequence };
const memberInput = { user_id: text, role, group_id: nullableText, status: text, quota_milli: { type: ['integer', 'null'], minimum: 0 } };
const member = managed({ id: text, name: text, email: nullableText, phone: nullableText, month_used_milli: sequence,
  quota_configurable: boolean, ...memberInput });
const groupInput = { name: text, parent_id: nullableText, quota_milli: memberInput.quota_milli };
const group = managed({ id: text, month_used_milli: sequence, quota_configurable: boolean, ...groupInput });
const quotaUsage = object({ scope: { type: 'string', enum: ['member', 'group'] }, id: text, quota_milli: { type: ['integer', 'null'], minimum: 0 },
  used_milli: sequence, reserved_milli: sequence, quota_distribution: boolean, remaining_milli: { type: ['integer', 'null'] }, actions });
const meQuota = object({ quota_milli: { type: ['integer', 'null'], minimum: 0 }, month_used_milli: sequence,
  remaining_milli: { type: ['integer', 'null'] }, limited_by: { type: ['string', 'null'] } });
const agentBinary = { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } };
const agentArtifactRangeParameters = [idPath,
  { name: 'Range', in: 'header', schema: text, description: '单一字节区间，例如 bytes=1048576-。' },
  { name: 'If-Range', in: 'header', schema: text, description: '使用发行 SHA-256 的带引号强 ETag。验证值不匹配时返回完整制品。' },
];
const agentArtifactRangeHeaders = { 'Accept-Ranges': { schema: { const: 'bytes' } }, ETag: { schema: text } };
const agentArtifactContentRange = { 'Content-Range': { schema: text } };
const agentArtifactDownloadResponses = {
  200: { description: '完整制品原始字节', headers: agentArtifactRangeHeaders, content: agentBinary },
  206: { description: '请求区间的制品原始字节', headers: { ...agentArtifactRangeHeaders, ...agentArtifactContentRange }, content: agentBinary },
  416: { description: '有效的字节区间超出制品范围', headers: agentArtifactContentRange },
  401: status[401],
};
const runtimeArtifact = object({ size: sequence, sha256: releaseDigest, artifact_cached: { type: 'boolean' } });
const releaseSupply = { runtime: { anyOf: [runtimeArtifact, { type: 'null' }] }, artifact_cached: { type: 'boolean' }, qualification_required: { type: 'boolean' }, part_bytes: { type: ['integer', 'null'], minimum: 1 },
  format: { type: ['string', 'null'], enum: ['executable', 'dmg', 'nsis', null] } };
const contractInput = { seat_limit: sequence, allowed_agents: { type: 'array', items: text }, allowed_models: { type: 'array', items: text },
  lease_minutes: sequence, lease_budget_milli: sequence, visibility: { type: 'object' } };
const agentPin = { id: text, agent: text, version: text, os: text, arch: text, sha256: releaseDigest, size: sequence };
const contract = managed({ ...contractInput, agent_releases: { type: 'array', items: object({ ...agentPin, available: { type: 'boolean' } }) },
  platform_revision: sequence, tenant_revision: sequence, quota_distribution: boolean, updated_by: text, updated_at: text });
const visible = object({ summary: boolean, content: boolean });
const entitlements = { ...contractInput, lease_minutes: { ...revision, maximum: 1440 },
  visibility: object({ admin: visible, group_admin: visible }), quota_distribution: boolean };
const configurationItems = { allowed_agents: entitlements.allowed_agents, allowed_models: entitlements.allowed_models,
  lease_minutes: entitlements.lease_minutes, lease_budget_milli: entitlements.lease_budget_milli,
  visibility: entitlements.visibility, agent_release_ids: { type: 'array', items: text } };
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const visibilitySelection = object({
  admin: nullable(object({ summary: nullable(boolean), content: nullable(boolean) }, [])),
  group_admin: nullable(object({ summary: nullable(boolean), content: nullable(boolean) }, [])),
}, []);
const tenantConfiguration = object({
  ...Object.fromEntries(Object.entries(configurationItems).map(([key, schema]) => [key, nullable(schema)])),
  visibility: nullable(visibilitySelection),
}, []);
const templateInput = object({ id: text, name: text, revision: sequence, entitlements: object(entitlements) });
const template = object({ id: text, name: text, version: revision, entitlements: object(entitlements),
  published_by: text, published_at: timestamp, actions });
const platformContractFields = { revision, template_id: text, template_version: revision, entitlements: object(entitlements),
  reason: text, issued_by: text, effective_at: timestamp };
const platformContract = object(platformContractFields);
const contractSeats = object({ limit: sequence, active: sequence, available: sequence, over_limit: sequence });
const effectiveContract = object({ ...entitlements, agent_release_ids: configurationItems.agent_release_ids });
const platformContractView = object({ tenant_id: tenantId, revision: sequence, platform_contract: nullable(platformContract),
  tenant_revision: sequence, effective: effectiveContract, seats: contractSeats, actions });
const configurationView = object({ platform_revision: sequence, revision: sequence, entitlements: nullable(object(entitlements)),
  configuration: tenantConfiguration, effective: effectiveContract, seats: contractSeats, actions });
const platformContractInput = object({ revision: sequence, tenant_revision: sequence, template_id: text, template_version: revision,
  entitlements: object(entitlements, []), reason: text }, ['revision', 'tenant_revision', 'template_id', 'template_version', 'reason']);
const configurationInput = object({ platform_revision: revision, revision: sequence, configuration: tenantConfiguration });
const contractPreview = (input: object, parameters: object[] = []) => ({
  security: bearer, parameters, requestBody: requestBody(input),
  responses: { 200: response('预览', object({ previous_effective: effectiveContract, effective: effectiveContract,
    configuration: tenantConfiguration, seats: contractSeats })),
    404: error('对象不存在'), ...status },
});
const contractTenantPath = { name: 'tenant_id', in: 'path', required: true, schema: tenantId };
const contractIdempotency = headers.map(header => ({ ...header, required: true }));
const listItems = (items: object) => ({ type: 'array', items });
const policyRef = object({ id: text, version: revision });
const policyValue = { oneOf: [boolean, sequence, text, listItems(text)] };
const policyScope = { type: 'string', enum: ['tenant', 'group', 'member'] };
const policyBinding = object({ adapter: text, abi: { type: 'integer', const: 1 } });
const definitionFields = {
  id: text, title: text, description: text, category: text, scopes: listItems(policyScope),
  schema: object({
    kind: { type: 'string', enum: ['boolean', 'integer', 'money_milli', 'ratio_ppm', 'enum', 'resource_set', 'text'] },
    min: sequence, max: sequence, catalog: text, options: listItems(object({ id: text, label: text })),
  }, ['kind']),
  merge: { type: 'string', enum: ['fixed', 'min', 'max', 'intersection', 'and'] },
  default_value: policyValue, binding: nullable(policyBinding),
};
const policyDefinitionRecord = object({ ...definitionFields, version: revision });
const policyDefinition = object({ ...definitionFields, version: revision, actions });
const policyChoice = { clause_ref: policyRef, value: policyValue };
const policyTemplateFields = { id: text, name: text, description: text, scope: { type: 'string', enum: ['platform', 'group', 'member'] } };
const policyTemplate = object({ ...policyTemplateFields, version: revision, actions,
  entries: listItems(object({ ...policyChoice, definition: policyDefinitionRecord })) });
const policyDraftEntry = { clause_ref: policyRef, template_ref: nullable(policyRef), adjustment: policyValue };
const policySignedEntry = object({ ...policyDraftEntry, base_value: policyValue, signed_value: policyValue, definition: policyDefinitionRecord },
  ['clause_ref', 'template_ref', 'base_value', 'signed_value', 'definition']);
const policyEffectiveEntry = object({ clause_ref: policyRef, definition: policyDefinitionRecord, parent_value: policyValue,
  effective_value: policyValue, source: object({ scope: text, subject_id: text, revision }) });
const policyHead = { platform_revision: sequence, policy_revision: sequence };
const policyExpected = { expected_platform_revision: sequence, expected_policy_revision: sequence };
const policyContractRow = { tenant_id: tenantId, name: text, short_name: shortName, ...policyHead, actions };
const poolChoice = { model_id: text, pool_revision: revision, mode: { type: 'string', enum: ['pinned', 'follow'] } };
const ownerSignedPools = listItems(object({ ...poolChoice, member_count: revision }));
const platformSignedPools = listItems(object({ ...poolChoice, member_count: revision, source_rate_key: text }));
const policySign = object({ ...policyExpected, base_revision: nullable(revision), reason: text,
  entries: listItems(object(policyDraftEntry, ['clause_ref', 'template_ref'])), route_pools: listItems(object(poolChoice)) },
['expected_platform_revision', 'expected_policy_revision', 'base_revision', 'reason', 'entries']);
const policySignature = { tenant_id: tenantId, revision, current: boolean, ...policyHead, reason: text, issued_by: text, issued_at: timestamp, actions };
const policyConfigInput = {oneOf:[object({ ...policyExpected, template_ref: nullable(policyRef), selections: listItems(object(policyChoice)) }),
  object({...policyExpected,restore_revision:revision})]};
const policyConfig = { scope: policyScope, subject_id: text, revision: sequence, ...policyHead, template_ref: nullable(policyRef),
  selections: listItems(object(policyChoice)), entries: listItems(policyEffectiveEntry), actions };
const policyBalance = object({ balance_milli: sequence, reserved_milli: sequence, month_used_milli: sequence });
const policyRecharge = object({ ledger_id: text, tenant_id: tenantId, platform_revision: revision, amount_milli: revision,
  balance_before_milli: sequence, balance_after_milli: sequence, by: text, at: timestamp, note: nullableText, actions });
const policyDiscountAmounts = { gross_milli: sequence, net_milli: sequence, discount_milli: sequence };
const policyDiscount = object({ tenant_id: tenantId, month: text, ...policyDiscountAmounts,
  adjustment_ledger_id: nullableText, closed_at: timestamp, closed_by: text, actions,
  buckets: listItems(object({ platform_revision: revision, policy_revisions: listItems(revision),
    ratio_ppm: { ...sequence, maximum: 1_000_000 }, ...policyDiscountAmounts })),
});
const policyPlatform = '/v1/platform/policy';
const policyTenant = '/v1/policy';
const policyContractPath = policyPlatform + '/contracts/{tenant_id}';
const policyConfigPath = policyTenant + '/configurations/{scope}/{subject_id}';
const namedPath = (name: string, schema: object = text) => ({ name, in: 'path', required: true, schema });
const policyDetail = (schema: object, parameters: object[]) => ({ ...detailOf(schema, false), parameters });
const policyWrite = (input: object, output: object, mode: 'create' | 'update', parameters: object[] = []) =>
  ({ ...write(input, output, mode), parameters: [...parameters, ...contractIdempotency] });
const policyPreview = (input: object, output: object, parameters: object[]) => ({
  security: bearer, parameters, requestBody: requestBody(input), responses: { 200: response('预览', output), 404: error('对象不存在'), ...status },
});
const versionPaths = (path: string, input: object, output: object) => ({
  [path]: { get: listOf(output), post: policyWrite(input, output, 'create') },
  [path + '/{id}/{version}']: { get: policyDetail(output, [idPath, namedPath('version', revision)]) },
});
const policyTemplateInput = object({ ...policyTemplateFields, expected_version: sequence, entries: listItems(object(policyChoice)) });
const policyConfigParams = [namedPath('scope', policyScope), namedPath('subject_id')];
const policyRechargeList = (parameters: object[]) => ({ ...listOf(policyRecharge, parameters), responses: {
  ...listOf(policyRecharge, parameters).responses,
  200: response('分页结果与可用余额', object({ items: listItems(policyRecharge), total: sequence,
    next_cursor: nullableText, actions, balance: policyBalance })),
} });
const policyOptions = listOf(object({ id: text, label: text }), [namedPath('catalog', { ...text, enum: ['agents', 'models', 'tools','releases','providers','commerce_plans'] }),
  { name: 'ids', in: 'query', schema: text }]);
const discountMonth = namedPath('month', { ...text, pattern: '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$' });
const platformDiscount = policyDetail(policyDiscount, [contractTenantPath, discountMonth]);
const upstreamFields={model_id:text,name:text,upstream_name:text,base_url:text,priority:sequence,status:{enum:['active','disabled']}};
const upstreamView=object({...upstreamFields,id:text,has_key:boolean,protocol:text,revision,actions});
const upstreamWrite={...upstreamFields,expected_revision:sequence,secret:{...text,writeOnly:true}};
const sharesResult=object({items:listItems(object({recipient:text,created_at:timestamp}))});
const impactRow=object({device_id:text,user_id:text,os:text,arch:text,applied_policy_revision:nullable(revision),
  changed_clauses:listItems(text),unavailable:listItems(object({resource_id:text,reason:text}))});
const impactMember = object({user_id:text,name:text,changed_clauses:listItems(text),device_count:sequence});
const priceFields={input_milli_per_mtok:sequence,output_milli_per_mtok:sequence,cache_read_milli_per_mtok:sequence,cache_write_milli_per_mtok:sequence};
const modelPrice = object({model_id:text,source_rate_key:text,...priceFields}, ['model_id',...Object.keys(priceFields)]);
const salesRateFields = {model_id:text,commerce_plan_id:text,source_rate_key:nullableText,terms_digest:text,...priceFields,
  input_multiplier_basis:{const:'cny_1_per_mtok_input'},input_multiplier_ppm:sequence};
const signedSalesRates = listItems(object({...salesRateFields,rate_version_id:text,platform_revision:revision,
  valid_from:timestamp,valid_until:nullable(timestamp)}));
const tenantSignedSalesRates = listItems(object({rate_version_id:text,model_id:text,
  input_multiplier_basis:salesRateFields.input_multiplier_basis,input_multiplier_ppm:sequence,
  valid_from:timestamp,valid_until:nullable(timestamp),...priceFields}));
const commerceFields={monthly_grant_milli:sequence,monthly_fee_fen:sequence,
  tiers:listItems(object({from_milli:sequence,ratio_ppm:sequence})),commitment:nullable(object({up_to_milli:sequence,ratio_ppm:sequence})),
  model_prices:listItems(modelPrice),model_budgets:listItems(object({model_id:text,monthly_milli:sequence})),
  tool_prices:listItems(object({release_id:text,per_call_milli:sequence}))};
const commerceTerms=object(commerceFields);
const commerceTermsInput=object({...commerceFields,model_prices:listItems({oneOf:[
  {...object({model_id:text,source_rate_key:text}),additionalProperties:false},modelPrice,
]})}, []);
const commercePlan=object({id:text,plan_id:text,version:revision,name:text,terms:commerceTerms,created_by:text,created_at:timestamp});
const tierInput={floor_model_id:text,models:listItems(object({model_id:text,tier:{enum:['floor','standard','pro','advanced','top']}}))};
const commerceAccount=object({tenant_id:text,month:text,plan:nullable(commercePlan),balance_milli:{type:'integer'},reserved_milli:sequence,
  month_used_milli:sequence,permanent_available_milli:{type:'integer'},package_available_milli:sequence,packages:listItems({type:'object'}),
  model_budgets:listItems({type:'object'}),tool_calls:listItems({type:'object'}),tiers:{type:'object'}},
  ['tenant_id','month','plan','balance_milli','reserved_milli','permanent_available_milli','package_available_milli','packages','model_budgets','tool_calls','tiers']);
const targetParameters=[namedPath('user_id'),{name:'os',in:'query',required:true,schema:{enum:['darwin','win32','linux']}},
  {name:'arch',in:'query',required:true,schema:{enum:['arm64','x64']}}];
const targetView=object({...policyHead,user_id:text,os:text,arch:text,models:listItems({type:'object'}),releases:listItems({type:'object'}),
  tools:listItems({type:'object'}),routes:listItems(object({model_id:text,candidates:listItems(object({provider_id:text,priority:sequence,source:text}))})),unavailable:listItems(object({resource_id:text,reason:text}))});
const policyPaths = {
  [policyTenant+'/targets/{user_id}']:{get:policyDetail(targetView,targetParameters)},
  [policyContractPath+'/targets/{user_id}']:{get:policyDetail(targetView,[contractTenantPath,...targetParameters])},
  [policyContractPath+'/targets']:{get:listOf(object({user_id:text,name:text,actions}),[contractTenantPath])},
  '/v1/platform/commerce/plans':{get:listOf(commercePlan),post:policyWrite(object({name:text,expected_version:sequence,plan_id:text,terms:commerceTermsInput},['name','expected_version','terms']),commercePlan,'create')},
  '/v1/platform/commerce/model-tiers':{get:detailOf(object({...tierInput,revision:sequence}),false),
    put:policyWrite(object({...tierInput,expected_revision:sequence}),object({...tierInput,revision}),'update')},
  '/v1/platform/commerce/tenants/{tenant_id}':{get:policyDetail(commerceAccount,[contractTenantPath])},
  '/v1/commerce/account':{get:detailOf(commerceAccount,false)},
  [policyConfigPath+'/history']:{get:listOf(object({revision,platform_revision:revision,updated_at:timestamp,updated_by:text,
    restored_from_revision:nullable(revision)}),policyConfigParams)},
  [policyTenant+'/upstreams']:{get:listOf(upstreamView),post:policyWrite(object(upstreamWrite,['model_id','name','upstream_name','base_url','expected_revision','secret']),upstreamView,'create')},
  [policyTenant+'/upstreams/{id}']:{put:policyWrite(object(upstreamWrite,['expected_revision']),upstreamView,'update',[idPath])},
  '/v1/observe/shared':{get:listOf(object({id:text,user_id:text,agent:text,model:nullableText,created_at:timestamp}))},
  '/v1/observe/sessions/{id}/export':{get:listOf(object({seq:sequence,kind:text,at:timestamp,payload:{type:'object'}}),[idPath])},
  '/v1/observe/sessions/{id}/shares':{get:policyDetail(sharesResult,[idPath]),post:write(object({recipient:text}),sharesResult,'update',true)},
  '/v1/observe/sessions/{id}/shares/{recipient}':{delete:policyDetail(sharesResult,[idPath,namedPath('recipient')])},
  [policyPlatform + '/adapters']: { get: listOf(object({
    id: text, abi: revision, kind: text, merge: text, scopes: listItems(policyScope), catalog: text, min: sequence, max: sequence,
  }, ['id', 'abi', 'kind', 'merge', 'scopes'])) },
  ...versionPaths(policyPlatform + '/definitions', object({ ...definitionFields, expected_version: sequence }), policyDefinition),
  ...versionPaths(policyPlatform + '/templates', policyTemplateInput, policyTemplate),
  ...versionPaths(policyTenant + '/configuration-templates', policyTemplateInput, policyTemplate),
  [policyPlatform + '/catalog/{catalog}']: { get: policyOptions },
  [policyTenant + '/catalog/{catalog}']: { get: policyOptions },
  [policyPlatform + '/contracts']: { get: listOf(object(policyContractRow)) },
  [policyContractPath]: { get: policyDetail(object({ ...policyContractRow, balance: policyBalance }), [contractTenantPath]) },
  [policyContractPath + '/signatures']: { get: listOf(object(policySignature), [contractTenantPath]),
    post: policyWrite(policySign, object({ ...policySignature, entries: listItems(policySignedEntry), sales_rate_snapshots:signedSalesRates,
      route_pools:platformSignedPools }), 'create', [contractTenantPath]) },
  [policyContractPath + '/signatures/{revision}']: { get: policyDetail(object({ ...policySignature, entries: listItems(policySignedEntry),
    sales_rate_snapshots:signedSalesRates, route_pools:platformSignedPools }),
    [contractTenantPath, namedPath('revision', revision)]) },
  [policyContractPath + '/preview']: { post: policyPreview(policySign, object({ tenant_id: tenantId, ...policyHead,
    entries: listItems(policySignedEntry), previous_entries: listItems(policySignedEntry), sales_rate_snapshots:listItems(object(salesRateFields)),
    route_pools:platformSignedPools, actions,
    seats:object({limit:sequence,active:sequence,over_limit:sequence}),impact:object({member_count:sequence,device_count:sequence,
      members:object({items:listItems(impactMember),total:sequence,next_cursor:nullableText,actions}),
      devices:object({items:listItems(impactRow),total:sequence,next_cursor:nullableText,actions})}) }),
    [contractTenantPath,...listParams,{name:'member_cursor',in:'query',schema:text,description:'受影响成员的分页游标。cursor 用于受影响设备。'}]) },
  [policyTenant + '/signatures']: { get: listOf(object(policySignature)) },
  [policyTenant + '/signatures/{revision}']: { get: {
    ...policyDetail(object({ revision,issued_at:timestamp,sales_rate_snapshots:tenantSignedSalesRates,route_pools:ownerSignedPools,actions }),
      [namedPath('revision', revision)]),
    summary: '户主读取本租户签发版本的销售费率',
  } },
  [policyTenant + '/configurations/{scope}']: { get: listOf(object({
    id: text, name: text, role, group_id: nullableText, parent_id: nullableText, actions,
  }, ['id', 'name', 'actions']), [namedPath('scope', { type: 'string', enum: ['group', 'member'] })]) },
  [policyConfigPath]: { get: policyDetail(object(policyConfig), policyConfigParams),
    put: policyWrite(policyConfigInput, object(policyConfig), 'update', policyConfigParams) },
  [policyConfigPath + '/preview']: { post: policyPreview(policyConfigInput, object({ ...policyConfig,
    previous_entries: listItems(policyEffectiveEntry) }), policyConfigParams) },
  [policyContractPath + '/recharges']: { get: policyRechargeList([contractTenantPath]),
    post: policyWrite(object({ amount_milli: revision, note: text }, ['amount_milli']), policyRecharge, 'create', [contractTenantPath]) },
  [policyContractPath + '/recharges/{ledger_id}']: { get: policyDetail(policyRecharge, [contractTenantPath, namedPath('ledger_id')]) },
  [policyTenant + '/recharges']: { get: policyRechargeList([]) },
  [policyTenant + '/recharges/{ledger_id}']: { get: policyDetail(policyRecharge, [namedPath('ledger_id')]) },
  [policyContractPath + '/discounts/{month}']: { get: platformDiscount,
    post: { ...platformDiscount, parameters: [...platformDiscount.parameters, ...contractIdempotency],
      responses: { ...platformDiscount.responses, ...status } } },
  [policyTenant + '/discounts/{month}']: { get: policyDetail(policyDiscount, [discountMonth]) },
};
const audit = managed({ id: text, actor: text, action: text, target: text, at: { ...text, format: 'date-time' } });
const inviteInput = { role, group_id: nullableText, max_uses: sequence, expires_in_ms: sequence };
const invite = object({ id: text, role, group_id: nullableText, max_uses: sequence, used: sequence, expires_at: text,
  created_by: text, revision, actions, code_returned: { type: 'boolean' }, invite_code: text },
['id', 'role', 'group_id', 'max_uses', 'used', 'expires_at', 'created_by', 'revision', 'actions', 'code_returned']);

function platformPaths(path: string, fields: Record<string, unknown>, required: string[], additionalInput = {}, additionalOutput = {},
  listOutput = additionalOutput, detail = false) {
  const result = managed({ ...fields, ...additionalOutput });
  const listResult = object({ ...fields, revision, actions, ...listOutput });
  const input = { ...fields, ...additionalInput, revision };
  const item = write(object(input, ['revision']), result, 'update', true);
  return {
    [path]: { get: listOf(listResult, path.endsWith('/models') ? [{ name: 'provider_id', in: 'query', schema: text }] : []), post: { ...write({ oneOf: [{ ...object(input, required), not: { required: ['id'] } }, object(input, ['id', 'revision'])] }, result, 'upsert'),
      description: '新建时不传 id；更新已有对象时传 id 和 revision。' } },
    [`${path}/{id}`]: { ...(detail && { get: detailOf(result) }), post: item, patch: item },
  };
}

const routingId = { ...text, pattern: '^[A-Za-z0-9_.-]{1,128}$' };
const routingModelId = namedPath('model_id', routingId);
const routingPoolPath = '/v1/platform/models/{model_id}/pool';
const routingPagination = listParams.slice(1);
const routingSearch = { name: 'q', in: 'query', schema: { ...text, maxLength: 200 } };
const readActions = { ...actions, const: ['read'] };

function routingList(item: object, parameters: object[], pageActions: object, extras = {}, optionalFields = {}) {
  const list = listOf(item);
  const fields = { items: listItems(item), total: sequence, next_cursor: nullableText, actions: pageActions, ...extras };
  return { ...list, parameters, responses: { ...list.responses, 404: error('对象不存在'),
    200: response('分页结果', object({ ...fields, ...optionalFields }, Object.keys(fields))) } };
}

const providerDeployment = object({ id: routingId, revision, deployment_revision: revision, display_name: text, raw_model: text,
  account_id: routingId, endpoint_id: routingId, capabilities: listItems(text),
  status: { ...text, enum: ['active', 'disabled', 'archived'] }, actions: { ...actions, const: ['read', 'read_quotes'] },
  archive_blockers: listItems(object({ kind: { const: 'active_pool' }, model_id: routingId, pool_revision: revision })) });
const routingMatchStatus = { ...text, enum: ['suggested', 'needs_review', 'accepted', 'rejected'] };
const routingCandidateFields = { candidate_id: routingId, discovery_id: nullableText, catalog_item_id: nullableText,
  deployment_id: routingId, deployment_revision: revision, provider_id: routingId, account_id: routingId, endpoint_id: routingId, raw_model: text,
  match: object({ match_rule_id: nullableText, rule_revision: nullable(revision),
    kind: { ...text, enum: ['exact', 'catalog', 'manual', 'normalized'] }, confidence: { ...text, enum: ['high', 'medium', 'low'] },
    reason: text, reasons: listItems(text), review_status: routingMatchStatus }),
  capabilities: listItems(text), health: object({ state: { const: 'unknown' }, reason: { const: 'not_observed' } }),
  quote_ref: { type: 'null' }, eligible: boolean, reason: nullableText, reasons: listItems(text),
  actions: { ...actions, enum: [['read'], ['read', 'select']] } };
const routingCandidate = { ...object({ ...routingCandidateFields, approved_match_id: routingId, evidence_ids: listItems(routingId) },
  Object.keys(routingCandidateFields)),
  if: { properties: { eligible: { const: true } } }, then: { required: ['approved_match_id', 'evidence_ids'] },
  else: { properties: { actions: readActions, approved_match_id: false, evidence_ids: false } } };

const routingMember = { deployment_id: routingId, deployment_revision: revision, priority: { ...sequence, maximum: 1_000_000 },
  approved_match_id: routingId, evidence_ids: { ...listItems(routingId), minItems: 1, maxItems: 16 } };
const routingRules = { ...object({ strategy: { const: 'ordered' }, max_attempts: { ...revision, maximum: 8 },
  attempt_timeout_ms: { ...revision, maximum: 600_000 },
  total_timeout_ms: { ...revision, maximum: 600_000, description: '不得小于单次尝试时限。' } }), additionalProperties: false };
const routingDraftContents = { members: { ...listItems({ ...object(routingMember), additionalProperties: false }), minItems: 1, maxItems: 32,
  description: '同一 deployment_id 只允许出现一次。' }, routing: routingRules,
  reason: { ...text, maxLength: 500, pattern: '\\S' } };
const routingDraft = { expected_pool_revision: sequence, ...routingDraftContents };
const routingIssue = object({ code: text, message: text, deployment_id: routingId, field: text }, ['code', 'message']);
const routingPreviewBasis = { ...text, maxLength: 256, pattern: '\\S', description: '预览返回的不透明校验依据。' };
const routingPreview = { ...object({ model_id: routingId, expected_pool_revision: sequence, preview_basis: routingPreviewBasis,
  publishable: boolean, blocking: listItems(routingIssue), warnings: listItems(routingIssue),
  diff: object({ added: listItems(routingId), removed: listItems(routingId), updated: listItems(routingId) }),
  impact: object({ tenant_count: sequence, device_count: sequence }), draft: object(routingDraftContents),
  actions }), if: { properties: { publishable: { const: true } } },
  then: { properties: { actions: { ...actions, const: ['read', 'publish_pool'] } } }, else: { properties: { actions: readActions } } };
const routingRevision = { model_id: routingId, pool_revision: revision, based_on_revision: nullable(revision),
  rollback_of: nullable(revision), reason: text, released_by: text, released_at: timestamp, current: boolean, actions: readActions };
const routingRevisionDetail = object({ ...routingRevision, identity_revision: revision, digest: text, routing: routingRules,
  members: listItems(object({ ...routingMember, provider_id: routingId, account_id: routingId, endpoint_id: routingId, raw_model: text })),
  rollout: nullable(object({ rollout_id: routingId, status: { ...text, enum: ['pending', 'running', 'done', 'failed'] } })) });

const rolloutStateNames = ['pending', 'applied', 'rejected', 'offline', 'needs_upgrade', 'superseded'];
const rolloutState = { ...text, enum: rolloutStateNames };
const rolloutJobStatus = { ...text, enum: ['pending', 'running', 'done', 'failed'] };
const rolloutTarget = object({ tenant_id: text, user_id: text, device_id: text, target_config_revision: nullable(revision),
  applied_config_revision: nullable(revision), state: rolloutState, reason: { ...nullableText, description: '稳定原因码；设备拒绝时为脱敏的 error.detail.reason。' },
  last_seen_at: nullable(timestamp), last_receipt_at: { ...nullable(timestamp), description: '仅指本目标的最近回执。' }, actions: { ...actions, const: [] } });

const channelProvider = '/v1/platform/providers/{provider_id}';
const channelJobPath = '/v1/platform/probe-jobs/{job_id}';
const channelIdentityPath = '/v1/platform/models/{model_id}/identity';
const channelProviderId = namedPath('provider_id', routingId);
const channelJobId = namedPath('job_id', routingId);
const channelLedgerPath = channelProvider + '/channel-ledger';
const channelBalancePath = channelProvider + '/accounts/{account_id}';
const channelBalanceParams = [channelProviderId, namedPath('account_id', routingId)];
const channelCurrency = { ...text, pattern: '^[A-Z]{3}$' };
const channelLedgerCommon = { account_id: routingId, currency: channelCurrency,
  reference: { ...text, minLength: 1, maxLength: 128 }, note: { ...text, minLength: 1, maxLength: 512 } };
const channelLedgerEntry = object({ ...channelLedgerCommon, id: routingId, funding_id: routingId,
  kind: { type: 'string', enum: ['recharge', 'balance_observation', 'expense'] }, amount_micro: sequence, recorded_at: timestamp,
  source: { ...text, enum: ['manual', 'upstream', 'routing'] } });
const channelWallet = object({ account_id: routingId, funding_id: routingId, label: text, status: text, currency: nullable(channelCurrency),
  balance_micro: { ...nullable({ type: 'integer' }), description: '最近一次余额观测，加上后续充值，减去后续费用。' },
  observed_balance_micro: nullable(sequence), observed_at: nullableTimestamp, credited_micro: sequence, spent_micro: sequence, actions });
const channelLedgerWrite = (balance: boolean) => ({
  ...write(object({ ...channelLedgerCommon, ...(balance ? { balance_micro: sequence } : { amount_micro: revision }) }), channelLedgerEntry, 'upsert'),
  parameters: [channelProviderId, ...contractIdempotency],
});
const balanceAdapter = { ...text, enum: ['new_api', 'sub2api'] };
const balanceProfileFields = { adapter: balanceAdapter, expected_user_id: { ...text, pattern: '^[1-9][0-9]{0,18}$' },
  currency: channelCurrency, quota_per_unit: nullable(revision), sync_wallet: boolean };
const balanceProfile = object({ profile: nullable(object({ ...balanceProfileFields, profile_revision: revision,
  credential_configured: boolean, credential_usable: boolean, source_origin: text })), adapters: listItems(balanceAdapter), actions });
const balanceProfileWrite = object({ ...balanceProfileFields, expected_profile_revision: sequence,
  credential: { ...text, minLength: 1, maxLength: 4096, writeOnly: true } },
['adapter', 'expected_user_id', 'currency', 'sync_wallet', 'expected_profile_revision']);
const balanceObservation = object({ id: routingId, status: { ...text, enum: ['ok', 'exhausted', 'unknown', 'stale'] },
  reason_code: nullableText, scope: { ...text, enum: ['account_quota', 'account_balance'] }, amount_micro: nullable(sequence),
  currency: channelCurrency, quota_units: nullable(sequence), observed_at: timestamp, valid_until: nullableTimestamp,
  profile_revision: revision, wallet_synced: boolean, source: object({ adapter: balanceAdapter, origin: text }) });
const channelJob = object({ id: routingId, kind: { enum: ['connectivity', 'discovery'] }, status: { enum: ['succeeded', 'partial', 'failed'] },
  location: text, scope: object({ provider_id: routingId, provider_revision: revision, account_id: routingId, endpoint_id: routingId, endpoint_revision: revision }),
  observed_at: timestamp, summary: object({ model_count: sequence, reason: nullableText }), actions });
const channelAccount = object({ account_id: routingId, name: text, balance_mode: text, funding_id: nullableText, endpoint_id: nullableText });
const modelReference = object({ id: text, maker_id: text, model_family: text, model_variant: text, model_snapshot: nullableText,
  display_name: text, context_tokens: nullable(revision), output_tokens: nullable(revision), capabilities_claim: listItems(text),
  source: text, source_url: text, aliases: listItems(text), provider_names: listItems(text) });
const channelAdoption = object({ model_id: routingId, display_name: text, status: text,
  candidate_id: routingId, deployment_id: routingId, deployment_revision: revision, pool_revision: nullable(revision) });
const channelIntake = object({ draft_id: routingId, discovery_id: routingId, catalog_item_id: routingId,
  raw_model: text, status: { const: 'needs_review' } });
const channelIdentity = { maker_id: text, model_family: text, model_variant: text, identity_mode: { enum: ['family_follow', 'pinned_snapshot'] },
  model_snapshot: nullableText, capability_floor: listItems(text) };
const channelModelIdentity = object({ model_id: routingId, revision, identity: nullable(object({ ...channelIdentity, identity_revision: revision })), actions });
const adoptFields = { catalog_item_id: routingId, display_name: text, context_window: revision,
  maker_id: text, model_family: text, model_variant: text, identity_mode: channelIdentity.identity_mode,
  model_snapshot: nullableText, capabilities: listItems(text), reason: text, mode: { const: 'adopt' } };
const adoptionResult = object({ model_id: routingId, display_name: text, identity_revision: revision,
  deployment_id: routingId, deployment_revision: revision, candidate_id: routingId, status: { const: 'accepted' } });
const testQuotaFields = { user_id: routingId, name: text, period: text, revision: sequence, limit_milli: sequence,
  reserved_milli: sequence, spent_milli: sequence, available_milli: sequence };
const testTariff = { input_milli_per_mtok: sequence, output_milli_per_mtok: sequence, source_reference: text };
const testMode = { ...text, enum: ['default', 'chat_template_no_thinking'] };
const testReconciliationProof = { reason: text, evidence_reference: text };
const modelTest = object({ id: routingId, discovery_id: routingId, catalog_item_id: routingId, raw_model: text, provider_id: routingId,
  provider_revision: revision, account_id: routingId, endpoint_id: routingId, endpoint_revision: revision,
  actor_id: routingId, period: text, created_at: timestamp, test_mode: testMode,
  completed_at: nullableTimestamp, status: { enum: ['running','succeeded','failed','pending_reconciliation'] },
  reason_code: nullableText, reserved_milli: sequence, charged_milli: nullable(sequence), usage: nullable(object({
    input_tokens: sequence, output_tokens: sequence, cache_read_tokens: sequence, cache_write_tokens: sequence
  })), tariff: object({ ...testTariff, cache_read_milli_per_mtok: sequence, cache_write_milli_per_mtok: sequence,
    source: { enum: ['manual', 'legacy_rate'] }, model_id: routingId, effective_from: timestamp },
  [...Object.keys(testTariff), 'cache_read_milli_per_mtok', 'cache_write_milli_per_mtok', 'source']),
  reconciliation: nullable(object({ ...testReconciliationProof, actor_id: routingId, reconciled_at: timestamp })), actions });
const channelCatalogItem = object({ catalog_item_id: routingId, discovery_id: routingId, raw_model: text, context_tokens: nullable(revision),
  snapshot_claim: nullableText, variant_claim: nullableText, capabilities_claim: listItems(text),
  reference_suggestions: listItems(modelReference), adoptions: listItems(channelAdoption), intake: nullable(channelIntake),
  latest_model_test: nullable(modelTest) });
const channelStart = (input: object) => ({ security: bearer, parameters: [channelProviderId, ...contractIdempotency], requestBody: requestBody(input),
  responses: { 202: { ...response('本次连接检查或目录拉取的已记录结果', channelJob), headers: { Location: { schema: text } } },
    404: error('供应商不存在'), ...status } });

const routingPaths = {
  [channelLedgerPath]: { get: routingList(channelLedgerEntry, [channelProviderId, ...routingPagination,
    { name: 'account_id', in: 'query', schema: routingId }], actions, { accounts: listItems(channelWallet) }) },
  [channelLedgerPath + '/recharges']: { post: channelLedgerWrite(false) },
  [channelLedgerPath + '/observations']: { post: channelLedgerWrite(true) },
  [channelLedgerPath + '/expenses']: { post: channelLedgerWrite(false) },
  [channelBalancePath + '/balance-profile']: { get: policyDetail(balanceProfile, channelBalanceParams),
    post: policyWrite(balanceProfileWrite, balanceProfile, 'update', channelBalanceParams) },
  [channelBalancePath + '/balance-profile/clear']: { post: policyWrite(object({ expected_profile_revision: revision }),
    balanceProfile, 'update', channelBalanceParams) },
  [channelBalancePath + '/balance-probes']: { post: { security: bearer, parameters: [...channelBalanceParams, ...contractIdempotency],
    requestBody: requestBody(object({ profile_revision: revision })), responses: { 202: response('上游账户余额或额度观测', balanceObservation),
      404: error('渠道账户不存在'), ...status } } },
  [channelBalancePath + '/balance-observations']: { get: routingList(balanceObservation, [...channelBalanceParams, ...routingPagination],
    actions, { latest: nullable(balanceObservation), last_success: nullable(balanceObservation) }) },
  [channelProvider + '/channel']: { get: policyDetail(object({ provider_id: routingId, revision, accounts: listItems(channelAccount),
    latest_probe: nullable(channelJob), latest_discovery: nullable(channelJob), latest_catalog: nullable(channelJob),
    historical_catalog: nullable(channelJob), actions }), [channelProviderId]) },
  [channelProvider + '/probes']: { post: channelStart(object({ kind: { const: 'connectivity' }, revision })) },
  [channelProvider + '/discoveries']: { post: channelStart(object({ revision })) },
  [channelJobPath]: { get: policyDetail(channelJob, [channelJobId]) },
  [channelJobPath + '/results']: { get: routingList(channelCatalogItem, [channelJobId, ...listParams], actions) },
  [channelJobPath + '/adoptions']: { post: policyWrite({ oneOf: [
    object({ mode: { const: 'draft' }, catalog_item_id: routingId }),
    object(adoptFields, Object.keys(adoptFields).filter(key => key !== 'mode' && key !== 'model_snapshot'))
  ] }, { oneOf: [adoptionResult, channelIntake] }, 'create', [channelJobId]) },
  '/v1/platform/model-references': { get: routingList(modelReference, [...listParams,
    { name: 'maker_id', in: 'query', schema: text }], actions, { makers: listItems(text) }) },
  '/v1/platform/model-test-quotas': { get: routingList(object({ ...testQuotaFields, self: boolean, actions }), listParams, actions) },
  '/v1/platform/model-test-quotas/{user_id}': { post: policyWrite(object({ expected_revision: sequence, limit_milli: sequence, reason: text }),
    object(testQuotaFields), 'update', [namedPath('user_id', routingId)]) },
  '/v1/platform/model-test-quotas/{user_id}/tests': { get: routingList(modelTest, [namedPath('user_id', routingId),
    { name: 'period', in: 'query', schema: { ...text, pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' } }, ...routingPagination], actions, { period: text }) },
  [channelJobPath + '/model-tests']: {
    get: routingList(modelTest, [channelJobId, ...routingPagination, { name: 'catalog_item_id', in: 'query', schema: routingId }], actions,
      { requires_tariff: boolean, blocked_reason: nullableText, output_token_limit: revision, test_modes: listItems(testMode) }),
    post: { security: bearer, parameters: [channelJobId, ...contractIdempotency],
      requestBody: requestBody(object({ catalog_item_id: routingId, test_tariff: object(testTariff), test_mode: testMode }, ['catalog_item_id'])),
      responses: { 202: response('已记录平台管理员的限额推理实测', modelTest), ...status } }
  },
  [channelJobPath + '/model-tests/{test_id}/reconcile']: { post: policyWrite(
    object({ charged_milli: sequence, ...testReconciliationProof }), modelTest, 'update', [channelJobId, namedPath('test_id', routingId)]) },
  [channelIdentityPath]: { get: policyDetail(channelModelIdentity, [routingModelId]),
    post: policyWrite(object({ revision, ...channelIdentity }, ['revision', 'maker_id', 'model_family', 'model_variant', 'identity_mode', 'capability_floor']),
      channelModelIdentity, 'create', [routingModelId]) },
  [routingPoolPath + '/candidates/review']: { post: policyWrite(object({ expected_identity_revision: revision, reason: text,
    decisions: listItems(object({ discovery_id: routingId, catalog_item_id: routingId, decision: { enum: ['accept', 'reject'] }, capabilities: listItems(text) })) }),
  object({ items: listItems(object({ deployment_id: routingId, deployment_revision: revision, approved_match_id: nullableText, evidence_ids: listItems(routingId),
    raw_model: text, status: { enum: ['accepted', 'rejected'] } })) }), 'update', [routingModelId]) },
  '/v1/platform/providers/{provider_id}/deployments': {
    get: routingList(providerDeployment, [namedPath('provider_id', routingId), routingSearch, ...routingPagination], { ...actions, const: [] }),
  },
  '/v1/platform/deployments': { get: routingList(routingCandidate, [routingSearch, ...routingPagination,
    { name: 'target_model_id', in: 'query', required: true, schema: routingId },
    { name: 'provider_id', in: 'query', schema: routingId }, { name: 'protocol', in: 'query', schema: providers.protocol },
    { name: 'match', in: 'query', schema: routingMatchStatus }], { ...actions, const: [] }) },
  [routingPoolPath + '/preview']: {
    post: policyPreview({ ...object(routingDraft), additionalProperties: false }, routingPreview, [routingModelId]),
  },
  [routingPoolPath + '/revisions']: {
    get: routingList(object({ ...routingRevision, member_count: sequence }), [routingModelId, ...routingPagination],
      { ...actions, enum: [[], ['preview_pool']] }, { current_pool_revision: sequence }),
    post: { ...policyWrite({ ...object({ ...routingDraft, preview_basis: routingPreviewBasis }), additionalProperties: false },
      object({ model_id: routingId, pool_revision: revision, rollout_id: routingId, actions: readActions }), 'create', [routingModelId]),
      description: '提交原预览草稿及预览依据。重复提交使用同一幂等键。冲突原因包含 revision_changed、preview_stale 和 idempotency_mismatch。' },
  },
  [routingPoolPath + '/revisions/{pool_revision}']: {
    get: policyDetail(routingRevisionDetail, [routingModelId, namedPath('pool_revision', revision)]),
  },
  '/v1/platform/model-pool-rollouts/{rollout_id}': {
    get: { ...policyDetail(object({ rollout_id: routingId, model_id: routingId, pool_revision: revision, job_status: rolloutJobStatus,
      total: sequence, counts: object(Object.fromEntries(rolloutStateNames.map(state => [state, sequence]))), actions: readActions }),
      [namedPath('rollout_id', routingId)]),
      description: '发布任务完成不等于设备已应用。精确目标有已持久成功回执时为 applied，否则依次按 superseded、rejected、needs_upgrade、offline、pending 折叠。' },
  },
  '/v1/platform/model-pool-rollouts/{rollout_id}/targets': {
    get: routingList(rolloutTarget, [namedPath('rollout_id', routingId), ...routingPagination,
      { name: 'state', in: 'query', schema: rolloutState }], readActions),
  },
};


const procurementTime = { ...timestamp, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$' };
const procurementStart = { ...procurementTime, description: '起点包含在有效区间内。新版本的起点必须晚于当前发布头。' };
const procurementEnd = { ...procurementTime, description: '终点不包含在有效区间内，且必须晚于起点。' };
const procurementCurrency = { ...text, pattern: '^[A-Z]{3}$' };
const procurementFxBase = { ...procurementCurrency, not: { const: 'CNY' } };
const procurementFxTarget = { ...text, const: 'CNY' };
const procurementUnsignedDecimal = { ...text, pattern: '^(?:0|[1-9][0-9]{0,37})$' };
const procurementPositiveDecimal = { ...text, pattern: '^[1-9][0-9]{0,37}$' };
const procurementSourceFields = { kind: { const: 'manual' }, reference: nullable({ ...text, maxLength: 200, pattern: '\\S' }) };
const procurementSourceInput = { ...object(procurementSourceFields, ['kind']), additionalProperties: false };
const procurementReason = { ...text, maxLength: 500, pattern: '\\S' };
const procurementPublication = { source: object(procurementSourceFields), reason: procurementReason,
  published_by: text, published_at: timestamp, actions: readActions };
const procurementLookupWindow = {
  lookup_until: { ...nullable(procurementTime), description: '查找截止时间，取有效终点和下一版起点中较早的一项。两者都未设置时为 null。' },
  superseded_from: { ...nullable(procurementTime), description: '下一版的起点。没有下一版时为 null。' },
};
const procurementAsOf = { name: 'as_of', in: 'query', schema: procurementTime,
  description: '按此时点查询开始最晚的版本。该版本过期时，旧版本不会恢复生效。' };
function procurementApplicable(record: object, reasonCodes: string[]) {
  return {
    applicable: { ...nullable(record), description: '仅传入 as_of 时返回。没有适用版本时为 null。' },
    applicable_reason: { ...text, enum: reasonCodes, description: '仅传入 as_of 且查不到适用版本时返回。' },
  };
}

const procurementQuoteItem = { ...object({ dimension: { ...text, enum: [...quoteDimensions] },
  rate_micro: { ...procurementUnsignedDecimal, description: '原币百万分之一单位的整数文本。' },
  quantity_basis: { ...revision, maximum: Number.MAX_SAFE_INTEGER }, unit: { ...text, enum: ['token', 'request'] } }),
  additionalProperties: false, if: { properties: { dimension: { const: 'request' } } },
  then: { properties: { unit: { const: 'request' } } }, else: { properties: { unit: { const: 'token' } } } };
const procurementQuoteFields = { deployment_revision: revision, currency: procurementCurrency,
  tariff_scope: { ...object({ kind: { const: 'deployment' } }), additionalProperties: false },
  valid_from: procurementStart, valid_until: nullable(procurementEnd),
  items: { ...listItems(procurementQuoteItem), minItems: 1, maxItems: quoteDimensions.length, description: '同一计价维度只能提交一次。' } };
const procurementQuoteInputFields = { ...procurementQuoteFields, expected_quote_revision: sequence,
  source: procurementSourceInput, reason: procurementReason };
const procurementQuoteInput = { ...object(procurementQuoteInputFields,
  Object.keys(procurementQuoteInputFields).filter(field => field !== 'valid_until')), additionalProperties: false };
const procurementQuoteRecord = { ...procurementQuoteFields, ...procurementPublication, quote_id: routingId, quote_revision: revision,
  deployment_id: routingId, provider_id: routingId, account_id: routingId };
const procurementQuoteView = object({ ...procurementQuoteRecord, ...procurementLookupWindow });

const procurementFxFields = { base_currency: procurementFxBase, quote_currency: procurementFxTarget,
  rate_numerator: procurementPositiveDecimal, rate_denominator: procurementPositiveDecimal,
  observed_at: { ...procurementTime, description: '不得晚于服务端当前时间。' }, valid_from: procurementStart, valid_until: procurementEnd };
const procurementFxInput = { ...object({ ...procurementFxFields, expected_fx_revision: sequence,
  source: procurementSourceInput, reason: procurementReason }), additionalProperties: false };
const procurementFxRecord = { ...procurementFxFields, ...procurementPublication, fx_revision: revision };
const procurementFxView = object({ ...procurementFxRecord, ...procurementLookupWindow });

const procurementDeploymentId = namedPath('deployment_id', routingId);
const procurementQuotePath = '/v1/platform/deployments/{deployment_id}/quotes';
const procurementFxPath = '/v1/platform/procurement/fx-rates';
const procurementPaths = {
  [procurementQuotePath]: {
    get: routingList(procurementQuoteView, [procurementDeploymentId, ...routingPagination, procurementAsOf],
      { ...actions, enum: [[], ['publish_quote']] }, { deployment_revision: revision, head_revision: sequence },
      procurementApplicable(procurementQuoteView, ['missing_quote', 'quote_expired', 'quote_deployment_revision_changed'])),
    post: policyWrite(procurementQuoteInput, object(procurementQuoteRecord), 'create', [procurementDeploymentId]),
  },
  [procurementQuotePath + '/{quote_id}/revisions/{quote_revision}']: {
    get: policyDetail(procurementQuoteView, [procurementDeploymentId, namedPath('quote_id', routingId), namedPath('quote_revision', revision)]),
  },
  [procurementFxPath]: {
    get: routingList(procurementFxView, [{ name: 'base_currency', in: 'query', required: true, schema: procurementFxBase },
      ...routingPagination, procurementAsOf], { ...actions, const: ['publish_fx_rate'] }, { head_revision: sequence },
      procurementApplicable(procurementFxView, ['missing_fx', 'fx_expired'])),
    post: policyWrite(procurementFxInput, object(procurementFxRecord), 'create'),
  },
  [procurementFxPath + '/{base_currency}/{quote_currency}/revisions/{fx_revision}']: {
    get: policyDetail(procurementFxView, [namedPath('base_currency', procurementFxBase), namedPath('quote_currency', procurementFxTarget),
      namedPath('fx_revision', revision)]),
  },
};
const multiplierPoolRevision = { ...sequence, maximum: Number.MAX_SAFE_INTEGER };
const multiplierPpm = { ...sequence, multipleOf: 1000 };
const multiplierBasis = { ...text, const: INPUT_MULTIPLIER_BASIS };
const multiplierCalculation = { ...text, enum: ['complete', 'partial', 'unavailable'] };
const multiplierStatus = { ...text, const: 'available_to_sign' };
const multiplierRequest = {
  expected_pool_revision: multiplierPoolRevision,
  expected_source_rate_key: { ...nullable(routingId), description: '没有已发布的倍率版本时传 null。' },
  manual_input_multiplier_ppm: nullable({ ...multiplierPpm, maximum: 1_000_000_000_000 }),
  reason: nullable(procurementReason),
};
const multiplierRequestRequired = ['expected_pool_revision', 'expected_source_rate_key'];
const multiplierPreviewInput = { ...object({ ...multiplierRequest, pricing_at: {
  ...nullable(procurementTime), description: '省略或传 null 时采用服务端当前时间。',
} }, multiplierRequestRequired), additionalProperties: false };
const multiplierPublishInput = { ...object({ ...multiplierRequest, pricing_at: procurementTime, preview_basis: routingPreviewBasis },
  [...multiplierRequestRequired, 'pricing_at', 'preview_basis']), additionalProperties: false };

const multiplierChannelFields = { deployment_id: routingId, deployment_revision: revision, quote_id: nullable(routingId),
  quote_revision: nullable(revision), currency: nullable(procurementCurrency), amount_micro: nullable(procurementUnsignedDecimal),
  quantity_basis: nullable({ ...revision, maximum: Number.MAX_SAFE_INTEGER }), unit: nullable({ ...text, const: 'token' }),
  fx_revision: nullable(revision), rate_numerator: nullable(procurementPositiveDecimal), rate_denominator: nullable(procurementPositiveDecimal),
  input_cny_micro_per_mtok: nullable({ ...text, pattern: '^(?:0|[1-9][0-9]*)$' }) };
const multiplierChannelReason = { ...text, enum: ['deployment_ineligible', 'missing_input_quote', 'quote_expired',
  'quote_deployment_revision_changed', 'invalid_input_unit', 'missing_fx', 'fx_expired'] };
const multiplierChannel = object({ ...multiplierChannelFields, reason_code: multiplierChannelReason }, Object.keys(multiplierChannelFields));
const multiplierPreviewChannel = { ...object({ ...multiplierChannel.properties, eligibility_codes: listItems(text) }, multiplierChannel.required),
  if: { required: ['reason_code'], properties: { reason_code: { const: 'deployment_ineligible' } } },
  then: { required: ['eligibility_codes'] } };
const multiplierBlocking = object({ code: { ...text, enum: ['missing_pool_revision', 'multiplier_unavailable', 'missing_sales_rates', 'reason_required', 'multiplier_out_of_range'] }, message: text });
const multiplierPreview = { ...object({ model_id: routingId, expected_pool_revision: multiplierPoolRevision,
  expected_source_rate_key: nullable(routingId), pool_revision: multiplierPoolRevision, pricing_at: procurementTime,
  input_multiplier_basis: multiplierBasis, calculation_status: multiplierCalculation, channels: listItems(multiplierPreviewChannel),
  recommended_input_multiplier_ppm: nullable(multiplierPpm), input_multiplier_ppm: nullable(multiplierPpm),
  input_milli_per_mtok: nullable(sequence), output_milli_per_mtok: nullable(sequence), cache_read_milli_per_mtok: nullable(sequence),
  cache_write_milli_per_mtok: nullable(sequence), sales_rates_source: nullableText, manual_input_multiplier_ppm: multiplierRequest.manual_input_multiplier_ppm,
  reason: multiplierRequest.reason, blocking: listItems(multiplierBlocking), preview_basis: routingPreviewBasis, actions }),
  if: { properties: { blocking: { maxItems: 0 } } },
  then: { properties: { actions: { ...actions, const: ['read', 'publish_input_multiplier'] } } },
  else: { properties: { actions: readActions } } };
const multiplierPublishedFields = { model_id: routingId, source_rate_key: routingId, input_multiplier_basis: multiplierBasis,
  input_multiplier_ppm: multiplierPpm, input_milli_per_mtok: sequence, status: multiplierStatus };
const multiplierDetail = object({ ...multiplierPublishedFields, recommended_input_multiplier_ppm: nullable(multiplierPpm),
  output_milli_per_mtok: sequence, cache_read_milli_per_mtok: sequence, cache_write_milli_per_mtok: sequence, sales_rates_source: text,
  pool_revision: revision, pricing_at: procurementTime, calculation_status: multiplierCalculation, based_on_source_rate_key: nullable(routingId),
  override_reason: multiplierRequest.reason, channels: listItems(multiplierChannel), created_by: text, created_at: timestamp,
  current: boolean, actions: readActions });

const multiplierConflictFields = { current_pool_revision: multiplierPoolRevision, current_source_rate_key: nullable(routingId) };
const multiplierRevisionChanged = object({ reason: { const: 'revision_changed' }, ...multiplierConflictFields,
  changed: { ...listItems({ ...text, enum: ['pool_revision', 'source_rate_key'] }), minItems: 1, maxItems: 2, uniqueItems: true } });
const multiplierPreviewStale = object({ reason: { const: 'preview_stale' }, ...multiplierConflictFields,
  changed: { ...listItems(text), enum: [['preview_basis'], ['pricing_window']] } });
const multiplierIdempotencyMismatch = object({ reason: { const: 'idempotency_mismatch' } });
const multiplierConflict = (description: string, detail: object) => response(description,
  object({ error: object({ code: { const: 'conflict' }, message: text, detail }) }));
const multiplierInvalid = response('请求字段无效。', object({ error: object({ code: { const: 'invalid' }, message: text,
  detail: object({ fields: listItems(text) }) }) }));
const multiplierPreviewOperation = policyPreview(multiplierPreviewInput, multiplierPreview, [routingModelId]);
const multiplierPublishOperation = policyWrite(multiplierPublishInput, object(multiplierPublishedFields), 'create', [routingModelId]);
const multiplierPath = '/v1/platform/models/{model_id}/input-multiplier';
const multiplierPaths = {
  [multiplierPath + '/preview']: { post: { ...multiplierPreviewOperation, responses: { ...multiplierPreviewOperation.responses,
    409: multiplierConflict('模型池或倍率版本已变更。', multiplierRevisionChanged), 422: multiplierInvalid } } },
  [multiplierPath + '/revisions']: { post: { ...multiplierPublishOperation, responses: { ...multiplierPublishOperation.responses,
    409: multiplierConflict('倍率发布依据已变更或幂等键已用于不同请求。',
      { oneOf: [multiplierRevisionChanged, multiplierPreviewStale, multiplierIdempotencyMismatch] }), 422: multiplierInvalid } } },
  [multiplierPath + '/revisions/{source_rate_key}']: { get: policyDetail(multiplierDetail, [routingModelId, namedPath('source_rate_key', routingId)]) },
};

const ledgerFields = { id: text, kind: text, amount_milli: { type: 'integer' }, user_id: nullableText, lease_id: nullableText,
  request_ref: nullableText, by: nullableText, at: text, note: nullableText, actions };
const ledger = object({ ...ledgerFields, discount_month: text }, Object.keys(ledgerFields));
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
    ...policyPaths,
    ...routingPaths,
    ...procurementPaths,
    ...multiplierPaths,
    '/v1/healthz': { get: { summary: '健康检查', responses: { 200: response('正常', object({ status: { const: 'ok' }, version: text, commit: text })) } } },
    '/v1/openapi.json': { get: { summary: '接口文档', responses: { 200: response('OpenAPI 文档', { type: 'object' }) } } },
    '/v1/auth/code': { post: { summary: '请求验证码', parameters: headers, requestBody: requestBody(object({ target: text })),
      responses: { 202: response('已受理', object({})), 403: error('未启用验证码发送'), 409: status[409], 422: status[422], 429: error('发送过快'), 500: status[500] } } },
    '/v1/auth/login': { post: { summary: '使用验证码登录，可同时接受邀请', parameters: headers,
      requestBody: requestBody(object({ target: text, code: { type: 'string', pattern: '^[0-9]{6}$' }, invite_code: text, kind: { ...kind, default: 'web' } }, ['target', 'code'])),
      responses: { 200: response('全局令牌', loginResponse),
        404: error('邀请码无效或已用完'), 429: error('验证码暂时锁定'), ...status } } },
    '/v1/auth/password-login': { post: { summary: '使用租户、用户名和密码登录',
      requestBody: requestBody(object({
        tenant: { ...text, minLength: 1, maxLength: 64, description: '完整租户 ID 或简称' },
        username: { ...text, minLength: 1, maxLength: 64 },
        password: { ...text, format: 'password', minLength: 1, maxLength: 256, writeOnly: true },
        kind: { ...kind, default: 'web' },
      }, ['tenant', 'username', 'password'])),
      responses: { 200: response('租户范围的会话令牌', loginResponse), 401: status[401], 422: status[422],
        429: error('登录请求过快'), 500: status[500] },
    } },
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
        role: { anyOf: [role, { type: 'null' }] }, agents: { type: 'array', items: text }, is_platform_admin: { type: 'boolean' }, actions, quota: meQuota,
        tenant_password_login: { const: true, description: '当前会话通过租户范围的密码登录签发。' } },
      ['user', 'tenant', 'role', 'agents', 'is_platform_admin', 'actions', 'quota'])), 401: status[401], 403: status[403], 500: status[500],
    } } },
    '/v1/devices': { post: { summary: '注册设备，需要租户令牌', security: bearer, parameters: headers,
      requestBody: requestBody(object({ name: { ...text, maxLength: 128 }, os: { ...text, maxLength: 32 }, arch: { ...text, maxLength: 32 },
        public_key: { ...nullableText, contentEncoding: 'base64', description: '32 字节 X25519 公钥，缺少公钥时不下发密钥' } }, ['name', 'os', 'arch'])),
      responses: { 201: response('设备令牌', object({ device_id: text, device_token: token })), ...status } },
      get: { ...listOf(device), summary: '设备台账，仅 owner/admin 可见' } },
    '/v1/devices/{id}': { get: { ...detailOf(device), summary: '设备详情' } },
    '/v1/devices/{id}/resume-challenge': { post: { summary: '获取恢复当前账号设备的加密挑战',
      security: bearer, parameters: [idPath], requestBody: requestBody(object({})),
      responses: { 200: response('仅设备持有的 X25519 私钥可解密，有效期两分钟', object({
        key_id: { ...text, contentEncoding: 'base64', description: '32 字节临时 X25519 公钥' },
        nonce: { ...text, contentEncoding: 'base64', description: '24 字节 XChaCha20-Poly1305 nonce' },
        ciphertext: { ...text, contentEncoding: 'base64', description: '用 onex-device-resume-v1 作为附加认证数据加密的 UTF-8 证明' },
      })), 401: status[401], 403: status[403], 404: error('当前账号没有可恢复的设备'), 422: status[422], 500: status[500] } } },
    '/v1/devices/{id}/resume': { post: { summary: '恢复当前账号设备并更换设备令牌',
      security: bearer, parameters: [idPath, { ...headers[0], required: true }],
      requestBody: requestBody(object({ proof: { ...text, maxLength: 64, description: '用设备私钥解出的完整挑战字符串' } })),
      responses: { 200: response('原设备 ID 与新设备令牌', object({ device_id: text, device_token: token })),
        401: error('会话或挑战无效、已使用或过期'), 403: status[403], 404: error('当前账号没有可恢复的设备'),
        409: error('幂等键已用于不同请求或设备令牌已再次更换'), 422: status[422], 500: status[500] } } },
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
    '/v1/contract': { get: detailOf(contract, false), put: { ...write(object({
      ...contractInput, revision: sequence, agent_release_ids: { type: 'array', items: text },
    }, [...Object.keys(contractInput), 'revision']), contract, 'update'), deprecated: true } },
    '/v1/contract/configuration': {
      get: detailOf(configurationView, false),
      put: { ...write(configurationInput, configurationView, 'update'), parameters: contractIdempotency },
    },
    '/v1/contract/configuration/preview': { post: contractPreview(configurationInput) },
    '/v1/contract/effective': { get: { summary: '查看指定设备实际可用的 Agent 和当前生效的模型倍率',
      security: bearer, parameters: [
        { name: 'os', in: 'query', required: true, schema: { ...text, enum: ['darwin', 'linux', 'win32'] } },
        { name: 'arch', in: 'query', required: true, schema: { ...text, enum: ['arm64', 'x64'] } },
      ], responses: { ...status, 200: response('生效配置', object({ revision, platform_revision: sequence, tenant_revision: sequence,
        os: text, arch: text, actions,
        agents: { type: 'array', items: object({ agent: text,
          status: { ...text, enum: ['available', 'unavailable', 'qualification_required'] },
          releases: { type: 'array', items: object(agentPin) } }) },
        models: { type: 'array', items: object({ model_id: text, name: text, model: text, provider_id: text, protocol: text,
          rate: object({ model_id: text, input_milli_per_mtok: sequence, output_milli_per_mtok: sequence,
            cache_read_milli_per_mtok: sequence, cache_write_milli_per_mtok: sequence, effective_from: text }) }) },
      })) } } },
    '/v1/contract/agent-releases': { get: { ...listOf(object(agentPin)), summary: '能力合约可固定的已启用缓存发行' } },
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
    '/v1/observe/statistics': { get: { summary: '按北京时间读取会话与计量统计', security: bearer,
      parameters: statisticsParameters, responses: { 200: { description: '选定区间的整体、每日及按 Agent 统计' }, 401: status[401], 403: status[403], 422: status[422] } } },
    '/v1/observe/statistics/parquet': { get: { summary: '导出当前可见范围的 Parquet 汇总并记录审计', security: bearer,
      parameters: statisticsParameters, responses: { 200: { description: '按日期及 Agent 汇总', content: {
        'application/vnd.apache.parquet': { schema: { type: 'string', format: 'binary' } },
      } }, 401: status[401], 403: status[403], 422: status[422] } } },
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
    '/v1/platform/contract-templates': {
      get: listOf(template),
      post: { ...write(templateInput, template, 'create'), parameters: contractIdempotency },
    },
    '/v1/platform/capability-contracts': { get: listOf(object({ tenant_id: tenantId, name: text, actions })) },
    '/v1/platform/capability-contracts/{tenant_id}': {
      get: { ...detailOf(platformContractView, false), parameters: [contractTenantPath] },
      put: { ...write(platformContractInput, platformContractView, 'update'), parameters: [contractTenantPath, ...contractIdempotency] },
    },
    '/v1/platform/capability-contracts/{tenant_id}/history': { get: listOf(object({ ...platformContractFields, actions }), [contractTenantPath]) },
    '/v1/platform/capability-contracts/{tenant_id}/preview': { post: contractPreview(platformContractInput, [contractTenantPath]) },
    ...platformPaths('/v1/platform/tenants', tenantFields, ['name', 'owner_user_id'], {}, { created_at: text }, undefined, true),
    ...platformPaths('/v1/platform/providers', providers, ['name', 'protocol', 'base_url', 'secret'], { secret: { ...text, writeOnly: true } }),
    ...platformPaths('/v1/platform/models', models, ['provider_id', 'upstream_name', 'display_name', 'context_window'], {}, {}, {
      current_identity_revision: nullable(revision), current_pool_revision: { ...sequence, description: '0 表示未发布模型池。' },
      channel_count: sequence, current_source_rate_key: nullable(routingId), input_multiplier_ppm: {
        ...nullable(multiplierPpm), description: '没有已发布的倍率版本时，回显现行旧平台费率对应的倍率。没有可用费率时为 null。',
      }, actions: { ...actions, enum: [['read', 'update'], ['read', 'update', 'preview_input_multiplier']],
        description: '仅启用的模型可预览倍率。' },
    }),
    ...platformPaths('/v1/platform/agent-releases', releases, ['agent', 'version', 'os', 'arch', 'url', 'sha256', 'size'], {},
      releaseSupply),
    '/v1/platform/agent-releases/{id}': {
      get: detailOf(managed({ ...releases, ...releaseSupply })),
      post: write(object({ revision, url: text, status: text }, ['revision']), managed({ ...releases, ...releaseSupply }), 'update', true),
      patch: write(object({ revision, url: text, status: text }, ['revision']), managed({ ...releases, ...releaseSupply }), 'update', true),
    },
    '/v1/platform/agent-releases/{id}/artifact': { put: { summary: '校验并缓存受管 Agent 制品',
      security: bearer, parameters: [idPath, { name: 'part', in: 'query', schema: sequence },
        { name: 'revision', in: 'query', schema: revision }],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
        'application/gzip': { schema: { type: 'string', format: 'binary' } } } },
      responses: { ...status, 200: response('制品校验通过', object({ sha256: releaseDigest, size: sequence,
        artifact_cached: { const: true }, download_url: text })),
        202: response('已暂存分段', object({ artifact_cached: { const: false }, part: sequence, count: sequence })),
        404: error('发行不存在'), 413: error('文件超限') } } },
    '/v1/platform/agent-releases/{id}/runtime': {
      put: { summary: '上传并校验 Claude Desktop 固定 Code 引擎', security: bearer,
        parameters: [idPath, { name: 'revision', in: 'query', required: true, schema: revision }],
        requestBody: { required: true, content: agentBinary }, responses: { ...status, 200: response('引擎已缓存', runtimeArtifact),
          404: error('发行没有配套的引擎'), 413: error('文件超限') } },
      get: { summary: '平台管理员下载 Claude Desktop 配套引擎', security: bearer, parameters: [idPath],
        responses: { 200: { description: '配套引擎原始字节', content: agentBinary }, 401: status[401], 403: status[403],
          404: error('引擎未缓存') } },
    },
    '/v1/edge/agent-artifacts/{id}/runtime': { get: { summary: '按设备和能力合约下载 Claude Desktop 配套引擎',
      security: [{ DeviceToken: [] }], parameters: agentArtifactRangeParameters,
      responses: { ...agentArtifactDownloadResponses, 404: error('引擎不可用或合约未授权') } } },
    '/v1/platform/agent-releases/{id}/pull': { post: { summary: '从登记的官方源拉取受管 Agent 制品',
      security: bearer, parameters: [idPath], responses: { ...status,
        200: response('制品校验通过', object({ sha256: releaseDigest, size: sequence, artifact_cached: { const: true }, download_url: text })),
        404: error('发行不存在') } } },
    '/v1/agent-artifacts/{sha256}': { get: { summary: '平台管理员下载已启用制品或暂存的桌面安装包', security: bearer,
      parameters: [{ name: 'sha256', in: 'path', required: true, schema: releaseDigest }],
      responses: { 200: { description: '制品原始字节', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        401: status[401], 403: status[403], 404: error('制品未缓存或发行已撤销') } } },
    '/v1/edge/agent-artifacts/{id}': { get: { summary: '按当前设备和能力合约下载 Agent 制品', security: [{ DeviceToken: [] }],
      parameters: agentArtifactRangeParameters,
      responses: { ...agentArtifactDownloadResponses, 404: error('制品不存在或当前合约不允许') } } },
    '/v1/platform/tool-targets': { get: detailOf(object({ agents: { type: 'object', additionalProperties:
      object({ kinds: { type: 'array', items: text }, platforms: { type: 'array', items: text } }, ['kinds']) } })) },
    '/v1/platform/tool-releases': { get: listOf(toolRelease),
      post: { ...write(object({ ...toolFields, os: { ...text, enum: ['macos', 'windows'] }, arch: desktopArch,
        delivery: toolDelivery, entrypoint: text, endpoint: { ...text, format: 'uri' }, secret: { ...text, writeOnly: true } },
        ['name', 'version', 'kind', 'agents']), toolRelease, 'create'),
        description: '新建固定版本。MCP 与 Hook 需要系统、架构和启动文件。HTTP 搜索需要 HTTPS endpoint 和上游凭据。' } },
    '/v1/platform/tool-releases/{id}': { get: detailOf(toolRelease) },
    '/v1/platform/tool-releases/{id}/artifact': { put: { summary: '上传并校验工具包', security: bearer,
      parameters: [idPath, { name: 'revision', in: 'query', required: true, schema: revision }],
      requestBody: requestBody(toolBundle), responses: { ...status, 200: response('工具包已校验', toolRelease),
        404: error('发行不存在'), 413: error('文件超限') } } },
    '/v1/platform/tool-releases/{id}/publish': { post: write(object({ revision }), toolRelease, 'update', true) },
    '/v1/platform/tool-releases/{id}/disable': { post: write(object({ revision }), toolRelease, 'update', true) },
    '/v1/edge/tool-artifacts/{id}': { get: { summary: '按设备当前生效的能力策略下载工具包',
      security: [{ DeviceToken: [] }], parameters: [idPath],
      responses: { 200: response('经 SHA-256 固定的原始工具包', toolBundle),
        401: status[401], 404: error('制品不存在或当前配置未授权') } } },
    '/v1/edge/tool-search/{release_id}': { post: { summary: '代理按次计费的 HTTP 搜索',
      security: [{ DeviceToken: [] }], parameters: [
        { name: 'release_id', in: 'path', required: true, schema: toolId },
        { name: 'Idempotency-Key', in: 'header', required: true, schema: { ...text, pattern: '^[A-Za-z0-9_:-]{1,128}$' } },
      ],
      requestBody: requestBody(object({ session_id: text, query: { ...text, minLength: 1, maxLength: 2000 },
        limit: { type: 'integer', minimum: 1, maximum: 20 } })),
      responses: { ...status, 200: response('首次结算及结果，或相同回执', searchReply),
        202: response('相同调用仍在执行', searchReply), 404: error('发行或活动会话不匹配'),
        413: error('请求体超限'), 502: response('搜索未完成且没有扣费', searchReply) } } },
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
    '/v1/platform/desktop-releases/{id}': { get: { ...detailOf({ ...desktopRelease, properties: { ...desktopRelease.properties, update: desktopUpdate } }),
      description: '上传结果未知时用来重新确认当前修订、摘要及可选的已签名更新制品。' } },
    '/v1/platform/desktop-releases/{id}/artifact': { put: { summary: '上传安装包原始字节', security: bearer,
      parameters: [idPath, { name: 'revision', in: 'query', required: true, schema: revision }],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      responses: { ...status, 200: response('校验通过的草稿，带字节数和摘要', desktopRelease), 404: error('对象不存在'),
        409: error('不是草稿状态或 revision 已过期'), 413: error('超出单包大小上限'), 422: error('格式或参数无效') },
      description: '仅平台管理员；S2 单包上限 256 MiB，校验实际字节数和 XAR/PE 格式后才改草稿元数据。' } },
    '/v1/platform/desktop-releases/{id}/update-artifact': { put: { summary: '上传已签名的客户端更新制品', security: bearer,
      parameters: [idPath, { name: 'revision', in: 'query', required: true, schema: revision },
        { name: 'X-OneX-Update-Signature', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{86}$' } }],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      responses: { ...status, 200: response('带更新制品摘要的草稿', { ...desktopRelease,
        properties: { ...desktopRelease.properties, update: desktopUpdate } }), 409: error('草稿修订或状态已变更'),
        413: error('超出单包大小上限'), 422: error('格式或参数无效') } } },
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
    '/v1/desktop-updates/{os}/{arch}': { get: { summary: '当前可自动安装的签名更新',
      parameters: [{ name: 'os', in: 'path', required: true, schema: desktopOs },
        { name: 'arch', in: 'path', required: true, schema: desktopArch }],
      responses: { 200: response('平台当前签名更新清单', desktopUpdate), 404: error('当前发行未提供自动更新') } } },
    '/v1/desktop-releases/{id}/update-download': { get: { summary: '下载当前签名更新的制品', parameters: [idPath],
      responses: { 200: { description: '更新制品二进制', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        404: error('更新未发布、已下架或不存在') } } },
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
