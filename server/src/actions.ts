export const tenantCreateActions = ['create_member', 'create_group', 'create_invite'] as const;
export const platformCreateActions = ['create_tenant', 'create_provider', 'create_model', 'create_rate', 'create_agent_release', 'topup'] as const;

export function tenantActions(role: string) {
  if (role === 'owner') return [...tenantCreateActions, 'update_contract'];
  if (role === 'admin') return [...tenantCreateActions];
  return [];
}
