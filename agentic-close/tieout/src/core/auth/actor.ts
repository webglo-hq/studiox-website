/** Resolve a user into an Actor: roles, effective permissions and entity scope (RBAC). */
import type { Actor } from '../agent/types';
import { forbidden } from '../util/errors';
import type { DbTx } from '../../schema';

export interface UserActor extends Actor {
  approvalLimitMinor: number | null;
  email: string;
}

export async function resolveUserActor(tx: DbTx, userId: string): Promise<UserActor> {
  const u = await tx.get('users', userId);
  if (!u || u.status !== 'active') throw forbidden('This account is not active.');
  const grants = await tx.find('user_roles', { user_id: u.id });
  const roles = grants.length ? await tx.find('roles', { id: { in: grants.map((g) => g.role_id) } }) : [];
  const perms = roles.length ? await tx.find('role_permissions', { role_id: { in: roles.map((r) => r.id) } }) : [];
  const unscoped = grants.some((g) => g.scope_entity_id === null);
  let limit: number | null = 0;
  for (const r of roles) {
    if (r.approval_limit_minor === null) {
      limit = null;
      break;
    }
    if (r.approval_limit_minor > (limit ?? 0)) limit = r.approval_limit_minor;
  }
  return {
    type: 'user',
    id: u.id,
    label: u.display_name,
    email: u.email,
    onBehalfOf: null,
    permissions: new Set(perms.map((p) => p.permission_id)),
    roles: roles.map((r) => r.key),
    entityScope: unscoped ? null : [...new Set(grants.map((g) => g.scope_entity_id!).filter(Boolean))],
    approvalLimitMinor: limit,
  };
}
