import { appendAudit, verifyAuditChain } from '../../audit/audit';
import { importDocument } from '../../integrations/importer';
import { ADAPTERS } from '../../integrations/adapters';
import type { Where } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import { closeOntology } from '../../packs/accounting/ontology';
import { toGraph } from '../../ontology/export';
import { authorityOf, PERMISSIONS, ROLES } from '../../security/permissions';
import { can, requirePermission, type Principal } from '../../security/principal';
import { revokeSession, revokeUserSessions } from '../../security/sessions';
import { DomainError } from '../../shared/errors';
import type { App, RequestMeta } from '../app';
import { changeRoles, everEnrolled, issueCredentialLink, requestSodChange, resolveGrants, type GrantInput } from './access';

/** Administration (users, roles, SoD rules, sessions), audit log, imports and the ontology explorer. */

export async function listUsers(app: App, p: Principal) {
  if (!can(p, 'admin.users') && !can(p, 'audit.view')) requirePermission(p, 'admin.users');
  return app.read(async (tx) => {
    const users = await tx.find('users', { tenant_id: p.tenantId }, { orderBy: [['display_name', 'asc']] });
    const grants = await tx.find('user_roles', { tenant_id: p.tenantId });
    const roles = new Map((await tx.find('roles', {})).map((r) => [r.id, r]));
    const entities = await tx.find('entities', { tenant_id: p.tenantId }, { orderBy: [['code', 'asc']] });
    const entityCode = new Map(entities.map((e) => [e.id, e.code]));
    const sessions = await tx.find('sessions', { tenant_id: p.tenantId });
    const pending = await tx.find('access_requests', { tenant_id: p.tenantId, kind: 'role_grant', status: 'pending' });
    const tokens = await tx.find('credential_tokens', { tenant_id: p.tenantId });
    const now = app.clock.now();
    return {
      users: users.map((u) => ({
        id: u.id,
        name: u.display_name,
        email: u.email,
        title: u.title,
        hue: u.avatar_hue,
        status: u.status,
        mfaEnabled: u.mfa_enabled,
        lastLoginAt: u.last_login_at,
        lockedUntil: u.locked_until && u.locked_until > now ? u.locked_until : null,
        provider: u.identity_provider,
        // Not enrolled yet: the person never chose a password with their enrolment link.
        enrolled: everEnrolled(u, tokens),
        hasPassword: u.identity_provider !== 'password' || !!u.password_hash,
        roles: grants.filter((g) => g.user_id === u.id).map((g) => ({ key: roles.get(g.role_id)?.key, name: roles.get(g.role_id)?.name, entityId: g.entity_id, entity: g.entity_id ? (entityCode.get(g.entity_id) ?? null) : null })),
        pendingGrant: pending.filter((r) => r.target_user_id === u.id).map((r) => ({ id: r.id, summary: r.summary }))[0] ?? null,
        activeSessions: sessions.filter((s) => s.user_id === u.id && !s.revoked_at && s.idle_expires_at > now).length,
      })),
      roles: ROLES.map((r) => ({ key: r.key, name: r.name, description: r.description, approvalLimit: r.approvalLimitMinor, readOnly: !!r.readOnly, permissions: r.permissions, needsApproval: authorityOf(r.permissions).length > 0, entityScopable: r.key !== 'admin' })),
      entities: entities.map((e) => ({ id: e.id, code: e.code, name: e.name })),
      permissions: Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })),
      canManage: can(p, 'admin.users'),
      canApproveAccess: can(p, 'access.approve'),
      pendingRequests: (await tx.count('access_requests', { tenant_id: p.tenantId, status: 'pending' })),
    };
  });
}

function validName(input: { email: string; name: string }) {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DomainError('VALIDATION', 'Enter a valid email address.');
  if (!input.name || input.name.trim().length < 2) throw new DomainError('VALIDATION', 'Enter the person\'s name.');
  return email;
}

/**
 * Add a person. Nobody receives a password: the person gets a single-use enrolment link at their own address.
 * Roles without approval authority apply at once; roles that carry it wait for a second approver.
 */
export async function createUser(app: App, p: Principal, input: { email: string; name: string; title?: string; roles: GrantInput[]; reason?: string }, meta: RequestMeta = {}) {
  requirePermission(p, 'admin.users', 'create users');
  const email = validName(input);
  if (!input.roles?.length) throw new DomainError('VALIDATION', 'Give the person at least one role.');
  return app.tx(async (tx) => {
    const grants = await resolveGrants(tx, p.tenantId, input.roles);
    // Sign-in identifies a person by email alone, so an email belongs to one account across all organizations.
    if (await tx.findOne('users', { email })) throw new DomainError('CONFLICT', 'That email address is already in use.');
    const now = app.clock.now();
    const u = await tx.insert('users', { tenant_id: p.tenantId, email, display_name: input.name.trim(), title: input.title?.trim() || null, password_hash: null, avatar_hue: Math.floor(Math.random() * 360), created_at: now, updated_at: now });
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'user.create', objectType: 'user', objectId: u.id, summary: `Created ${u.display_name} (${email}) without a password: they choose one with their enrolment link` }, now);
    const roles = await changeRoles(tx, app, p, u, grants, input.reason?.trim() || `New team member: ${u.display_name}`, meta);
    const enrolment = await issueCredentialLink(tx, app, { user: u, purpose: 'enrolment', by: p, meta });
    return { id: u.id, enrolment, applied: roles.applied, pending: roles.pending };
  });
}

export async function setUserRoles(app: App, p: Principal, userId: string, input: GrantInput[], meta: RequestMeta = {}, reason?: string) {
  requirePermission(p, 'admin.roles', 'assign roles');
  if (userId === p.user.id) throw new DomainError('SOD_VIOLATION', 'You cannot change your own roles.');
  return app.tx(async (tx) => {
    const user = await tx.get('users', userId);
    if (!user || user.tenant_id !== p.tenantId) app.notFound('User');
    const grants = await resolveGrants(tx, p.tenantId, input);
    return { ok: true, ...(await changeRoles(tx, app, p, user, grants, reason?.trim() || `Role change for ${user.display_name}`, meta)) };
  });
}

export async function setUserStatus(app: App, p: Principal, userId: string, status: 'active' | 'disabled', meta: RequestMeta = {}) {
  requirePermission(p, 'admin.users', 'enable or disable users');
  if (userId === p.user.id) throw new DomainError('VALIDATION', 'You cannot disable yourself.');
  return app.tx(async (tx) => {
    const user = await tx.get('users', userId);
    if (!user || user.tenant_id !== p.tenantId) app.notFound('User');
    await tx.update('users', userId, { status, failed_login_count: 0, locked_until: null, updated_at: app.clock.now() });
    if (status === 'disabled') await revokeUserSessions(tx, userId, 'user_disabled', app.clock.now());
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: `user.${status === 'active' ? 'enable' : 'disable'}`, objectType: 'user', objectId: userId, summary: `${status === 'active' ? 'Enabled (and unlocked)' : 'Disabled'} ${user.display_name}` }, app.clock.now());
    return { ok: true };
  });
}

/**
 * Reset a password: the old one stops working, every session is signed out and the person gets a single-use
 * reset link at their own address (someone who never enrolled gets a fresh enrolment link). The administrator
 * never sees a password or the link.
 */
export async function resetPassword(app: App, p: Principal, userId: string, meta: RequestMeta = {}) {
  requirePermission(p, 'admin.users', 'reset passwords');
  return app.tx(async (tx) => {
    const user = await tx.get('users', userId);
    if (!user || user.tenant_id !== p.tenantId) app.notFound('User');
    if (user.identity_provider !== 'password') throw new DomainError('VALIDATION', `${user.display_name} signs in with single sign-on; reset it with the identity provider.`);
    if (user.status !== 'active') throw new DomainError('VALIDATION', `${user.display_name} is disabled; enable the account first.`);
    const now = app.clock.now();
    const enrolled = everEnrolled(user, await tx.find('credential_tokens', { user_id: user.id }));
    if (user.password_hash) {
      await tx.update('users', userId, { password_hash: null, failed_login_count: 0, locked_until: null, updated_at: now });
      await revokeUserSessions(tx, userId, 'password_reset', now);
      await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'user.password_reset', objectType: 'user', objectId: userId, summary: `Reset the password of ${user.display_name}: the old password no longer works (sessions revoked)` }, now);
    }
    const link = await issueCredentialLink(tx, app, { user, purpose: enrolled ? 'password_reset' : 'enrolment', by: p, meta });
    return { purpose: enrolled ? 'password_reset' : 'enrolment', ...link };
  });
}

export async function listSodRules(app: App, p: Principal) {
  if (!can(p, 'admin.sod') && !can(p, 'audit.view') && !can(p, 'close.view')) requirePermission(p, 'admin.sod');
  return app.read(async (tx) => {
    const pending = await tx.find('access_requests', { tenant_id: p.tenantId, kind: 'sod_rule_change', status: 'pending' });
    return (await tx.find('sod_rules', { tenant_id: p.tenantId }, { orderBy: [['code', 'asc']] })).map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      kind: r.kind,
      params: r.params,
      severity: r.severity,
      enabled: r.enabled,
      version: r.version,
      updatedAt: r.updated_at,
      pendingChange: pending.filter((x) => x.sod_rule_id === r.id).map((x) => ({ id: x.id, summary: x.summary }))[0] ?? null,
    }));
  });
}

/** A rule change never applies at once: it waits for a second approver (see access.ts). */
export async function updateSodRule(app: App, p: Principal, id: string, patch: { enabled?: boolean; severity?: 'block' | 'warn'; params?: Record<string, unknown>; reason: string }, meta: RequestMeta = {}) {
  return requestSodChange(app, p, id, patch, meta);
}

export async function listSessions(app: App, p: Principal) {
  requirePermission(p, 'admin.sessions');
  return app.read(async (tx) => {
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
    const now = app.clock.now();
    return (await tx.find('sessions', { tenant_id: p.tenantId }, { orderBy: [['last_seen_at', 'desc']], limit: 200 }))
      .filter((s) => !s.revoked_at && s.idle_expires_at > now)
      .map((s) => ({ id: s.id, user: users.get(s.user_id) ?? s.user_id, method: s.auth_method, mfaVerified: s.mfa_verified, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.idle_expires_at, ip: s.ip, userAgent: s.user_agent }));
  });
}

export async function adminRevokeSession(app: App, p: Principal, id: string, meta: RequestMeta = {}) {
  requirePermission(p, 'admin.sessions');
  return app.tx(async (tx) => {
    const s = await tx.get('sessions', id);
    if (!s || s.tenant_id !== p.tenantId) app.notFound('Session');
    await revokeSession(tx, id, 'revoked_by_admin', app.clock.now());
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'session.revoke', objectType: 'session', objectId: id, summary: 'Revoked a session' }, app.clock.now());
    return { ok: true };
  });
}

// ------------------------------------------------------------------ audit

export async function auditLog(app: App, p: Principal, f: { action?: string; objectType?: string; objectId?: string; actor?: string; limit?: number; beforeSeq?: number }) {
  if (!can(p, 'audit.view')) requirePermission(p, 'audit.view');
  return app.read(async (tx) => {
    const where: Where<'audit_log'> = { tenant_id: p.tenantId };
    if (f.objectType) where.object_type = f.objectType;
    if (f.objectId) where.object_id = f.objectId;
    if (f.action) where.action = { contains: f.action };
    if (f.actor) where.actor_label = { contains: f.actor };
    if (f.beforeSeq) where.seq = { lt: f.beforeSeq };
    const rows = await tx.find('audit_log', where, { orderBy: [['seq', 'desc']], limit: Math.min(f.limit ?? 100, 500) });
    const total = await tx.count('audit_log', { tenant_id: p.tenantId });
    return { total, events: rows.map((r) => ({ seq: r.seq, at: r.occurred_at, actorType: r.actor_type, actor: r.actor_label, action: r.action, objectType: r.object_type, objectId: r.object_id, summary: r.summary, hash: r.hash, prevHash: r.prev_hash, record: r.record, ip: r.ip })) };
  });
}

export async function verifyAudit(app: App, p: Principal, meta: RequestMeta = {}) {
  requirePermission(p, 'audit.verify', 'verify the audit chain');
  const result = await app.read((tx) => verifyAuditChain(tx, p.tenantId));
  await app.tx((tx) => appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'audit.verify', objectType: 'audit_log', summary: `Verified the audit chain: ${result.ok ? `intact (${result.checked} events)` : `BROKEN at seq ${result.firstBadSeq}: ${result.reason}`}`, details: result }, app.clock.now()));
  return result;
}

// ------------------------------------------------------------------ imports

export async function listImports(app: App, p: Principal) {
  requirePermission(p, 'close.view');
  return app.read(async (tx) => {
    const batches = await tx.find('import_batches', { tenant_id: p.tenantId }, { orderBy: [['started_at', 'desc']], limit: 60 });
    const docs = new Map((batches.length ? await tx.find('source_documents', { id: { in: batches.map((b) => b.source_document_id) } }) : []).map((d) => [d.id, d]));
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
    const connectors = await tx.find('connectors', { tenant_id: p.tenantId });
    return {
      batches: batches.map((b) => ({ id: b.id, filename: docs.get(b.source_document_id)?.filename ?? '', sha256: docs.get(b.source_document_id)?.sha256 ?? '', format: b.format, target: b.target, status: b.status, startedAt: b.started_at, total: b.records_total, created: b.records_created, duplicates: b.records_duplicate, failed: b.records_failed, errors: b.errors, importedBy: b.imported_by ? users.get(b.imported_by) ?? null : 'Connector' })),
      connectors: connectors.map((c) => ({ id: c.id, kind: c.kind, adapter: c.adapter, name: c.name, status: c.status, lastSyncAt: c.last_sync_at, lastSyncStatus: c.last_sync_status })),
      adapters: ADAPTERS.map((a) => ({ key: a.key, label: a.label, format: a.format, kind: a.kind, description: a.description })),
      canImport: can(p, 'import.run'),
    };
  });
}

export async function importFile(app: App, p: Principal, input: { filename: string; content: string; adapterKey?: string }, meta: RequestMeta = {}) {
  requirePermission(p, 'import.run', 'import files');
  if (!input.filename || typeof input.content !== 'string') throw new DomainError('VALIDATION', 'Choose a file.');
  return app.tx(async (tx) => importDocument(tx, app.ctx(p, meta), await app.lookups(tx, p.tenantId), { filename: input.filename.slice(0, 200), content: input.content, adapterKey: input.adapterKey }));
}

// ------------------------------------------------------------------ ontology (no database)

export function ontologyIndex() {
  const classes = closeOntology.classes();
  return {
    iri: closeOntology.spec.iri,
    version: closeOntology.spec.version,
    contentHash: closeOntology.hash,
    modules: [...new Set(classes.map((c) => c.module))].sort(),
    classes: classes.map((c) => ({ id: c.id, label: c.label, module: c.module, parents: c.parents, definition: c.definition, accountClass: c.accountClass ?? null, normalBalance: c.normalBalance ?? null })),
    axioms: closeOntology.spec.axioms.map((a) => ({ id: a.id, label: a.label, appliesTo: a.appliesTo, severity: a.severity, plainEnglish: a.plainEnglish, formal: a.formal, citations: a.citations ?? [] })),
    relations: closeOntology.spec.relations.map((r) => ({ id: r.id, label: r.label, domain: r.domain, range: r.range })),
  };
}

export function ontologyTerm(id: string) {
  const term = closeOntology.term(id) ?? (closeOntology.lookup(id) ? closeOntology.term(closeOntology.lookup(id)!) : undefined);
  if (!term) throw new DomainError('NOT_FOUND', `No ontology term "${id}"`);
  const cls = closeOntology.getClass(term.id);
  return {
    ...term,
    ancestors: cls ? closeOntology.ancestors(cls.id).map((a) => ({ id: a, label: closeOntology.getClass(a)?.label ?? a })) : [],
    children: cls ? closeOntology.classes().filter((c) => c.parents.includes(cls.id)).map((c) => ({ id: c.id, label: c.label })) : [],
    axioms: cls ? closeOntology.axiomsFor(cls.id).map((a) => ({ id: a.id, label: a.label, plainEnglish: a.plainEnglish, severity: a.severity })) : [],
    properties: cls?.properties ?? [],
    table: cls?.table ?? null,
    accountClass: cls?.accountClass ?? null,
    normalBalance: cls?.normalBalance ?? null,
    fsLine: cls?.fsLine ?? null,
    bucketing: cls?.bucketing ?? null,
    assertions: cls?.assertions ?? [],
  };
}

export function ontologyGraph(module?: string) {
  const g = toGraph(closeOntology);
  if (!module) return g;
  const keep = new Set(closeOntology.classes().filter((c) => c.module === module).map((c) => c.id));
  for (const id of [...keep]) for (const p of closeOntology.getClass(id)?.parents ?? []) keep.add(p);
  return { nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
}

export function ontologyLookup(q: string) {
  const id = closeOntology.lookup(q);
  return id ? { found: true, term: closeOntology.term(id) } : { found: false, term: null };
}

export type { Row };
