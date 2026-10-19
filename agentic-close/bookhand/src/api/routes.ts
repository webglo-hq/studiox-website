import { z } from 'zod';
import * as access from '../app/usecases/access';
import * as admin from '../app/usecases/admin';
import * as agents from '../app/usecases/agents';
import * as auth from '../app/usecases/auth';
import * as closeUc from '../app/usecases/close';
import { home } from '../app/usecases/home';
import * as inbox from '../app/usecases/inbox';
import * as ledger from '../app/usecases/ledger';
import * as recs from '../app/usecases/recs';
import * as tokens from '../app/usecases/tokens';
import { closeOntology } from '../packs/accounting/ontology';
import { DomainError } from '../shared/errors';
import type { RouteDef } from './kernel';

/** Every API endpoint. Bodies are validated with zod; permissions are re-checked inside the use cases. */

const id = z.string().regex(/^[0-9a-f-]{36}$/i, 'expected an id');
const text = (min = 0, max = 2000) => z.string().trim().min(min).max(max);
const mode = z.object({ mode: z.enum(['offline', 'live']).optional() }).strict();

const LineInput = z.object({ account: text(1, 20), debit: z.number().int().nonnegative().optional(), credit: z.number().int().nonnegative().optional(), department: text(0, 20).nullable().optional(), memo: text(0, 300).nullable().optional() }).strict();
const DraftInput = z.object({ entity: text(2, 20), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), type: z.enum(['standard', 'adjusting', 'accrual', 'reclass']).default('adjusting'), description: text(5, 300), autoReverseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), lines: z.array(LineInput).min(2).max(100) }).strict();

/** A role for everything (its key) or limited to one entity ({ role, entity: code or id }). */
const GrantBody = z.union([text(2, 40), z.object({ role: text(2, 40), entity: text(1, 40).nullable().optional() }).strict()]);

const q = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);
const qn = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

export const ROUTES: RouteDef[] = [
  // ------------------------------------------------------------------ public & auth
  {
    method: 'GET',
    path: '/api/health',
    auth: 'public',
    handler: ({ app }) => ({ ok: true, db: app.db.label, mode: app.config.mode, live: !!app.liveModel, model: app.liveModel, ontology: closeOntology.spec.version }),
  },
  {
    method: 'GET',
    path: '/api/auth/demo-users',
    auth: 'public',
    async handler({ app }) {
      const tenant = (await app.read((tx) => tx.find('tenants', {}, { limit: 1 })))[0];
      if (!tenant?.is_demo) return { demo: false, users: [] };
      const users = await app.read(async (tx) => {
        // People who have not enrolled yet (no password) cannot sign in, so they are not offered.
        const list = (await tx.find('users', { tenant_id: tenant.id, status: 'active' }, { orderBy: [['display_name', 'asc']] })).filter((u) => u.password_hash);
        const grants = await tx.find('user_roles', { tenant_id: tenant.id });
        const roles = new Map((await tx.find('roles', {})).map((r) => [r.id, r]));
        const enrolled = new Set((await tx.find('credential_tokens', { tenant_id: tenant.id })).filter((t) => t.used_at).map((t) => t.user_id));
        return list.map((u) => ({ email: u.email, name: u.display_name, title: u.title, hue: u.avatar_hue, role: roles.get(grants.find((g) => g.user_id === u.id)?.role_id ?? '')?.name ?? '', ownPassword: enrolled.has(u.id) }));
      });
      return { demo: true, company: tenant.name, password: app.config.demoPassword ?? null, users };
    },
  },
  {
    method: 'POST',
    path: '/api/auth/login',
    auth: 'public',
    rate: 'signIn',
    rateOnFailure: 'login',
    body: z.object({ email: text(3, 200), password: z.string().min(1).max(256) }).strict(),
    async handler(ctx) {
      const result = await auth.login(ctx.app, String(ctx.body.email), String(ctx.body.password), ctx.meta);
      ctx.setSessionCookie(result.token);
      return { mfaRequired: result.mfaRequired, csrfToken: result.csrfToken, user: result.user };
    },
  },
  {
    method: 'POST',
    path: '/api/auth/mfa',
    auth: 'mfa',
    rate: 'signIn',
    rateOnFailure: 'mfa',
    body: z.object({ code: z.string().trim().regex(/^\d{6}$/, 'six digits') }).strict(),
    async handler(ctx) {
      const r = await auth.verifyMfa(ctx.app, ctx.session!, String(ctx.body.code), ctx.meta);
      ctx.setSessionCookie(r.token);
      return { csrfToken: r.csrfToken };
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    auth: 'mfa',
    async handler(ctx) {
      await auth.logout(ctx.app, ctx.session!, ctx.meta);
      ctx.clearSessionCookie();
      return { ok: true };
    },
  },
  {
    method: 'GET',
    path: '/api/session',
    auth: 'mfa',
    async handler(ctx) {
      if (ctx.session!.state === 'mfa_pending') return { mfaRequired: true, csrfToken: ctx.session!.csrf_token };
      return auth.me(ctx.app, ctx.principal!, ctx.session!);
    },
  },
  // Enrolment and password-reset links: they work only for the person they were sent to, signed out (POST keeps the
  // single-use token out of URLs and logs).
  {
    method: 'POST',
    path: '/api/auth/credential-link/check',
    auth: 'public',
    rate: 'signIn',
    rateOnFailure: 'login',
    body: z.object({ token: z.string().min(1).max(200) }).strict(),
    handler: (c) => access.inspectCredentialLink(c.app, String(c.body.token), c.principal, c.meta),
  },
  {
    method: 'POST',
    path: '/api/auth/credential-link',
    auth: 'public',
    rate: 'signIn',
    rateOnFailure: 'login',
    body: z.object({ token: z.string().min(1).max(200), password: z.string().min(1).max(256) }).strict(),
    handler: (c) => access.redeemCredentialLink(c.app, String(c.body.token), String(c.body.password), c.principal, c.meta),
  },
  // A demo organization's delivery log: the messages addressed to one person, opened by that person and audited.
  {
    method: 'POST',
    path: '/api/auth/delivery-log',
    auth: 'public',
    rate: 'signIn',
    body: z.object({ to: text(3, 200) }).strict(),
    handler: (c) => access.readDeliveryLog(c.app, String(c.body.to), c.principal, c.meta),
  },
  { method: 'POST', path: '/api/me/mfa/setup', handler: (c) => auth.setupMfa(c.app, c.principal!, c.meta) },
  { method: 'POST', path: '/api/me/mfa/enable', body: z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict(), handler: (c) => auth.enableMfa(c.app, c.principal!, String(c.body.code), c.meta) },
  { method: 'POST', path: '/api/me/mfa/disable', body: z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict(), handler: (c) => auth.disableMfa(c.app, c.principal!, String(c.body.code), c.meta) },
  { method: 'GET', path: '/api/me/tokens', handler: (c) => tokens.listApiTokens(c.app, c.principal!) },
  {
    method: 'POST',
    path: '/api/me/tokens',
    body: z.object({ name: text(2, 60), scope: z.enum(['read', 'write']), expiresInDays: z.number().int() }).strict(),
    handler: (c) => tokens.createApiToken(c.app, c.principal!, c.body as { name: string; scope: tokens.TokenScope; expiresInDays: number }, c.meta),
  },
  { method: 'POST', path: '/api/me/tokens/:id/revoke', handler: (c) => tokens.revokeApiToken(c.app, c.principal!, c.params.id!, c.meta) },
  { method: 'POST', path: '/api/me/password', rate: 'signIn', rateOnFailure: 'login', body: z.object({ current: z.string().min(1).max(256), next: z.string().min(1).max(256) }).strict(), handler: (c) => auth.changePassword(c.app, c.principal!, c.session!, String(c.body.current), String(c.body.next), c.meta) },

  // ------------------------------------------------------------------ home & close
  { method: 'GET', path: '/api/home', handler: (c) => home(c.app, c.principal!) },
  { method: 'GET', path: '/api/closes', handler: (c) => closeUc.listCloses(c.app, c.principal!) },
  { method: 'GET', path: '/api/closes/current', async handler(c) {
    const cur = await closeUc.currentClose(c.app, c.principal!.tenantId);
    if (!cur) throw new DomainError('NOT_FOUND', 'No close yet');
    return closeUc.closeDetail(c.app, c.principal!, cur.id);
  } },
  { method: 'GET', path: '/api/closes/:id', handler: (c) => closeUc.closeDetail(c.app, c.principal!, c.params.id!) },
  { method: 'POST', path: '/api/closes/:id/run', rate: 'agentRun', body: mode, handler: (c) => closeUc.runCloseAgents(c.app, c.principal!, c.params.id!, { mode: c.body.mode as 'offline' | 'live' | undefined }, c.meta) },
  { method: 'POST', path: '/api/closes/:id/review-all', handler: (c) => closeUc.reviewAllReady(c.app, c.principal!, c.params.id!, c.meta) },
  { method: 'POST', path: '/api/closes/:id/lock', body: z.object({ comment: text(0, 500).optional() }).strict(), handler: (c) => closeUc.lockPeriod(c.app, c.principal!, c.params.id!, c.body.comment as string | undefined, c.meta) },
  { method: 'POST', path: '/api/closes/:id/reopen', body: z.object({ reason: text(10, 500) }).strict(), handler: (c) => closeUc.reopenClose(c.app, c.principal!, c.params.id!, String(c.body.reason), c.meta) },
  { method: 'GET', path: '/api/closes/:id/package', handler: (c) => closeUc.closePackage(c.app, c.principal!, c.params.id!) },
  { method: 'POST', path: '/api/closes/:id/package', rate: 'agentRun', handler: (c) => closeUc.generatePackage(c.app, c.principal!, c.params.id!) },
  { method: 'POST', path: '/api/tasks/:id/run', rate: 'agentRun', body: mode, handler: (c) => closeUc.runTask(c.app, c.principal!, c.params.id!, { mode: c.body.mode as 'offline' | 'live' | undefined }) },
  { method: 'POST', path: '/api/tasks/:id/complete', body: z.object({ note: text(0, 500).optional() }).strict(), handler: (c) => closeUc.completeCloseTask(c.app, c.principal!, c.params.id!, c.body.note as string | undefined, c.meta) },
  { method: 'POST', path: '/api/tasks/:id/review', body: z.object({ decision: z.enum(['approve', 'send_back']), note: text(0, 500).optional() }).strict(), handler: (c) => closeUc.reviewCloseTask(c.app, c.principal!, c.params.id!, c.body.decision as 'approve' | 'send_back', c.body.note as string | undefined, c.meta) },

  // ------------------------------------------------------------------ inbox
  {
    method: 'GET',
    path: '/api/proposals',
    handler: (c) => inbox.listProposals(c.app, c.principal!, { view: q(c.query.view) as inbox.InboxView | undefined, kind: q(c.query.kind), skill: q(c.query.skill), entity: q(c.query.entity), closeTaskId: q(c.query.task), runId: q(c.query.run), limit: qn(c.query.limit), offset: qn(c.query.offset) }),
  },
  { method: 'GET', path: '/api/proposals/:id', handler: (c) => inbox.proposalDetail(c.app, c.principal!, c.params.id!) },
  {
    method: 'POST',
    path: '/api/proposals/bulk',
    body: z.object({ ids: z.array(id).min(1).max(200), decision: z.enum(['approve', 'reject']), reason: text(0, 500).optional(), confirm: z.object({ count: z.number().int().nonnegative(), totalMinor: z.number().int() }).strict().optional() }).strict(),
    handler: (c) => inbox.decideBulk(c.app, c.principal!, c.body.ids as string[], c.body.decision as 'approve' | 'reject', c.body.reason as string | undefined, c.meta, c.body.confirm as { count: number; totalMinor: number } | undefined),
  },
  { method: 'POST', path: '/api/proposals/:id/approve', body: z.object({ note: text(0, 500).optional() }).strict(), handler: (c) => inbox.decide(c.app, c.principal!, c.params.id!, 'approve', c.body.note as string | undefined, c.meta) },
  { method: 'POST', path: '/api/proposals/:id/reject', body: z.object({ reason: text(3, 500) }).strict(), handler: (c) => inbox.decide(c.app, c.principal!, c.params.id!, 'reject', String(c.body.reason), c.meta) },
  { method: 'POST', path: '/api/proposals/:id/adopt', handler: (c) => inbox.adopt(c.app, c.principal!, c.params.id!, c.meta) },
  { method: 'POST', path: '/api/proposals/:id/post-hoc', body: z.object({ decision: z.enum(['confirm', 'reverse']), reason: text(0, 500).optional() }).strict(), handler: (c) => inbox.postHocReview(c.app, c.principal!, c.params.id!, c.body.decision as 'confirm' | 'reverse', c.body.reason as string | undefined, c.meta) },

  // ------------------------------------------------------------------ reconciliations
  { method: 'GET', path: '/api/recs', handler: (c) => recs.listRecs(c.app, c.principal!, q(c.query.close)) },
  { method: 'POST', path: '/api/recs/start', body: z.object({ entityId: id, periodId: id, account: text(1, 20) }).strict(), handler: (c) => recs.startRec(c.app, c.principal!, String(c.body.entityId), String(c.body.periodId), String(c.body.account), c.meta) },
  { method: 'GET', path: '/api/recs/:id', handler: (c) => recs.recDetail(c.app, c.principal!, c.params.id!) },
  { method: 'POST', path: '/api/recs/:id/sign', body: z.object({ role: z.enum(['preparer', 'reviewer']), comment: text(0, 500).optional() }).strict(), handler: (c) => recs.signRec(c.app, c.principal!, c.params.id!, c.body.role as 'preparer' | 'reviewer', c.body.comment as string | undefined, c.meta) },
  { method: 'POST', path: '/api/recs/:id/reopen', body: z.object({ reason: text(3, 500) }).strict(), handler: (c) => recs.reopenRec(c.app, c.principal!, c.params.id!, String(c.body.reason), c.meta) },
  { method: 'POST', path: '/api/recs/:id/match', body: z.object({ bankIds: z.array(id).min(1).max(20), ledgerIds: z.array(id).min(1).max(20), note: text(5, 500) }).strict(), handler: (c) => recs.manualMatch(c.app, c.principal!, c.params.id!, c.body.bankIds as string[], c.body.ledgerIds as string[], String(c.body.note), c.meta) },

  // ------------------------------------------------------------------ flux
  { method: 'GET', path: '/api/flux', handler: (c) => ledger.fluxView(c.app, c.principal!, q(c.query.close)) },
  { method: 'POST', path: '/api/flux/lines/:id/explain', body: z.object({ text: text(15, 1500) }).strict(), handler: (c) => ledger.explainFlux(c.app, c.principal!, c.params.id!, String(c.body.text), c.meta) },
  { method: 'POST', path: '/api/flux/:id/approve', body: z.object({ comment: text(0, 500).optional() }).strict(), handler: (c) => ledger.approveFluxAnalysis(c.app, c.principal!, c.params.id!, c.body.comment as string | undefined, c.meta) },

  // ------------------------------------------------------------------ ledger & reports
  {
    method: 'GET',
    path: '/api/journal-entries',
    handler: (c) => ledger.listEntries(c.app, c.principal!, { entity: q(c.query.entity), period: q(c.query.period), status: q(c.query.status), type: q(c.query.type), source: q(c.query.source), q: q(c.query.q), account: q(c.query.account), limit: qn(c.query.limit), offset: qn(c.query.offset) }),
  },
  { method: 'POST', path: '/api/journal-entries', body: DraftInput, handler: (c) => ledger.prepareEntry(c.app, c.principal!, c.body as never, c.meta) },
  { method: 'POST', path: '/api/journal-entries/preview', body: DraftInput, handler: (c) => ledger.previewEntry(c.app, c.principal!, c.body as never) },
  { method: 'GET', path: '/api/journal-entries/:id', handler: (c) => ledger.entryDetail(c.app, c.principal!, c.params.id!) },
  { method: 'POST', path: '/api/journal-entries/:id/approve', handler: (c) => ledger.approveEntry(c.app, c.principal!, c.params.id!, c.meta) },
  { method: 'POST', path: '/api/journal-entries/:id/reject', body: z.object({ reason: text(3, 500) }).strict(), handler: (c) => ledger.rejectEntry(c.app, c.principal!, c.params.id!, String(c.body.reason), c.meta) },
  { method: 'POST', path: '/api/journal-entries/:id/reverse', body: z.object({ reason: text(5, 500) }).strict(), handler: (c) => ledger.reverse(c.app, c.principal!, c.params.id!, String(c.body.reason), c.meta) },
  { method: 'GET', path: '/api/reports/trial-balance', handler: (c) => ledger.trialBalance(c.app, c.principal!, { entity: q(c.query.entity), period: q(c.query.period), mode: q(c.query.mode) as 'balance' | 'activity' | undefined }) },
  { method: 'GET', path: '/api/reports/statements', handler: (c) => ledger.statements(c.app, c.principal!, { entity: q(c.query.entity), period: q(c.query.period) }) },
  { method: 'GET', path: '/api/reports/activity', handler: (c) => ledger.accountActivity(c.app, c.principal!, { account: c.query.account ?? '', entity: q(c.query.entity), period: q(c.query.period) }) },
  {
    method: 'GET',
    path: '/api/reference',
    async handler({ app, principal }) {
      // Resolve the open close first: a read inside another read would wait on the same connection forever.
      const close = await closeUc.currentClose(app, principal!.tenantId);
      return app.read(async (tx) => {
        const lookups = await app.lookups(tx, principal!.tenantId);
        return {
          entities: [...lookups.entitiesById.values()].map((e) => ({ id: e.id, code: e.code, name: e.name, kind: e.kind, currency: e.functional_currency, period: close ? lookups.period(e.id, close.fiscal_year, close.period_number)?.id ?? null : null })),
          accounts: [...lookups.accountsById.values()].filter((a) => a.is_postable).sort((a, b) => a.number.localeCompare(b.number)).map((a) => ({ number: a.number, name: a.name, subtype: a.subtype, class: a.account_class, requiresDepartment: a.requires_department, normalBalance: a.normal_balance })),
          departments: [...new Map([...lookups.departments.values()].map((d) => [d.id, d])).values()].map((d) => ({ code: d.code, name: d.name })),
          period: close ? `${close.fiscal_year}-${String(close.period_number).padStart(2, '0')}` : null,
        };
      });
    },
  },

  // ------------------------------------------------------------------ agents & skills
  { method: 'GET', path: '/api/runs', handler: (c) => agents.listRuns(c.app, c.principal!, { skill: q(c.query.skill), status: q(c.query.status), closeId: q(c.query.close), parentRunId: q(c.query.parent), limit: qn(c.query.limit) }) },
  { method: 'GET', path: '/api/runs/:id', handler: (c) => agents.runDetail(c.app, c.principal!, c.params.id!) },
  { method: 'POST', path: '/api/runs/:id/cancel', body: z.object({ reason: text(0, 300).optional() }).strict(), handler: (c) => agents.cancelRun(c.app, c.principal!, c.params.id!, String(c.body.reason ?? ''), c.meta) },
  { method: 'GET', path: '/api/skills', handler: (c) => agents.listSkills(c.app, c.principal!) },
  { method: 'GET', path: '/api/skills/:key', handler: (c) => agents.skillDetail(c.app, c.principal!, c.params.key!) },
  {
    method: 'POST',
    path: '/api/skills/:key/policy/preview',
    body: z.object({ autonomy: z.enum(['L0', 'L1', 'L2', 'L3']).optional(), thresholds: z.record(z.string(), z.union([z.number(), z.boolean()])).optional(), rulesText: text(0, 8000).optional() }).strict(),
    handler: (c) => agents.previewSkillPolicy(c.app, c.principal!, c.params.key!, c.body as agents.PolicyChangeInput),
  },
  {
    method: 'PUT',
    path: '/api/skills/:key/policy',
    // Autonomy and policy are controls: changed by a person in the web app, never with an access token.
    sessionOnly: true,
    body: z.object({ autonomy: z.enum(['L0', 'L1', 'L2', 'L3']).optional(), thresholds: z.record(z.string(), z.union([z.number(), z.boolean()])).optional(), rulesText: text(0, 8000).optional(), reason: text(5, 500) }).strict(),
    handler: (c) => agents.updateSkillPolicy(c.app, c.principal!, c.params.key!, c.body as agents.PolicyChangeInput, c.meta),
  },

  // ------------------------------------------------------------------ ontology (read-only, any signed-in user)
  { method: 'GET', path: '/api/ontology', permission: 'ontology.view', handler: () => admin.ontologyIndex() },
  { method: 'GET', path: '/api/ontology/terms/:id', permission: 'ontology.view', handler: (c) => admin.ontologyTerm(c.params.id!) },
  { method: 'GET', path: '/api/ontology/graph', permission: 'ontology.view', handler: (c) => admin.ontologyGraph(q(c.query.module)) },
  { method: 'GET', path: '/api/ontology/lookup', permission: 'ontology.view', handler: (c) => admin.ontologyLookup(c.query.q ?? '') },

  // ------------------------------------------------------------------ audit, imports, admin
  { method: 'GET', path: '/api/audit', handler: (c) => admin.auditLog(c.app, c.principal!, { action: q(c.query.action), objectType: q(c.query.objectType), objectId: q(c.query.objectId), actor: q(c.query.actor), limit: qn(c.query.limit), beforeSeq: qn(c.query.before) }) },
  // Verifying recomputes hashes and records that it happened; read-only tokens (auditors) may do it.
  { method: 'POST', path: '/api/audit/verify', tokenScope: 'read', handler: (c) => admin.verifyAudit(c.app, c.principal!, c.meta) },
  { method: 'GET', path: '/api/imports', handler: (c) => admin.listImports(c.app, c.principal!) },
  { method: 'POST', path: '/api/imports', body: z.object({ filename: text(1, 200), content: z.string().max(5_500_000), adapterKey: text(0, 40).optional() }).strict(), handler: (c) => admin.importFile(c.app, c.principal!, c.body as { filename: string; content: string; adapterKey?: string }, c.meta) },
  { method: 'GET', path: '/api/admin/users', handler: (c) => admin.listUsers(c.app, c.principal!) },
  { method: 'POST', path: '/api/admin/users', body: z.object({ email: text(3, 200), name: text(2, 120), title: text(0, 120).optional(), roles: z.array(GrantBody).min(1).max(10), reason: text(0, 500).optional() }).strict(), handler: (c) => admin.createUser(c.app, c.principal!, c.body as never, c.meta) },
  { method: 'PUT', path: '/api/admin/users/:id/roles', body: z.object({ roles: z.array(GrantBody).max(10), reason: text(0, 500).optional() }).strict(), handler: (c) => admin.setUserRoles(c.app, c.principal!, c.params.id!, c.body.roles as access.GrantInput[], c.meta, c.body.reason as string | undefined) },
  { method: 'PUT', path: '/api/admin/users/:id/status', body: z.object({ status: z.enum(['active', 'disabled']) }).strict(), handler: (c) => admin.setUserStatus(c.app, c.principal!, c.params.id!, c.body.status as 'active' | 'disabled', c.meta) },
  { method: 'POST', path: '/api/admin/users/:id/reset-password', handler: (c) => admin.resetPassword(c.app, c.principal!, c.params.id!, c.meta) },
  { method: 'GET', path: '/api/admin/sod-rules', handler: (c) => admin.listSodRules(c.app, c.principal!) },
  { method: 'PATCH', path: '/api/admin/sod-rules/:id', body: z.object({ enabled: z.boolean().optional(), severity: z.enum(['block', 'warn']).optional(), params: z.record(z.string(), z.unknown()).optional(), reason: text(5, 500) }).strict(), handler: (c) => admin.updateSodRule(c.app, c.principal!, c.params.id!, c.body as never, c.meta) },
  { method: 'GET', path: '/api/admin/access-requests', handler: (c) => access.listAccessRequests(c.app, c.principal!) },
  {
    method: 'POST',
    path: '/api/admin/access-requests/:id/decide',
    body: z.object({ decision: z.enum(['approve', 'reject']), reason: text(0, 500).optional() }).strict(),
    handler: (c) => access.decideAccessRequest(c.app, c.principal!, c.params.id!, c.body.decision as 'approve' | 'reject', c.body.reason as string | undefined, c.meta),
  },
  { method: 'GET', path: '/api/admin/sessions', handler: (c) => admin.listSessions(c.app, c.principal!) },
  { method: 'DELETE', path: '/api/admin/sessions/:id', handler: (c) => admin.adminRevokeSession(c.app, c.principal!, c.params.id!, c.meta) },
];
