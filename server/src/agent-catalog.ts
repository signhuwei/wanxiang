import desktopBuilds from './desktop-qualifications.json';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store';

const CLI_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
const DESKTOP_AGENT_ARTIFACT_MAX_BYTES = 768 * 1024 * 1024;
export const DESKTOP_AGENT_PART_BYTES = 32 * 1024 * 1024;
export const agentDigest = /^[0-9a-f]{64}$/;
const cliAgents = ['claude-code', 'codex', 'kimi-code'] as const;
const desktopAgents = ['workbuddy', 'deepseek-desktop', 'claude-desktop', 'codex-desktop'] as const;
export const managedAgents = [...cliAgents, ...desktopAgents] as const;
export const requiresDesktopQualification = (agent: string) => (desktopAgents as readonly string[]).includes(agent);

export const agentArtifactMaxBytes = (agent: string) => requiresDesktopQualification(agent)
  ? DESKTOP_AGENT_ARTIFACT_MAX_BYTES : CLI_ARTIFACT_MAX_BYTES;

export function artifactFormat({ agent, os, arch }: { agent: string; os: string; arch: string }) {
  if (!requiresDesktopQualification(agent)) return 'executable';
  if (agent === 'claude-desktop' || agent === 'codex-desktop') {
    return os === 'darwin' && arch === 'arm64' ? 'dmg' : null;
  }
  if (os === 'win32' && arch === 'x64') return 'nsis';
  if (os === 'darwin' && (arch === 'arm64' || (arch === 'x64' && agent === 'workbuddy'))) return 'dmg';
  return null;
}
export function hasDesktopRuntime(agent: string, os: string, arch: string) {
  return desktopBuilds.some(build => build.qualified && build.agent === agent && build.os === os && build.arch === arch);
}

type ReleaseIdentity = Pick<AgentPin, 'agent' | 'version' | 'os' | 'arch' | 'sha256' | 'size'>;

function matchingBuild(release: ReleaseIdentity) {
  return desktopBuilds.find(build => build.qualified && build.agent === release.agent && build.version === release.version
    && build.os === release.os && build.arch === release.arch && build.size === release.size && build.sha256 === release.sha256);
}

export function runtimeArtifact(release: ReleaseIdentity) {
  const runtime = matchingBuild(release)?.runtime;
  return runtime ? { size: runtime.size, sha256: runtime.sha256 } : null;
}

export function qualifiedDesktopRelease(release: ReleaseIdentity) {
  return !!matchingBuild(release);
}

export const releaseIdentity = ['id', 'agent', 'version', 'os', 'arch', 'sha256', 'size'] as const;

export type AgentPin = { id: string; agent: string; version: string; os: string; arch: string; sha256: string; size: number };
export type AgentRelease = AgentPin & { url: string; status: string; revision: number };
export type AgentPolicy = { allowed_agents_json: string; agent_release_pins_json: string; release_ids_json?: string | null; lease_budget_milli: number };
export type DesktopCapabilities = { macDesktop?: boolean; codexDesktop?: boolean; claudeDesktop?: boolean };
export const allDesktopCapabilities: DesktopCapabilities = { macDesktop: true, codexDesktop: true, claudeDesktop: true };

export function artifactPath(dataDir: string, sha256: string) {
  return join(dataDir, 'agent-artifacts', sha256);
}

export function hasArtifact(dataDir: string, release: Pick<AgentPin, 'agent' | 'sha256' | 'size'>) {
  if (!agentDigest.test(release.sha256) || release.size <= 0 || release.size > agentArtifactMaxBytes(release.agent)) return false;
  const meta = lstatSync(artifactPath(dataDir, release.sha256), { throwIfNoEntry: false });
  return !!(meta?.isFile() && meta.size === release.size);
}

export function hasReleaseArtifacts(dataDir: string, release: ReleaseIdentity) {
  const runtime = runtimeArtifact(release);
  return hasArtifact(dataDir, release) && (!runtime || hasArtifact(dataDir, { ...runtime, agent: release.agent }));
}

export function agentTarget(release: Pick<AgentPin, 'agent' | 'os' | 'arch'>) {
  return `${release.agent}/${release.os}/${release.arch}`;
}

export function matchesPin(release: AgentRelease, pin: AgentPin) {
  return releaseIdentity.every(key => release[key] === pin[key]);
}

export function artifactDownloadPath(id: string) { return `/v1/edge/agent-artifacts/${id}`; }

export function hasPinnedAgentTarget(policy: AgentPolicy | null, os: string, arch: string) {
  return !!policy && (JSON.parse(policy.agent_release_pins_json) as AgentPin[]).some(pin => pin.os === os && pin.arch === arch);
}

export function allowedAgentReleases(store: Store, dataDir: string, policy: AgentPolicy | null, os: string, arch: string, requireCache: boolean,
  desktop: DesktopCapabilities = {}) {
  if (!policy || policy.lease_budget_milli <= 0) return [];
  const exact: Set<string> | null = policy.release_ids_json == null ? null : new Set(JSON.parse(policy.release_ids_json));
  const pins = new Map((JSON.parse(policy.agent_release_pins_json) as AgentPin[]).map(row => [agentTarget(row), row]));
  const rows = store.system.all<AgentRelease>(`SELECT * FROM agent_releases
    WHERE status = 'active' AND os = ? AND arch = ? AND agent IN (SELECT value FROM json_each(?))
    ORDER BY id`, [os, arch, policy.allowed_agents_json]);
  return rows.filter(row => {
    if (requiresDesktopQualification(row.agent) && (!desktop.macDesktop || !requireCache || !qualifiedDesktopRelease(row))) return false;
    if (row.agent === 'codex-desktop' && !desktop.codexDesktop) return false;
    if (row.agent === 'claude-desktop' && !desktop.claudeDesktop) return false;
    if (exact && !exact.has(row.id)) return false;
    const pin = pins.get(agentTarget(row));
    if (pin && !matchesPin(row, pin)) return false;
    return (requireCache || pin || exact) ? hasReleaseArtifacts(dataDir, row) : true;
  });
}

const sourceHosts: Record<string, string> = {
  'claude-code': 'downloads.claude.ai',
  'claude-desktop': 'downloads.claude.ai',
  'codex-desktop': 'persistent.oaistatic.com',
  codex: 'releases.openai.com',
  'kimi-code': 'code.kimi.com',
  workbuddy: 'download.codebuddy.cn',
  'deepseek-desktop': 'download.deepseek.com',
};

export function officialArtifactSource(release: Pick<AgentRelease, 'agent' | 'url'>) {
  const url = URL.parse(release.url);
  return url && url.protocol === 'https:' && url.hostname === sourceHosts[release.agent]
    && !url.username && !url.password && !url.port && !url.search && !url.hash
    && (release.agent !== 'claude-desktop' || /^\/releases\/darwin\/universal\/[0-9]+(?:\.[0-9]+)+\/Claude-[a-f0-9]+\.dmg$/.test(url.pathname))
    && (release.agent !== 'codex-desktop' || url.pathname === '/codex-app-prod/Codex.dmg')
    && (release.agent !== 'workbuddy' || url.pathname.startsWith('/workbuddy/saas/'))
    && (release.agent !== 'deepseek-desktop' || /^\/(dsh-desk|desktop)\//.test(url.pathname)) ? url : null;
}
