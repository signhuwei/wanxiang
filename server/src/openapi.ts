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
const toolId = { ...text, pattern: '^tool_[0-9A-HJKMNP-TV-Z]{26}$' };
const toolFields = { name: text, version: text, kind: { ...text, enum: ['skill', 'mcp', 'hook', 'http_search'] },
  agents: { type: 'array', minItems: 1, uniqueItems: true, items: { ...text, enum: ['claude-code', 'codex', 'kimi-code'] } },
  os: { enum: ['macos', 'windows', null] }, arch: { enum: ['arm64', 'x64', null] },
  entrypoint: nullableText, args: { type: 'array', items: text } };
const toolReleaseBase = managed({ id: toolId, ...toolFields, status: { ...text, enum: ['draft', 'published', 'disabled'] },
  created_at: timestamp, artifact_cached: boolean, sha256: nullableText, size: { type: ['integer', 'null'], minimum: 1 } });
const toolRelease = { ...toolReleaseBase, properties: { ...toolReleaseBase.properties, endpoint: { ...text, format: 'uri' }, has_key: boolean } };
const searchReceipt = object({
  call_id: text, release_id: toolId, session_id: text, plan_id: text, fee_milli: sequence, package_used_milli: sequence,
  status: { ...text, enum: ['awaiting_result', 'charged', 'failed'] },
  called_at: timestamp, settled_at: nullableTimestamp, ledger_id: nullableText, outcome: nullableText,
});
const searchReply = object({ receipt: searchReceipt, results: { type: 'array', items: object({ url: text, title: text, snippet: text }) } }, ['receipt']);
const toolBundle = object({ files: { type: 'array', minItems: 1, maxItems: 256, items: object({
  path: { ...text, maxLength: 240 }, data: { ...text, contentEncoding: 'base64' },
}) } });
const tenantFields = { id: tenantId, name: text, owner_user_id: text, status: { type: 'string', enum: ['active', 'suspended'] } };
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
const policyContractRow = { tenant_id: tenantId, name: text, ...policyHead, actions };
const policySign = object({ ...policyExpected, base_revision: nullable(revision), reason: text,
  entries: listItems(object(policyDraftEntry, ['clause_ref', 'template_ref'])) });
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
const commerceTerms=object({monthly_grant_milli:sequence,monthly_fee_fen:sequence,
  tiers:listItems(object({from_milli:sequence,ratio_ppm:sequence})),commitment:nullable(object({up_to_milli:sequence,ratio_ppm:sequence})),
  model_prices:listItems(object({model_id:text,...priceFields})),model_budgets:listItems(object({model_id:text,monthly_milli:sequence})),
  tool_prices:listItems(object({release_id:text,per_call_milli:sequence}))});
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
  '/v1/platform/commerce/plans':{get:listOf(commercePlan),post:policyWrite(object({name:text,expected_version:sequence,plan_id:text,terms:commerceTerms},['name','expected_version','terms']),commercePlan,'create')},
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
    post: policyWrite(policySign, object({ ...policySignature, entries: listItems(policySignedEntry) }), 'create', [contractTenantPath]) },
  [policyContractPath + '/signatures/{revision}']: { get: policyDetail(object({ ...policySignature, entries: listItems(policySignedEntry) }),
    [contractTenantPath, namedPath('revision', revision)]) },
  [policyContractPath + '/preview']: { post: policyPreview(policySign, object({ tenant_id: tenantId, ...policyHead,
    entries: listItems(policySignedEntry), previous_entries: listItems(policySignedEntry), actions,
    seats:object({limit:sequence,active:sequence,over_limit:sequence}),impact:object({member_count:sequence,device_count:sequence,
      members:object({items:listItems(impactMember),total:sequence,next_cursor:nullableText,actions}),
      devices:object({items:listItems(impactRow),total:sequence,next_cursor:nullableText,actions})}) }),
    [contractTenantPath,...listParams,{name:'member_cursor',in:'query',schema:text,description:'受影响成员的分页游标。cursor 用于受影响设备。'}]) },
  [policyTenant + '/signatures']: { get: listOf(object(policySignature)) },
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
    ...platformPaths('/v1/platform/tenants', tenantFields, ['name', 'owner_user_id'], {}, { created_at: text }),
    ...platformPaths('/v1/platform/providers', providers, ['name', 'protocol', 'base_url', 'secret'], { secret: { ...text, writeOnly: true } }),
    ...platformPaths('/v1/platform/models', models, ['provider_id', 'upstream_name', 'display_name', 'context_window']),
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
      security: [{ DeviceToken: [] }], parameters: [idPath],
      responses: { 200: { description: '配套引擎原始字节', content: agentBinary }, 401: status[401],
        404: error('引擎不可用或合约未授权') } } },
    '/v1/platform/agent-releases/{id}/pull': { post: { summary: '从登记的官方源拉取受管 Agent 制品',
      security: bearer, parameters: [idPath], responses: { ...status,
        200: response('制品校验通过', object({ sha256: releaseDigest, size: sequence, artifact_cached: { const: true }, download_url: text })),
        404: error('发行不存在') } } },
    '/v1/agent-artifacts/{sha256}': { get: { summary: '平台管理员下载已启用制品或暂存的桌面安装包', security: bearer,
      parameters: [{ name: 'sha256', in: 'path', required: true, schema: releaseDigest }],
      responses: { 200: { description: '制品原始字节', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        401: status[401], 403: status[403], 404: error('制品未缓存或发行已撤销') } } },
    '/v1/edge/agent-artifacts/{id}': { get: { summary: '按当前设备和能力合约下载 Agent 制品', security: [{ DeviceToken: [] }],
      parameters: [idPath],
      responses: { 200: { description: '制品原始字节', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        401: status[401], 404: error('制品不存在或当前合约不允许') } } },
    '/v1/platform/tool-releases': { get: listOf(toolRelease),
      post: { ...write(object({ ...toolFields, os: { ...text, enum: ['macos', 'windows'] }, arch: desktopArch,
        entrypoint: text, endpoint: { ...text, format: 'uri' }, secret: { ...text, writeOnly: true } },
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
