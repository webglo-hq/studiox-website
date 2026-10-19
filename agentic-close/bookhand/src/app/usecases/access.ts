import { appendAudit } from '../../audit/audit';
import type { Tx } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import { hashPassword, passwordProblems } from '../../security/passwords';
import { authorityOf } from '../../security/permissions';
import { can, requirePermission, type Principal } from '../../security/principal';
import { revokeUserSessions } from '../../security/sessions';
import { canonicalJson } from '../../shared/canonical-json';
import { DomainError } from '../../shared/errors';
import { sha256Hex } from '../../shared/hash';
import { randomToken } from '../../shared/ids';
import { formatMoney } from '../../shared/money';
import type { App, RequestMeta } from '../app';
import { DELIVERY_LOG, queueMessage } from '../outbox';

/**
 * Access control that no single administrator can subvert:
 *  - Nobody is handed someone else's credential. A new person gets a single-use, expiring enrolment link and a
 *    password reset sends a reset link, both through the outbox to the person's own address; the administrator
 *    who triggered them never sees the link, and only its hash is stored.
 *  - A role grant that carries approval authority, and any change to a segregation-of-duties rule, is held as an
 *    access request and takes effect only when a second person with enough authority approves it: never the
 *    requester, never the grantee (also enforced by the database).
 */

export const ENROLMENT_HOURS = 72;
export const RESET_MINUTES = 60;

export interface Grant {
  role: string;
  entityId: string | null;
}

const LINK_INVALID = 'This link is invalid, has expired or was already used. Ask your administrator to send a new one.';

// ------------------------------------------------------------------ enrolment and reset links

export async function issueCredentialLink(tx: Tx, app: App, args: { user: Row<'users'>; purpose: 'enrolment' | 'password_reset'; by: Principal; meta: RequestMeta }): Promise<{ sentTo: string; expiresAt: string; delivery: string }> {
  const now = app.clock.now();
  const tenant = (await tx.get('tenants', args.user.tenant_id))!;
  // The newest link is the only one that works.
  for (const t of await tx.find('credential_tokens', { user_id: args.user.id, used_at: null, revoked_at: null })) await tx.update('credential_tokens', t.id, { revoked_at: now });
  const token = randomToken(32);
  const enrolment = args.purpose === 'enrolment';
  const expiresAt = new Date(Date.parse(now) + (enrolment ? ENROLMENT_HOURS * 3_600_000 : RESET_MINUTES * 60_000)).toISOString();
  await tx.insert('credential_tokens', { tenant_id: tenant.id, user_id: args.user.id, purpose: args.purpose, token_hash: sha256Hex(token), created_by: args.by.user.id, created_at: now, expires_at: expiresAt });
  const first = args.user.display_name.split(' ')[0];
  const message = await queueMessage(
    tx,
    tenant,
    app.config.outbox ?? null,
    enrolment
      ? {
          tenantId: tenant.id,
          toUserId: args.user.id,
          toEmail: args.user.email,
          kind: 'enrolment',
          subject: `Set your Bookhand password for ${tenant.name}`,
          body: `Hello ${first}, ${args.by.user.display_name} added you to ${tenant.name} on Bookhand. Open this single-use link within ${ENROLMENT_HOURS} hours to choose your password. It was sent only to you: do not forward it.`,
          link: `#/enrol?token=${token}`,
        }
      : {
          tenantId: tenant.id,
          toUserId: args.user.id,
          toEmail: args.user.email,
          kind: 'password_reset',
          subject: 'Reset your Bookhand password',
          body: `Hello ${first}, ${args.by.user.display_name} reset your Bookhand password and signed you out everywhere. Open this single-use link within ${RESET_MINUTES} minutes to choose a new one. It was sent only to you: do not forward it.`,
          link: `#/reset?token=${token}`,
        },
    now,
  );
  await appendAudit(tx, tenant.id, app.actorOf(args.by, args.meta), {
    action: enrolment ? 'user.enrolment_link' : 'user.reset_link',
    objectType: 'user',
    objectId: args.user.id,
    summary: `Sent a single-use ${enrolment ? 'enrolment' : 'password-reset'} link to ${args.user.email} (expires ${expiresAt.slice(0, 16).replace('T', ' ')} UTC, ${message.transport === DELIVERY_LOG ? 'demo delivery log' : `transport ${message.transport}`})`,
  }, now);
  return { sentTo: args.user.email, expiresAt, delivery: message.transport };
}

/** Whether the person ever had a password of their own (a reset clears it, but they stay enrolled). */
export function everEnrolled(user: Row<'users'>, tokens: Array<Row<'credential_tokens'>>): boolean {
  return user.identity_provider !== 'password' || !!user.password_hash || tokens.some((t) => t.user_id === user.id && (t.purpose === 'password_reset' || !!t.used_at));
}

async function liveLink(tx: Tx, token: string, now: string, opts: { forUpdate?: boolean } = {}) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const found = await tx.findOne('credential_tokens', { token_hash: sha256Hex(token) });
  const row = found && opts.forUpdate ? await tx.get('credential_tokens', found.id, { forUpdate: true }) : found;
  if (!row || row.used_at || row.revoked_at || row.expires_at <= now) return null;
  const user = await tx.get('users', row.user_id);
  if (!user || user.status !== 'active' || user.tenant_id !== row.tenant_id || user.identity_provider !== 'password') return null;
  return { row, user };
}

/** A link works only for the person it was sent to: anyone signed in as someone else is refused, and that is audited. */
async function refuseSomeoneElse(app: App, live: { row: Row<'credential_tokens'>; user: Row<'users'> }, principal: Principal | null, meta: RequestMeta): Promise<void> {
  if (!principal || principal.user.id === live.user.id) return;
  await app.tx((tx) =>
    appendAudit(tx, live.user.tenant_id, app.actorOf(principal, meta), { action: 'auth.credential_link_refused', objectType: 'user', objectId: live.user.id, summary: `Refused ${principal.user.display_name} the ${live.row.purpose === 'enrolment' ? 'enrolment' : 'reset'} link addressed to ${live.user.email}` }, app.clock.now()),
  );
  throw new DomainError('FORBIDDEN', `You are signed in as ${principal.user.display_name}. This link belongs to someone else: it works only for the person it was sent to, signed out.`);
}

export async function inspectCredentialLink(app: App, token: string, principal: Principal | null, meta: RequestMeta = {}) {
  const live = await app.read((tx) => liveLink(tx, token, app.clock.now()));
  if (!live) throw new DomainError('VALIDATION', LINK_INVALID);
  await refuseSomeoneElse(app, live, principal, meta);
  return { purpose: live.row.purpose, name: live.user.display_name, email: live.user.email, expiresAt: live.row.expires_at };
}

/** Set a password with a link: single use (the row is locked while it is spent), then every session is signed out. */
export async function redeemCredentialLink(app: App, token: string, password: string, principal: Principal | null, meta: RequestMeta = {}) {
  const now = app.clock.now();
  const live = await app.read((tx) => liveLink(tx, token, now));
  if (!live) throw new DomainError('VALIDATION', LINK_INVALID);
  await refuseSomeoneElse(app, live, principal, meta);
  const problems = passwordProblems(password, { email: live.user.email, name: live.user.display_name });
  if (problems.length) throw new DomainError('VALIDATION', problems.join(' '), { problems });
  const hash = await hashPassword(password);
  await app.tx(async (tx) => {
    const fresh = await liveLink(tx, token, now, { forUpdate: true });
    if (!fresh) throw new DomainError('VALIDATION', LINK_INVALID);
    const enrolment = fresh.row.purpose === 'enrolment';
    await tx.update('credential_tokens', fresh.row.id, { used_at: now });
    await tx.update('users', fresh.user.id, { password_hash: hash, failed_login_count: 0, locked_until: null, updated_at: now });
    await revokeUserSessions(tx, fresh.user.id, enrolment ? 'enrolled' : 'password_reset', now);
    await appendAudit(tx, fresh.user.tenant_id, { type: 'user', userId: fresh.user.id, label: fresh.user.display_name, ip: meta.ip, requestId: meta.requestId }, { action: enrolment ? 'auth.enrolled' : 'auth.password_reset', objectType: 'user', objectId: fresh.user.id, summary: enrolment ? 'Chose a password with a single-use enrolment link' : 'Chose a new password with a single-use reset link' }, now);
  });
  return { ok: true, email: live.user.email };
}

// ------------------------------------------------------------------ the demo delivery log

function linkToken(link: string | null): string | null {
  return link ? (/[?&]token=([A-Za-z0-9_-]+)/.exec(link)?.[1] ?? null) : null;
}

/**
 * A demo organization's messages to one address. It opens only for that person (signed out, or signed in as them),
 * and every opening is recorded in the audit log and on the messages, so a link is never used silently.
 */
export async function readDeliveryLog(app: App, email: string, principal: Principal | null, meta: RequestMeta = {}) {
  const to = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new DomainError('VALIDATION', 'Enter the email address the message was sent to.');
  if (principal && principal.user.email !== to) throw new DomainError('FORBIDDEN', `You are signed in as ${principal.user.display_name}. A delivery log opens only for the person it is addressed to: sign out first.`);
  const now = app.clock.now();
  const rows = await app.read((tx) => tx.find('outbox_messages', { to_email: to, transport: DELIVERY_LOG }, { orderBy: [['created_at', 'desc']], limit: 20 }));
  const status = new Map<string, string>();
  await app.tx(async (tx) => {
    for (const m of rows) {
      const token = linkToken(m.link);
      if (!token) continue;
      const t = await tx.findOne('credential_tokens', { token_hash: sha256Hex(token) });
      status.set(m.id, !t ? 'invalid' : t.used_at ? 'used' : t.revoked_at ? 'replaced' : t.expires_at <= now ? 'expired' : 'usable');
      await tx.update('outbox_messages', m.id, { opened_count: m.opened_count + 1, last_opened_at: now });
    }
    for (const tenantId of new Set(rows.map((m) => m.tenant_id))) {
      const mine = rows.filter((m) => m.tenant_id === tenantId);
      await appendAudit(tx, tenantId, { type: 'system', userId: null, label: 'Delivery log', ip: meta.ip, requestId: meta.requestId }, { action: 'outbox.opened', objectType: 'user', objectId: mine[0]!.to_user_id, summary: `Opened the delivery log of ${to} (${mine.length} message${mine.length === 1 ? '' : 's'}) from ${meta.ip ?? 'an unknown address'}${principal ? ` signed in as ${principal.user.display_name}` : ', signed out'}` }, now);
    }
  });
  return { to, messages: rows.map((m) => ({ id: m.id, kind: m.kind, subject: m.subject, body: m.body, link: m.link, linkStatus: status.get(m.id) ?? null, sentAt: m.created_at })) };
}

// ------------------------------------------------------------------ role grants with dual control

async function roleRows(tx: Tx) {
  const rows = await tx.find('roles', {});
  return { byId: new Map(rows.map((r) => [r.id, r])), byKey: new Map(rows.map((r) => [r.key, r])) };
}

const grantKey = (g: Grant) => `${g.role}|${g.entityId ?? ''}`;

/** A role, optionally limited to one entity (by code or id); a bare role key covers every entity. */
export type GrantInput = string | { role: string; entity?: string | null };

export async function resolveGrants(tx: Tx, tenantId: string, input: GrantInput[]): Promise<Grant[]> {
  const entities = await tx.find('entities', { tenant_id: tenantId });
  return input.map((g) => {
    const role = typeof g === 'string' ? g : g.role;
    const ref = typeof g === 'string' ? null : (g.entity ?? null);
    if (!ref) return { role, entityId: null };
    if (role === 'admin') throw new DomainError('VALIDATION', 'Administration covers the whole organization: the Admin role cannot be limited to one entity.');
    const e = entities.find((x) => x.id === ref || x.code === ref);
    if (!e) throw new DomainError('VALIDATION', `Unknown entity ${ref}.`);
    return { role, entityId: e.id };
  });
}

/** Refuse role combinations a role-conflict SoD rule forbids (e.g. SOD-005: no approval roles for admins). */
export async function checkRoleConflicts(tx: Tx, tenantId: string, roleKeys: string[]): Promise<void> {
  const rules = await tx.find('sod_rules', { tenant_id: tenantId, kind: 'role_conflict', enabled: true });
  for (const r of rules) {
    const params = r.params as { role?: string; conflicts?: string[] };
    if (params.role && roleKeys.includes(params.role) && (params.conflicts ?? []).some((c) => roleKeys.includes(c))) {
      throw new DomainError('SOD_VIOLATION', `${r.code} ${r.name}: ${r.description}`);
    }
  }
}

export async function describeGrants(tx: Tx, tenantId: string, grants: Grant[]): Promise<string> {
  const { byKey } = await roleRows(tx);
  const entities = new Map((await tx.find('entities', { tenant_id: tenantId })).map((e) => [e.id, e.code]));
  return grants.map((g) => `${byKey.get(g.role)?.name ?? g.role}${g.entityId ? ` (${entities.get(g.entityId) ?? 'one entity'} only)` : ''}`).join(', ');
}

/**
 * Change a person's roles to `desired`. Removals and grants without approval authority apply at once; grants
 * that carry approval authority are held in one pending access request for a second person to approve.
 */
export async function changeRoles(tx: Tx, app: App, p: Principal, target: Row<'users'>, desired: Grant[], reason: string, meta: RequestMeta) {
  const now = app.clock.now();
  const { byId, byKey } = await roleRows(tx);
  for (const g of desired) if (!byKey.has(g.role)) throw new DomainError('VALIDATION', `Unknown role ${g.role}`);
  await checkRoleConflicts(tx, p.tenantId, [...new Set(desired.map((g) => g.role))]);
  const current = (await tx.find('user_roles', { user_id: target.id })).map((r) => ({ id: r.id, role: byId.get(r.role_id)!.key, entityId: r.entity_id }));
  const wanted = new Set(desired.map(grantKey));
  const removed = current.filter((g) => !wanted.has(grantKey(g)));
  const added = desired.filter((g, i) => !current.some((c) => grantKey(c) === grantKey(g)) && desired.findIndex((x) => grantKey(x) === grantKey(g)) === i);
  const authority = (g: Grant) => authorityOf((byKey.get(g.role)!.permissions as string[]) ?? []).length > 0;
  const immediate = added.filter((g) => !authority(g));
  const held = added.filter(authority);

  for (const g of removed) await tx.delete('user_roles', g.id);
  for (const g of immediate) await tx.insert('user_roles', { tenant_id: p.tenantId, user_id: target.id, role_id: byKey.get(g.role)!.id, entity_id: g.entityId, granted_by: p.user.id });
  if (removed.length || immediate.length) {
    await revokeUserSessions(tx, target.id, 'roles_changed', now);
    const parts = [...(immediate.length ? [`granted ${await describeGrants(tx, p.tenantId, immediate)}`] : []), ...(removed.length ? [`removed ${await describeGrants(tx, p.tenantId, removed)}`] : [])];
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'user.roles', objectType: 'user', objectId: target.id, summary: `${target.display_name}: ${parts.join('; ')} (sessions revoked)` }, now);
  }

  // One pending grant per person: an unchanged request stands, anything else replaces it.
  const open = await tx.find('access_requests', { tenant_id: p.tenantId, kind: 'role_grant', target_user_id: target.id, status: 'pending' });
  const heldKey = canonicalJson(held.map(grantKey).sort());
  let pending = open.find((r) => canonicalJson(((r.payload.grants as Grant[]) ?? []).map(grantKey).sort()) === heldKey && held.length > 0) ?? null;
  for (const r of open) if (r.id !== pending?.id) await tx.update('access_requests', r.id, { status: 'superseded', decided_at: now });
  if (held.length && !pending) {
    const summary = `Grant ${await describeGrants(tx, p.tenantId, held)} to ${target.display_name}`;
    pending = await tx.insert('access_requests', { tenant_id: p.tenantId, kind: 'role_grant', target_user_id: target.id, payload: { grants: held }, summary, reason, requested_by: p.user.id, requested_at: now });
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'access_request.create', objectType: 'access_request', objectId: pending.id, summary: `${summary}: waiting for a second approver (${reason})` }, now);
  }
  return { applied: immediate.length + removed.length, pending: pending ? { id: pending.id, summary: pending.summary } : null };
}

/** Hold a segregation-of-duties rule change for a second approver. */
export async function requestSodChange(app: App, p: Principal, ruleId: string, patch: { enabled?: boolean; severity?: 'block' | 'warn'; params?: Record<string, unknown>; reason: string }, meta: RequestMeta = {}) {
  requirePermission(p, 'admin.sod', 'edit segregation-of-duties rules');
  if (!patch.reason || patch.reason.trim().length < 5) throw new DomainError('VALIDATION', 'Say why you are changing a control.');
  return app.tx(async (tx) => {
    const r = await tx.get('sod_rules', ruleId);
    if (!r || r.tenant_id !== p.tenantId) app.notFound('SoD rule');
    if (r.kind === 'requester_limit' && (patch.enabled === false || patch.severity === 'warn' || patch.params !== undefined)) throw new DomainError('VALIDATION', `${r.code} is enforced by the database: it cannot be switched off, relaxed to a warning or given a limit.`);
    const before = { enabled: r.enabled, severity: r.severity, params: r.params };
    const after = { enabled: patch.enabled ?? r.enabled, severity: patch.severity ?? r.severity, params: patch.params ?? r.params };
    if (canonicalJson(before) === canonicalJson(after)) throw new DomainError('VALIDATION', 'That is how the rule is already set.');
    const now = app.clock.now();
    for (const old of await tx.find('access_requests', { tenant_id: p.tenantId, kind: 'sod_rule_change', sod_rule_id: r.id, status: 'pending' })) await tx.update('access_requests', old.id, { status: 'superseded', decided_at: now });
    const describe = (x: typeof before) => (!x.enabled ? 'off' : x.severity === 'block' ? 'blocks' : 'warns');
    const summary = `${r.code} ${r.name}: ${describe(before)} -> ${describe(after)}`;
    const req = await tx.insert('access_requests', { tenant_id: p.tenantId, kind: 'sod_rule_change', sod_rule_id: r.id, payload: { before, after }, summary, reason: patch.reason.trim(), requested_by: p.user.id, requested_at: now });
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'access_request.create', objectType: 'access_request', objectId: req.id, summary: `${summary}: waiting for a second approver (${patch.reason.trim()})` }, now);
    return { pending: { id: req.id, summary } };
  });
}

/** Why `approver` may not decide `request` (empty = may decide): independence, then sufficient authority. */
export async function decisionProblems(tx: Tx, approver: Principal, request: Row<'access_requests'>): Promise<string[]> {
  const out: string[] = [];
  if (!can(approver, 'access.approve')) out.push('Only a Controller or CFO approves access changes.');
  if (request.requested_by === approver.user.id) out.push('You requested this change, so someone else must decide it.');
  if (request.target_user_id && request.target_user_id === approver.user.id) out.push('Nobody decides roles for themselves.');
  if (request.kind === 'sod_rule_change' && approver.entityIds !== null) out.push('Segregation-of-duties rules cover every entity; your access is limited to some.');
  if (request.kind === 'role_grant') {
    const { byKey } = await roleRows(tx);
    for (const g of (request.payload.grants as Grant[]) ?? []) {
      const role = byKey.get(g.role);
      if (!role) continue;
      const missing = authorityOf((role.permissions as string[]) ?? []).filter((perm) => !approver.permissions.has(perm));
      if (missing.length) out.push(`${role.name} carries authority you do not hold (${missing.join(', ')}).`);
      const limit = role.approval_limit_minor;
      if (limit === null ? approver.approvalLimitMinor !== null : approver.approvalLimitMinor !== null && approver.approvalLimitMinor < limit) {
        out.push(`${role.name} approves ${limit === null ? 'without a limit' : `up to ${formatMoney(limit, { cents: false })}`}, more than you.`);
      }
      if (approver.entityIds !== null && (g.entityId === null || !approver.entityIds.includes(g.entityId))) out.push(`${role.name} would cover an entity outside your own access.`);
    }
  }
  return out;
}

export async function listAccessRequests(app: App, p: Principal) {
  if (!can(p, 'access.approve') && !can(p, 'admin.users') && !can(p, 'admin.sod') && !can(p, 'audit.view')) requirePermission(p, 'access.approve');
  return app.read(async (tx) => {
    const all = await tx.find('access_requests', { tenant_id: p.tenantId }, { orderBy: [['requested_at', 'desc']], limit: 80 });
    const rows = [...all.filter((r) => r.status === 'pending'), ...all.filter((r) => r.status !== 'pending').slice(0, 30)];
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u]));
    const tokens = await tx.find('credential_tokens', { tenant_id: p.tenantId });
    const rules = new Map((await tx.find('sod_rules', { tenant_id: p.tenantId })).map((r) => [r.id, r]));
    const out = [];
    for (const r of rows) {
      const target = r.target_user_id ? users.get(r.target_user_id) : undefined;
      const opened = target ? (await tx.find('outbox_messages', { to_user_id: target.id, kind: 'enrolment' })).map((m) => m.last_opened_at).filter((x): x is string => !!x).sort().at(-1) ?? null : null;
      const problems = r.status === 'pending' ? await decisionProblems(tx, p, r) : [];
      out.push({
        id: r.id,
        kind: r.kind,
        summary: r.summary,
        reason: r.reason,
        status: r.status,
        requestedBy: users.get(r.requested_by)?.display_name ?? r.requested_by,
        requestedAt: r.requested_at,
        target: target ? { id: target.id, name: target.display_name, email: target.email, enrolled: everEnrolled(target, tokens), enrolmentLinkOpenedAt: opened } : null,
        rule: r.sod_rule_id ? { code: rules.get(r.sod_rule_id)?.code ?? '', name: rules.get(r.sod_rule_id)?.name ?? '' } : null,
        decidedBy: r.decided_by ? users.get(r.decided_by)?.display_name ?? null : null,
        decidedAt: r.decided_at,
        decisionReason: r.decision_reason,
        canDecide: r.status === 'pending' && problems.length === 0,
        blocks: problems,
      });
    }
    return { requests: out, canApprove: can(p, 'access.approve') };
  });
}

/** Approve (apply) or reject a held access change. */
export async function decideAccessRequest(app: App, p: Principal, id: string, decision: 'approve' | 'reject', reason: string | undefined, meta: RequestMeta = {}) {
  requirePermission(p, 'access.approve', 'approve access changes');
  if (decision === 'reject' && (!reason || reason.trim().length < 3)) throw new DomainError('VALIDATION', 'Say why you are rejecting it.');
  return app.tx(async (tx) => {
    const r = await tx.get('access_requests', id, { forUpdate: true });
    if (!r || r.tenant_id !== p.tenantId) app.notFound('Access request');
    if (r.status !== 'pending') throw new DomainError('CONFLICT', `This request is already ${r.status}.`);
    const problems = await decisionProblems(tx, p, r);
    if (problems.length) throw new DomainError(problems.some((x) => /someone else|themselves/.test(x)) ? 'SOD_VIOLATION' : 'FORBIDDEN', problems.join(' '), { problems });
    const now = app.clock.now();
    const requester = (await tx.get('users', r.requested_by))?.display_name ?? 'an administrator';
    if (decision === 'approve' && r.kind === 'role_grant') {
      const target = await tx.get('users', r.target_user_id!);
      if (!target) app.notFound('User');
      const { byId, byKey } = await roleRows(tx);
      const grants = (r.payload.grants as Grant[]) ?? [];
      const current = await tx.find('user_roles', { user_id: target.id });
      await checkRoleConflicts(tx, p.tenantId, [...new Set([...current.map((g) => byId.get(g.role_id)!.key), ...grants.map((g) => g.role)])]);
      for (const g of grants) {
        const role = byKey.get(g.role)!;
        if (current.some((c) => c.role_id === role.id && c.entity_id === g.entityId)) continue;
        await tx.insert('user_roles', { tenant_id: p.tenantId, user_id: target.id, role_id: role.id, entity_id: g.entityId, granted_by: r.requested_by });
      }
      await revokeUserSessions(tx, target.id, 'roles_changed', now);
      await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'user.roles', objectType: 'user', objectId: target.id, summary: `${target.display_name}: granted ${await describeGrants(tx, p.tenantId, grants)}, requested by ${requester} and approved by ${p.user.display_name} (sessions revoked)` }, now);
    }
    if (decision === 'approve' && r.kind === 'sod_rule_change') {
      const rule = await tx.get('sod_rules', r.sod_rule_id!);
      if (!rule) app.notFound('SoD rule');
      const after = r.payload.after as { enabled: boolean; severity: 'block' | 'warn'; params: Record<string, unknown> };
      const updated = await tx.update('sod_rules', rule.id, { enabled: after.enabled, severity: after.severity, params: after.params, version: rule.version + 1, updated_by: r.requested_by, updated_at: now });
      await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'sod.update', objectType: 'sod_rule', objectId: rule.id, summary: `${rule.code} ${rule.name} v${updated.version}: ${r.summary.split(': ').slice(1).join(': ')} (${r.reason}), requested by ${requester} and approved by ${p.user.display_name}`, details: r.payload }, now);
    }
    const decided = await tx.update('access_requests', r.id, { status: decision === 'approve' ? 'approved' : 'rejected', decided_by: p.user.id, decided_at: now, decision_reason: reason?.trim() || null });
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: `access_request.${decision}`, objectType: 'access_request', objectId: r.id, summary: `${decision === 'approve' ? 'Approved' : 'Rejected'}: ${r.summary}${reason?.trim() ? ` (${reason.trim()})` : ''}` }, now);
    return { id: decided.id, status: decided.status };
  });
}
