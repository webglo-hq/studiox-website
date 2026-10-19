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

// ------------------------------------------------------------------ entity scope
//
// An object belongs to one entity (entity_id) or to the whole organization (null: consolidated reports, the
// close orchestrator, the close package, skill policies, the audit log). A grant limited to an entity covers that
// entity's objects only; whole-organization objects and actions need a grant for every entity.

const covers = (grant: { entityId: string | null }, entityId: string | null | undefined) => grant.entityId === null || (!!entityId && grant.entityId === entityId);

/** Whether `p` may see an object of `entityId` (null = a whole-organization object). */
export function canSeeEntity(p: Principal, entityId: string | null | undefined): boolean {
  return p.entityIds === null || (!!entityId && p.entityIds.includes(entityId));
}

/** The query condition limiting rows to the entities `p` sees (undefined = every entity). */
export function entityScope(p: Principal): { in: string[] } | undefined {
  return p.entityIds === null ? undefined : { in: p.entityIds };
}

/** Whether a grant holding `permission` covers `entityId` (null = the whole organization). */
export function canOn(p: Principal, permission: Permission, entityId: string | null | undefined): boolean {
  return p.user.status === 'active' && p.roles.some((r) => ((r.permissions as Permission[]) ?? []).includes(permission) && covers(r, entityId));
}

export function requirePermissionOn(p: Principal, permission: Permission, entityId: string | null | undefined, what?: string): void {
  requirePermission(p, permission, what);
  if (!canOn(p, permission, entityId)) {
    throw new DomainError('FORBIDDEN', entityId ? `${p.user.display_name} may ${what ?? permission} only for other entities, not this one.` : `${p.user.display_name} may ${what ?? permission} only for some entities; this covers the whole organization.`, { permission, entityId: entityId ?? null });
  }
}

/** Refuse whole-organization actions and views (consolidated reports, the close orchestrator, policies) to someone limited to some entities. */
export function requireAllEntities(p: Principal, what: string): void {
  if (p.entityIds !== null) throw new DomainError('FORBIDDEN', `${what} covers every entity; your access is limited to some.`);
}

/** The highest approval limit among the grants covering `entityId` (null = unlimited). */
export function approvalLimitOn(p: Principal, entityId: string | null | undefined): number | null {
  let limit = 0;
  for (const r of p.roles) {
    if (!covers(r, entityId)) continue;
    if (r.approval_limit_minor === null) return null;
    limit = Math.max(limit, r.approval_limit_minor);
  }
  return limit;
}

/** Within the approval limit; with an entity, only grants covering that entity count. */
export function withinLimit(p: Principal, amountMinor: number, entityId?: string | null): boolean {
  const limit = entityId === undefined ? p.approvalLimitMinor : approvalLimitOn(p, entityId);
  return limit === null || Math.abs(amountMinor) <= limit;
}
