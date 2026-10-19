/**
 * Access requests: the two-person rule for authority. A grant that gives someone approval
 * authority they did not have (packs/accounting/controls/access.ts), and any change to a
 * segregation-of-duties rule, is recorded as a request and changes nothing until a second person
 * approves it — someone other than the requester and the person the access is for, whose own
 * authority covers what is granted. The database refuses those combinations as well
 * (migration 0012).
 */
import { audit } from '../core/audit/audit';
import { conflict, forbidden, notFound, sodViolation, validation } from '../core/util/errors';
import type { AccessChange } from '../packs/accounting/model/types';
import { insufficientAuthority } from '../packs/accounting/controls/access';
import { ROLES } from '../packs/accounting/controls/permissions';
import { evaluateAssignment } from '../packs/accounting/controls/sod';
import type { AccessRequestRow, DbTx } from '../schema';
import type { AppContext, RequestUser } from './context';
import { requirePermission } from './context';
import { send } from './outbox';

const roleName = (k: string) => ROLES.find((r) => r.key === k)?.name ?? k;

/** Set a person's roles, limited to some legal entities (or every entity): the change itself. */
export async function applyRoles(ctx: AppContext, tx: DbTx, by: RequestUser['actor'], userId: string, roleKeys: readonly string[], scope: readonly string[] | null, ip: string | null, via: string | null = null) {
  const user = await tx.get('users', userId);
  if (!user) throw notFound('User', userId);
  const ents = scope ? await tx.find('entities', { id: { in: [...scope] } }) : [];
  if (scope && (ents.length !== scope.length || ents.some((e) => e.kind !== 'legal'))) throw validation('Access can only be limited to legal entities.');
  const roles = roleKeys.length ? await tx.find('roles', { key: { in: [...roleKeys] } }) : [];
  const perms = new Set(roles.length ? (await tx.find('role_permissions', { role_id: { in: roles.map((r) => r.id) } })).map((p) => p.permission_id) : []);
  const conflicts = evaluateAssignment(await tx.find('sod_rules', { enabled: true }), [...roleKeys], perms);
  if (conflicts.length) throw sodViolation(conflicts.map((c) => `${c.code} ${c.name}: ${c.message}`).join(' '), { conflicts });
  for (const g of await tx.find('user_roles', { user_id: userId })) await tx.delete('user_roles', g.id);
  const now = ctx.clock.now().toISOString();
  for (const r of roles) for (const sid of scope ?? [null]) await tx.insert('user_roles', { user_id: userId, role_id: r.id, scope_entity_id: sid, granted_by: by.id, granted_at: now });
  const codes = scope ? ents.map((e) => e.code).sort() : null;
  await audit(tx, by, ctx.clock, { action: 'admin.roles.assign', subjectType: 'user', subjectId: userId, summary: `${user.display_name}: roles set to ${roleKeys.join(', ') || 'none'} for ${codes ? codes.join(', ') : 'all entities'}${via ? ` (${via})` : ''}`, data: { roles: [...roleKeys], entities: codes, accessRequest: via } }, ip);
  return { userId, roles: [...roleKeys], entityScope: codes };
}

/** Record a request; an older pending request for the same person (or the same rule) is replaced. */
export async function requestChange(ctx: AppContext, tx: DbTx, u: RequestUser, req: { subjectUserId: string | null; change: AccessChange; summary: string; reason: string }): Promise<AccessRequestRow> {
  const now = ctx.clock.now().toISOString();
  const pending = await tx.find('access_requests', { kind: req.change.kind, status: 'pending' });
  for (const p of pending) {
    const same = req.change.kind === 'role_grant' ? p.subject_user_id === req.subjectUserId : (p.change as { code?: string }).code === (req.change as { code: string }).code;
    if (same) await tx.update('access_requests', p.id, { status: 'superseded', decided_at: now, decision_note: 'Replaced by a newer request' });
  }
  const n = await tx.nextCounter('access_request');
  const row = await tx.insert('access_requests', { ref: `AR-${String(n).padStart(4, '0')}`, kind: req.change.kind, subject_user_id: req.subjectUserId, change: req.change, summary: req.summary.slice(0, 300), reason: req.reason.slice(0, 1000), requested_by: u.actor.id, requested_at: now, status: 'pending', decided_by: null, decided_at: null, decision_note: null });
  await audit(tx, u.actor, ctx.clock, { action: 'access.request', subjectType: 'access_request', subjectId: row.id, summary: `${row.ref} requested: ${row.summary} — waits for a second person to approve`, data: { change: req.change as unknown as Record<string, unknown>, reason: req.reason } }, u.ip);
  // tell the people who can approve it (through the outbox, like every message to a person)
  const approvers = await approversOf(tx, row);
  for (const a of approvers) await send(ctx, tx, { toUserId: a.id, to: a.email, kind: 'access_request', subject: `Approve access: ${row.summary}`.slice(0, 300), text: `${u.actor.label} asks for a change that needs a second person: ${row.summary}.\nReason: ${req.reason}\n\nApprove or reject it in Tieout under Admin → Access requests (${row.ref}).` });
  return row;
}

/** Everyone who could approve the request (for notification); the rules are applied again on approval. */
async function approversOf(tx: DbTx, r: AccessRequestRow) {
  const out: { id: string; email: string }[] = [];
  for (const user of await tx.find('users', { status: 'active', kind: 'human' })) {
    if (user.id === r.requested_by || user.id === r.subject_user_id) continue;
    const grants = await tx.find('user_roles', { user_id: user.id });
    const keys = (await tx.find('roles', { id: { in: grants.map((g) => g.role_id) } })).map((x) => x.key);
    const perms = new Set(ROLES.filter((x) => keys.includes(x.key)).flatMap((x) => x.permissions));
    const limit = ROLES.filter((x) => keys.includes(x.key)).reduce<number | null>((m, x) => (m === null || x.approvalLimitMinor === null ? null : Math.max(m, x.approvalLimitMinor)), 0);
    const roles = r.change.kind === 'role_grant' ? r.change.roles : [];
    if (keys.length && !insufficientAuthority({ permissions: perms, approvalLimitMinor: limit }, roles) && grants.every((g) => g.scope_entity_id === null)) out.push({ id: user.id, email: user.email });
  }
  return out;
}

/** Why this person cannot decide the request (empty: they can). */
export function cannotDecide(u: RequestUser, r: AccessRequestRow): string[] {
  const out: string[] = [];
  if (r.status !== 'pending') out.push(`It is already ${r.status}.`);
  if (r.requested_by === u.actor.id) out.push('You asked for this change, so someone else has to decide it.');
  if (r.subject_user_id === u.actor.id) out.push('Nobody decides on their own access.');
  const authority = insufficientAuthority(u.actor, r.change.kind === 'role_grant' ? r.change.roles : []);
  if (authority) out.push(authority);
  if (u.actor.entityScope) out.push('Access changes are decided by someone with access to every entity.');
  return out;
}

export async function listAccessRequests(ctx: AppContext, u: RequestUser) {
  const canSee = ['admin.users', 'admin.sod', 'access.approve'].some((p) => u.actor.permissions.has(p));
  if (!canSee) throw forbidden('Access requests are for administrators and the people who approve access.');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const users = new Map((await tx.find('users', {})).map((x) => [x.id, x.display_name]));
    const rows = await tx.find('access_requests', {}, { orderBy: [['requested_at', 'desc']], limit: 50 });
    return {
      items: rows.map((r) => {
        const blocked = cannotDecide(u, r);
        return { id: r.id, ref: r.ref, kind: r.kind, summary: r.summary, reason: r.reason, subject: r.subject_user_id ? (users.get(r.subject_user_id) ?? null) : null, requestedBy: users.get(r.requested_by) ?? r.requested_by, requestedAt: r.requested_at, status: r.status, decidedBy: r.decided_by ? (users.get(r.decided_by) ?? r.decided_by) : null, decidedAt: r.decided_at, note: r.decision_note, canDecide: blocked.length === 0, blockedBy: blocked, canCancel: r.status === 'pending' && r.requested_by === u.actor.id };
      }),
    };
  });
}

/** A second person approves: the change takes effect now, in their name and the requester's. */
export async function approveAccessRequest(ctx: AppContext, u: RequestUser, id: string, note = '') {
  requirePermission(u, 'access.approve');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const r = await tx.get('access_requests', id);
    if (!r) throw notFound('Access request', id);
    const blocked = cannotDecide(u, r);
    if (blocked.length) throw (r.status !== 'pending' ? conflict(blocked.join(' ')) : sodViolation(blocked.join(' ')));
    const now = ctx.clock.now().toISOString();
    await tx.update('access_requests', r.id, { status: 'approved', decided_by: u.actor.id, decided_at: now, decision_note: note.trim().slice(0, 500) || null });
    const via = `${r.ref}, requested by ${(await tx.get('users', r.requested_by))?.display_name ?? r.requested_by}, approved by ${u.actor.label}`;
    if (r.change.kind === 'role_grant') {
      await applyRoles(ctx, tx, u.actor, r.subject_user_id!, r.change.roles, r.change.entityIds, u.ip, via);
    } else {
      const rule = await tx.findOne('sod_rules', { code: r.change.code });
      if (!rule) throw notFound('SoD rule', r.change.code);
      await tx.update('sod_rules', rule.id, { enabled: r.change.enabled, updated_by: u.actor.id, updated_at: now });
      await audit(tx, u.actor, ctx.clock, { action: 'admin.sod.update', subjectType: 'sod_rule', subjectId: rule.id, summary: `${rule.code} ${r.change.enabled ? 'enabled' : 'DISABLED'}: ${r.reason} (${via})`, data: { enabled: r.change.enabled, accessRequest: r.ref } }, u.ip);
    }
    await audit(tx, u.actor, ctx.clock, { action: 'access.approve', subjectType: 'access_request', subjectId: r.id, summary: `${r.ref} approved: ${r.summary}`, data: { note: note || null } }, u.ip);
    return { id: r.id, ref: r.ref, status: 'approved' as const };
  });
}

export async function rejectAccessRequest(ctx: AppContext, u: RequestUser, id: string, reason: string) {
  requirePermission(u, 'access.approve');
  if (!reason || reason.trim().length < 5) throw validation('Say briefly why you are rejecting it (at least 5 characters).');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const r = await tx.get('access_requests', id);
    if (!r) throw notFound('Access request', id);
    const blocked = cannotDecide(u, r);
    if (blocked.length) throw (r.status !== 'pending' ? conflict(blocked.join(' ')) : sodViolation(blocked.join(' ')));
    await tx.update('access_requests', r.id, { status: 'rejected', decided_by: u.actor.id, decided_at: ctx.clock.now().toISOString(), decision_note: reason.trim().slice(0, 500) });
    await audit(tx, u.actor, ctx.clock, { action: 'access.reject', subjectType: 'access_request', subjectId: r.id, summary: `${r.ref} rejected: ${r.summary} — ${reason.trim().slice(0, 140)}`, data: {} }, u.ip);
    return { id: r.id, ref: r.ref, status: 'rejected' as const };
  });
}

/** The requester withdraws a request nobody has decided yet. */
export async function cancelAccessRequest(ctx: AppContext, u: RequestUser, id: string) {
  return ctx.db.tx(u.tenantId, async (tx) => {
    const r = await tx.get('access_requests', id);
    if (!r) throw notFound('Access request', id);
    if (r.requested_by !== u.actor.id) throw forbidden('Only the person who asked for a change can withdraw it.');
    if (r.status !== 'pending') throw conflict(`It is already ${r.status}.`);
    await tx.update('access_requests', r.id, { status: 'cancelled', decided_at: ctx.clock.now().toISOString(), decision_note: 'Withdrawn by the requester' });
    await audit(tx, u.actor, ctx.clock, { action: 'access.cancel', subjectType: 'access_request', subjectId: r.id, summary: `${r.ref} withdrawn: ${r.summary}`, data: {} }, u.ip);
    return { id: r.id, ref: r.ref, status: 'cancelled' as const };
  });
}

export const describeRoles = (roles: readonly string[], codes: readonly string[] | null) => `${roles.map(roleName).join(' + ') || 'no roles'} for ${codes ? codes.join(', ') : 'every entity'}`;
