import { z } from 'zod';
import { addMonths, hourInZone, periodEnd, periodStart } from '../../../framework/util/dates';
import { benfordFirstDigit, controlAccountPostings, duplicatePayments, roundAmounts, sodBreaks, thresholdAvoidance, unusualPairs, weekendPostings, type EntryFact, type Finding, type PaymentFact } from '../domain/anomaly-math';
import { accounts, entities, entityByCode } from '../domain/refdata';
import { Id } from '../ontology/shapes';
import { closeCalendar, orchTasks } from '../services/close';
import { settings } from '../services/common';
import { computeFluxLines, DEFAULT_THRESHOLD, varianceDrivers, type Comparison } from '../services/flux';
import { listIssues } from '../services/issues';
import { buildPackageContent, numbersHash } from '../services/package';
import { lockReadiness } from '../services/periods';
import { listRecs } from '../services/recs';
import type { AgentCtx } from './context';
import { defineTool, type AnyTool } from './tool-kit';

// ------------------------------------------------------------------ JE review

async function entryFacts(ctx: AgentCtx, from: string, to: string): Promise<{ facts: EntryFact[]; byId: Map<string, { entryNumber: string; memo: string; source: string }> }> {
  const accs = await accounts(ctx.svc);
  const entries = await ctx.svc.db.find('journal_entry', { tenant_id: ctx.svc.tenantId, status: 'posted', period_key: { gte: from, lte: to } });
  const lines = entries.length ? await ctx.svc.db.find('journal_line', { journal_entry_id: { in: entries.map((e) => e.id) } }) : [];
  const byEntry = new Map<string, typeof lines>();
  for (const l of lines) byEntry.set(l.journal_entry_id, [...(byEntry.get(l.journal_entry_id) ?? []), l]);
  const facts: EntryFact[] = [];
  const byId = new Map<string, { entryNumber: string; memo: string; source: string }>();
  for (const e of entries) {
    if (e.entity_id && e.entry_type === 'elimination') continue;
    const ls = byEntry.get(e.id) ?? [];
    // Journals keyed by people in another system are manual entries for testing purposes.
    const manualLike = e.source === 'manual' || (e.source === 'import' && !!e.external_preparer);
    facts.push({
      id: e.id,
      entryNumber: e.entry_number,
      entryDate: e.entry_date,
      entryType: e.entry_type,
      source: manualLike ? 'manual' : e.source,
      memo: e.memo,
      amount: e.total_debit,
      preparedBy: e.prepared_by,
      approvedBy: e.approved_by,
      externalPreparer: e.external_preparer,
      externalApprover: e.external_approver,
      postedAt: e.posted_at,
      externalPostedAt: e.external_posted_at,
      accountsDebited: ls.filter((l) => l.debit > 0).map((l) => accs.get(l.account_id)?.code ?? ''),
      accountsCredited: ls.filter((l) => l.credit > 0).map((l) => accs.get(l.account_id)?.code ?? ''),
      controlAccountsTouched: [...new Set(ls.map((l) => accs.get(l.account_id)).filter((a) => a?.is_control_account && a.subledger !== 'bank').map((a) => `${a!.code} ${a!.name}`))],
      revenueTouched: ls.some((l) => accs.get(l.account_id)?.account_class === 'revenue'),
    });
    byId.set(e.id, { entryNumber: e.entry_number, memo: e.memo, source: e.source });
  }
  return { facts, byId };
}

export const listPeriodEntries = defineTool({
  name: 'list_period_entries',
  description: 'Posted journal entries in the period with preparer, approver, source and posting time (memos are external data).',
  input: z.object({ source: z.enum(['manual', 'agent', 'import', 'system', 'subledger']).optional(), limit: z.number().int().min(1).max(500).default(200) }),
  outputClass: 'ek:JournalEntry',
  permission: 'report.view',
  untrustedFields: ['items[].memo'],
  handler: async (ctx: AgentCtx, input: { source?: string; limit: number }) => {
    const rows = await ctx.svc.db.find('journal_entry', { tenant_id: ctx.svc.tenantId, period_key: ctx.periodKey, status: 'posted', ...(input.source ? { source: input.source as never } : {}) }, { orderBy: [['entry_date', 'asc']], limit: input.limit });
    const ents = await entities(ctx.svc);
    return { items: rows.map((e) => ({ id: e.id, entryNumber: e.entry_number, entity: ents.get(e.entity_id)?.code ?? '', date: e.entry_date, type: e.entry_type, source: e.source, memo: e.memo, amount: e.total_debit, preparedBy: e.prepared_by, approvedBy: e.approved_by, externalPreparer: e.external_preparer, externalApprover: e.external_approver, postedAt: e.external_posted_at ?? e.posted_at })) };
  },
});

export const getJournalEntry = defineTool({
  name: 'get_journal_entry',
  description: 'One journal entry with its lines (account, debit, credit, department, counterparty) and who prepared and approved it.',
  input: z.object({ entryId: Id }),
  outputClass: 'ek:JournalEntry',
  permission: 'report.view',
  untrustedFields: ['memo', 'lines[].memo'],
  handler: async (ctx: AgentCtx, input: { entryId: string }) => {
    const e = await ctx.svc.db.get('journal_entry', input.entryId);
    if (!e || e.tenant_id !== ctx.svc.tenantId) throw new Error('Journal entry not found');
    const accs = await accounts(ctx.svc);
    const lines = await ctx.svc.db.find('journal_line', { journal_entry_id: e.id }, { orderBy: [['line_no', 'asc']] });
    return {
      id: e.id,
      entryNumber: e.entry_number,
      entityId: e.entity_id,
      periodKey: e.period_key,
      date: e.entry_date,
      type: e.entry_type,
      status: e.status,
      source: e.source,
      memo: e.memo,
      currency: e.currency,
      reversedBy: e.reversed_by_entry_id,
      preparedBy: e.prepared_by,
      approvedBy: e.approved_by,
      externalPreparer: e.external_preparer,
      externalApprover: e.external_approver,
      lines: lines.map((l) => ({ accountId: l.account_id, accountCode: accs.get(l.account_id)?.code ?? '', debit: l.debit, credit: l.credit, memo: l.memo, departmentId: l.department_id, counterpartyEntityId: l.counterparty_entity_id, txnCurrency: l.txn_currency, txnAmount: l.txn_amount })),
    };
  },
});

export interface JeTestsOut {
  periodKey: string;
  tested: { entries: number; payments: number };
  findings: (Finding & { entries: { id: string; entryNumber: string; memo: string; source: string }[] })[];
  benford: ReturnType<typeof benfordFirstDigit>;
}

export const runJeTests = defineTool({
  name: 'run_je_tests',
  description: 'Runs journal-entry tests over the period: duplicate payments, self-approval, round amounts, weekend/after-hours postings, manual postings to control accounts, threshold avoidance, unusual account pairs, plus a Benford first-digit test.',
  input: z.object({}),
  outputClass: 'ek:Exception',
  permission: 'report.view',
  untrustedFields: ['findings[].entries[].memo'],
  handler: async (ctx: AgentCtx): Promise<JeTestsOut> => {
    const s = await settings(ctx.svc);
    const { facts, byId } = await entryFacts(ctx, ctx.periodKey, ctx.periodKey);
    const history = await entryFacts(ctx, addMonths(ctx.periodKey, -12), addMonths(ctx.periodKey, -1));
    const known = new Set<string>();
    for (const f of history.facts) if (f.source === 'manual' || f.source === 'import') for (const d of f.accountsDebited) for (const c of f.accountsCredited) known.add(`${d}>${c}`);
    const pays = await ctx.svc.db.find('vendor_payment', { tenant_id: ctx.svc.tenantId, payment_date: { gte: periodStart(addMonths(ctx.periodKey, -1)), lte: periodEnd(ctx.periodKey) } });
    const vendors = new Map((await ctx.svc.db.find('vendor', { tenant_id: ctx.svc.tenantId })).map((v) => [v.id, v.name]));
    const bills = new Map((await ctx.svc.db.find('bill', { id: { in: pays.map((p) => p.bill_id).filter((x): x is string => !!x) } })).map((b) => [b.id, b.bill_number]));
    const payments: PaymentFact[] = pays.map((p) => ({ id: p.id, vendorId: p.vendor_id, vendorName: vendors.get(p.vendor_id) ?? 'Vendor', billId: p.bill_id, billNumber: p.bill_id ? (bills.get(p.bill_id) ?? null) : null, amount: p.amount, paymentDate: p.payment_date, method: p.method, reference: p.reference }));
    const threshold = ctx.policy.thresholds.approvalThreshold ?? 5_000_000;
    const raw: Finding[] = [
      ...duplicatePayments(payments).filter((f) => f.subjectIds.some((id) => pays.find((p) => p.id === id)!.payment_date >= periodStart(ctx.periodKey))),
      ...sodBreaks(facts),
      ...roundAmounts(facts, ctx.policy.thresholds.roundAmountMin ?? 1_000_000),
      ...weekendPostings(facts, (iso) => hourInZone(new Date(iso), s.timezone)),
      ...controlAccountPostings(facts),
      ...thresholdAvoidance(facts, threshold),
      ...unusualPairs(facts, known),
    ];
    const amounts = facts.filter((f) => f.source !== 'system').map((f) => f.amount);
    return {
      periodKey: ctx.periodKey,
      tested: { entries: facts.length, payments: payments.length },
      findings: raw.map((f) => ({ ...f, entries: f.subjectIds.filter((id) => byId.has(id)).map((id) => ({ id, ...byId.get(id)! })) })),
      benford: benfordFirstDigit(amounts),
    };
  },
});

// ------------------------------------------------------------------ flux

export const computeFlux = defineTool({
  name: 'compute_flux',
  description: 'Income-statement variances for one entity against the prior month or budget, with the materiality flag from the policy thresholds (absolute AND percentage).',
  input: z.object({ entityCode: z.enum(['US', 'UK']), comparison: z.enum(['prior_month', 'budget']) }),
  outputClass: 'ek:Variance',
  permission: 'report.view',
  handler: async (ctx: AgentCtx, input: { entityCode: 'US' | 'UK'; comparison: Comparison }) => {
    const ent = await entityByCode(ctx.svc, input.entityCode);
    const threshold = { abs: ctx.policy.thresholds.absThreshold ?? DEFAULT_THRESHOLD.abs, pct: ctx.policy.thresholds.pctThreshold ?? DEFAULT_THRESHOLD.pct, mode: 'and' as const };
    const lines = await computeFluxLines(ctx.svc, ent.id, ctx.periodKey, input.comparison, threshold);
    return { entityId: ent.id, entityCode: ent.code, currency: ent.functional_currency, periodKey: ctx.periodKey, comparison: input.comparison, threshold, lines };
  },
});

export const analyzeVarianceDrivers = defineTool({
  name: 'analyze_variance_drivers',
  description: 'Decomposes one account’s variance into drivers (new vendor, one-time, accrual, volume, rate) from transaction detail, with coverage and a deterministic draft narrative.',
  input: z.object({ entityCode: z.enum(['US', 'UK']), accountId: Id, comparison: z.enum(['prior_month', 'budget']) }),
  inputClass: 'ek:Variance',
  outputClass: 'ek:VarianceDriver',
  permission: 'report.view',
  untrustedFields: ['drivers[].label', 'narrative'],
  handler: async (ctx: AgentCtx, input: { entityCode: 'US' | 'UK'; accountId: string; comparison: Comparison }) => {
    const ent = await entityByCode(ctx.svc, input.entityCode);
    return varianceDrivers(ctx.svc, { entityId: ent.id, accountId: input.accountId, periodKey: ctx.periodKey, comparison: input.comparison });
  },
});

// ------------------------------------------------------------------ close package & calendar

export const getCloseStatus = defineTool({
  name: 'get_close_status',
  description: 'Where the close stands: tasks, reconciliations, exceptions, pending proposals and the lock checklist.',
  input: z.object({}),
  outputClass: 'ek:CloseCycle',
  permission: 'close.view',
  untrustedFields: ['issues[].title'],
  handler: async (ctx: AgentCtx) => {
    const cal = await closeCalendar(ctx.svc, ctx.periodKey);
    const recs = await listRecs(ctx.svc, ctx.periodKey);
    const issues = await listIssues(ctx.svc, { periodKey: ctx.periodKey });
    const ready = await lockReadiness(ctx.svc, ctx.periodKey);
    return {
      periodKey: ctx.periodKey,
      progress: cal.progress,
      tasks: cal.tasks.map((t) => ({ code: t.code, title: t.title, status: t.status, pending: t.pendingProposals })),
      recs: recs.map((r) => ({ title: r.title, status: r.status, difference: r.difference, unexplained: r.unexplained })),
      issues: issues.map((i) => ({ title: i.title, severity: i.severity, status: i.status, amount: i.amount })),
      lockChecklist: ready.checks,
    };
  },
});

export const buildClosePackage = defineTool({
  name: 'build_close_package',
  description: 'Builds the close package deterministically (statements, sections, reconciliation and checklist status) and returns its content hash and key figures. Does not save anything.',
  input: z.object({}),
  outputClass: 'ek:ClosePackage',
  permission: 'report.view',
  handler: async (ctx: AgentCtx) => {
    const content = await buildPackageContent(ctx.svc, ctx.periodKey, null);
    const is = content.consolidated.incomeStatement;
    const sub = (label: string) => is.subtotals.find((x) => x.label === label);
    const sec = (name: string) => is.sections.find((x) => x.name === name);
    const bs = content.consolidated.balanceSheet;
    return {
      periodKey: ctx.periodKey,
      contentHashWithoutCommentary: numbersHash(content),
      keyFigures: {
        currency: content.currency,
        revenue: sec('Revenue')?.total ?? 0,
        revenuePrior: sec('Revenue')?.comparisonTotal ?? 0,
        operatingExpenses: sec('Operating expenses')?.total ?? 0,
        operatingExpensesPrior: sec('Operating expenses')?.comparisonTotal ?? 0,
        netIncome: sub('Net income')?.amount ?? 0,
        netIncomePrior: sub('Net income')?.comparison ?? 0,
        totalAssets: bs.subtotals.find((x) => x.label === 'Total assets')?.amount ?? 0,
        cash: bs.sections.flatMap((s) => s.lines).find((l) => l.code === 'BS-CASH')?.amount ?? 0,
        balanced: content.consolidated.balanced,
      },
      approvedFlux: content.flux.filter((f) => f.status === 'approved').map((f) => ({ entity: f.entity, account: f.account, comparison: f.comparison, variance: f.variance, narrative: f.narrative })),
      openExceptions: content.exceptions.filter((x) => x.status === 'open' || x.status === 'acknowledged').map((x) => ({ title: x.title, severity: x.severity, amount: x.amount })),
      adjustments: content.adjustments.length,
      sections: [
        { id: 'commentary', title: 'Executive commentary', kind: 'narrative' as const },
        { id: 'bs', title: 'Consolidated balance sheet', kind: 'table' as const },
        { id: 'is', title: 'Consolidated income statement', kind: 'table' as const },
        { id: 'entities', title: 'Entity statements', kind: 'table' as const },
        { id: 'recs', title: 'Reconciliations', kind: 'checklist' as const },
        { id: 'checklist', title: 'Close checklist', kind: 'checklist' as const },
        { id: 'flux', title: 'Variance commentary', kind: 'narrative' as const },
        { id: 'exceptions', title: 'Exceptions', kind: 'table' as const },
        { id: 'adjustments', title: 'Adjustments', kind: 'table' as const },
        { id: 'metrics', title: 'FX rates and agent activity', kind: 'metrics' as const },
      ],
    };
  },
});

export const getCloseCalendar = defineTool({
  name: 'get_close_calendar',
  description: 'The close calendar: every task with workday, owner, status, dependencies, pending approvals and blockers.',
  input: z.object({}),
  outputClass: 'ek:CloseTask',
  permission: 'close.view',
  handler: async (ctx: AgentCtx) => {
    const cal = await closeCalendar(ctx.svc, ctx.periodKey);
    const ot = await orchTasks(ctx.svc, ctx.periodKey);
    return {
      periodKey: ctx.periodKey,
      today: cal.today,
      todayWorkday: cal.todayWorkday,
      tasks: cal.tasks.map((t) => ({ code: t.code, title: t.title, workday: t.workdayLabel, owner: t.owner?.name ?? null, status: t.status, skill: t.skillId, deps: t.depCodes, pending: t.pendingProposals, ran: ot.find((o) => o.id === t.id)?.ran ?? false })),
      blockers: cal.blockers,
    };
  },
});

export const dispatchReadyTasks = defineTool({
  name: 'dispatch_ready_tasks',
  description: 'Starts the agent for every task whose dependencies are satisfied (one wave) and returns what ran, what is waiting for people and what is blocked. Child runs are gated on their own.',
  input: z.object({}),
  outputClass: 'ek:AgentRun',
  permission: 'agent.orchestrate',
  effect: 'dispatch',
  handler: async (ctx: AgentCtx) => ctx.dispatch(ctx.run),
});

export const REVIEW_TOOLS: AnyTool[] = [listPeriodEntries, getJournalEntry, runJeTests, computeFlux, analyzeVarianceDrivers, getCloseStatus, buildClosePackage, getCloseCalendar, dispatchReadyTasks];
