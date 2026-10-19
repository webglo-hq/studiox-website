/** Administration: users and roles (SoD-checked), SoD rules, tenant settings and materiality. */
import { audit } from '../core/audit/audit';
import type { TenantSettings } from '../core/tenancy';
import { conflict, forbidden, notFound, sodViolation, validation } from '../core/util/errors';
import { secureToken } from '../core/util/random';
import type { MaterialitySettings } from '../packs/accounting/model/types';
import { ROLES } from '../packs/accounting/controls/permissions';
import { evaluateAssignment } from '../packs/accounting/controls/sod';
import { closeOntology } from '../packs/accounting/ontology';
import type { AppContext, RequestUser } from './context';
import { requirePermission } from './context';

export async function assignRoles(ctx: AppContext, u: RequestUser, userId: string, roleKeys: string[]) {
  requirePermission(u, 'admin.users');
  if (!Array.isArray(roleKeys) || roleKeys.some((k) => !ROLES.some((r) => r.key === k))) throw validation('Unknown role.');
  if (userId === u.actor.id) throw forbidden('You cannot change your own roles.');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const user = await tx.get('users', userId);
    if (!user) throw notFound('User', userId);
    const roles = await tx.find('roles', { key: { in: roleKeys } });
    const perms = new Set(roles.length ? (await tx.find('role_permissions', { role_id: { in: roles.map((r) => r.id) } })).map((p) => p.permission_id) : []);
    const conflicts = evaluateAssignment(await tx.find('sod_rules', { enabled: true }), roleKeys, perms);
    if (conflicts.length) throw sodViolation(conflicts.map((c) => `${c.code} ${c.name}: ${c.message}`).join(' '), { conflicts });
    for (const g of await tx.find('user_roles', { user_id: userId })) await tx.delete('user_roles', g.id);
    const now = ctx.clock.now().toISOString();
    for (const r of roles) await tx.insert('user_roles', { user_id: userId, role_id: r.id, scope_entity_id: null, granted_by: u.actor.id, granted_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'admin.roles.assign', subjectType: 'user', subjectId: userId, summary: `${user.display_name}: roles set to ${roleKeys.join(', ') || 'none'}`, data: { roles: roleKeys } }, u.ip);
    return { userId, roles: roleKeys };
  });
}

export async function setUserStatus(ctx: AppContext, u: RequestUser, userId: string, status: 'active' | 'disabled') {
  requirePermission(u, 'admin.users');
  if (userId === u.actor.id) throw forbidden('You cannot disable yourself.');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const user = await tx.get('users', userId);
    if (!user) throw notFound('User', userId);
    const now = ctx.clock.now().toISOString();
    await tx.update('users', userId, { status, failed_logins: 0, locked_until: null });
    if (status === 'disabled') for (const s of await tx.find('sessions', { user_id: userId, revoked_at: { isNull: true } })) await tx.update('sessions', s.id, { revoked_at: now, revoked_reason: 'account disabled' });
    await audit(tx, u.actor, ctx.clock, { action: `admin.user.${status === 'active' ? 'enable' : 'disable'}`, subjectType: 'user', subjectId: userId, summary: `${user.display_name} ${status === 'active' ? 'enabled' : 'disabled'}`, data: {} }, u.ip);
    return { userId, status };
  });
}

/** Invite a user; returns a one-time temporary password (delivered out of band in production). */
export async function inviteUser(ctx: AppContext, u: RequestUser, input: { email: string; name: string; title?: string; role: string }) {
  requirePermission(u, 'admin.users');
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw validation('Enter a valid email address.');
  if (!input.name || input.name.length > 120) throw validation('Enter a name.');
  const tempPassword = `${secureToken(12)}-Tmp`;
  const hash = await ctx.hasher.hash(tempPassword);
  return ctx.db.tx(u.tenantId, async (tx) => {
    if ((await ctx.db.system((sys) => sys.findGlobal('users', { email }))).length) throw conflict('A user with that email already exists.');
    const role = await tx.findOne('roles', { key: input.role });
    if (!role) throw validation('Unknown role.');
    const now = ctx.clock.now().toISOString();
    const user = await tx.insert('users', { email, display_name: input.name.trim(), title: input.title ?? null, password_hash: hash, status: 'active', kind: 'human', mfa_enabled: false, failed_logins: 0, locked_until: null, last_login_at: null, preferences: {}, created_at: now });
    await tx.insert('user_roles', { user_id: user.id, role_id: role.id, scope_entity_id: null, granted_by: u.actor.id, granted_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'admin.user.invite', subjectType: 'user', subjectId: user.id, summary: `Invited ${input.name} as ${role.name}`, data: { role: role.key } }, u.ip);
    return { userId: user.id, tempPassword };
  });
}

export async function setSodRule(ctx: AppContext, u: RequestUser, code: string, enabled: boolean, reason: string) {
  requirePermission(u, 'admin.sod');
  if (!reason || reason.trim().length < 10) throw validation('Changing a control needs a documented reason (at least 10 characters).');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const rule = await tx.findOne('sod_rules', { code });
    if (!rule) throw notFound('SoD rule', code);
    const updated = await tx.update('sod_rules', rule.id, { enabled, updated_by: u.actor.id, updated_at: ctx.clock.now().toISOString() });
    await audit(tx, u.actor, ctx.clock, { action: 'admin.sod.update', subjectType: 'sod_rule', subjectId: rule.id, summary: `${code} ${enabled ? 'enabled' : 'DISABLED'}: ${reason.trim()}`, data: { enabled } }, u.ip);
    return updated;
  });
}

export async function updateSettings(ctx: AppContext, u: RequestUser, patch: Pick<TenantSettings, 'mfaRequiredRoles' | 'sessionIdleMinutes' | 'sessionAbsoluteHours'>) {
  requirePermission(u, 'admin.settings');
  if (patch.sessionIdleMinutes !== undefined && (patch.sessionIdleMinutes < 5 || patch.sessionIdleMinutes > 240)) throw validation('Idle timeout must be 5–240 minutes.');
  if (patch.sessionAbsoluteHours !== undefined && (patch.sessionAbsoluteHours < 1 || patch.sessionAbsoluteHours > 24)) throw validation('Session lifetime must be 1–24 hours.');
  if (patch.mfaRequiredRoles && patch.mfaRequiredRoles.some((r) => !ROLES.some((x) => x.key === r))) throw validation('Unknown role.');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const t = (await tx.get('tenants', u.tenantId))!;
    const settings = { ...t.settings, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    await tx.update('tenants', t.id, { settings });
    await audit(tx, u.actor, ctx.clock, { action: 'admin.settings.update', subjectType: 'tenant', subjectId: t.id, summary: `Settings changed: ${Object.keys(patch).join(', ')}`, data: { patch } }, u.ip);
    return settings;
  });
}

export async function updateMateriality(ctx: AppContext, u: RequestUser, entityId: string, m: Partial<MaterialitySettings>) {
  requirePermission(u, 'admin.settings');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const e = await tx.get('entities', entityId);
    if (!e) throw notFound('Entity', entityId);
    const next = { ...e.materiality, ...m };
    const check = closeOntology().check('AX-MAT-01', { clearlyTrivialMinor: next.clearlyTrivialMinor, performanceMinor: next.performanceMinor, overallMinor: next.overallMinor });
    if (!check.passed) throw validation(`AX-MAT-01: ${check.messages.join('; ')}`);
    await tx.update('entities', e.id, { materiality: next });
    await audit(tx, u.actor, ctx.clock, { action: 'admin.materiality.update', subjectType: 'entity', subjectId: e.id, entityId: e.id, summary: `${e.code} materiality updated`, data: { before: e.materiality as unknown as Record<string, unknown>, after: next as unknown as Record<string, unknown> } }, u.ip);
    return next;
  });
}
