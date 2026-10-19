/**
 * Administration: people (invite, roles with entity scope, disable, two-factor and password
 * resets), SoD rules, tenant settings and materiality. Every change is audited.
 */
import { audit } from '../core/audit/audit';
import type { TenantSettings } from '../core/tenancy';
import { conflict, forbidden, notFound, sodViolation, validation } from '../core/util/errors';
import { secureToken } from '../core/util/random';
import type { MaterialitySettings } from '../packs/accounting/model/types';
import { ROLES } from '../packs/accounting/controls/permissions';
import { evaluateAssignment } from '../packs/accounting/controls/sod';
import { closeOntology } from '../packs/accounting/ontology';
import type { DbTx } from '../schema';
import type { AppContext, RequestUser } from './context';
import { requirePermission } from './context';

/** An administrator limited to some entities manages only people whose access lies within them. */
async function assertCanManage(tx: DbTx, u: RequestUser, userId: string) {
  if (!u.actor.entityScope) return;
  const grants = await tx.find('user_roles', { user_id: userId });
  if (grants.some((g) => g.scope_entity_id === null || !u.actor.entityScope!.includes(g.scope_entity_id)))
    throw forbidden('This person has access beyond your entities, so an administrator with access to every entity has to make this change.');
}

async function revokeSessions(tx: DbTx, userId: string, now: string, reason: string) {
  for (const s of await tx.find('sessions', { user_id: userId, revoked_at: { isNull: true } })) await tx.update('sessions', s.id, { revoked_at: now, revoked_reason: reason });
}

/**
 * Set a person's roles and, optionally, the legal entities those roles apply to (entity scope).
 * No entities (or an empty list) means every entity. An administrator who is limited to some
 * entities can only grant access within them.
 */
export async function assignRoles(ctx: AppContext, u: RequestUser, userId: string, roleKeys: string[], entityIds: string[] | null = null) {
  requirePermission(u, 'admin.users');
  if (!Array.isArray(roleKeys) || roleKeys.some((k) => !ROLES.some((r) => r.key === k))) throw validation('Unknown role.');
  if (entityIds !== null && (!Array.isArray(entityIds) || entityIds.length > 50 || entityIds.some((e) => typeof e !== 'string'))) throw validation('Choose the entities this person may work on.');
  if (userId === u.actor.id) throw forbidden('You cannot change your own roles.');
  const scope = entityIds?.length ? [...new Set(entityIds)] : null;
  if (u.actor.entityScope && (!scope || scope.some((e) => !u.actor.entityScope!.includes(e)))) throw forbidden('You can only grant access to entities you have access to yourself.');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const user = await tx.get('users', userId);
    if (!user) throw notFound('User', userId);
    await assertCanManage(tx, u, userId);
    const ents = scope ? await tx.find('entities', { id: { in: scope } }) : [];
    if (scope && (ents.length !== scope.length || ents.some((e) => e.kind !== 'legal'))) throw validation('Access can only be limited to legal entities.');
    const roles = await tx.find('roles', { key: { in: roleKeys } });
    const perms = new Set(roles.length ? (await tx.find('role_permissions', { role_id: { in: roles.map((r) => r.id) } })).map((p) => p.permission_id) : []);
    const conflicts = evaluateAssignment(await tx.find('sod_rules', { enabled: true }), roleKeys, perms);
    if (conflicts.length) throw sodViolation(conflicts.map((c) => `${c.code} ${c.name}: ${c.message}`).join(' '), { conflicts });
    for (const g of await tx.find('user_roles', { user_id: userId })) await tx.delete('user_roles', g.id);
    const now = ctx.clock.now().toISOString();
    for (const r of roles) for (const sid of scope ?? [null]) await tx.insert('user_roles', { user_id: userId, role_id: r.id, scope_entity_id: sid, granted_by: u.actor.id, granted_at: now });
    const codes = scope ? ents.map((e) => e.code).sort() : null;
    await audit(tx, u.actor, ctx.clock, { action: 'admin.roles.assign', subjectType: 'user', subjectId: userId, summary: `${user.display_name}: roles set to ${roleKeys.join(', ') || 'none'} for ${codes ? codes.join(', ') : 'all entities'}`, data: { roles: roleKeys, entities: codes } }, u.ip);
    return { userId, roles: roleKeys, entityScope: codes };
  });
}

export async function setUserStatus(ctx: AppContext, u: RequestUser, userId: string, status: 'active' | 'disabled', reason = '') {
  requirePermission(u, 'admin.users');
  if (userId === u.actor.id) throw forbidden('You cannot disable yourself.');
  if (status === 'disabled' && reason.trim().length < 5) throw validation('Say briefly why the account is being disabled (at least 5 characters); it is recorded in the audit log.');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const user = await tx.get('users', userId);
    if (!user) throw notFound('User', userId);
    await assertCanManage(tx, u, userId);
    const now = ctx.clock.now().toISOString();
    await tx.update('users', userId, { status, failed_logins: 0, locked_until: null });
    if (status === 'disabled') await revokeSessions(tx, userId, now, 'account disabled');
    await audit(tx, u.actor, ctx.clock, { action: `admin.user.${status === 'active' ? 'enable' : 'disable'}`, subjectType: 'user', subjectId: userId, summary: `${user.display_name} ${status === 'active' ? 'enabled' : `disabled: ${reason.trim().slice(0, 200)}`}`, data: {} }, u.ip);
    return { userId, status };
  });
}

/**
 * Lost authenticator: clear a person's two-factor setup and recovery codes with a documented
 * reason, and sign them out everywhere. They set it up again at their next sign-in (or under My
 * account); roles that require two-factor are asked to enrol before anything else.
 */
export async function resetMfa(ctx: AppContext, u: RequestUser, userId: string, reason: string) {
  requirePermission(u, 'admin.users');
  if (userId === u.actor.id) throw forbidden('Another administrator has to reset your own two-factor authentication.');
  if (!reason || reason.trim().length < 10) throw validation('Resetting two-factor authentication needs a documented reason (at least 10 characters).');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const user = await tx.get('users', userId);
    if (!user) throw notFound('User', userId);
    await assertCanManage(tx, u, userId);
    const now = ctx.clock.now().toISOString();
    for (const f of await tx.find('mfa_factors', { user_id: userId })) if (f.status !== 'revoked') await tx.update('mfa_factors', f.id, { status: 'revoked' });
    for (const r of await tx.find('mfa_recovery_codes', { user_id: userId })) await tx.delete('mfa_recovery_codes', r.id);
    await tx.update('users', userId, { mfa_enabled: false });
    await revokeSessions(tx, userId, now, 'two-factor reset by an administrator');
    await audit(tx, u.actor, ctx.clock, { action: 'admin.user.mfa_reset', subjectType: 'user', subjectId: userId, summary: `${user.display_name}: two-factor authentication reset: ${reason.trim().slice(0, 200)}`, data: {} }, u.ip);
    return { userId, mfa: false };
  });
}

/** Issue a one-time temporary password (delivered out of band) and sign the person out everywhere. */
export async function resetPassword(ctx: AppContext, u: RequestUser, userId: string) {
  requirePermission(u, 'admin.users');
  if (userId === u.actor.id) throw forbidden('Change your own password under My account.');
  const tempPassword = `${secureToken(12)}-Tmp`;
  const hash = await ctx.hasher.hash(tempPassword);
  return ctx.db.tx(u.tenantId, async (tx) => {
    const user = await tx.get('users', userId);
    if (!user) throw notFound('User', userId);
    await assertCanManage(tx, u, userId);
    const now = ctx.clock.now().toISOString();
    await tx.update('users', userId, { password_hash: hash, failed_logins: 0, locked_until: null, must_change_password: true });
    await revokeSessions(tx, userId, now, 'password reset by an administrator');
    // a forgotten (or exposed) password also retires the person's API tokens
    for (const t of await tx.find('api_tokens', { user_id: userId, revoked_at: { isNull: true } })) await tx.update('api_tokens', t.id, { revoked_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'admin.user.password_reset', subjectType: 'user', subjectId: userId, summary: `${user.display_name}: temporary password issued; signed out everywhere`, data: {} }, u.ip);
    return { userId, tempPassword };
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
  // emails are unique across tenants (sign-in looks them up globally; the column is UNIQUE too).
  // Checked before the tenant transaction: a store that serialises transactions cannot nest them.
  if ((await ctx.db.system((sys) => sys.findGlobal('users', { email }))).length) throw conflict('A user with that email already exists.');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const role = await tx.findOne('roles', { key: input.role });
    if (!role) throw validation('Unknown role.');
    const now = ctx.clock.now().toISOString();
    const user = await tx.insert('users', { email, display_name: input.name.trim(), title: input.title ?? null, password_hash: hash, status: 'active', kind: 'human', mfa_enabled: false, failed_logins: 0, locked_until: null, last_login_at: null, preferences: {}, created_at: now, must_change_password: true });
    // an administrator limited to some entities invites people with the same limit (never wider)
    for (const sid of u.actor.entityScope ?? [null]) await tx.insert('user_roles', { user_id: user.id, role_id: role.id, scope_entity_id: sid, granted_by: u.actor.id, granted_at: now });
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

export async function updateSettings(ctx: AppContext, u: RequestUser, input: Pick<TenantSettings, 'mfaRequiredRoles' | 'sessionIdleMinutes' | 'sessionAbsoluteHours'>) {
  requirePermission(u, 'admin.settings');
  // Whitelist the editable keys (the scenario clock, active period etc. are not editable here).
  const patch: Pick<TenantSettings, 'mfaRequiredRoles' | 'sessionIdleMinutes' | 'sessionAbsoluteHours'> = {};
  if (input.mfaRequiredRoles !== undefined) patch.mfaRequiredRoles = Array.isArray(input.mfaRequiredRoles) ? input.mfaRequiredRoles.map(String) : [];
  if (input.sessionIdleMinutes !== undefined) patch.sessionIdleMinutes = Math.round(Number(input.sessionIdleMinutes));
  if (input.sessionAbsoluteHours !== undefined) patch.sessionAbsoluteHours = Math.round(Number(input.sessionAbsoluteHours));
  if (patch.sessionIdleMinutes !== undefined && !(patch.sessionIdleMinutes >= 5 && patch.sessionIdleMinutes <= 240)) throw validation('Idle timeout must be 5–240 minutes.');
  if (patch.sessionAbsoluteHours !== undefined && !(patch.sessionAbsoluteHours >= 1 && patch.sessionAbsoluteHours <= 24)) throw validation('Session lifetime must be 1–24 hours.');
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
    // Whitelist: only the numeric thresholds and the rationale can change (no mass assignment).
    const patch: Partial<MaterialitySettings> = {};
    for (const k of ['overallMinor', 'performanceMinor', 'clearlyTrivialMinor', 'fluxAbsMinor'] as const) {
      if (m[k] === undefined) continue;
      const v = Number(m[k]);
      if (!Number.isSafeInteger(v) || v < 0) throw validation(`${k} must be a whole, non-negative amount in minor units.`);
      patch[k] = v;
    }
    if (m.fluxPct !== undefined) {
      const v = Number(m.fluxPct);
      if (!(v > 0 && v <= 1)) throw validation('fluxPct must be between 0 and 1.');
      patch.fluxPct = v;
    }
    if (m.rationale !== undefined) patch.rationale = String(m.rationale).slice(0, 2000);
    const next = { ...e.materiality, ...patch };
    const check = closeOntology().check('AX-MAT-01', { clearlyTrivialMinor: next.clearlyTrivialMinor, performanceMinor: next.performanceMinor, overallMinor: next.overallMinor });
    if (!check.passed) throw validation(`AX-MAT-01: ${check.messages.join('; ')}`);
    await tx.update('entities', e.id, { materiality: next });
    await audit(tx, u.actor, ctx.clock, { action: 'admin.materiality.update', subjectType: 'entity', subjectId: e.id, entityId: e.id, summary: `${e.code} materiality updated`, data: { before: e.materiality as unknown as Record<string, unknown>, after: next as unknown as Record<string, unknown> } }, u.ip);
    return next;
  });
}
