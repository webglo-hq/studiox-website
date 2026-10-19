import { describe, expect, it } from 'vitest';
import type { Row } from '../persistence/schema';
import { ROLES } from './permissions';
import { approvalLimitOn, canOn, canSeeEntity, entityScope, type Principal, requireAllEntities, withinLimit } from './principal';

/** A principal from role grants (role key, entity or null for every entity), as loadPrincipal builds it. */
function principal(grants: Array<[string, string | null]>): Principal {
  const roles = grants.map(([key, entityId]) => {
    const r = ROLES.find((x) => x.key === key)!;
    return { id: key, key, name: r.name, description: r.description, permissions: r.permissions, approval_limit_minor: r.approvalLimitMinor, is_read_only: !!r.readOnly, sort_order: 0, entityId } as Row<'roles'> & { entityId: string | null };
  });
  const limits = roles.map((r) => r.approval_limit_minor);
  return {
    user: { id: 'u1', status: 'active', display_name: 'Pat' } as Row<'users'>,
    tenantId: 't1',
    roles,
    roleKeys: roles.map((r) => r.key),
    permissions: new Set(roles.flatMap((r) => r.permissions as never[])),
    approvalLimitMinor: limits.includes(null) ? null : Math.max(0, ...(limits as number[])),
    readOnly: false,
    entityIds: roles.some((r) => r.entityId === null) ? null : [...new Set(roles.map((r) => r.entityId!))],
  };
}

describe('entity scope of a principal (BH-M1)', () => {
  it('BH-M1: a grant for one entity covers that entity only, never whole-organization objects', () => {
    const uk = principal([['senior_accountant', 'UK']]);
    expect(canSeeEntity(uk, 'UK')).toBe(true);
    expect(canSeeEntity(uk, 'US')).toBe(false);
    expect(canSeeEntity(uk, null)).toBe(false);
    expect(entityScope(uk)).toEqual({ in: ['UK'] });
    expect(canOn(uk, 'je.approve', 'UK')).toBe(true);
    expect(canOn(uk, 'je.approve', 'US')).toBe(false);
    expect(canOn(uk, 'je.approve', null)).toBe(false);
    expect(() => requireAllEntities(uk, 'The consolidated trial balance')).toThrow(/covers every entity/);
  });

  it('BH-M1: authority and approval limits come from the grants that cover the entity', () => {
    const p = principal([['ap_clerk', null], ['controller', 'UK']]);
    expect(entityScope(p)).toBeUndefined();
    expect(canOn(p, 'je.approve', 'UK')).toBe(true);
    expect(canOn(p, 'je.approve', 'US')).toBe(false);
    expect(canOn(p, 'period.lock', null)).toBe(false);
    expect(approvalLimitOn(p, 'UK')).toBe(50_000_000);
    expect(approvalLimitOn(p, 'US')).toBe(250_000);
    expect(withinLimit(p, 1_500_000, 'UK')).toBe(true);
    expect(withinLimit(p, 1_500_000, 'US')).toBe(false);
    expect(withinLimit(p, 1_500_000, null)).toBe(false);
  });
});
