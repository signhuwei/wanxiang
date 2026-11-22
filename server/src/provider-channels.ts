import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { channelCapabilities, discoverProviderCatalog, type CatalogResult, type CatalogTarget, type ProviderChannelFetch } from './channel-catalog-upstream';
import { iso } from './credentials';
import { enumField, int, platformActor, type ManagementOptions } from './management';
import { decryptProviderSecret } from './provider-secret';
import { boundPage, conflict, digest, replay, requirePlatformAdmin, routeId, strictObject } from './routing-http';
import type { Store, Transaction } from './store';

type Reader = Pick<Transaction, 'get' | 'all'>;
type Provider = { id: string; revision: number; status: 'active' | 'disabled'; base_url: string; protocol: CatalogTarget['protocol'];
  auth: CatalogTarget['auth'] | null; proxy: string | null; secret_ciphertext: Uint8Array };
type Channel = { account_id: string; endpoint_id: string; current_revision: number; protocol: CatalogTarget['protocol'];
  base_url: string; auth_adapter: CatalogTarget['auth']; credential_scope: string };
type Job = { id: string; kind: 'connectivity' | 'discovery'; status: CatalogResult['status']; reason: string | null;
  provider_id: string; provider_revision: number; account_id: string; endpoint_id: string; endpoint_revision: number;
  observed_at: string; model_count: number };
type Model = { revision: number; status: string; current_identity_revision: number | null };
type Identity = { identity_revision: number; maker_id: string; model_family: string; model_variant: string;
  identity_mode: 'family_follow' | 'pinned_snapshot'; model_snapshot: string | null; capability_floor_json: string };
type Discovery = Job & { catalog_item_id: string; raw_model: string; context_tokens: number | null; snapshot_claim: string | null; variant_claim: string | null };
type Decision = { discovery_id: string; catalog_item_id: string; decision: 'accept' | 'reject'; capabilities: string[] };
type Deployment = { deployment_id: string; status: string; current_revision: number; endpoint_revision: number; capabilities_json: string };

const root = '/v1/platform';
const providerPath = `${root}/providers/:provider_id`;
const modelPath = `${root}/models/:model_id`;
const jobPath = `${root}/probe-jobs`;

function getProvider(db: Reader, id: string) {
  const row = db.get<Provider>('SELECT id, revision, status, base_url, protocol, auth, proxy, secret_ciphertext FROM providers WHERE id = ?', [id]);
  if (!row) throw new ApiError('not_found');
  return row;
}

function getDefault(db: Reader, id: string) {
  return db.get<Channel>(`SELECT d.account_id, d.endpoint_id, d.credential_scope, e.current_revision, er.protocol, er.base_url, er.auth_adapter
    FROM provider_channel_defaults d JOIN provider_endpoints e ON e.endpoint_id = d.endpoint_id
    JOIN provider_endpoint_revisions er ON er.endpoint_id = e.endpoint_id AND er.endpoint_revision = e.current_revision
    WHERE d.provider_id = ?`, [id]);
}

function authFor(provider: Provider) {
  return provider.auth ?? (provider.protocol === 'anthropic' ? 'x_api_key' : 'bearer');
}

function credentialScope(provider: Provider) {
  return JSON.stringify([URL.parse(provider.base_url)?.origin ?? null, provider.protocol, authFor(provider)]);
}

/** Keep the default channel's stable IDs and immutable endpoint versions in sync with Provider edits. */
export function syncProviderChannel(db: Transaction, providerId: string, at: number, credentialsChanged = false): Channel {
  const provider = getProvider(db, providerId);
  const auth = authFor(provider);
  const previous = getDefault(db, providerId);
  const scoped = credentialsChanged || !previous ? credentialScope(provider) : previous.credential_scope;
  const now = iso(at);
  const accountId = previous?.account_id ?? `acct_${ulid()}`;
  const endpointId = previous?.endpoint_id ?? `end_${ulid()}`;
  const changed = !previous || credentialsChanged || previous.protocol !== provider.protocol || previous.base_url !== provider.base_url || previous.auth_adapter !== auth;
  const revision = (previous?.current_revision ?? 0) + Number(changed);
  if (!previous) {
    db.run(`INSERT INTO provider_accounts (account_id, provider_id, name, status, funding_id, created_at)
      VALUES (?, ?, '默认渠道', 'active', ?, ?)`, [accountId, providerId, accountId, now]);
    db.run(`INSERT INTO provider_endpoints (endpoint_id, provider_id, status, current_revision, created_at)
      VALUES (?, ?, ?, ?, ?)`, [endpointId, providerId, provider.status, revision, now]);
    db.run(`INSERT INTO provider_account_endpoints (provider_id, account_id, endpoint_id, state)
      VALUES (?, ?, ?, 'enabled')`, [providerId, accountId, endpointId]);
    db.run('INSERT INTO provider_channel_defaults (provider_id, account_id, endpoint_id, credential_scope) VALUES (?, ?, ?, ?)',
      [providerId, accountId, endpointId, scoped]);
  }
  if (previous && credentialsChanged) {
    db.run('UPDATE provider_channel_defaults SET credential_scope = ? WHERE provider_id = ?', [scoped, providerId]);
  }
  if (changed) {
    db.run(`INSERT INTO provider_endpoint_revisions (endpoint_id, endpoint_revision, protocol, base_url, fault_domain_id, auth_adapter, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [endpointId, revision, provider.protocol, provider.base_url, URL.parse(provider.base_url)?.hostname ?? null, auth, now]);
  }
  if (previous) db.run('UPDATE provider_endpoints SET status = ?, current_revision = ? WHERE endpoint_id = ?', [provider.status, revision, endpointId]);
  return { account_id: accountId, endpoint_id: endpointId, current_revision: revision, protocol: provider.protocol, base_url: provider.base_url,
    auth_adapter: auth, credential_scope: scoped };
}

function jobView(row: Job) {
  return { id: row.id, kind: row.kind, status: row.status, location: `${jobPath}/${row.id}`, observed_at: row.observed_at,
    scope: { provider_id: row.provider_id, provider_revision: row.provider_revision,
      account_id: row.account_id, endpoint_id: row.endpoint_id, endpoint_revision: row.endpoint_revision },
    summary: { model_count: row.model_count, reason: row.reason }, actions: ['read'] };
}

function latestJob(db: Reader, providerId: string, kind: Job['kind']) {
  return db.get<Job>(`SELECT * FROM provider_channel_jobs WHERE provider_id = ? AND kind = ?
    ORDER BY observed_at DESC, rowid DESC LIMIT 1`, [providerId, kind]);
}

function latestCatalog(db: Reader, provider: Provider, channel: Channel | null, historical = false) {
  if (!channel) return null;
  return db.get<Job>(`SELECT * FROM provider_channel_jobs WHERE provider_id = ? AND kind = 'discovery'
    AND status IN ('succeeded', 'partial') AND ${historical ? 'NOT ' : ''}(provider_revision = ? AND endpoint_id = ? AND endpoint_revision = ?)
    ORDER BY (status = 'succeeded') DESC, observed_at DESC, rowid DESC LIMIT 1`,
    [provider.id, provider.revision, channel.endpoint_id, channel.current_revision]);
}

function reviewable(db: Reader, row: Job) {
  if (row.kind !== 'discovery' || row.status === 'failed') return false;
  const provider = getProvider(db, row.provider_id);
  const channel = getDefault(db, row.provider_id);
  // A complete pull takes priority over partial pulls from the same revision.
  return provider.status === 'active' && latestCatalog(db, provider, channel)?.id === row.id;
}

function modelIdentity(db: Reader, id: string) {
  const model = db.get<Model>('SELECT revision, status, current_identity_revision FROM models WHERE id = ?', [id]);
  if (!model) throw new ApiError('not_found');
  const identity = model.current_identity_revision === null ? null : db.get<Identity>(`SELECT identity_revision, maker_id, model_family,
    model_variant, identity_mode, model_snapshot, capability_floor_json FROM model_identity_revisions WHERE model_id = ? AND identity_revision = ?`,
  [id, model.current_identity_revision]);
  return { model, identity };
}

function identityView(id: string, model: Model, identity: Identity | null) {
  const { capability_floor_json, ...fields } = identity ?? {};
  return { model_id: id, revision: model.revision, identity: identity ? { ...fields, capability_floor: JSON.parse(capability_floor_json!) } : null,
    actions: model.status === 'active' && !identity ? ['create_identity'] : ['read'] };
}

function capabilities(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length > channelCapabilities.length) invalid(name);
  return [...new Set(value.map((item) => enumField(item, name, channelCapabilities)))].sort();
}

function audit(db: Transaction, actor: string, action: string, target: string, detail: object, at: string) {
  db.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
    [`aud_${ulid()}`, actor, action, target, JSON.stringify(detail), at]);
}

async function observe(provider: Provider, channel: Channel, kind: Job['kind'], masterKey: Uint8Array | undefined, send?: ProviderChannelFetch): Promise<CatalogResult> {
  const unavailable = (reason: string): CatalogResult => ({ status: 'failed', reason, items: [] });
  if (provider.proxy && provider.proxy !== 'none') return unavailable('unsupported_proxy');
  if (channel.credential_scope !== credentialScope(provider)) return unavailable('credential_scope_changed');
  if (!masterKey) return unavailable('missing_credential');
  let secret: Buffer;
  try { secret = decryptProviderSecret(masterKey, provider.id, provider.secret_ciphertext); }
  catch { return unavailable('missing_credential'); }
  try {
    return await discoverProviderCatalog({ protocol: provider.protocol, base_url: provider.base_url,
      auth: authFor(provider), secret: secret.toString() }, kind, send);
  } finally { secret.fill(0); }
}

function saveJob(db: Transaction, job: Job, observation: CatalogResult, actor: string) {
  db.run(`INSERT INTO provider_channel_jobs (id, provider_id, provider_revision, account_id, endpoint_id, endpoint_revision, kind,
    status, reason, model_count, observed_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [job.id, job.provider_id, job.provider_revision, job.account_id, job.endpoint_id, job.endpoint_revision, job.kind,
    job.status, job.reason, job.model_count, job.observed_at, actor]);
  for (const item of observation.items) {
    const known = db.get<{ catalog_item_id: string }>(`SELECT catalog_item_id FROM provider_channel_catalog
      WHERE account_id = ? AND endpoint_id = ? AND raw_model = ?`, [job.account_id, job.endpoint_id, item.raw_model]);
    const id = known?.catalog_item_id ?? `cat_${ulid()}`;
    if (!known) db.run('INSERT INTO provider_channel_catalog (catalog_item_id, account_id, endpoint_id, raw_model) VALUES (?, ?, ?, ?)',
      [id, job.account_id, job.endpoint_id, item.raw_model]);
    db.run(`INSERT INTO provider_channel_discoveries (discovery_id, catalog_item_id, context_tokens, capabilities_claim_json, snapshot_claim, variant_claim)
      VALUES (?, ?, ?, ?, ?, ?)`, [job.id, id, item.context_tokens, JSON.stringify(item.capabilities_claim), item.snapshot_claim, item.variant_claim]);
  }
}

function discoveryItem(db: Reader, input: Decision) {
  const row = db.get<Discovery>(`SELECT j.*, d.catalog_item_id, c.raw_model, d.context_tokens, d.snapshot_claim, d.variant_claim
    FROM provider_channel_discoveries d JOIN provider_channel_jobs j ON j.id = d.discovery_id
    JOIN provider_channel_catalog c ON c.catalog_item_id = d.catalog_item_id
    WHERE d.discovery_id = ? AND d.catalog_item_id = ?`, [input.discovery_id, input.catalog_item_id]);
  if (!row) throw new ApiError('not_found');
  if (!reviewable(db, row)) throw conflict('discovery_changed');
  return row;
}

function deploymentFor(db: Transaction, item: Discovery, allowed: string[], actor: string, at: string, accepted: boolean) {
  const previous = db.get<Deployment>(`SELECT d.deployment_id, d.status, d.current_revision, r.endpoint_revision, r.capabilities_json
    FROM model_deployments d JOIN model_deployment_revisions r ON r.deployment_id = d.deployment_id AND r.deployment_revision = d.current_revision
    WHERE d.account_id = ? AND d.endpoint_id = ? AND d.catalog_item_id = ? ORDER BY d.created_at, d.deployment_id LIMIT 1`,
  [item.account_id, item.endpoint_id, item.catalog_item_id]);
  if (previous?.status === 'archived') throw conflict('deployment_archived');
  const deploymentId = previous?.deployment_id ?? `dep_${ulid()}`;
  if (previous && !accepted) return { deployment_id: deploymentId, deployment_revision: previous.current_revision };
  if (previous?.endpoint_revision === item.endpoint_revision && previous.status === 'active') {
    const registered: string[] = JSON.parse(previous.capabilities_json);
    if (!allowed.every((capability) => registered.includes(capability))) throw conflict('deployment_capability_changed');
    return { deployment_id: deploymentId, deployment_revision: previous.current_revision };
  }
  const revision = (previous?.current_revision ?? 0) + 1;
  if (!previous) db.run(`INSERT INTO model_deployments(deployment_id,provider_id,account_id,endpoint_id,catalog_item_id,display_name,
    status,current_revision,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  [deploymentId, item.provider_id, item.account_id, item.endpoint_id, item.catalog_item_id, item.raw_model, accepted ? 'active' : 'disabled', revision, at]);
  db.run(`INSERT INTO model_deployment_revisions(deployment_id,deployment_revision,endpoint_id,endpoint_revision,upstream_model,
    capabilities_json,context_tokens,snapshot_claim,quantization_claim,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [deploymentId, revision, item.endpoint_id, item.endpoint_revision, item.raw_model, JSON.stringify(allowed), item.context_tokens,
    item.snapshot_claim, item.variant_claim, actor, at]);
  if (previous) db.run(`UPDATE model_deployments SET current_revision = ?, status = 'active', edit_revision = edit_revision + 1
    WHERE deployment_id = ?`, [revision, deploymentId]);
  return { deployment_id: deploymentId, deployment_revision: revision };
}

function reviewedCandidate(db: Transaction, modelId: string, identity: Identity, decision: Decision, reason: string, actor: string, at: string) {
  const item = discoveryItem(db, decision);
  const review = db.get('SELECT 1 FROM provider_channel_reviews WHERE model_id = ? AND identity_revision = ? AND discovery_id = ? AND catalog_item_id = ?',
    [modelId, identity.identity_revision, item.id, item.catalog_item_id]);
  if (review) throw conflict('candidate_already_reviewed');
  const accepted = decision.decision === 'accept';
  if (accepted && identity.identity_mode === 'pinned_snapshot' && identity.model_snapshot !== item.snapshot_claim) throw conflict('snapshot_unverified');
  if (accepted && item.variant_claim && item.variant_claim !== identity.model_variant) throw conflict('model_variant_mismatch');
  const floor = JSON.parse(identity.capability_floor_json) as string[];
  if (accepted && !floor.every((capability) => decision.capabilities.includes(capability))) throw conflict('capability_unverified');
  const deployment = deploymentFor(db, item, accepted ? decision.capabilities : [], actor, at, accepted);
  const candidate = `mt_${ulid()}`;
  const evidence = accepted ? `ev_${ulid()}` : null;
  const status = accepted ? 'accepted' : 'rejected';
  if (evidence) db.run(`INSERT INTO model_evidence(evidence_id,deployment_id,deployment_revision,source_kind,outcome,identity_verified,
    capabilities_json,key_fields_json,observed_at,created_by) VALUES (?,?,?,'manual_review','passed',1,?,?,?,?)`,
  [evidence, deployment.deployment_id, deployment.deployment_revision, JSON.stringify(decision.capabilities),
    JSON.stringify({ model_id: modelId, identity_revision: identity.identity_revision, discovery_id: item.id, reason }), at, actor]);
  db.run(`INSERT INTO model_discovery_matches(candidate_id,model_id,identity_revision,deployment_id,deployment_revision,catalog_item_id,discovery_id,
    match_kind,normalized_key,confidence,reasons_json,status,decided_by,decided_at,decision_reason,created_at)
    VALUES (?,?,?,?,?,?,?,'manual',?,'high',?,?,?,?,?,?)`,
  [candidate, modelId, identity.identity_revision, deployment.deployment_id, deployment.deployment_revision, item.catalog_item_id, item.id,
    identity.model_family, JSON.stringify([reason]), status, actor, at, reason, at]);
  db.run(`INSERT INTO provider_channel_reviews(model_id,identity_revision,discovery_id,catalog_item_id,candidate_id) VALUES (?,?,?,?,?)`,
    [modelId, identity.identity_revision, item.id, item.catalog_item_id, candidate]);
  return { ...deployment, approved_match_id: accepted ? candidate : null, evidence_ids: evidence ? [evidence] : [], raw_model: item.raw_model, status };
}

export function providerChannelRoutes(app: Hono, store: Store, opts: ManagementOptions & { providerChannelFetch?: ProviderChannelFetch }) {
  const underway = new Map<string, Promise<Response>>();
  const activeProviders = new Set<string>();

  app.get(`${providerPath}/channel`, (c) => {
    platformActor(store, c, opts.now());
    const provider = getProvider(store.system, routeId(c.req.param('provider_id'), 'provider_id'));
    const accounts = store.system.all(`SELECT a.account_id, a.name, a.balance_mode, a.funding_id, d.endpoint_id
      FROM provider_accounts a LEFT JOIN provider_channel_defaults d ON d.account_id = a.account_id
      WHERE a.provider_id = ? ORDER BY a.name, a.account_id`, [provider.id]);
    const channel = getDefault(store.system, provider.id);
    function view(job: Job | null) {
      return job ? jobView(job) : null;
    }
    return c.json({ provider_id: provider.id, revision: provider.revision, accounts,
      latest_probe: view(latestJob(store.system, provider.id, 'connectivity')),
      latest_discovery: view(latestJob(store.system, provider.id, 'discovery')),
      latest_catalog: view(latestCatalog(store.system, provider, channel)),
      historical_catalog: view(latestCatalog(store.system, provider, channel, true)),
      actions: provider.status === 'active' ? ['probe_connectivity', 'discover'] : [] });
  });

  async function start(c: Context, kind: Job['kind']) {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const id = routeId(c.req.param('provider_id'), 'provider_id');
    const body = strictObject(await json(c), 'body', kind === 'connectivity' ? ['kind', 'revision'] : ['revision']);
    if (kind === 'connectivity' && body.kind !== 'connectivity') invalid('kind');
    const revision = int(body.revision, 'revision', 1);
    const op = operation(c, opts.codeSecret, at, actor, body);
    if (!op.key) invalid('Idempotency-Key');
    const cached = replay(op, store.system);
    if (cached) return cached;
    const command = op.scope + ':' + op.key;
    const pending = underway.get(command);
    if (pending) {
      await pending;
      const result = replay(op, store.system);
      if (result) return result;
      throw conflict('probe_interrupted');
    }
    if (activeProviders.has(id)) throw conflict('probe_in_progress');
    activeProviders.add(id);
    const run = (async () => {
      const { provider, channel } = await store.system.write((db) => {
        requirePlatformAdmin(db, actor);
        const provider = getProvider(db, id);
        if (provider.revision !== revision) throw conflict('revision_changed', provider.revision);
        if (provider.status !== 'active') throw conflict('provider_inactive');
        return { provider, channel: syncProviderChannel(db, id, at) };
      });
      const observation = await observe(provider, channel, kind, opts.masterKey, opts.providerChannelFetch);
      const observed = iso(opts.now());
      return store.system.write((db) => {
        requirePlatformAdmin(db, actor);
        const current = getProvider(db, id).revision;
        if (current !== revision) throw conflict('revision_changed', current);
        const job: Job = { id: `prb_${ulid()}`, kind, status: observation.status, reason: observation.reason, provider_id: id,
          provider_revision: revision, account_id: channel.account_id, endpoint_id: channel.endpoint_id,
          endpoint_revision: channel.current_revision, observed_at: observed, model_count: observation.items.length };
        saveJob(db, job, observation, actor);
        audit(db, actor, `channel.${kind}`, id, { id: job.id, status: job.status, model_count: job.model_count }, observed);
        c.header('Location', `${jobPath}/${job.id}`);
        return op.complete(db, { status: 202, payload: jobView(job) });
      });
    })();
    underway.set(command, run);
    try { return await run; }
    finally { underway.delete(command); activeProviders.delete(id); }
  }

  app.post(`${providerPath}/probes`, (c) => start(c, 'connectivity'));
  app.post(`${providerPath}/discoveries`, (c) => start(c, 'discovery'));
  function job(c: Context) {
    const actor = platformActor(store, c, opts.now());
    const id = routeId(c.req.param('job_id'), 'job_id');
    const row = store.system.get<Job>('SELECT * FROM provider_channel_jobs WHERE id = ?', [id]);
    if (!row) throw new ApiError('not_found');
    return { actor, row };
  }
  app.get(`${jobPath}/:job_id`, (c) => c.json(jobView(job(c).row)));
  app.get(`${jobPath}/:job_id/results`, (c) => {
    const { actor, row } = job(c);
    const q = c.req.query('q') ?? '';
    if (q.length > 200) invalid('q');
    const page = boundPage(c, opts.codeSecret, actor, { job_id: row.id, q });
    const where = `FROM provider_channel_discoveries d JOIN provider_channel_catalog c ON c.catalog_item_id = d.catalog_item_id
      WHERE d.discovery_id = ? AND instr(lower(c.raw_model), lower(?)) > 0`;
    const { total } = store.system.get<{ total: number }>(`SELECT count(*) AS total ${where}`, [row.id, q])!;
    const items = store.system.all<{ catalog_item_id: string; discovery_id: string; raw_model: string; context_tokens: number | null;
      capabilities_claim_json: string; snapshot_claim: string | null; variant_claim: string | null }>(`SELECT d.catalog_item_id,d.discovery_id,c.raw_model,
      d.context_tokens,d.capabilities_claim_json,d.snapshot_claim,d.variant_claim ${where} ORDER BY c.raw_model COLLATE BINARY,c.catalog_item_id LIMIT ? OFFSET ?`,
    [row.id, q, page.limit, page.offset]).map(({ capabilities_claim_json, ...fields }) => ({ ...fields, capabilities_claim: JSON.parse(capabilities_claim_json) }));
    return c.json(page.page(items, total, reviewable(store.system, row) ? ['read', 'review_candidates'] : ['read']));
  });

  app.get(`${modelPath}/identity`, (c) => {
    platformActor(store, c, opts.now());
    const id = routeId(c.req.param('model_id'), 'model_id');
    const { model, identity } = modelIdentity(store.system, id);
    return c.json(identityView(id, model, identity));
  });
  app.post(`${modelPath}/identity`, async (c) => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const id = routeId(c.req.param('model_id'), 'model_id');
    const body = strictObject(await json(c), 'body', ['revision', 'maker_id', 'model_family', 'model_variant', 'identity_mode', 'model_snapshot', 'capability_floor']);
    const identity_mode = enumField(body.identity_mode, 'identity_mode', ['family_follow', 'pinned_snapshot']);
    const model_snapshot = body.model_snapshot == null ? null : field(body.model_snapshot, 'model_snapshot');
    if ((identity_mode === 'pinned_snapshot') !== (model_snapshot !== null)) invalid('model_snapshot');
    const maker_id = field(body.maker_id, 'maker_id');
    const model_family = field(body.model_family, 'model_family');
    const model_variant = field(body.model_variant, 'model_variant');
    const capability_floor_json = JSON.stringify(capabilities(body.capability_floor, 'capability_floor'));
    const supplied = int(body.revision, 'revision', 1);
    const op = operation(c, opts.codeSecret, at, actor, body);
    if (!op.key) invalid('Idempotency-Key');
    return store.system.write((db) => {
      requirePlatformAdmin(db, actor);
      const cached = replay(op, db);
      if (cached) return cached;
      const { model, identity } = modelIdentity(db, id);
      if (identity) throw conflict('identity_already_registered');
      if (model.status !== 'active') throw conflict('model_inactive');
      if (supplied !== model.revision) throw conflict('revision_changed', model.revision);
      const now = iso(at);
      db.run(`INSERT INTO model_identity_revisions(model_id,identity_revision,maker_id,model_family,model_variant,identity_mode,
        model_snapshot,capability_floor_json,created_by,created_at) VALUES (?,1,?,?,?,?,?,?,?,?)`,
      [id, maker_id, model_family, model_variant, identity_mode, model_snapshot, capability_floor_json, actor, now]);
      db.run('UPDATE models SET current_identity_revision = 1, revision = revision + 1 WHERE id = ?', [id]);
      audit(db, actor, 'channel.identity.create', id, { identity_revision: 1 }, now);
      return op.complete(db, { status: 201, payload: identityView(id, { ...model, revision: model.revision + 1 },
        { identity_revision: 1, maker_id, model_family, model_variant, identity_mode, model_snapshot, capability_floor_json }) });
    });
  });
  app.post(`${modelPath}/pool/candidates/review`, async (c) => {
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const id = routeId(c.req.param('model_id'), 'model_id');
    const body = strictObject(await json(c), 'body', ['expected_identity_revision', 'reason', 'decisions']);
    const revision = int(body.expected_identity_revision, 'expected_identity_revision', 1);
    const reason = field(body.reason, 'reason', 500);
    if (!Array.isArray(body.decisions) || body.decisions.length < 1 || body.decisions.length > 32) invalid('decisions');
    const decisions = body.decisions.map((entry, i): Decision => {
      const path = `decisions[${i}]`;
      const fields = strictObject(entry, path, ['discovery_id', 'catalog_item_id', 'decision', 'capabilities']);
      const selected = enumField(fields.decision, `${path}.decision`, ['accept', 'reject']);
      return { discovery_id: routeId(fields.discovery_id, `${path}.discovery_id`), catalog_item_id: routeId(fields.catalog_item_id, `${path}.catalog_item_id`),
        decision: selected, capabilities: capabilities(fields.capabilities, `${path}.capabilities`) };
    });
    if (new Set(decisions.map(({ catalog_item_id }) => catalog_item_id)).size !== decisions.length) invalid('decisions');
    const op = operation(c, opts.codeSecret, at, actor, body);
    if (!op.key) invalid('Idempotency-Key');
    return store.system.write((db) => {
      requirePlatformAdmin(db, actor);
      const cached = replay(op, db);
      if (cached) return cached;
      const { model, identity } = modelIdentity(db, id);
      if (model.status !== 'active') throw conflict('model_inactive');
      if (!identity || identity.identity_revision !== revision) throw conflict('model_identity_changed', identity?.identity_revision ?? null);
      const when = iso(at);
      const items = decisions.map((decision) => reviewedCandidate(db, id, identity, decision, reason, actor, when));
      audit(db, actor, 'channel.candidates.review', id, { revision, count: items.length, fingerprint: digest(decisions) }, when);
      return op.complete(db, { status: 200, payload: { items } });
    });
  });
}
