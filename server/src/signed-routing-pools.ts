import { invalid } from './api';
import { enumField, int } from './management';
import type { PolicyReader } from './policy-types';
import { routeId, strictObject } from './routing-http';
import { signatureSalesRates } from './sales-rate-snapshots';
import type { Store, Transaction } from './store';

export type SignedPool = { model_id: string; pool_revision: number; mode: 'pinned' | 'follow'; member_count: number; source_rate_key: string };

export function signatureRoutingPools(store: Store, rates: ReturnType<typeof signatureSalesRates>, input: unknown): SignedPool[] {
  const requested = new Map<string, { pool_revision: number; mode: SignedPool['mode'] }>();
  if (input !== undefined) {
    if (!Array.isArray(input) || input.length > 500) invalid('route_pools');
    for (const [index, value] of input.entries()) {
      const name = `route_pools.${index}`;
      const row = strictObject(value, name, ['model_id', 'pool_revision', 'mode']);
      const modelId = routeId(row.model_id, `${name}.model_id`);
      if (requested.has(modelId)) invalid(`${name}.model_id`);
      requested.set(modelId, { pool_revision: int(row.pool_revision, `${name}.pool_revision`, 1),
        mode: enumField(row.mode, `${name}.mode`, ['pinned','follow']) });
    }
  }

  const pools: SignedPool[] = [];
  for (const { model_id, source_rate_key } of rates) {
    if (!source_rate_key) continue;
    const reference = store.system.get<{ pool_revision: number; member_count: number }>(`SELECT p.pool_revision,
      (SELECT count(*) FROM model_pool_deployments m WHERE m.model_id=p.model_id AND m.pool_revision=p.pool_revision) member_count
      FROM platform_rate_versions r JOIN model_pool_revisions p ON p.model_id=r.model_id AND p.pool_revision=r.pool_revision
      WHERE r.source_rate_key=? AND r.model_id=?`, [source_rate_key, model_id]);
    const choice = requested.get(model_id);
    if (!reference?.member_count || (choice && choice.pool_revision !== reference.pool_revision)) invalid('route_pools');
    pools.push({ model_id, source_rate_key, ...reference, mode: choice?.mode ?? 'pinned' });
    requested.delete(model_id);
  }
  if (requested.size) invalid('route_pools');
  return pools;
}

export function writeSignedPools(sql: Transaction, revision: number, pools: SignedPool[]) {
  for (const pool of pools) sql.run(`INSERT INTO signed_routing_pools
    (platform_revision,model_id,pool_revision,mode,member_count,source_rate_key) VALUES (?,?,?,?,?,?)`,
    [revision, pool.model_id, pool.pool_revision, pool.mode, pool.member_count, pool.source_rate_key]);
}

export function readSignedPools(sql: PolicyReader, revision: number) {
  return sql.all<SignedPool>(`SELECT model_id,pool_revision,mode,member_count,source_rate_key
    FROM signed_routing_pools WHERE platform_revision=? ORDER BY model_id`, [revision]);
}
