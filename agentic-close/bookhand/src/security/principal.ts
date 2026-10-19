import type { Tx } from '../persistence/db';
import type { Row } from '../persistence/schema';
import { DomainError } from '../shared/errors';
import type { Permission } from './permissions';

/**
 * The authenticated person as the system sees them: roles, the union of their permissions, the highest
 * approval limit they hold and the entities they may see. Tenant scoping is implicit (every lookup is by
 * tenant); entity scoping comes from role grants limited to an entity.
 */
export interface Principal {
  user: Row<'users'>;
  tenantId: string;
  roles: Array<Row<'roles'> & { entityId: string | null }>;
  roleKeys: string[];
  permissions: Set<Permission>;
  /** null = unlimited. */
  approvalLimitMinor: number | null;
  readOnly: boolean;
  /** null = all entities. */
  entityIds: string[] | null;
}

export async function loadPrincipal(tx: Tx, tenantId: string, userId: string): Promise<Principal> {
  const user = await tx.get('users', userId);
  if (!user || user.tenant_id !== tenantId) throw new DomainError('UNAUTHENTICATED', 'Unknown user');
  const grants = await tx.find('user_roles', { user_id: userId });
  const roleRows = grants.length ? await tx.find('roles', { id: { in: grants.map((g) => g.role_id) } }) : [];
  const roles = grants.map((g) => ({ ...roleRows.find((r) => r.id === g.role_id)!, entityId: g.entity_id })).filter((r) => r.id);
  const permissions = new Set<Permission>(roles.flatMap((r) => (r.permissions as Permission[]) ?? []));
  let limit: number | null = 0;
  for (const r of roles) {
    if (r.approval_limit_minor === null) limit = null;
    else if (limit !== null) limit = Math.max(limit, r.approval_limit_minor);
  }
  const readOnly = roles.length > 0 && roles.every((r) => r.is_read_only);
  const entityIds = roles.some((r) => r.entityId === null) ? null : [...new Set(roles.map((r) => r.entityId!).filter(Boolean))];
  return { user, tenantId, roles, roleKeys: roles.map((r) => r.key), permissions, approvalLimitMinor: limit, readOnly, entityIds };
}

export function can(p: Principal, permission: Permission): boolean {
  return p.user.status === 'active' && p.permissions.has(permission);
}

export function requirePermission(p: Principal, permission: Permission, what?: string): void {
  if (!can(p, permission)) {
    throw new DomainError('FORBIDDEN', `${p.user.display_name} (${p.roleKeys.join(', ') || 'no role'}) is not allowed to ${what ?? permission}.`, { permission });
  }
}

export function canSeeEntity(p: Principal, entityId: string | null | undefined): boolean {
  return !entityId || p.entityIds === null || p.entityIds.includes(entityId);
}

export function withinLimit(p: Principal, amountMinor: number): boolean {
  return p.approvalLimitMinor === null || Math.abs(amountMinor) <= p.approvalLimitMinor;
}
