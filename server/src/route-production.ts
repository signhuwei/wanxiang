import { isIP } from 'node:net';
import { hasArtifact } from './agent-catalog';
import { readHead, readSignature } from './policy-data';
import { decryptProviderSecret } from './provider-secret';
import type { RoutingProjectionInputs } from './route-projection';
import { digest } from './routing-http';
import { readSignedPools } from './signed-routing-pools';
import type { Store } from './store';

export type RoutePoolDevice = { tenantId: string; deviceId: string };

export function configuredRoutePoolDevices(value: string | undefined): RoutePoolDevice[] {
  if (!value?.trim()) return [];
  const devices = new Map<string, RoutePoolDevice>();
  for (const entry of value.split(',')) {
    const match = /^(ten_[0-9A-HJKMNP-TV-Z]{26}):(dev_[0-9A-HJKMNP-TV-Z]{26})$/.exec(entry.trim());
    if (!match) throw new Error('ONEX_ROUTE_POOL_DEVICES must contain tenant ID and device ID pairs');
    const tenantId = match[1]!, deviceId = match[2]!;
    if (devices.has(deviceId)) throw new Error('ONEX_ROUTE_POOL_DEVICES includes a duplicate device');
    devices.set(deviceId, { tenantId, deviceId });
  }
  if (devices.size > 100) throw new Error('ONEX_ROUTE_POOL_DEVICES supports up to 100 devices');
  return [...devices.values()];
}

function publicHttpsOrigin(raw: string) {
  const url = URL.parse(raw);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  // DNS answers are validated and pinned at the Edge before any request leaves the device.
  if (isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /\.(?:localhost|local|internal)\.?$/.test(host)) return null;
  return url.origin;
}

type Source = { provider_id: string; revision: number; base_url: string; auth: string; protocol: string; credential_scope: string };

export function productionRouting(store: Store, dataDir: string, key: Uint8Array, devices: readonly RoutePoolDevice[]): RoutingProjectionInputs {
  const cohort = new Map(devices.map(({ tenantId, deviceId }) => [deviceId, tenantId]));
  return {
    productionExecution: true, leaseGate: true,
    selectRoutePool: (tenant, device) => cohort.get(device) === tenant,
    grants(tenant) {
      if (!devices.some(device => device.tenantId === tenant)) return [];
      const db = store.tenant(tenant);
      const head = readHead(db);
      const signature = head && readSignature(db, head.platform_revision);
      if (!signature) return [];
      const signedAccess = (name: string) => signature.entries.find(entry => entry.definition.binding?.adapter === name)?.signed_value;
      const releaseIds = signedAccess('access.releases');
      const models = signedAccess('access.models');
      const agents = signedAccess('access.agents');
      if (!Array.isArray(releaseIds) || !Array.isArray(models) || !Array.isArray(agents) || !agents.includes('codex')) return [];
      const releases = store.system.all<{ id: string; agent: string; os: string; arch: string; sha256: string; size: number }>(`SELECT id,agent,os,arch,sha256,size FROM agent_releases
        WHERE status='active' AND agent='codex' AND id IN (SELECT value FROM json_each(?)) ORDER BY id`, [JSON.stringify(releaseIds)]);
      const ready = releases.filter(release => hasArtifact(dataDir, release));
      return readSignedPools(db, signature.revision).flatMap(pool => {
        if (pool.mode !== 'pinned' || !models.includes(pool.model_id)) return [];
        return ready.map(release => ({ binding_id: `bnd_${digest([pool.model_id, release.id])}`, binding_revision: signature.revision,
          agent_release_id: release.id, model_id: pool.model_id, ingress_protocol: 'openai_responses', aliases: [pool.model_id],
          platform_revision: signature.revision, pool: { mode: 'pinned' as const, pool_revision: pool.pool_revision } }));
      });
    },
    productionCandidate(deployment, revision, sourceRate) {
      const quote = store.system.get(`SELECT 1 FROM platform_rate_channels c
        JOIN model_deployments d ON d.deployment_id=c.deployment_id AND d.current_revision=c.deployment_revision
        JOIN procurement_quotes q ON q.quote_id=c.quote_id AND q.quote_revision=c.quote_revision AND q.deployment_id=c.deployment_id
          AND q.deployment_revision=c.deployment_revision AND q.provider_id=d.provider_id AND q.account_id=d.account_id
        JOIN provider_accounts a ON a.account_id=q.account_id AND a.provider_id=q.provider_id
        JOIN channel_wallets w ON w.funding_id=coalesce(a.funding_id,a.account_id) AND w.currency=q.currency
        JOIN procurement_quote_items i ON i.quote_id=q.quote_id AND i.quote_revision=q.quote_revision AND i.dimension='input'
        JOIN procurement_quote_items o ON o.quote_id=q.quote_id AND o.quote_revision=q.quote_revision AND o.dimension='output'
        JOIN procurement_quote_items r ON r.quote_id=q.quote_id AND r.quote_revision=q.quote_revision AND r.dimension='cache_read'
        WHERE c.source_rate_key=? AND c.deployment_id=? AND c.deployment_revision=? AND c.reason_code IS NULL`, [sourceRate, deployment, revision]);
      return !!quote;
    },
    credentialRef(deployment, revision) {
      const row = store.system.get<Source>(`SELECT p.id provider_id,p.revision,p.base_url,coalesce(p.auth,'bearer') auth,p.protocol,
          s.credential_scope
        FROM model_deployment_revisions r JOIN model_deployments d ON d.deployment_id=r.deployment_id AND d.current_revision=r.deployment_revision
        JOIN provider_channel_defaults s ON s.provider_id=d.provider_id AND s.account_id=d.account_id AND s.endpoint_id=r.endpoint_id
        JOIN provider_endpoints e ON e.endpoint_id=r.endpoint_id AND e.current_revision=r.endpoint_revision AND e.status='active'
        JOIN provider_endpoint_revisions v ON v.endpoint_id=e.endpoint_id AND v.endpoint_revision=e.current_revision
        JOIN providers p ON p.id=d.provider_id AND p.status='active' AND p.base_url=v.base_url AND p.protocol=v.protocol
        WHERE r.deployment_id=? AND r.deployment_revision=? AND p.protocol='openai_responses' AND v.auth_adapter='bearer'
          AND coalesce(p.proxy,'none')='none'`, [deployment, revision]);
      if (!row || !matchesScope(row)) return null;
      return { credential_id: row.provider_id, credential_version: row.revision };
    },
    credentialMaterial(id, revision) {
      const row = store.system.get<Source & { secret_ciphertext: Uint8Array }>(`SELECT p.id provider_id,p.revision,p.base_url,coalesce(p.auth,'bearer') auth,p.protocol,
          s.credential_scope,p.secret_ciphertext FROM providers p JOIN provider_channel_defaults s ON s.provider_id=p.id
        WHERE p.id=? AND p.revision=? AND p.status='active' AND p.protocol='openai_responses' AND coalesce(p.proxy,'none')='none'`, [id, revision]);
      if (!row || !matchesScope(row)) return null;
      try {
        const plaintext = decryptProviderSecret(key, id, row.secret_ciphertext);
        if (!plaintext.length || plaintext.some(byte => byte < 0x21 || byte > 0x7e)) { plaintext.fill(0); return null; }
        return { purpose: 'inference', material_class: 'inference', plaintext, dispose: () => { plaintext.fill(0); } };
      } catch { return null; }
    },
  };
}

function matchesScope(row: Source) {
  const origin = publicHttpsOrigin(row.base_url);
  return origin && row.auth === 'bearer' && JSON.stringify([origin, row.protocol, row.auth]) === row.credential_scope;
}
