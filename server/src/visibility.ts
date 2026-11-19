import { invalid } from './api';

const defaultGrant = { summary: true, content: false };
export const defaultVisibility = { admin: defaultGrant, group_admin: defaultGrant };

export function visibility(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('visibility');
  const grants = value as Record<string, unknown>;
  function grant(role: keyof typeof defaultVisibility) {
    const row = grants[role] ?? defaultGrant;
    if (!row || typeof row !== 'object' || !('summary' in row) || !('content' in row)
      || typeof row.summary !== 'boolean' || typeof row.content !== 'boolean') invalid(`visibility.${role}`);
    return { summary: row.summary, content: row.content };
  }
  return { admin: grant('admin'), group_admin: grant('group_admin') };
}
