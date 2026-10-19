import { z } from 'zod';
import type { SkillPackage } from '../framework/skills/manifest';
import type { Clock } from '../framework/util/clock';
import { AppError } from '../framework/util/errors';
import { AUTONOMY_LEVELS } from '../framework/skills/manifest';
import type { AgentEngine } from '../packs/accounting/agents/engine';
import { makeContext, requirePermission, type ServiceContext } from '../packs/accounting/domain/context';
import { loadActor } from '../packs/accounting/domain/rbac';
import { Id, JournalEntryDraft, PeriodKeyShape, ReconcilingItemDraft, FluxExplanationDraft } from '../packs/accounting/ontology/shapes';
import { closeSettings, listAudit, listRoles, listSodRules, listUsers, setSodRule, setUserRoles, setUserStatus, updateCloseSettings, verifyAudit, whoAmI } from '../packs/accounting/services/admin';
import { assignTask, closeCalendar, updateTask } from '../packs/accounting/services/close';
import { currentPeriodKey } from '../packs/accounting/services/common';
import { approveExplanation, fluxView, rejectExplanation, submitExplanation, varianceDrivers } from '../packs/accounting/services/flux';
import { myClose } from '../packs/accounting/services/home';
import { getProposal, listProposals, undoProposal } from '../packs/accounting/services/inbox';
import { listConnectors, listDocuments, uploadDocument } from '../packs/accounting/services/integrations';
import { listIssues, updateIssue } from '../packs/accounting/services/issues';
import { approveEntry, createManualEntry, entryDetail, ledgerReference, listEntries, previewManualEntry, rejectEntry, reversePostedEntry } from '../packs/accounting/services/journals';
import { exportOntology, glossary, graph, overview, search, term } from '../packs/accounting/services/ontology-view';
import { approvePackage, createPackage, getPackage, listPackages } from '../packs/accounting/services/package';
import { lockPeriod, lockReadiness, periodsOverview, reopenPeriod, softClose } from '../packs/accounting/services/periods';
import { addReconcilingItem, certifyRec, listRecs, manualMatch, recDetail, resolveReconcilingItem, reviewRec, unmatch } from '../packs/accounting/services/recs';
import { accountActivity, sourceDocument, sourceRecord, statementView, trialBalanceView } from '../packs/accounting/services/reports';
import { listRuns, runTrace } from '../packs/accounting/services/runs';
import { listSkills, previewRules, ruleRefs, setAutonomy, skillDetail, updatePolicy } from '../packs/accounting/services/skills';
import type { EkDb } from '../packs/accounting/store';

/**
 * The application API: one typed registry of methods used by the HTTP server, the in-browser
 * demo and the MCP server. Inputs are validated with zod; every service checks permissions
 * itself (defence in depth) and every mutation is audited by the service layer.
 */

export interface AppEnv {
  db: EkDb;
  tenantId: string;
  clock: Clock;
  engine: AgentEngine;
  skills: SkillPackage[];
  mode: 'server' | 'demo';
  /** Run the close agents in the background (the UI polls close.activity). */
  backgroundAgents: boolean;
}

interface MethodDef<S extends z.ZodType, O> {
  input: S;
  mutates: boolean;
  /** heavier calls get a stricter rate limit on the server */
  expensive?: boolean;
  description: string;
  handler: (ctx: ServiceContext, env: AppEnv, input: z.output<S>) => Promise<O>;
}

function m<S extends z.ZodType, O>(def: MethodDef<S, O>): MethodDef<S, O> {
  return def;
}

const period = z.object({ periodKey: PeriodKeyShape.optional() }).strict();
const empty = z.object({}).strict();
const reason = z.string().trim().min(3).max(1000);
const periodOr = async (ctx: ServiceContext, p?: string) => p ?? (await currentPeriodKey(ctx));
const scope = z.string().regex(/^(consolidated|US|UK|CONSOL)$/);

export const METHODS = {
  'session.me': m({ input: empty, mutates: false, description: 'The signed-in user, roles and permissions', handler: (ctx) => whoAmI(ctx) }),
  'home.myClose': m({ input: empty, mutates: false, description: 'What to do next', handler: (ctx) => myClose(ctx) }),

  'close.calendar': m({ input: period, mutates: false, description: 'Close calendar, progress and blockers', handler: async (ctx, _e, i) => closeCalendar(ctx, await periodOr(ctx, i.periodKey)) }),
  'close.periods': m({ input: empty, mutates: false, description: 'All periods and their states', handler: (ctx) => periodsOverview(ctx) }),
  'close.lockReadiness': m({ input: period, mutates: false, description: 'Checklist for locking the period', handler: async (ctx, _e, i) => lockReadiness(ctx, await periodOr(ctx, i.periodKey)) }),
  'close.updateTask': m({ input: z.object({ taskId: Id, action: z.enum(['start', 'block', 'prepare', 'complete', 'reopen']), note: z.string().max(500).optional() }).strict(), mutates: true, description: 'Move a task through its workflow', handler: (ctx, _e, i) => updateTask(ctx, i) }),
  'close.assignTask': m({ input: z.object({ taskId: Id, ownerId: Id.optional(), reviewerId: Id.optional() }).strict(), mutates: true, description: 'Assign owner/reviewer', handler: (ctx, _e, i) => assignTask(ctx, i) }),
  'close.runTask': m({
    input: z.object({ taskId: Id }).strict(),
    mutates: true,
    expensive: true,
    description: 'Run the agent for one task',
    handler: async (ctx, env, i) => {
      const r = await env.engine.runTask(i.taskId, { userId: ctx.actor.userId });
      return { runId: r.run.id, status: r.run.status, summary: r.run.summary ?? r.run.error };
    },
  }),
  'close.orchestrate': m({
    input: period,
    mutates: true,
    expensive: true,
    description: 'Run (or continue) all close agents',
    handler: async (ctx, env, i) => {
      requirePermission(ctx, 'agent.orchestrate');
      const p = await periodOr(ctx, i.periodKey);
      if (env.backgroundAgents || env.engine.mode === 'live') {
        const r = await env.engine.startOrchestration(p, ctx.actor.userId!);
        return { background: true, runId: null as string | null, status: 'running', summary: r.queued ? 'The agents are already working; they will pick this up when the current pass finishes.' : 'The agents are working. This page updates as each task finishes.' };
      }
      const r = await env.engine.orchestrate(p, ctx.actor.userId!);
      return { background: false, runId: r.run.id as string | null, status: r.run.status as string, summary: r.run.summary };
    },
  }),
  'close.activity': m({
    input: period,
    mutates: false,
    description: 'Whether the close agents are running, and the latest runs',
    handler: async (ctx, env, i) => {
      requirePermission(ctx, 'close.view');
      const p = await periodOr(ctx, i.periodKey);
      return { periodKey: p, ...env.engine.activity(p), runs: await listRuns(ctx, { periodKey: p, limit: 40 }) };
    },
  }),
  'close.softClose': m({ input: z.object({ periodKey: PeriodKeyShape }).strict(), mutates: true, description: 'Soft-close the period', handler: (ctx, _e, i) => softClose(ctx, i.periodKey) }),
  'close.lock': m({ input: z.object({ periodKey: PeriodKeyShape, statement: z.string().max(500).optional() }).strict(), mutates: true, description: 'Lock (hard-close) the period', handler: (ctx, _e, i) => lockPeriod(ctx, i.periodKey, i.statement) }),
  'close.reopen': m({ input: z.object({ periodKey: PeriodKeyShape, reason: z.string().min(10).max(1000) }).strict(), mutates: true, description: 'Reopen a locked period', handler: (ctx, _e, i) => reopenPeriod(ctx, i.periodKey, i.reason) }),

  'inbox.list': m({ input: z.object({ tab: z.enum(['waiting', 'mine', 'review', 'auto', 'decided', 'all']).optional(), kind: z.string().max(40).optional(), skillId: z.string().max(64).optional(), periodKey: PeriodKeyShape.optional(), q: z.string().max(100).optional(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() }).strict(), mutates: false, description: 'Agent proposals', handler: (ctx, _e, i) => listProposals(ctx, i) }),
  'inbox.get': m({ input: z.object({ id: Id }).strict(), mutates: false, description: 'One proposal with evidence', handler: (ctx, _e, i) => getProposal(ctx, i.id) }),
  'inbox.decide': m({
    input: z.object({ ids: z.array(Id).min(1).max(200), decision: z.enum(['approve', 'reject']), reason: z.string().max(1000).optional() }).strict(),
    mutates: true,
    expensive: true,
    description: 'Approve or reject proposals (bulk)',
    handler: async (ctx, env, i) => {
      if (i.decision === 'reject' && (!i.reason || i.reason.trim().length < 3)) throw new AppError('VALIDATION', 'Say briefly why you are rejecting (at least 3 characters).');
      const r = await env.engine.decide({ proposalIds: i.ids, decision: i.decision, reason: i.reason ?? null, userId: ctx.actor.userId!, background: env.backgroundAgents });
      return { results: r.results, continued: r.continued ? { runId: r.continued.run.id, summary: r.continued.run.summary } : null, continuing: r.continuing };
    },
  }),
  'inbox.review': m({ input: z.object({ id: Id, note: z.string().max(500).optional() }).strict(), mutates: true, description: 'Complete a post-hoc review', handler: async (ctx, env, i) => { const r = await env.engine.review(i.id, ctx.actor.userId!, i.note); return { id: r.id, reviewStatus: r.reviewStatus }; } }),
  'inbox.undo': m({ input: z.object({ id: Id, reason }).strict(), mutates: true, description: 'Undo an applied entry by reversal', handler: (ctx, _e, i) => undoProposal(ctx, i.id, i.reason) }),

  'recs.list': m({ input: period, mutates: false, description: 'Reconciliations for the period', handler: async (ctx, _e, i) => listRecs(ctx, await periodOr(ctx, i.periodKey)) }),
  'recs.get': m({ input: z.object({ id: Id }).strict(), mutates: false, description: 'Reconciliation workbench', handler: (ctx, _e, i) => recDetail(ctx, i.id) }),
  'recs.certify': m({ input: z.object({ id: Id, statement: z.string().max(500).optional() }).strict(), mutates: true, description: 'Preparer certification', handler: (ctx, _e, i) => certifyRec(ctx, i.id, i.statement) }),
  'recs.review': m({ input: z.object({ id: Id, approve: z.boolean(), note: z.string().max(1000).optional() }).strict(), mutates: true, description: 'Reviewer sign-off or return', handler: (ctx, _e, i) => reviewRec(ctx, i.id, { approve: i.approve, note: i.note }) }),
  'recs.addItem': m({ input: z.object({ id: Id, item: ReconcilingItemDraft }).strict(), mutates: true, description: 'Add a reconciling item', handler: (ctx, _e, i) => addReconcilingItem(ctx, i.id, { ...i.item, reconciliationId: i.id }) }),
  'recs.resolveItem': m({ input: z.object({ itemId: Id, status: z.enum(['cleared', 'resolved', 'written_off']), note: z.string().min(3).max(500) }).strict(), mutates: true, description: 'Resolve a reconciling item', handler: (ctx, _e, i) => resolveReconcilingItem(ctx, i.itemId, { status: i.status, note: i.note }) }),
  'recs.match': m({ input: z.object({ reconciliationId: Id, bankTransactionIds: z.array(Id).min(1).max(50), journalLineIds: z.array(Id).min(1).max(50), note: z.string().max(300).optional() }).strict(), mutates: true, description: 'Manual match', handler: (ctx, _e, i) => manualMatch(ctx, i) }),
  'recs.unmatch': m({ input: z.object({ matchId: Id, reason }).strict(), mutates: true, description: 'Undo a match', handler: (ctx, _e, i) => unmatch(ctx, i.matchId, i.reason) }),

  'flux.view': m({ input: z.object({ entityCode: z.enum(['US', 'UK']), comparison: z.enum(['prior_month', 'budget']), periodKey: PeriodKeyShape.optional() }).strict(), mutates: false, description: 'Variance analysis', handler: async (ctx, _e, i) => fluxView(ctx, { entityCode: i.entityCode, comparison: i.comparison, periodKey: await periodOr(ctx, i.periodKey) }) }),
  'flux.drivers': m({ input: z.object({ entityId: Id, accountId: Id, comparison: z.enum(['prior_month', 'budget']), periodKey: PeriodKeyShape.optional() }).strict(), mutates: false, expensive: true, description: 'Driver analysis for one line', handler: async (ctx, _e, i) => { requirePermission(ctx, 'report.view'); return varianceDrivers(ctx, { ...i, periodKey: await periodOr(ctx, i.periodKey) }); } }),
  'flux.explain': m({ input: FluxExplanationDraft, mutates: true, description: 'Write an explanation', handler: async (ctx, _e, i) => ({ id: await submitExplanation(ctx, i) }) }),
  'flux.approve': m({ input: z.object({ explanationId: Id }).strict(), mutates: true, description: 'Approve an explanation', handler: async (ctx, _e, i) => { await approveExplanation(ctx, i.explanationId); return { ok: true }; } }),
  'flux.reject': m({ input: z.object({ explanationId: Id, reason }).strict(), mutates: true, description: 'Send an explanation back', handler: async (ctx, _e, i) => { await rejectExplanation(ctx, i.explanationId, i.reason); return { ok: true }; } }),

  'journals.reference': m({ input: empty, mutates: false, description: 'Entities, chart of accounts and departments', handler: (ctx) => ledgerReference(ctx) }),
  'journals.list': m({ input: z.object({ periodKey: PeriodKeyShape.optional(), entityCode: z.enum(['US', 'UK', 'CONSOL']).optional(), status: z.enum(['draft', 'pending_approval', 'posted', 'rejected']).optional(), source: z.enum(['manual', 'agent', 'import', 'system', 'subledger']).optional(), type: z.string().max(30).optional(), accountId: Id.optional(), q: z.string().max(80).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }).strict(), mutates: false, description: 'Journal entries', handler: (ctx, _e, i) => listEntries(ctx, i) }),
  'journals.get': m({ input: z.object({ id: Id }).strict(), mutates: false, description: 'Entry with lines, sources and audit trail', handler: (ctx, _e, i) => entryDetail(ctx, i.id) }),
  'journals.preview': m({ input: z.object({ draft: JournalEntryDraft }).strict(), mutates: false, description: 'Validate a draft against the ontology', handler: (ctx, _e, i) => previewManualEntry(ctx, i.draft) }),
  'journals.create': m({ input: z.object({ draft: JournalEntryDraft, submit: z.boolean() }).strict(), mutates: true, description: 'Prepare a manual entry', handler: (ctx, _e, i) => createManualEntry(ctx, i) }),
  'journals.approve': m({ input: z.object({ id: Id }).strict(), mutates: true, description: 'Approve and post', handler: (ctx, _e, i) => approveEntry(ctx, i.id) }),
  'journals.reject': m({ input: z.object({ id: Id, reason }).strict(), mutates: true, description: 'Reject an unposted entry', handler: (ctx, _e, i) => rejectEntry(ctx, i.id, i.reason) }),
  'journals.reverse': m({ input: z.object({ id: Id, reason: z.string().trim().min(5).max(500) }).strict(), mutates: true, description: 'Reverse a posted entry', handler: (ctx, _e, i) => reversePostedEntry(ctx, i.id, i.reason) }),

  'reports.trialBalance': m({ input: z.object({ scope, periodKey: PeriodKeyShape.optional() }).strict(), mutates: false, expensive: true, description: 'Trial balance', handler: async (ctx, _e, i) => trialBalanceView(ctx, { scope: i.scope, periodKey: await periodOr(ctx, i.periodKey) }) }),
  'reports.statement': m({ input: z.object({ kind: z.enum(['BS', 'IS']), scope, periodKey: PeriodKeyShape.optional() }).strict(), mutates: false, expensive: true, description: 'Balance sheet or income statement', handler: async (ctx, _e, i) => statementView(ctx, { kind: i.kind, scope: i.scope, periodKey: await periodOr(ctx, i.periodKey) }) }),
  'reports.activity': m({ input: z.object({ accountId: Id, scope, periodKey: PeriodKeyShape.optional(), ytd: z.boolean().optional() }).strict(), mutates: false, description: 'Account drill-down', handler: async (ctx, _e, i) => accountActivity(ctx, { accountId: i.accountId, scope: i.scope, periodKey: await periodOr(ctx, i.periodKey), ytd: i.ytd }) }),
  'reports.record': m({ input: z.object({ type: z.string().max(40), id: Id }).strict(), mutates: false, description: 'Source record', handler: (ctx, _e, i) => sourceRecord(ctx, i) }),
  'reports.document': m({ input: z.object({ id: Id }).strict(), mutates: false, description: 'Source document', handler: (ctx, _e, i) => sourceDocument(ctx, i.id) }),

  'issues.list': m({ input: z.object({ periodKey: PeriodKeyShape.optional(), status: z.array(z.enum(['open', 'acknowledged', 'resolved', 'dismissed'])).optional() }).strict(), mutates: false, description: 'Exceptions', handler: (ctx, _e, i) => listIssues(ctx, i) }),
  'issues.update': m({ input: z.object({ issueId: Id, action: z.enum(['acknowledge', 'resolve', 'dismiss', 'reopen']), note: z.string().max(1000).optional() }).strict(), mutates: true, description: 'Disposition an exception', handler: async (ctx, _e, i) => { await updateIssue(ctx, i); return { ok: true }; } }),

  'package.list': m({ input: period, mutates: false, description: 'Close packages', handler: (ctx, _e, i) => listPackages(ctx, i.periodKey) }),
  'package.get': m({ input: z.object({ id: Id }).strict(), mutates: false, expensive: true, description: 'Close package content', handler: (ctx, _e, i) => getPackage(ctx, i.id) }),
  'package.generate': m({ input: z.object({ periodKey: PeriodKeyShape.optional(), commentary: z.string().max(10_000).optional() }).strict(), mutates: true, expensive: true, description: 'Generate a new draft package', handler: async (ctx, _e, i) => createPackage(ctx, await periodOr(ctx, i.periodKey), { commentary: i.commentary ?? null }) }),
  'package.approve': m({ input: z.object({ id: Id, statement: z.string().max(500).optional() }).strict(), mutates: true, expensive: true, description: 'Approve (sign) the package', handler: (ctx, _e, i) => approvePackage(ctx, i.id, i.statement) }),

  'runs.list': m({ input: z.object({ periodKey: PeriodKeyShape.optional(), skillId: z.string().max(64).optional(), status: z.string().max(30).optional(), limit: z.number().int().min(1).max(500).optional() }).strict(), mutates: false, description: 'Agent runs', handler: (ctx, _e, i) => listRuns(ctx, i) }),
  'runs.get': m({ input: z.object({ id: Id }).strict(), mutates: false, description: 'Run trace', handler: (ctx, _e, i) => runTrace(ctx, i.id) }),

  'skills.list': m({ input: empty, mutates: false, description: 'Skill catalog', handler: (ctx, env) => listSkills(ctx, env.skills) }),
  'skills.get': m({ input: z.object({ id: z.string().max(64) }).strict(), mutates: false, description: 'Skill detail and policy history', handler: (ctx, env, i) => skillDetail(ctx, env.skills, i.id) }),
  'skills.previewRules': m({ input: z.object({ text: z.string().max(20_000) }).strict(), mutates: false, description: 'Compile plain-English rules', handler: async (ctx, _e, i) => { requirePermission(ctx, 'close.view'); return previewRules(await ruleRefs(ctx), i.text); } }),
  'skills.updatePolicy': m({ input: z.object({ skillId: z.string().max(64), rulesText: z.string().max(20_000).optional(), thresholds: z.record(z.string(), z.number()).optional(), enabled: z.boolean().optional(), note: z.string().min(5).max(500) }).strict(), mutates: true, description: 'New policy version', handler: (ctx, env, i) => updatePolicy(ctx, env.skills, i) }),
  'skills.setAutonomy': m({ input: z.object({ skillId: z.string().max(64), level: z.enum(AUTONOMY_LEVELS), note: z.string().min(5).max(500) }).strict(), mutates: true, description: 'Set autonomy level', handler: (ctx, env, i) => setAutonomy(ctx, env.skills, i) }),

  'ontology.overview': m({ input: empty, mutates: false, description: 'Ontology overview', handler: async (ctx) => overview(ctx) }),
  'ontology.term': m({ input: z.object({ id: z.string().max(80) }).strict(), mutates: false, description: 'Term definition', handler: async (ctx, _e, i) => term(ctx, i.id) }),
  'ontology.search': m({ input: z.object({ q: z.string().max(80) }).strict(), mutates: false, description: 'Search terms', handler: async (ctx, _e, i) => search(ctx, i.q) }),
  'ontology.graph': m({ input: empty, mutates: false, description: 'Class graph', handler: async (ctx) => graph(ctx) }),
  'ontology.export': m({ input: z.object({ format: z.enum(['jsonld', 'ttl']) }).strict(), mutates: false, description: 'Export JSON-LD or Turtle', handler: async (ctx, _e, i) => exportOntology(ctx, i.format) }),
  'ontology.glossary': m({ input: empty, mutates: false, description: 'Hover definitions', handler: async (ctx) => glossary(ctx) }),

  'audit.list': m({ input: z.object({ action: z.string().max(60).optional(), subjectId: z.string().max(80).optional(), actorType: z.enum(['user', 'agent', 'system']).optional(), q: z.string().max(80).optional(), beforeSeq: z.number().int().optional(), limit: z.number().int().min(1).max(500).optional() }).strict(), mutates: false, description: 'Audit log', handler: (ctx, _e, i) => listAudit(ctx, i) }),
  'audit.verify': m({ input: empty, mutates: false, expensive: true, description: 'Verify the hash chain', handler: (ctx) => verifyAudit(ctx) }),

  'admin.users': m({ input: empty, mutates: false, description: 'Users and roles', handler: (ctx) => listUsers(ctx) }),
  'admin.roles': m({ input: empty, mutates: false, description: 'Roles and permissions', handler: (ctx) => listRoles(ctx) }),
  'admin.setRoles': m({ input: z.object({ userId: Id, roles: z.array(z.string().max(40)).max(8) }).strict(), mutates: true, description: 'Replace a user’s roles', handler: (ctx, _e, i) => setUserRoles(ctx, i) }),
  'admin.setStatus': m({ input: z.object({ userId: Id, status: z.enum(['active', 'disabled']) }).strict(), mutates: true, description: 'Enable or disable a user', handler: async (ctx, _e, i) => { await setUserStatus(ctx, i); return { ok: true }; } }),
  'admin.sodRules': m({ input: empty, mutates: false, description: 'Segregation-of-duties rules', handler: (ctx) => listSodRules(ctx) }),
  'admin.setSodRule': m({ input: z.object({ code: z.string().max(20), enabled: z.boolean(), note: z.string().min(5).max(500) }).strict(), mutates: true, description: 'Enable/disable a SoD rule', handler: async (ctx, _e, i) => { await setSodRule(ctx, i); return { ok: true }; } }),
  'admin.settings': m({ input: empty, mutates: false, description: 'Close settings', handler: (ctx) => closeSettings(ctx) }),
  'admin.updateSettings': m({ input: z.object({ materiality: z.object({ overall: z.number().int().positive(), performance: z.number().int().positive(), clearlyTrivial: z.number().int().positive() }).optional(), capitalizationThreshold: z.number().int().positive().optional(), prepaidThreshold: z.number().int().positive().optional(), autoContinue: z.boolean().optional(), note: z.string().min(5).max(500) }).strict(), mutates: true, description: 'Update materiality and thresholds', handler: (ctx, _e, i) => updateCloseSettings(ctx, i) }),

  'integrations.connectors': m({ input: empty, mutates: false, description: 'Connectors', handler: (ctx) => listConnectors(ctx) }),
  'integrations.documents': m({ input: z.object({ connectorId: Id.optional(), limit: z.number().int().min(1).max(200).optional() }).strict(), mutates: false, description: 'Imported documents', handler: (ctx, _e, i) => listDocuments(ctx, i) }),
  'integrations.upload': m({ input: z.object({ connectorId: Id, filename: z.string().min(1).max(200), content: z.string().max(5 * 1024 * 1024) }).strict(), mutates: true, expensive: true, description: 'Import a file', handler: (ctx, _e, i) => uploadDocument(ctx, i) }),
} as const;

export type Methods = typeof METHODS;
export type MethodName = keyof Methods;
export type MethodInput<K extends MethodName> = z.input<Methods[K]['input']>;
export type MethodOutput<K extends MethodName> = Awaited<ReturnType<Methods[K]['handler']>>;

export function isMethod(name: string): name is MethodName {
  return Object.prototype.hasOwnProperty.call(METHODS, name);
}

export interface Caller {
  userId: string;
  ip?: string | null;
}

/** Invoke a method as a signed-in user. Errors are AppErrors with stable codes. */
export async function invoke(env: AppEnv, caller: Caller, name: string, raw: unknown): Promise<unknown> {
  if (!isMethod(name)) throw new AppError('NOT_FOUND', `Unknown method ${name}`);
  const def = METHODS[name] as unknown as MethodDef<z.ZodType, unknown>;
  const parsed = def.input.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  const actor = await loadActor(env.db, env.tenantId, caller.userId, { ip: caller.ip ?? null });
  const ctx = makeContext(env.db, env.tenantId, actor, env.clock);
  return def.handler(ctx, env, parsed.data);
}

export function methodInfo(name: MethodName): { mutates: boolean; expensive: boolean; description: string } {
  const d = METHODS[name] as unknown as MethodDef<z.ZodType, unknown>;
  return { mutates: d.mutates, expensive: !!d.expensive, description: d.description };
}
