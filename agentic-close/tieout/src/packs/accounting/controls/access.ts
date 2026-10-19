/**
 * Approval authority and the two-person rule for access (COSO 2013 principle 10, SOX 404 access
 * provisioning). An administrator can give people access, but no single person can create an
 * approver: a grant that confers approval authority — or wider approval authority than the person
 * already has — waits for a second, different person whose own authority covers it. So does any
 * change to a segregation-of-duties rule.
 */
import { approvalLimit, roleDef, type Permission } from './permissions';

/** Permissions that approve work (journal entries, reconciliations, explanations, the close) or set the controls around it. */
export const APPROVAL_AUTHORITY: readonly Permission[] = ['je.approve', 'recon.review', 'flux.approve', 'close.signoff', 'close.package', 'close.lock', 'payment.approve', 'skill.autonomy.set', 'skill.policy.edit', 'access.approve'];

/** The approval-authority permissions a role carries. */
export function authorityOf(roleKey: string): Permission[] {
  const perms = new Set(roleDef(roleKey)?.permissions ?? []);
  return APPROVAL_AUTHORITY.filter((p) => perms.has(p));
}

export interface Grant {
  roleKey: string;
  /** a legal entity, or null for every entity */
  entityId: string | null;
}

/**
 * Roles in `after` that confer approval authority the person does not already hold for those
 * entities: a new approving role, or one widened to more entities. Narrowing access, removing a
 * role or granting a role without approval authority needs no second person.
 */
export function newAuthority(before: readonly Grant[], after: { roles: readonly string[]; entityIds: readonly string[] | null }): string[] {
  return after.roles.filter((role) => {
    if (!authorityOf(role).length) return false;
    const held = before.filter((g) => g.roleKey === role);
    if (held.some((g) => g.entityId === null)) return false; // already over every entity
    if (!held.length || after.entityIds === null) return true;
    return after.entityIds.some((e) => !held.some((g) => g.entityId === e));
  });
}

/**
 * Why `approver` may not approve a grant of these roles, or null when they may: they hold the
 * right to approve access, every approval permission the roles carry, and an approval limit at
 * least as high (a Controller cannot create a CFO).
 */
export function insufficientAuthority(approver: { permissions: ReadonlySet<string>; approvalLimitMinor: number | null }, roleKeys: readonly string[]): string | null {
  if (!approver.permissions.has('access.approve')) return 'Only a Controller or the CFO approves access and control changes.';
  const missing = [...new Set(roleKeys.flatMap(authorityOf))].filter((p) => !approver.permissions.has(p));
  if (missing.length) return 'This grant carries approval authority that you do not hold yourself.';
  const wanted = approvalLimit(roleKeys);
  const own = approver.approvalLimitMinor;
  if (own !== null && (wanted === null || wanted > own)) return 'This grant carries a higher approval limit than your own.';
  return null;
}
