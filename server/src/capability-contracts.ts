import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { managedAgents, type AgentPin } from './agent-catalog';
import { ApiError, field, invalid, json, operation } from './api';
import { isTenantId } from './auth';
import { legacyPolicyRetired, readContract, readPins, stringList, validatePins,
  type Contract, type Reader, type Visibility } from './capability-data';
import { iso } from './credentials';
import { expectRevision, int, pagination, platformActor, tenantActor, type ManagementOptions } from './management';
import type { Store, Transaction } from './store';
import { readHead } from './policy-data';
import { defaultVisibility, visibility } from './visibility';

type Entitlements = {
  seat_limit: number;
  allowed_agents: string[];
  allowed_models: string[];
  lease_minutes: number;
  lease_budget_milli: number;
  visibility: Visibility;
  quota_distribution: boolean;
};
type Effective = Entitlements & { agent_release_ids: string[] };
type VisibilitySelection = Partial<Record<keyof Visibility, Partial<Visibility['admin']>>>;
type Configuration = Partial<Omit<Effective, 'seat_limit' | 'quota_distribution' | 'visibility'>> & { visibility?: VisibilitySelection };
type PlatformRow = { revision: number; template_id: string; template_version: number; entitlements_json: string;
  reason: string; issued_by: string; effective_at: string };
type ConfigurationRow = { revision: number; configuration_json: string };
type TemplateRow = { id: string; name: string; version: number; entitlements_json: string; published_at: string; published_by: string };

const entitlementKeys = ['seat_limit', 'allowed_agents', 'allowed_models', 'lease_minutes', 'lease_budget_milli',
  'visibility', 'quota_distribution'];
const configurationKeys = [...entitlementKeys.filter(key => key !== 'seat_limit' && key !== 'quota_distribution'), 'agent_release_ids'];
const selectPlatform = (sql: Reader) => sql.get<PlatformRow>('SELECT * FROM platform_contracts ORDER BY revision DESC LIMIT 1');
const selectConfiguration = (sql: Reader) => sql.get<ConfigurationRow>('SELECT revision, configuration_json FROM tenant_configurations ORDER BY revision DESC LIMIT 1');
const grantView = ({ entitlements_json, ...row }: PlatformRow) => ({ ...row, entitlements: JSON.parse(entitlements_json) as Entitlements });
const templateView = ({ entitlements_json, ...row }: TemplateRow) => ({
  ...row, entitlements: JSON.parse(entitlements_json) as Entitlements, actions: ['read', 'publish'],
});

function record(value: unknown, key: string, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(key);
  const row = value as Record<string, unknown>;
  const unknownKeys = Object.keys(row).filter(field => !keys.includes(field));
  if (unknownKeys.length) invalid(...unknownKeys.map(field => `${key}.${field}`));
  return row;
}

function strictVisibility(value: unknown) {
  const grants = record(value, 'visibility', ['admin', 'group_admin']);
  record(grants.admin, 'visibility.admin', ['summary', 'content']);
  record(grants.group_admin, 'visibility.group_admin', ['summary', 'content']);
  return visibility(grants);
}

function boolean(value: unknown, key: string) {
  if (typeof value !== 'boolean') invalid(key);
  return value;
}

function parseEntitlements(input: unknown, catalog: Reader, base?: Entitlements): Entitlements {
  const row = { ...base, ...record(input, 'entitlements', entitlementKeys) };
  const allowed_agents = stringList(row.allowed_agents, 'allowed_agents');
  const allowed_models = stringList(row.allowed_models, 'allowed_models');
  if (allowed_agents.some(agent => !managedAgents.some(known => agent === known))) invalid('allowed_agents');
  if (catalog.get('SELECT value FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM models WHERE models.id = value) LIMIT 1',
    [JSON.stringify(allowed_models)])) invalid('allowed_models');
  return { seat_limit: int(row.seat_limit, 'seat_limit'), allowed_agents, allowed_models,
    lease_minutes: int(row.lease_minutes, 'lease_minutes', 1, 1440),
    lease_budget_milli: int(row.lease_budget_milli, 'lease_budget_milli'), visibility: strictVisibility(row.visibility),
    quota_distribution: boolean(row.quota_distribution, 'quota_distribution') };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function readEffective(row: Contract | null): Effective {
  return { seat_limit: row?.seat_limit ?? 0, allowed_agents: row ? JSON.parse(row.allowed_agents_json) : [],
    allowed_models: row ? JSON.parse(row.allowed_models_json) : [], lease_minutes: row?.lease_minutes ?? 10,
    lease_budget_milli: row?.lease_budget_milli ?? 0, visibility: row ? visibility(JSON.parse(row.visibility_json)) : defaultVisibility,
    quota_distribution: row?.quota_distribution !== 0, agent_release_ids: readPins(row).map(pin => pin.id) };
}

function stockConfiguration(current: Effective): Configuration {
  const { allowed_agents, allowed_models, lease_minutes, lease_budget_milli, visibility, agent_release_ids } = current;
  return { allowed_agents, allowed_models, lease_minutes, lease_budget_milli, visibility, agent_release_ids };
}

function derive(entitlements: Entitlements, configuration: Configuration, candidatePins: AgentPin[]) {
  const allowed_agents = configuration.allowed_agents?.filter(agent => entitlements.allowed_agents.includes(agent));
  const allowed_models = configuration.allowed_models?.filter(model => entitlements.allowed_models.includes(model));
  const lease_minutes = configuration.lease_minutes === undefined ? undefined : Math.min(configuration.lease_minutes, entitlements.lease_minutes);
  const lease_budget_milli = configuration.lease_budget_milli === undefined ? undefined : Math.min(configuration.lease_budget_milli, entitlements.lease_budget_milli);
  const chosenVisibility: VisibilitySelection = {};
  const effectiveVisibility: Visibility = structuredClone(entitlements.visibility);
  for (const role of ['admin', 'group_admin'] as const) {
    const requested = configuration.visibility?.[role];
    if (!requested) continue;
    const chosen: Partial<Visibility['admin']> = {};
    for (const key of ['summary', 'content'] as const) {
      if (requested[key] === undefined) continue;
      chosen[key] = effectiveVisibility[role][key] = requested[key] && entitlements.visibility[role][key];
    }
    chosenVisibility[role] = chosen;
  }
  const pins = candidatePins.filter(pin => (allowed_agents ?? entitlements.allowed_agents).includes(pin.agent));
  const agent_release_ids = pins.map(pin => pin.id);
  const clipped: Configuration = { allowed_agents, allowed_models, lease_minutes, lease_budget_milli,
    visibility: configuration.visibility && chosenVisibility,
    ...(configuration.agent_release_ids === undefined ? {} : { agent_release_ids }) };
  const effective: Effective = { ...entitlements, allowed_agents: allowed_agents ?? entitlements.allowed_agents,
    allowed_models: allowed_models ?? entitlements.allowed_models, lease_minutes: lease_minutes ?? entitlements.lease_minutes,
    lease_budget_milli: lease_budget_milli ?? entitlements.lease_budget_milli, visibility: effectiveVisibility, agent_release_ids };
  return { configuration: clipped, effective, pins };
}

function parseVisibilitySelection(value: unknown): VisibilitySelection | undefined {
  if (value == null) return undefined;
  const row = record(value, 'visibility', ['admin', 'group_admin']);
  const result: VisibilitySelection = {};
  for (const role of ['admin', 'group_admin'] as const) {
    if (row[role] == null) continue;
    const grant = record(row[role], `visibility.${role}`, ['summary', 'content']);
    const selected: Partial<Visibility['admin']> = {};
    for (const key of ['summary', 'content'] as const) {
      if (grant[key] != null) selected[key] = boolean(grant[key], `visibility.${role}.${key}`);
    }
    if (Object.keys(selected).length) result[role] = selected;
  }
  return result;
}

function parseConfiguration(value: unknown): Configuration {
  const row = record(value, 'configuration', configurationKeys);
  return { allowed_agents: row.allowed_agents == null ? undefined : stringList(row.allowed_agents, 'allowed_agents'),
    allowed_models: row.allowed_models == null ? undefined : stringList(row.allowed_models, 'allowed_models'),
    lease_minutes: row.lease_minutes == null ? undefined : int(row.lease_minutes, 'lease_minutes', 1, 1440),
    lease_budget_milli: row.lease_budget_milli == null ? undefined : int(row.lease_budget_milli, 'lease_budget_milli'),
    visibility: parseVisibilitySelection(row.visibility),
    ...(row.agent_release_ids == null ? {} : { agent_release_ids: stringList(row.agent_release_ids, 'agent_release_ids') }) };
}

function checkBounds(requested: Configuration, clipped: Configuration) {
  const fields = (Object.keys(requested) as (keyof Configuration)[])
    .filter(key => key !== 'agent_release_ids' && !same(requested[key], clipped[key]));
  if (fields.length) throw new ApiError('invalid', { fields, reason: 'exceeds_entitlements' });
}

function seats(sql: Reader, limit: number) {
  const { active } = sql.get<{ active: number }>("SELECT count(*) AS active FROM members WHERE status = 'active'")!;
  return { limit, active, available: Math.max(0, limit - active), over_limit: Math.max(0, active - limit) };
}

function insertProjection(sql: Transaction, previous: Contract | null, platformRevision: number, tenantRevision: number,
  effective: Effective, pins: AgentPin[], actor: string, at: string) {
  sql.run(`INSERT INTO contract (revision, seat_limit, allowed_agents_json, allowed_models_json, agent_release_pins_json,
    lease_minutes, lease_budget_milli, visibility_json, updated_by, updated_at, platform_revision, tenant_revision, quota_distribution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [(previous?.revision ?? 0) + 1, effective.seat_limit,
    JSON.stringify(effective.allowed_agents), JSON.stringify(effective.allowed_models), JSON.stringify(pins),
    effective.lease_minutes, effective.lease_budget_milli, JSON.stringify(effective.visibility), actor, at,
    platformRevision, tenantRevision, Number(effective.quota_distribution)]);
}

function insertConfiguration(sql: Transaction, revision: number, platformRevision: number, configuration: Configuration, actor: string, at: string) {
  sql.run(`INSERT INTO tenant_configurations (revision, platform_revision, configuration_json, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?)`, [revision, platformRevision, JSON.stringify(configuration), actor, at]);
}

function audit(sql: Transaction, actor: string, action: string, target: string, detail: Record<string, unknown>, at: string) {
  sql.run('INSERT INTO audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
    [`aud_${ulid()}`, actor, action, target, JSON.stringify(detail), at]);
}

function auditProjectionChanges(sql: Transaction, actor: string, target: string, previous: Contract | null,
  next: Effective, pins: AgentPin[], at: string) {
  const from = readEffective(previous).visibility;
  const previousPins = readPins(previous);
  const revision = (previous?.revision ?? 0) + 1;
  if (!same(from, next.visibility)) {
    audit(sql, actor, 'contract.visibility.update', target, { from, to: next.visibility, revision }, at);
  }
  if (!same(previousPins, pins)) {
    audit(sql, actor, 'contract.agent_releases.update', target, { from: previousPins, to: pins, revision }, at);
  }
}

function requireIdempotency(c: Context, opts: ManagementOptions, at: number, actor: string, body: unknown) {
  const op = operation(c, opts.codeSecret, at, actor, body);
  if (!op.key) invalid('Idempotency-Key');
  return op;
}

function configurationView(sql: Reader, role: string) {
  const row = selectPlatform(sql);
  const configuration = selectConfiguration(sql);
  const effective = readEffective(readContract(sql));
  return { platform_revision: row?.revision ?? 0, revision: configuration?.revision ?? 0,
    entitlements: row ? grantView(row).entitlements : null,
    configuration: configuration ? JSON.parse(configuration.configuration_json) as Configuration : {},
    effective, seats: seats(sql, effective.seat_limit), actions: row && role === 'owner' ? ['read', 'update'] : ['read'] };
}

function platformView(sql: Reader, tenant_id: string) {
  const row = selectPlatform(sql);
  const current = configurationView(sql, 'platform');
  return { tenant_id, revision: row?.revision ?? 0, tenant_revision: current.revision,
    platform_contract: row ? grantView(row) : null, effective: current.effective, seats: current.seats,
    actions: ['read', 'publish', ...(row ? ['read_history'] : [])] };
}

export function capabilityRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const platformPath = '/v1/platform/capability-contracts';
  const templatePath = '/v1/platform/contract-templates';
  const tenantPath = '/v1/contract/configuration';

  function legacyAuthority(sql: Reader) {
    if (readHead(sql) || legacyPolicyRetired(sql)) throw new ApiError('conflict', { reason: 'use_capability_policy' });
  }

  function platformTenant(c: Context, at: number) {
    const actor = platformActor(store, c, at);
    const id = c.req.param('tenant_id');
    if (!isTenantId(id) || !store.system.get('SELECT 1 FROM tenants WHERE id = ?', [id])) throw new ApiError('not_found');
    return { actor, id, db: store.tenant(id) };
  }

  app.get(templatePath, c => {
    platformActor(store, c, opts.now());
    const p = pagination(c);
    const where = "WHERE instr(lower(id || ' ' || name), lower(?)) > 0";
    const { total } = store.system.get<{ total: number }>(`SELECT count(*) AS total FROM contract_templates ${where}`, [p.query])!;
    const rows = store.system.all<TemplateRow>(`SELECT * FROM contract_templates ${where} ORDER BY id, version DESC LIMIT ? OFFSET ?`,
      [p.query, p.limit, p.offset]);
    return c.json(p.page(rows.map(templateView), total, ['create_contract_template']));
  });
  app.post(templatePath, async c => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const body = await json(c);
    const op = requireIdempotency(c, opts, at, actor, body);
    return store.system.write(sql => {
      if (!sql.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [actor])) throw new ApiError('forbidden');
      const cached = op.read(sql);
      if (cached) return cached;
      record(body, 'body', ['id', 'name', 'revision', 'entitlements']);
      const id = field(body.id, 'id', 64);
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) invalid('id');
      const name = field(body.name, 'name');
      const { version } = sql.get<{ version: number }>('SELECT coalesce(max(version), 0) AS version FROM contract_templates WHERE id = ?', [id])!;
      expectRevision(body.revision, version, 0);
      const row = { id, version: version + 1, name, entitlements_json: JSON.stringify(parseEntitlements(body.entitlements, sql)),
        published_by: actor, published_at: iso(at) };
      sql.run('INSERT INTO contract_templates (id, version, name, entitlements_json, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, row.version, name, row.entitlements_json, actor, row.published_at]);
      sql.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${ulid()}`, actor, 'contract.template.publish', id, JSON.stringify({ version: row.version }), row.published_at]);
      return op.complete(sql, { status: 201, payload: templateView(row) });
    });
  });
  app.get(platformPath, c => {
    platformActor(store, c, opts.now());
    const p = pagination(c);
    const where = "WHERE instr(lower(id || ' ' || name), lower(?)) > 0";
    const { total } = store.system.get<{ total: number }>(`SELECT count(*) AS total FROM tenants ${where}`, [p.query])!;
    const tenants = store.system.all<{ tenant_id: string; name: string }>(`SELECT id AS tenant_id, name FROM tenants ${where} ORDER BY id LIMIT ? OFFSET ?`,
      [p.query, p.limit, p.offset]);
    return c.json(p.page(tenants.map(row => ({ ...row, actions: ['read'] })), total));
  });
  app.get(`${platformPath}/:tenant_id`, c => {
    const { id, db } = platformTenant(c, opts.now());
    legacyAuthority(db);
    return c.json(platformView(db, id));
  });
  app.get(`${platformPath}/:tenant_id/history`, c => {
    const { db } = platformTenant(c, opts.now());
    legacyAuthority(db);
    const p = pagination(c);
    const { total } = db.get<{ total: number }>('SELECT count(*) AS total FROM platform_contracts')!;
    const history = db.all<PlatformRow>('SELECT * FROM platform_contracts ORDER BY revision DESC LIMIT ? OFFSET ?', [p.limit, p.offset]);
    return c.json(p.page(history.map(row => ({ ...grantView(row), actions: ['read'] })), total));
  });

  function evaluatePlatform(sql: Reader, body: Record<string, unknown>) {
    legacyAuthority(sql);
    if (!readContract(sql)) throw new ApiError('conflict', { reason: 'use_capability_policy' });
    record(body, 'body', ['revision', 'tenant_revision', 'template_id', 'template_version', 'entitlements', 'reason']);
    const current = selectPlatform(sql);
    const saved = selectConfiguration(sql);
    const tenantRevision = saved?.revision ?? 0;
    expectRevision(body.revision, current?.revision ?? 0, 0);
    if (int(body.tenant_revision, 'tenant_revision') !== tenantRevision) throw new ApiError('conflict', { tenant_revision: tenantRevision });
    const template_id = field(body.template_id, 'template_id');
    const template_version = int(body.template_version, 'template_version', 1);
    const template = store.system.get<TemplateRow>('SELECT * FROM contract_templates WHERE id = ? AND version = ?', [template_id, template_version]);
    if (!template) invalid('template_id', 'template_version');
    const entitlements = parseEntitlements(body.entitlements === undefined ? {} : body.entitlements, store.system, templateView(template).entitlements);
    const previous = readContract(sql);
    const oldEffective = readEffective(previous);
    const configuration: Configuration = saved ? JSON.parse(saved.configuration_json) : previous ? stockConfiguration(oldEffective) : {};
    const evaluated = derive(entitlements, configuration, readPins(previous));
    return { current, previous, saved, tenantRevision, originalConfiguration: configuration, oldEffective, entitlements, ...evaluated,
      template_id, template_version, reason: field(body.reason, 'reason', 500) };
  }

  app.post(`${platformPath}/:tenant_id/preview`, async c => {
    const body = await json(c);
    const { db } = platformTenant(c, opts.now());
    const evaluated = evaluatePlatform(db, body);
    return c.json({ effective: evaluated.effective, previous_effective: evaluated.oldEffective,
      configuration: evaluated.configuration, seats: seats(db, evaluated.effective.seat_limit) });
  });
  app.put(`${platformPath}/:tenant_id`, async c => {
    const body = await json(c);
    const at = opts.now();
    const { actor, db, id } = platformTenant(c, at);
    const op = requireIdempotency(c, opts, at, actor, body);
    const { response, changed } = await db.write(sql => {
      if (!store.system.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [actor])) throw new ApiError('forbidden');
      legacyAuthority(sql);
      const cached = op.read(sql);
      if (cached) return { response: cached, changed: false };
      const result = evaluatePlatform(sql, body);
      const revision = (result.current?.revision ?? 0) + 1;
      const time = iso(at);
      sql.run(`INSERT INTO platform_contracts (revision, template_id, template_version, entitlements_json, reason, issued_by, effective_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [revision, result.template_id, result.template_version, JSON.stringify(result.entitlements), result.reason, actor, time]);
      const saveConfiguration = (!result.saved && !!result.previous) || !same(result.originalConfiguration, result.configuration);
      const tenantRevision = result.tenantRevision + Number(saveConfiguration);
      if (saveConfiguration) insertConfiguration(sql, tenantRevision, revision, result.configuration, actor, time);
      insertProjection(sql, result.previous, revision, tenantRevision, result.effective, result.pins, actor, time);
      auditProjectionChanges(sql, actor, id, result.previous, result.effective, result.pins, time);
      audit(sql, actor, 'contract.platform.publish', id, { platform_revision: revision, tenant_revision: tenantRevision,
        reason: result.reason, from: result.oldEffective, to: result.effective }, time);
      return { response: op.complete(sql, { status: 200, payload: platformView(sql, id) }), changed: true };
    });
    if (changed) opts.onConfigChange?.(id);
    return response;
  });

  app.get(tenantPath, c => {
    const { db, role } = tenantActor(store, c, opts.now());
    if (role !== 'owner' && role !== 'admin') throw new ApiError('forbidden');
    legacyAuthority(db);
    return c.json(configurationView(db, role));
  });

  function evaluateTenant(sql: Reader, body: Record<string, unknown>) {
    legacyAuthority(sql);
    record(body, 'body', ['platform_revision', 'revision', 'configuration']);
    const current = selectPlatform(sql);
    if (!current) throw new ApiError('conflict', { reason: 'platform_contract_required' });
    if (int(body.platform_revision, 'platform_revision', 1) !== current.revision) {
      throw new ApiError('conflict', { platform_revision: current.revision });
    }
    const revision = selectConfiguration(sql)?.revision ?? 0;
    expectRevision(body.revision, revision, 0);
    const old = readContract(sql);
    const entitlements = grantView(current).entitlements;
    const configuration = parseConfiguration(body.configuration);
    checkBounds(configuration, derive(entitlements, configuration, []).configuration);
    const candidatePins = validatePins(store, opts.dataDir, configuration.agent_release_ids ?? [],
      configuration.allowed_agents ?? entitlements.allowed_agents, readPins(old));
    const evaluated = derive(entitlements, configuration, candidatePins);
    return { old, revision, platformRevision: current.revision, oldEffective: readEffective(old), ...evaluated };
  }

  app.post(`${tenantPath}/preview`, async c => {
    const body = await json(c);
    const { db, role } = tenantActor(store, c, opts.now());
    if (role !== 'owner') throw new ApiError('forbidden');
    const result = evaluateTenant(db, body);
    return c.json({ effective: result.effective, previous_effective: result.oldEffective,
      configuration: result.configuration, seats: seats(db, result.effective.seat_limit) });
  });
  app.put(tenantPath, async c => {
    const body = await json(c);
    const at = opts.now();
    const actor = tenantActor(store, c, at);
    if (actor.role !== 'owner') throw new ApiError('forbidden');
    const op = requireIdempotency(c, opts, at, actor.userId, body);
    const { response, changed } = await actor.db.write(sql => {
      if (!sql.get("SELECT 1 FROM members WHERE user_id = ? AND status = 'active' AND role = 'owner'", [actor.userId])
        || !store.system.get("SELECT 1 FROM tenants WHERE id = ? AND status = 'active'", [actor.id])) throw new ApiError('forbidden');
      legacyAuthority(sql);
      const cached = op.read(sql);
      if (cached) return { response: cached, changed: false };
      const result = evaluateTenant(sql, body);
      const revision = result.revision + 1;
      const time = iso(at);
      insertConfiguration(sql, revision, result.platformRevision, result.configuration, actor.userId, time);
      insertProjection(sql, result.old, result.platformRevision, revision, result.effective, result.pins, actor.userId, time);
      auditProjectionChanges(sql, actor.userId, actor.id, result.old, result.effective, result.pins, time);
      audit(sql, actor.userId, 'contract.tenant.publish', actor.id, { platform_revision: result.platformRevision, tenant_revision: revision,
        from: result.oldEffective, to: result.effective, configuration: result.configuration }, time);
      return { response: op.complete(sql, { status: 200, payload: configurationView(sql, 'owner') }), changed: true };
    });
    if (changed) opts.onConfigChange?.(actor.id);
    return response;
  });
}
