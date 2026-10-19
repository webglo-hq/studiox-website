import { stableStringify } from '../../../framework/util/canonical';
import { addMonths, periodEnd } from '../../../framework/util/dates';
import { AppError } from '../../../framework/util/errors';
import { sha256Hex } from '../../../framework/util/sha256';
import { audit } from '../domain/audit';
import { hasPermission, requirePermission, withDb, type ServiceContext } from '../domain/context';
import { buildStatement, consolidatedTrialBalance, trialBalance, type Statement, type TrialBalance } from '../domain/reporting';
import { accounts, entities, fxRate, operatingEntities } from '../domain/refdata';
import { completionReadiness, updateTask } from './close';
import { live as liveRec } from './recs';
import { peopleMap, person, type PersonRef } from './common';

/**
 * Close package: the consolidated trial balance, balance sheet and income statement with
 * comparatives, entity statements, reconciliation and checklist status, approved variance
 * commentary, exceptions, adjustments booked during the close and agent activity — hashed so
 * the approver signs exactly what they saw.
 */

export interface PackageContent {
  title: string;
  periodKey: string;
  company: string;
  fictional: boolean;
  currency: string;
  consolidated: { balanceSheet: Statement; incomeStatement: Statement; tbTotals: { debit: number; credit: number }; balanced: boolean; translation: TrialBalance['translation'] };
  entities: { code: string; name: string; currency: string; periodStatus: string; balanceSheet: Statement; incomeStatement: Statement }[];
  reconciliations: { title: string; entity: string; account: string; gl: number; comparison: number; unexplained: number; status: string; preparedBy: string | null; reviewedBy: string | null }[];
  /** `signedWithPackage`: the package's own task, completed by signing it. */
  checklist: { code: string; title: string; status: string; owner: string | null; reviewer: string | null; completedAt: string | null; signedWithPackage?: boolean }[];
  flux: { entity: string; account: string; comparison: string; variance: number; variancePct: number | null; narrative: string | null; status: string; approvedBy: string | null }[];
  exceptions: { title: string; category: string; severity: string; status: string; amount: number | null; resolution: string | null }[];
  adjustments: { entryNumber: string; entity: string; type: string; memo: string; amount: number; source: string; preparedBy: string | null; approvedBy: string | null; policy: string | null }[];
  agentActivity: { runs: number; proposals: number; autoApplied: number; approvedByPeople: number; rejected: number; pending: number; costUsd: number; tokens: number };
  fxRates: { pair: string; closing: number; average: number }[];
  commentary: string | null;
}

/** Month-only TB from two YTD/cumulative TBs (income-statement rows only). */
function monthTb(cur: TrialBalance, prior: TrialBalance | null, periodKey: string): TrialBalance {
  const sameYear = prior && prior.periodKey.slice(0, 4) === periodKey.slice(0, 4);
  const priorNet = new Map((sameYear ? prior!.rows : []).map((r) => [r.accountId, r.net]));
  const ids = new Set([...cur.rows.map((r) => r.accountId), ...priorNet.keys()]);
  const curBy = new Map(cur.rows.map((r) => [r.accountId, r]));
  const priorBy = new Map((prior?.rows ?? []).map((r) => [r.accountId, r]));
  const rows = [];
  for (const id of ids) {
    const base = curBy.get(id) ?? priorBy.get(id)!;
    if (base.accountClass !== 'revenue' && base.accountClass !== 'expense') continue;
    const net = (curBy.get(id)?.net ?? 0) - (priorNet.get(id) ?? 0);
    if (net === 0) continue;
    rows.push({ ...base, net, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));
  const totals = rows.reduce((t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }), { debit: 0, credit: 0 });
  return { ...cur, rows, totals, balanced: true };
}

export async function statementsFor(ctx: ServiceContext, scope: 'consolidated' | string, periodKey: string): Promise<{ bs: Statement; is: Statement; tb: TrialBalance }> {
  const prevKey = addMonths(periodKey, -1);
  const tbOf = (p: string) => (scope === 'consolidated' ? consolidatedTrialBalance(ctx, p) : trialBalance(ctx, scope, p));
  // Comparatives before the first recorded period have no rates or activity: treat as empty.
  const empty = (p: string): TrialBalance => ({ scope: scope === 'consolidated' ? { kind: 'consolidated' } : { kind: 'entity', entityId: scope }, periodKey: p, asOf: periodEnd(p), currency: '', rows: [], totals: { debit: 0, credit: 0 }, balanced: true });
  const safe = (p: string) => tbOf(p).catch((e: unknown) => (e instanceof AppError && e.code === 'NOT_FOUND' ? empty(p) : Promise.reject(e)));
  const [tb, prev, prev2] = await Promise.all([tbOf(periodKey), safe(prevKey), safe(addMonths(periodKey, -2))]);
  const bs = await buildStatement(ctx, 'BS', tb, prev);
  const is = await buildStatement(ctx, 'IS', monthTb(tb, prev, periodKey), monthTb(prev, prev2, prevKey));
  return { bs, is, tb };
}

export async function buildPackageContent(ctx: ServiceContext, periodKey: string, commentary: string | null = null): Promise<PackageContent> {
  const ents = await operatingEntities(ctx);
  const allEnts = await entities(ctx);
  const accts = await accounts(ctx);
  const people = await peopleMap(ctx);
  const name = (id: string | null) => (id ? (people.get(id)?.name ?? null) : null);
  const tenant = await ctx.db.get('tenant', ctx.tenantId);
  const cons = await statementsFor(ctx, 'consolidated', periodKey);
  const entityOut: PackageContent['entities'] = [];
  for (const e of ents) {
    const s = await statementsFor(ctx, e.id, periodKey);
    const fp = await ctx.db.findOne('fiscal_period', { tenant_id: ctx.tenantId, entity_id: e.id, period_key: periodKey });
    entityOut.push({ code: e.code, name: e.name, currency: e.functional_currency, periodStatus: fp?.status ?? 'open', balanceSheet: s.bs, incomeStatement: s.is });
  }
  const recs = (await Promise.all((await ctx.db.find('reconciliation', { tenant_id: ctx.tenantId, period_key: periodKey })).map((r) => liveRec(ctx, r)))).sort((a, b) => `${allEnts.get(a.entity_id)?.code}${accts.get(a.account_id)?.code}${a.rec_type}`.localeCompare(`${allEnts.get(b.entity_id)?.code}${accts.get(b.account_id)?.code}${b.rec_type}`));
  const cycle = await ctx.db.findOne('close_cycle', { tenant_id: ctx.tenantId, period_key: periodKey });
  const tasks = cycle ? await ctx.db.find('close_task', { close_cycle_id: cycle.id }, { orderBy: [['sort_order', 'asc']] }) : [];
  const analyses = await ctx.db.find('flux_analysis', { tenant_id: ctx.tenantId, period_key: periodKey }, { orderBy: [['entity_id', 'asc'], ['comparison', 'asc']] });
  const flux: PackageContent['flux'] = [];
  for (const a of analyses) {
    const lines = (await ctx.db.find('flux_line', { flux_analysis_id: a.id, is_material: true })).sort((x, y) => (accts.get(x.account_id)?.code ?? '').localeCompare(accts.get(y.account_id)?.code ?? ''));
    for (const l of lines) {
      const ex = (await ctx.db.find('flux_explanation', { flux_line_id: l.id }, { orderBy: [['created_at', 'desc']] })).find((x) => x.status === 'approved') ?? null;
      flux.push({ entity: allEnts.get(a.entity_id)?.code ?? '', account: `${accts.get(l.account_id)?.code} ${accts.get(l.account_id)?.name}`, comparison: a.comparison, variance: l.variance, variancePct: l.variance_pct, narrative: ex?.narrative ?? null, status: l.status, approvedBy: name(ex?.approved_by ?? null) });
    }
  }
  const issues = await ctx.db.find('issue', { tenant_id: ctx.tenantId, period_key: periodKey }, { orderBy: [['created_at', 'asc'], ['title', 'asc']] });
  const closeStart = `${periodEnd(periodKey)}T23:59:59.999Z`;
  const adjEntries = await ctx.db.find('journal_entry', { tenant_id: ctx.tenantId, period_key: periodKey, status: 'posted', source: { in: ['manual', 'agent', 'import'] } });
  const codingProposals = new Set((await ctx.db.find('proposal', { tenant_id: ctx.tenantId, period_key: periodKey, kind: 'coding' })).map((p) => p.id));
  const adjustments = adjEntries
    .filter((e) => !(e.proposal_id && codingProposals.has(e.proposal_id)))
    .filter((e) => (e.posted_at ?? '') > closeStart || e.source === 'agent' || e.source === 'import')
    .sort((a, b) => a.entry_number.localeCompare(b.entry_number))
    .map((e) => ({ entryNumber: e.entry_number, entity: allEnts.get(e.entity_id)?.code ?? '', type: e.entry_type, memo: e.memo, amount: e.total_debit, source: e.source, preparedBy: name(e.prepared_by) ?? (e.prepared_by_agent ? `Agent: ${e.prepared_by_agent}` : e.external_preparer), approvedBy: name(e.approved_by) ?? e.external_approver, policy: e.approval_policy }));
  const runs = await ctx.db.find('agent_run', { tenant_id: ctx.tenantId, period_key: periodKey });
  const proposals = await ctx.db.find('proposal', { tenant_id: ctx.tenantId, period_key: periodKey });
  const fxRates: PackageContent['fxRates'] = [];
  for (const e of ents) {
    if (e.functional_currency === (tenant?.reporting_currency ?? 'USD')) continue;
    const pair = `${e.functional_currency}/${tenant?.reporting_currency ?? 'USD'}`;
    fxRates.push({ pair, closing: await fxRate(ctx, e.functional_currency, tenant?.reporting_currency ?? 'USD', periodEnd(periodKey), 'closing'), average: await fxRate(ctx, e.functional_currency, tenant?.reporting_currency ?? 'USD', periodEnd(periodKey), 'average') });
  }
  return {
    title: `Close package — ${periodKey}`,
    periodKey,
    company: tenant?.name ?? '',
    fictional: Boolean((tenant?.settings as Record<string, unknown> | undefined)?.fictional),
    currency: cons.tb.currency,
    consolidated: { balanceSheet: cons.bs, incomeStatement: cons.is, tbTotals: cons.tb.totals, balanced: cons.tb.balanced, translation: cons.tb.translation },
    entities: entityOut,
    reconciliations: recs.map((r) => ({ title: r.notes ?? '', entity: allEnts.get(r.entity_id)?.code ?? '', account: `${accts.get(r.account_id)?.code} ${accts.get(r.account_id)?.name}`, gl: r.gl_balance, comparison: r.comparison_balance, unexplained: r.unexplained, status: r.status, preparedBy: name(r.prepared_by), reviewedBy: name(r.reviewed_by) })),
    checklist: tasks.map((t) => ({ code: t.code, title: t.title, status: t.status, owner: name(t.owner_id), reviewer: name(t.reviewer_id), completedAt: t.completed_at, ...(t.category === 'reporting' ? { signedWithPackage: true } : {}) })),
    flux,
    exceptions: issues.map((i) => ({ title: i.title, category: i.category, severity: i.severity, status: i.status, amount: i.amount, resolution: i.resolution_note })),
    adjustments,
    agentActivity: {
      runs: runs.length,
      proposals: proposals.length,
      autoApplied: proposals.filter((p) => p.status === 'auto_applied').length,
      approvedByPeople: proposals.filter((p) => p.status === 'applied' || p.status === 'approved').length,
      rejected: proposals.filter((p) => p.status === 'rejected').length,
      pending: proposals.filter((p) => p.status === 'pending' || p.status === 'suggested').length,
      costUsd: Math.round(runs.reduce((s, r) => s + r.cost_micros, 0) / 10_000) / 100,
      tokens: runs.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0),
    },
    fxRates,
    commentary,
  };
}

/**
 * Hash of the numbers and words only (statements, balances, differences, commentary,
 * exceptions and adjustments), without workflow status. The close-package agent drafts its
 * commentary from these, so its proposal stays valid while reviews finish.
 */
export function numbersHash(content: PackageContent): string {
  const numbers = {
    ...content,
    agentActivity: undefined,
    checklist: undefined,
    entities: content.entities.map((e) => ({ ...e, periodStatus: undefined })),
    reconciliations: content.reconciliations.map((r) => ({ ...r, status: undefined, preparedBy: undefined, reviewedBy: undefined })),
    exceptions: content.exceptions.map((x) => ({ ...x, status: undefined, resolution: undefined })),
  };
  return sha256Hex(stableStringify(numbers));
}

/**
 * Hash of what the approver signs: the numbers and words, and the close status they rest on —
 * reconciliation sign-offs, exception dispositions and checklist progress. Left out are only
 * the facts that signing and locking change themselves (the package's own task, each
 * entity's period status) and the agent activity counters, which are informational.
 */
export function contentHash(content: PackageContent): string {
  return sha256Hex(stableStringify(signedView(content)));
}

function signedView(content: PackageContent): Record<string, unknown> {
  return {
    ...content,
    agentActivity: undefined,
    entities: content.entities.map((e) => ({ ...e, periodStatus: undefined })),
    checklist: content.checklist.map((t) => (t.signedWithPackage ? { ...t, status: undefined, completedAt: undefined } : t)),
  };
}

const SECTION_LABEL: [keyof PackageContent, string][] = [
  ['consolidated', 'consolidated statements'],
  ['entities', 'entity statements'],
  ['reconciliations', 'reconciliation status'],
  ['checklist', 'close checklist'],
  ['flux', 'variance explanations'],
  ['exceptions', 'exceptions'],
  ['adjustments', 'adjusting entries'],
  ['fxRates', 'exchange rates'],
];

/** In plain words, which parts of a package changed between two builds (for the stale notice). */
export function packageChanges(before: PackageContent, after: PackageContent): string[] {
  const a = signedView(before);
  const b = signedView(after);
  return SECTION_LABEL.filter(([k]) => stableStringify(a[k] ?? null) !== stableStringify(b[k] ?? null)).map(([, label]) => label);
}

export interface PackageSummary {
  id: string;
  periodKey: string;
  version: number;
  status: 'draft' | 'final';
  contentHash: string;
  generatedBy: PersonRef | null;
  generatedAt: string;
  generatedByRun: string | null;
  approvedBy: PersonRef | null;
  approvedAt: string | null;
}

async function toSummary(ctx: ServiceContext, p: { id: string; period_key: string; version: number; status: 'draft' | 'final'; content_hash: string; generated_by: string | null; generated_at: string; generated_by_run: string | null; approved_by: string | null; approved_at: string | null }): Promise<PackageSummary> {
  return { id: p.id, periodKey: p.period_key, version: p.version, status: p.status, contentHash: p.content_hash, generatedBy: await person(ctx, p.generated_by), generatedAt: p.generated_at, generatedByRun: p.generated_by_run, approvedBy: await person(ctx, p.approved_by), approvedAt: p.approved_at };
}

export async function listPackages(ctx: ServiceContext, periodKey?: string): Promise<PackageSummary[]> {
  requirePermission(ctx, 'report.view');
  const rows = await ctx.db.find('close_package', periodKey ? { tenant_id: ctx.tenantId, period_key: periodKey } : { tenant_id: ctx.tenantId }, { orderBy: [['period_key', 'desc'], ['version', 'desc']] });
  return Promise.all(rows.map((r) => toSummary(ctx, r)));
}

export async function getPackage(ctx: ServiceContext, id: string): Promise<{ summary: PackageSummary; content: PackageContent; stale: boolean; changes: string[] }> {
  requirePermission(ctx, 'report.view');
  const p = await ctx.db.get('close_package', id);
  if (!p || p.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Package not found');
  const content = p.content as unknown as PackageContent;
  let changes: string[] = [];
  let stale = false;
  if (p.status === 'draft') {
    const fresh = await buildPackageContent(ctx, p.period_key, content.commentary ?? null);
    stale = contentHash(fresh) !== p.content_hash;
    if (stale) changes = packageChanges(content, fresh);
  }
  return { summary: await toSummary(ctx, p), content, stale, changes };
}

/** Insert the next draft version built from the ledger and the close as they stand now. */
async function insertVersion(ctx: ServiceContext, periodKey: string, opts: { commentary: string | null; runId: string | null; generatedBy: string | null; refreshedFrom?: number }): Promise<PackageSummary> {
  const content = await buildPackageContent(ctx, periodKey, opts.commentary);
  const hash = contentHash(content);
  const prev = await ctx.db.find('close_package', { tenant_id: ctx.tenantId, period_key: periodKey }, { orderBy: [['version', 'desc']], limit: 1 });
  if (prev[0]?.status === 'final') throw new AppError('CONFLICT', 'The package for this period is already final.');
  const row = await ctx.db.tx(async (db) => {
    const r = await db.insert('close_package', { tenant_id: ctx.tenantId, period_key: periodKey, version: (prev[0]?.version ?? 0) + 1, status: 'draft', content: content as unknown as Record<string, unknown>, content_hash: hash, generated_by: opts.generatedBy, generated_by_run: opts.runId, generated_at: ctx.clock.nowIso() });
    await audit(withDb(ctx, db), { action: opts.refreshedFrom ? 'package.refreshed' : 'package.generated', subjectType: 'close_package', subjectId: r.id, data: { periodKey, version: r.version, contentHash: hash, run: opts.runId, ...(opts.refreshedFrom ? { from: opts.refreshedFrom } : {}) } });
    return r;
  });
  return toSummary(ctx, row);
}

/** A person generates a new draft version. */
export async function createPackage(ctx: ServiceContext, periodKey: string, opts: { commentary?: string | null } = {}): Promise<PackageSummary> {
  requirePermission(ctx, 'package.generate');
  return insertVersion(ctx, periodKey, { commentary: opts.commentary ?? null, runId: null, generatedBy: ctx.actor.userId });
}

/**
 * The close-package agent's draft, created when someone approves its proposal. That approval
 * was authorised as a package approval (see the adapter), and the draft is attributed to the
 * person who started the run, who therefore cannot sign it.
 */
export async function createAgentPackage(ctx: ServiceContext, periodKey: string, opts: { commentary: string | null; runId: string; requestedBy: string | null }): Promise<PackageSummary> {
  return insertVersion(ctx, periodKey, { commentary: opts.commentary, runId: opts.runId, generatedBy: opts.requestedBy });
}

/**
 * Rebuild a stale draft as a new version: same commentary and preparer of record, current
 * numbers and close status. It is a deterministic re-render, so the people who sign packages
 * may do it too; they then review the new version before signing.
 */
export async function refreshPackage(ctx: ServiceContext, id: string): Promise<PackageSummary> {
  if (!hasPermission(ctx.actor, 'package.generate')) requirePermission(ctx, 'package.approve');
  const p = await ctx.db.get('close_package', id);
  if (!p || p.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Package not found');
  if (p.status === 'final') throw new AppError('CONFLICT', 'This package is already final.');
  const latest = (await ctx.db.find('close_package', { tenant_id: ctx.tenantId, period_key: p.period_key }, { orderBy: [['version', 'desc']], limit: 1 }))[0]!;
  if (latest.id !== p.id) throw new AppError('CONFLICT', `Version ${latest.version} is newer; refresh or sign that one.`);
  const commentary = (p.content as unknown as PackageContent).commentary ?? null;
  if (contentHash(await buildPackageContent(ctx, p.period_key, commentary)) === p.content_hash) throw new AppError('CONFLICT', 'This version is already current.');
  return insertVersion(ctx, p.period_key, { commentary, runId: p.generated_by_run, generatedBy: p.generated_by, refreshedFrom: p.version });
}

/**
 * Final approval (sign-off). The approver signs a version whose numbers and close status are
 * still current; if anything moved since it was generated (a reconciliation certified, an
 * exception resolved, an entry posted) the approval is refused and the version is refreshed.
 */
export async function approvePackage(ctx: ServiceContext, id: string, statement?: string): Promise<PackageSummary> {
  requirePermission(ctx, 'package.approve');
  const p = await ctx.db.get('close_package', id);
  if (!p || p.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Package not found');
  if (p.status === 'final') throw new AppError('CONFLICT', 'This package is already final.');
  if (p.generated_by && p.generated_by === ctx.actor.userId) throw new AppError('SOD_VIOLATION', 'You generated this package, so someone else must approve it.');
  const stored = p.content as unknown as PackageContent;
  const fresh = await buildPackageContent(ctx, p.period_key, stored.commentary ?? null);
  if (contentHash(fresh) !== p.content_hash) {
    throw new AppError('CONFLICT', `The close changed since version ${p.version} was generated (${packageChanges(stored, fresh).join(', ') || 'content'}). Refresh the package, review the new version and sign that one.`, { stale: true });
  }
  const now = ctx.clock.nowIso();
  const row = await ctx.db.tx(async (db) => {
    const r = await db.update('close_package', p.id, { status: 'final', approved_by: ctx.actor.userId, approved_at: now });
    await db.insert('signoff', { tenant_id: ctx.tenantId, subject_type: 'close_package', subject_id: p.id, role: 'approver', user_id: ctx.actor.userId!, signed_at: now, statement: statement?.trim() || `I approve the ${p.period_key} close package.`, content_hash: p.content_hash });
    await audit(withDb(ctx, db), { action: 'package.approved', subjectType: 'close_package', subjectId: p.id, data: { periodKey: p.period_key, version: p.version, contentHash: p.content_hash } });
    return r;
  });
  // Signing the package is the review of the "prepare the close package" task.
  const cycle = await ctx.db.findOne('close_cycle', { tenant_id: ctx.tenantId, period_key: p.period_key });
  const task = cycle ? (await ctx.db.find('close_task', { close_cycle_id: cycle.id, category: 'reporting' }))[0] : undefined;
  if (task && task.status !== 'complete') {
    const ready = await completionReadiness(ctx, task.id);
    if (ready.ok) await updateTask(ctx, { taskId: task.id, action: 'complete', note: `Close package v${p.version} approved.` });
  }
  return toSummary(ctx, row);
}
