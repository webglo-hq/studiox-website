import { AppError } from '../../../framework/util/errors';
import { audit, verifyAuditChain } from '../domain/audit';
import { requireAllEntities, requirePermission, withDb, type ServiceContext } from '../domain/context';
import { loadActor, PERMISSIONS, roleConflicts } from '../domain/rbac';
import { entities } from '../domain/refdata';
import { settings } from './common';

/** Users, roles, segregation-of-duties rules, close settings and the audit log. */

/** Entity codes a person's grants cover, or 'all' when any grant is tenant-wide (as loadActor reads them). */
export type EntityAccess = 'all' | string[];

export async function listUsers(ctx: ServiceContext) {
  requirePermission(ctx, 'admin.users');
  const users = await ctx.db.find('app_user', { tenant_id: ctx.tenantId }, { orderBy: [['display_name', 'asc']] });
  const grants = await ctx.db.find('user_role', { tenant_id: ctx.tenantId });
  const roles = new Map((await ctx.db.find('role', {})).map((r) => [r.id, r]));
  const ents = await entities(ctx);
  const out = [];
  for (const u of users) {
    const mine = grants.filter((g) => g.user_id === u.id);
    const access: EntityAccess = mine.some((g) => g.entity_id === null) ? 'all' : [...new Set(mine.map((g) => ents.get(g.entity_id!)?.code ?? ''))].sort();
    out.push({
      id: u.id,
      name: u.display_name,
      email: u.email,
      title: u.title,
      status: u.status,
      mfaEnabled: u.mfa_enabled,
      idp: u.idp,
      lastLoginAt: u.last_login_at,
      lockedUntil: u.locked_until,
      roles: [...new Set(mine.map((g) => roles.get(g.role_id)?.code ?? ''))],
      entities: access,
      conflicts: await roleConflicts(ctx.db, ctx.tenantId, u.id),
    });
  }
  return out;
}

export async function listRoles(ctx: ServiceContext) {
  requirePermission(ctx, 'close.view');
  const roles = await ctx.db.find('role', {}, { orderBy: [['rank', 'desc']] });
  const perms = await ctx.db.find('role_permission', {});
  return {
    roles: roles.map((r) => ({ id: r.id, code: r.code, name: r.name, description: r.description, permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission).sort() })),
    permissions: Object.entries(PERMISSIONS).map(([code, description]) => ({ code, description })),
  };
}

/**
 * Replace a user's roles and the entities they apply to: 'all' (tenant-wide) or a list of entity
 * codes. Leaving entities out keeps the user's current scope. Blocking SoD permission pairs are
 * refused; warnings are audited.
 */
export async function setUserRoles(ctx: ServiceContext, input: { userId: string; roles: string[]; entities?: EntityAccess }) {
  requirePermission(ctx, 'admin.users');
  const user = await ctx.db.get('app_user', input.userId);
  if (!user || user.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'User not found');
  if (input.userId === ctx.actor.userId) throw new AppError('SOD_VIOLATION', 'You cannot change your own roles.');
  const roles = await ctx.db.find('role', { code: { in: input.roles } });
  if (roles.length !== new Set(input.roles).size) throw new AppError('VALIDATION', 'Unknown role.');
  const ents = [...(await entities(ctx)).values()];
  const access = input.entities ?? (await listUsers(ctx)).find((u) => u.id === user.id)!.entities;
  if (access !== 'all' && !access.length) throw new AppError('VALIDATION', 'Choose at least one entity, or all entities.');
  const scope = access === 'all' ? [null] : access.map((code) => ents.find((e) => e.code === code)?.id);
  if (scope.some((id) => id === undefined)) throw new AppError('VALIDATION', 'Unknown entity.');
  const perms = new Set((await ctx.db.find('role_permission', { role_id: { in: roles.map((r) => r.id) } })).map((p) => p.permission));
  const rules = await ctx.db.find('sod_rule', { tenant_id: ctx.tenantId, enabled: true, kind: 'permission_pair' });
  const hits = rules.filter((r) => r.permission_a && r.permission_b && perms.has(r.permission_a) && perms.has(r.permission_b));
  const blocking = hits.filter((h) => h.severity === 'block');
  if (blocking.length) throw new AppError('SOD_VIOLATION', `These roles together break ${blocking.map((b) => `${b.code} (${b.name})`).join(', ')}.`, { rules: blocking.map((b) => b.code) });
  await ctx.db.tx(async (db) => {
    const existing = await db.find('user_role', { user_id: user.id });
    for (const g of existing) await db.delete('user_role', g.id);
    // One grant per role and entity; a tenant-wide grant has no entity (rbac.ts loadActor).
    for (const r of roles) for (const entityId of new Set(scope)) await db.insert('user_role', { tenant_id: ctx.tenantId, user_id: user.id, role_id: r.id, entity_id: entityId ?? null, granted_by: ctx.actor.userId });
    await audit(withDb(ctx, db), { action: 'admin.roles.changed', subjectType: 'app_user', subjectId: user.id, data: { roles: input.roles, entities: access, warnings: hits.map((h) => h.code) } });
  });
  // Revoke sessions so new permissions apply immediately.
  await ctx.db.updateWhere('session', { user_id: user.id, revoked_at: { isNull: true } }, { revoked_at: ctx.clock.nowIso() });
  return (await listUsers(ctx)).find((u) => u.id === user.id);
}

export async function setUserStatus(ctx: ServiceContext, input: { userId: string; status: 'active' | 'disabled' }) {
  requirePermission(ctx, 'admin.users');
  if (input.userId === ctx.actor.userId) throw new AppError('SOD_VIOLATION', 'You cannot disable yourself.');
  const user = await ctx.db.get('app_user', input.userId);
  if (!user || user.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'User not found');
  await ctx.db.update('app_user', user.id, { status: input.status });
  if (input.status === 'disabled') await ctx.db.updateWhere('session', { user_id: user.id, revoked_at: { isNull: true } }, { revoked_at: ctx.clock.nowIso() });
  await audit(ctx, { action: `admin.user.${input.status}`, subjectType: 'app_user', subjectId: user.id, data: { email: user.email } });
}

export async function listSodRules(ctx: ServiceContext) {
  requirePermission(ctx, 'close.view');
  return ctx.db.find('sod_rule', { tenant_id: ctx.tenantId }, { orderBy: [['code', 'asc']] });
}

export async function setSodRule(ctx: ServiceContext, input: { code: string; enabled: boolean; note: string }) {
  requirePermission(ctx, 'admin.sod');
  const r = await ctx.db.findOne('sod_rule', { tenant_id: ctx.tenantId, code: input.code });
  if (!r) throw new AppError('NOT_FOUND', 'Rule not found');
  if (!input.note || input.note.trim().length < 5) throw new AppError('VALIDATION', 'Explain the change (at least 5 characters).');
  if (!input.enabled && ['SOD-01', 'SOD-02', 'SOD-05'].includes(r.code)) throw new AppError('FORBIDDEN', `${r.code} is a core maker-checker control and cannot be disabled.`);
  await ctx.db.update('sod_rule', r.id, { enabled: input.enabled });
  await audit(ctx, { action: 'admin.sod.changed', subjectType: 'sod_rule', subjectId: r.code, data: { enabled: input.enabled, note: input.note.trim() } });
}

export async function closeSettings(ctx: ServiceContext) {
  requirePermission(ctx, 'close.view');
  return settings(ctx);
}

export async function updateCloseSettings(ctx: ServiceContext, input: { materiality?: { overall: number; performance: number; clearlyTrivial: number }; capitalizationThreshold?: number; prepaidThreshold?: number; autoContinue?: boolean; note: string }) {
  requirePermission(ctx, 'period.lock');
  requireAllEntities(ctx, 'Close settings');
  if (!input.note || input.note.trim().length < 5) throw new AppError('VALIDATION', 'Explain the change (at least 5 characters).');
  if (input.materiality) {
    const m = input.materiality;
    if (!(0 < m.clearlyTrivial && m.clearlyTrivial < m.performance && m.performance <= m.overall)) throw new AppError('ONTOLOGY_VIOLATION', 'AX-MAT-01: clearly trivial < performance materiality ≤ overall materiality.');
  }
  const t = (await ctx.db.get('tenant', ctx.tenantId))!;
  const next = { ...(t.settings ?? {}), ...(input.materiality ? { materiality: input.materiality } : {}), ...(input.capitalizationThreshold !== undefined ? { capitalizationThreshold: input.capitalizationThreshold } : {}), ...(input.prepaidThreshold !== undefined ? { prepaidThreshold: input.prepaidThreshold } : {}), ...(input.autoContinue !== undefined ? { autoContinue: input.autoContinue } : {}) };
  await ctx.db.update('tenant', t.id, { settings: next });
  await audit(ctx, { action: 'settings.changed', subjectType: 'tenant', subjectId: t.id, data: { before: t.settings, after: next, note: input.note.trim() } });
  ctx.cache.delete('settings');
  return settings(ctx);
}

export async function listAudit(ctx: ServiceContext, f: { action?: string; subjectId?: string; actorType?: string; q?: string; beforeSeq?: number; limit?: number }) {
  requirePermission(ctx, 'audit.view');
  requireAllEntities(ctx, 'The audit log');
  const where: Record<string, unknown> = { tenant_id: ctx.tenantId };
  if (f.action) where.action = { contains: f.action };
  if (f.subjectId) where.subject_id = f.subjectId;
  if (f.actorType) where.actor_type = f.actorType;
  if (f.beforeSeq) where.seq = { lt: f.beforeSeq };
  let rows = await ctx.db.find('audit_log', where as never, { orderBy: [['seq', 'desc']], limit: f.q ? 2000 : Math.min(500, f.limit ?? 100) });
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((r) => `${r.action} ${r.actor_label ?? ''} ${r.subject_type ?? ''} ${JSON.stringify(r.data)}`.toLowerCase().includes(q)).slice(0, Math.min(500, f.limit ?? 100));
  }
  const total = await ctx.db.count('audit_log', { tenant_id: ctx.tenantId });
  return { total, items: rows.map((r) => ({ seq: r.seq, at: r.occurred_at, actorType: r.actor_type, actor: r.actor_label, actorId: r.actor_id, action: r.action, subjectType: r.subject_type, subjectId: r.subject_id, data: r.data, hash: r.hash, prevHash: r.prev_hash })) };
}

export async function verifyAudit(ctx: ServiceContext) {
  requirePermission(ctx, 'audit.view');
  requireAllEntities(ctx, 'The audit log');
  return verifyAuditChain(ctx.db, ctx.tenantId);
}

export async function whoAmI(ctx: ServiceContext) {
  if (!ctx.actor.userId) throw new AppError('UNAUTHENTICATED', 'Not signed in');
  const a = await loadActor(ctx.db, ctx.tenantId, ctx.actor.userId);
  const u = (await ctx.db.get('app_user', ctx.actor.userId))!;
  const t = (await ctx.db.get('tenant', ctx.tenantId))!;
  return { id: u.id, name: u.display_name, email: u.email, title: u.title, roles: a.roles, permissions: [...a.permissions].sort(), mfaEnabled: u.mfa_enabled, tenant: { name: t.name, slug: t.slug, timezone: t.timezone, reportingCurrency: t.reporting_currency } };
}
