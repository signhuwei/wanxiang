import { agentTarget, hasReleaseArtifacts, releaseIdentity, qualifiedDesktopRelease, requiresDesktopQualification, type AgentPin, type AgentRelease } from './agent-catalog';
import { ApiError, field, invalid } from './api';
import type { Store, Transaction } from './store';
import { visibility } from './visibility';

export type Reader = Pick<Transaction, 'get'>;
export type Contract = {
  revision: number;
  seat_limit: number;
  allowed_agents_json: string;
  allowed_models_json: string;
  agent_release_pins_json: string;
  visibility_json: string;
  lease_minutes: number;
  lease_budget_milli: number;
  updated_by: string;
  updated_at: string;
  platform_revision: number;
  tenant_revision: number;
  quota_distribution: number;
};
export type Visibility = ReturnType<typeof visibility>;
export const legacyPolicyRetired = (sql: Reader) => !!sql.get('SELECT 1 FROM policy_legacy_retirement WHERE id = 1');
// A migrated flat row is a historical record. Only a v2 issue can restore an active projection.
export const readContract = (sql: Reader) => sql.get<Contract>(`SELECT * FROM contract WHERE
  EXISTS (SELECT 1 FROM policy_head WHERE id = 1) OR NOT EXISTS (SELECT 1 FROM policy_legacy_retirement WHERE id = 1)
  ORDER BY revision DESC LIMIT 1`);
export const quotaConfigurable = (sql: Reader) => (readContract(sql)?.quota_distribution ?? 0) !== 0;
export const readPins = (row: Contract | null): AgentPin[] => row ? JSON.parse(row.agent_release_pins_json) : [];

export function stringList(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length > 200) invalid(name);
  const items = value.map(item => field(item, name));
  if (new Set(items).size !== items.length) invalid(name);
  return items;
}

export function narrowVisibility(requested: Visibility, ceiling: Visibility): Visibility {
  const narrow = (key: keyof Visibility) => ({
    summary: requested[key].summary && ceiling[key].summary,
    content: requested[key].content && ceiling[key].content,
  });
  return { admin: narrow('admin'), group_admin: narrow('group_admin') };
}

export function validatePins(store: Store, dataDir: string, ids: string[], allowed: string[], previous: AgentPin[]) {
  const result = ids.map(id => {
    const saved = previous.find(pin => pin.id === id);
    if (saved && allowed.includes(saved.agent)) return saved;
    const release = store.system.get<AgentRelease>('SELECT * FROM agent_releases WHERE id = ?', [id]);
    if (!release || !allowed.includes(release.agent) || (requiresDesktopQualification(release.agent) && !qualifiedDesktopRelease(release))
      || release.status !== 'active' || !hasReleaseArtifacts(dataDir, release)) {
      throw new ApiError('invalid', { fields: ['agent_release_ids'], reason: 'artifact_unavailable', release_id: id });
    }
    return Object.fromEntries(releaseIdentity.map(key => [key, release[key]])) as AgentPin;
  });
  if (new Set(result.map(agentTarget)).size !== result.length) invalid('agent_release_ids');
  return result.sort((a, b) => agentTarget(a).localeCompare(agentTarget(b)));
}
