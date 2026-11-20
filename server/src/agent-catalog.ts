import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store';

export const AGENT_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export const agentDigest = /^[0-9a-f]{64}$/;
export const managedAgents = ['claude-code', 'codex', 'kimi-code'] as const;
export const releaseIdentity = ['id', 'agent', 'version', 'os', 'arch', 'sha256', 'size'] as const;

export type AgentPin = { id: string; agent: string; version: string; os: string; arch: string; sha256: string; size: number };
export type AgentRelease = AgentPin & { url: string; status: string; revision: number };
export type AgentPolicy = { allowed_agents_json: string; agent_release_pins_json: string; lease_budget_milli: number };

export function artifactPath(dataDir: string, sha256: string) {
  return join(dataDir, 'agent-artifacts', sha256);
}

export function hasArtifact(dataDir: string, release: Pick<AgentPin, 'sha256' | 'size'>) {
  if (!agentDigest.test(release.sha256) || release.size <= 0 || release.size > AGENT_ARTIFACT_MAX_BYTES) return false;
  const meta = lstatSync(artifactPath(dataDir, release.sha256), { throwIfNoEntry: false });
  return !!(meta?.isFile() && meta.size === release.size);
}

export function agentTarget(release: Pick<AgentPin, 'agent' | 'os' | 'arch'>) {
  return `${release.agent}/${release.os}/${release.arch}`;
}

export function matchesPin(release: AgentRelease, pin: AgentPin) {
  return releaseIdentity.every(key => release[key] === pin[key]);
}

export function artifactDownloadPath(id: string) { return `/v1/edge/agent-artifacts/${id}`; }

export function readAgentPolicy(db: Pick<Store['system'], 'get'>) {
  return db.get<AgentPolicy>(`SELECT allowed_agents_json, agent_release_pins_json, lease_budget_milli
    FROM contract ORDER BY revision DESC LIMIT 1`);
}

export function hasPinnedAgentTarget(policy: AgentPolicy | null, os: string, arch: string) {
  return !!policy && (JSON.parse(policy.agent_release_pins_json) as AgentPin[]).some(pin => pin.os === os && pin.arch === arch);
}

export function allowedAgentReleases(store: Store, dataDir: string, policy: AgentPolicy | null, os: string, arch: string, requireCache: boolean) {
  if (!policy || policy.lease_budget_milli <= 0) return [];
  const pins = new Map((JSON.parse(policy.agent_release_pins_json) as AgentPin[]).map(row => [agentTarget(row), row]));
  const rows = store.system.all<AgentRelease>(`SELECT * FROM agent_releases
    WHERE status = 'active' AND os = ? AND arch = ? AND agent IN (SELECT value FROM json_each(?))
    ORDER BY id`, [os, arch, policy.allowed_agents_json]);
  return rows.filter(row => {
    const pin = pins.get(agentTarget(row));
    if (pin && !matchesPin(row, pin)) return false;
    return (requireCache || pin) ? hasArtifact(dataDir, row) : true;
  });
}

const sourceHosts: Record<string, string> = {
  'claude-code': 'downloads.claude.ai',
  codex: 'releases.openai.com',
  'kimi-code': 'code.kimi.com',
};

export function officialArtifactSource(release: Pick<AgentRelease, 'agent' | 'url'>) {
  const url = URL.parse(release.url);
  return url && url.protocol === 'https:' && url.hostname === sourceHosts[release.agent]
    && !url.username && !url.password && !url.port && !url.search && !url.hash ? url : null;
}
