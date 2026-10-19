import type { Row } from '../../../framework/store/schema';
import { addMonths, formatPeriod, periodEnd, periodStart } from '../../../framework/util/dates';
import { AppError } from '../../../framework/util/errors';
import { allocateByWeights } from '../../../framework/util/money';
import { normalize } from '../../../framework/util/text';
import { audit } from '../domain/audit';
import { requireEntity, requirePermission, withDb, type ServiceContext } from '../domain/context';
import { analyzeDrivers, computeVariance, fluxNarrative, isMaterialVariance, naturalSign, type ActivityLine, type DriverAnalysis, type FluxThreshold } from '../domain/flux-math';
import { ledgerLines } from '../domain/queries';
import { accounts, dimensionById, entities, entityByCode } from '../domain/refdata';
import { periodActivity } from '../domain/reporting';
import { assertSod } from '../domain/rbac';
import { FluxExplanationDraft, type VarianceDriver } from '../ontology/shapes';
import type { EkSchema } from '../store';
import { person, type PersonRef } from './common';

/**
 * Flux (variance) analysis on income-statement accounts, per entity, against the prior month
 * or the approved budget. Amounts are in each account's natural sign (revenue and expenses
 * both positive). A line is material when it crosses the absolute AND percentage thresholds.
 */

export type Comparison = 'prior_month' | 'budget';
type ExplRow = Row<EkSchema, 'flux_explanation'>;

export interface FluxLineView {
  lineId: string | null;
  accountId: string;
  code: string;
  name: string;
  current: number;
  comparison: number;
  variance: number;
  variancePct: number | null;
  material: boolean;
  status: 'not_required' | 'unexplained' | 'explained' | 'approved';
  stale: boolean;
  explanation: {
    id: string;
    narrative: string;
    drivers: VarianceDriver[];
    coverage: number;
    authorType: 'agent' | 'user';
    author: PersonRef | null;
    status: ExplRow['status'];
    approvedBy: PersonRef | null;
    approvedAt: string | null;
    rejectionReason: string | null;
    runId: string | null;
    createdAt: string;
  } | null;
}

export interface FluxView {
  entityId: string;
  entityCode: string;
  currency: string;
  periodKey: string;
  comparison: Comparison;
  comparisonLabel: string;
  threshold: FluxThreshold;
  analysisId: string | null;
  status: 'not_run' | 'draft' | 'in_review' | 'approved';
  lines: FluxLineView[];
  totals: { revenue: { current: number; comparison: number }; expenses: { current: number; comparison: number }; netIncome: { current: number; comparison: number } };
}

export const DEFAULT_THRESHOLD: FluxThreshold = { abs: 2_500_000, pct: 0.1, mode: 'and' };

export async function budgetActivity(ctx: ServiceContext, entityId: string, periodKey: string, byDepartment = false): Promise<Map<string, number>> {
  const budgets = await ctx.db.find('budget', { tenant_id: ctx.tenantId, entity_id: entityId, fiscal_year: Number(periodKey.slice(0, 4)), kind: 'budget', status: 'approved' });
  const out = new Map<string, number>();
  if (!budgets.length) return out;
  const lines = await ctx.db.find('budget_line', { budget_id: { in: budgets.map((b) => b.id) }, period_key: periodKey });
  for (const l of lines) {
    const k = byDepartment ? `${l.account_id}|${l.department_id ?? ''}` : l.account_id;
    out.set(k, (out.get(k) ?? 0) + l.amount);
  }
  return out;
}

export async function computeFluxLines(ctx: ServiceContext, entityId: string, periodKey: string, comparison: Comparison, threshold: FluxThreshold) {
  const accs = await accounts(ctx);
  const cur = await periodActivity(ctx, [entityId], periodKey);
  const cmp = comparison === 'prior_month' ? await periodActivity(ctx, [entityId], addMonths(periodKey, -1)) : await budgetActivity(ctx, entityId, periodKey);
  const ids = new Set([...cur.keys(), ...cmp.keys()]);
  const lines = [];
  for (const id of ids) {
    const a = accs.get(id);
    if (!a || (a.account_class !== 'revenue' && a.account_class !== 'expense')) continue;
    const c = naturalSign(cur.get(id) ?? 0, a.normal_balance);
    const p = naturalSign(cmp.get(id) ?? 0, a.normal_balance);
    if (c === 0 && p === 0) continue;
    const v = computeVariance(c, p);
    lines.push({ accountId: id, code: a.code, name: a.name, accountClass: a.account_class, current: c, comparison: p, variance: v.variance, variancePct: v.variancePct, material: isMaterialVariance(v, threshold) });
  }
  return lines.sort((x, y) => x.code.localeCompare(y.code));
}

function totalsOf(lines: { accountClass?: string; current: number; comparison: number; code: string }[]) {
  const rev = lines.filter((l) => l.code.startsWith('4') || (l.code === '7100'));
  const exp = lines.filter((l) => !rev.includes(l));
  const s = (xs: typeof lines, k: 'current' | 'comparison') => xs.reduce((t, l) => t + l[k], 0);
  return {
    revenue: { current: s(rev, 'current'), comparison: s(rev, 'comparison') },
    expenses: { current: s(exp, 'current'), comparison: s(exp, 'comparison') },
    netIncome: { current: s(rev, 'current') - s(exp, 'current'), comparison: s(rev, 'comparison') - s(exp, 'comparison') },
  };
}

export async function fluxView(ctx: ServiceContext, input: { entityCode: string; periodKey: string; comparison: Comparison; threshold?: FluxThreshold }): Promise<FluxView> {
  requirePermission(ctx, 'report.view');
  const ent = await entityByCode(ctx, input.entityCode);
  requireEntity(ctx, ent.id);
  const analysis = await ctx.db.findOne('flux_analysis', { tenant_id: ctx.tenantId, entity_id: ent.id, period_key: input.periodKey, comparison: input.comparison });
  const threshold: FluxThreshold = analysis ? { abs: analysis.threshold_abs, pct: analysis.threshold_pct, mode: 'and' } : (input.threshold ?? DEFAULT_THRESHOLD);
  const computed = await computeFluxLines(ctx, ent.id, input.periodKey, input.comparison, threshold);
  const stored = analysis ? await ctx.db.find('flux_line', { flux_analysis_id: analysis.id }) : [];
  const storedBy = new Map(stored.map((l) => [l.account_id, l]));
  const expl = stored.length ? await ctx.db.find('flux_explanation', { flux_line_id: { in: stored.map((l) => l.id) } }, { orderBy: [['created_at', 'desc']] }) : [];
  const lines: FluxLineView[] = [];
  for (const c of computed) {
    const s = storedBy.get(c.accountId);
    const ex = s ? (expl.find((e) => e.flux_line_id === s.id && e.status !== 'rejected') ?? expl.find((e) => e.flux_line_id === s.id) ?? null) : null;
    lines.push({
      lineId: s?.id ?? null,
      accountId: c.accountId,
      code: c.code,
      name: c.name,
      current: c.current,
      comparison: c.comparison,
      variance: c.variance,
      variancePct: c.variancePct,
      material: c.material,
      status: s ? s.status : c.material ? 'unexplained' : 'not_required',
      stale: !!s && (s.current_amount !== c.current || s.comparison_amount !== c.comparison),
      explanation: ex
        ? {
            id: ex.id,
            narrative: ex.narrative,
            drivers: ex.drivers as VarianceDriver[],
            coverage: ex.coverage,
            authorType: ex.author_type,
            author: await person(ctx, ex.author_id),
            status: ex.status,
            approvedBy: await person(ctx, ex.approved_by),
            approvedAt: ex.approved_at,
            rejectionReason: ex.rejection_reason,
            runId: ex.run_id,
            createdAt: ex.created_at,
          }
        : null,
    });
  }
  return {
    entityId: ent.id,
    entityCode: ent.code,
    currency: ent.functional_currency,
    periodKey: input.periodKey,
    comparison: input.comparison,
    comparisonLabel: input.comparison === 'prior_month' ? formatPeriod(addMonths(input.periodKey, -1)) : `Budget ${formatPeriod(input.periodKey, 'short')}`,
    threshold,
    analysisId: analysis?.id ?? null,
    status: analysis ? analysis.status : 'not_run',
    lines,
    totals: totalsOf(computed),
  };
}

/** Create or refresh the stored analysis (numbers), keeping existing explanations. */
export async function ensureAnalysis(ctx: ServiceContext, entityId: string, periodKey: string, comparison: Comparison, threshold: FluxThreshold, runId: string | null): Promise<{ analysisId: string; lines: Map<string, string> }> {
  const computed = await computeFluxLines(ctx, entityId, periodKey, comparison, threshold);
  return ctx.db.tx(async (db) => {
    let a = await db.findOne('flux_analysis', { tenant_id: ctx.tenantId, entity_id: entityId, period_key: periodKey, comparison });
    if (!a) a = await db.insert('flux_analysis', { tenant_id: ctx.tenantId, entity_id: entityId, period_key: periodKey, comparison, threshold_abs: threshold.abs, threshold_pct: threshold.pct, status: 'draft', run_id: runId, created_at: ctx.clock.nowIso() });
    else if (a.status === 'approved') return { analysisId: a.id, lines: new Map((await db.find('flux_line', { flux_analysis_id: a.id })).map((l) => [l.account_id, l.id])) };
    const existing = new Map((await db.find('flux_line', { flux_analysis_id: a.id })).map((l) => [l.account_id, l]));
    const out = new Map<string, string>();
    for (const c of computed) {
      const e = existing.get(c.accountId);
      if (e) {
        await db.update('flux_line', e.id, { current_amount: c.current, comparison_amount: c.comparison, variance: c.variance, variance_pct: c.variancePct, is_material: c.material, status: e.status === 'not_required' && c.material ? 'unexplained' : !c.material && e.status === 'unexplained' ? 'not_required' : e.status });
        out.set(c.accountId, e.id);
      } else {
        const row = await db.insert('flux_line', { tenant_id: ctx.tenantId, flux_analysis_id: a.id, account_id: c.accountId, current_amount: c.current, comparison_amount: c.comparison, variance: c.variance, variance_pct: c.variancePct, is_material: c.material, status: c.material ? 'unexplained' : 'not_required', created_at: ctx.clock.nowIso() });
        out.set(c.accountId, row.id);
      }
    }
    if (a.status === 'draft') await db.update('flux_analysis', a.id, { status: 'in_review', run_id: runId ?? a.run_id });
    return { analysisId: a.id, lines: out };
  });
}

/**
 * Group an account's activity by counterparty for driver analysis. Against the prior month,
 * both sides are ledger activity. Against budget, the comparison side is the approved budget
 * itself: each department's budget is spread over the counterparties of its recent spend
 * (the trailing three months), so the drivers add up to actual − budget and unbudgeted
 * one-time items surface as drivers.
 */
export async function activityLines(ctx: ServiceContext, entityId: string, accountId: string, periodKey: string, comparison: Comparison): Promise<ActivityLine[]> {
  const a = (await accounts(ctx)).get(accountId)!;
  const vendors = new Map((await ctx.db.find('vendor', { tenant_id: ctx.tenantId })).map((v) => [v.id, v.name]));
  const linesOf = (p: string) => ctx.db.query(ledgerLines, { tenantId: ctx.tenantId, entityIds: [entityId], accountIds: [accountId], periodFrom: p, periodTo: p });
  const counterparty = async (r: Awaited<ReturnType<typeof linesOf>>[number]): Promise<{ key: string; label: string }> => {
    if (r.sourceType === 'bill' && r.sourceId) {
      const b = await ctx.db.get('bill', r.sourceId);
      return { label: vendors.get(b?.vendor_id ?? '') ?? 'Vendor', key: `v:${b?.vendor_id}` };
    }
    if (r.sourceType === 'card_transaction' && r.sourceId) {
      const label = (await ctx.db.get('card_transaction', r.sourceId))?.merchant_name ?? 'Card spend';
      return { label, key: `m:${normalize(label)}` };
    }
    if (r.sourceType === 'payroll_run') return { label: 'Payroll', key: 'payroll' };
    const je = await ctx.db.get('journal_entry', r.entryId);
    const vid = (je?.source_ref as Record<string, unknown> | null)?.vendor;
    if (typeof vid === 'string' && vendors.has(vid)) return { label: vendors.get(vid)!, key: `v:${vid}` };
    const vendorInMemo = [...vendors.entries()].find(([, n]) => r.memo.includes(n));
    if (vendorInMemo) return { label: vendorInMemo[1], key: `v:${vendorInMemo[0]}` };
    const label = r.memo.replace(/\s*[—-]\s*\d{4}-\d{2}.*$/, '').replace(/\[[^\]]+\]/g, '').trim().slice(0, 60) || r.entryType;
    return { label, key: `memo:${normalize(label).replace(/\d+/g, '#')}` };
  };
  const natural = (r: { debit: number; credit: number }) => naturalSign(r.debit - r.credit, a.normal_balance);
  const out: ActivityLine[] = [];
  for (const r of await linesOf(periodKey)) out.push({ ...(await counterparty(r)), period: 'current', amount: natural(r), ref: { type: 'journal_entry', id: r.entryId, label: r.entryNumber }, entryType: r.entryType });
  if (comparison === 'prior_month') {
    for (const r of await linesOf(addMonths(periodKey, -1))) out.push({ ...(await counterparty(r)), period: 'comparison', amount: natural(r), entryType: r.entryType });
    return out;
  }
  // Budget side: the department budgets, each spread by its trailing counterparty mix.
  const mix = new Map<string, Map<string, { label: string; amount: number }>>();
  for (let back = 1; back <= 3; back++) {
    for (const r of await linesOf(addMonths(periodKey, -back))) {
      const cp = await counterparty(r);
      const byKey = mix.get(r.departmentId ?? '') ?? new Map<string, { label: string; amount: number }>();
      const cur = byKey.get(cp.key) ?? { label: cp.label, amount: 0 };
      cur.amount += natural(r);
      byKey.set(cp.key, cur);
      mix.set(r.departmentId ?? '', byKey);
    }
  }
  const depts = await dimensionById(ctx);
  for (const [k, net] of await budgetActivity(ctx, entityId, periodKey, true)) {
    const [acct, dept = ''] = k.split('|');
    const planned = naturalSign(net, a.normal_balance);
    if (acct !== accountId || planned === 0) continue;
    const parts = [...(mix.get(dept)?.entries() ?? [])].filter(([, v]) => Math.sign(v.amount) === Math.sign(planned));
    if (!parts.length) {
      out.push({ key: `budget:${dept}`, label: `${dept ? (depts.get(dept)?.name ?? 'Department') : a.name} budget (no recent spend)`, period: 'comparison', amount: planned });
      continue;
    }
    const shares = allocateByWeights(planned, parts.map(([, v]) => Math.abs(v.amount)));
    parts.forEach(([key, v], i) => out.push({ key, label: v.label, period: 'comparison', amount: shares[i]! }));
  }
  return out;
}

export async function varianceDrivers(ctx: ServiceContext, input: { entityId: string; accountId: string; periodKey: string; comparison: Comparison }): Promise<DriverAnalysis & { variance: number; narrative: string; current: number; comparisonAmount: number }> {
  requireEntity(ctx, input.entityId);
  const a = (await accounts(ctx)).get(input.accountId)!;
  const ent = (await entities(ctx)).get(input.entityId)!;
  const lines = await computeFluxLines(ctx, input.entityId, input.periodKey, input.comparison, DEFAULT_THRESHOLD);
  const line = lines.find((l) => l.accountId === input.accountId);
  const variance = line?.variance ?? 0;
  const acts = await activityLines(ctx, input.entityId, input.accountId, input.periodKey, input.comparison);
  const analysis = analyzeDrivers(acts, variance);
  const narrative = fluxNarrative({
    accountName: a.name,
    periodLabel: formatPeriod(input.periodKey),
    comparisonLabel: input.comparison === 'prior_month' ? formatPeriod(addMonths(input.periodKey, -1)) : 'budget',
    variance: computeVariance(line?.current ?? 0, line?.comparison ?? 0),
    currency: ent.functional_currency,
    drivers: analysis.drivers,
    coverage: analysis.coverage,
  });
  return { ...analysis, variance, narrative, current: line?.current ?? 0, comparisonAmount: line?.comparison ?? 0 };
}

/** A person writes (or rewrites) an explanation. */
export async function submitExplanation(ctx: ServiceContext, input: unknown): Promise<string> {
  requirePermission(ctx, 'flux.explain');
  const d = FluxExplanationDraft.parse(input);
  requireEntity(ctx, d.entityId);
  const ensured = await ensureAnalysis(ctx, d.entityId, d.periodKey, d.comparison as Comparison, DEFAULT_THRESHOLD, null);
  const lineId = d.fluxLineId ?? ensured.lines.get(d.accountId);
  if (!lineId) throw new AppError('NOT_FOUND', 'No variance line for this account.');
  return ctx.db.tx(async (db) => {
    const e = await db.insert('flux_explanation', { tenant_id: ctx.tenantId, flux_line_id: lineId, narrative: d.narrative, drivers: d.drivers, coverage: d.coverage, author_type: 'user', author_id: ctx.actor.userId, run_id: null, status: 'submitted', created_at: ctx.clock.nowIso() });
    await db.update('flux_line', lineId, { status: 'explained' });
    await audit(withDb(ctx, db), { action: 'flux.explained', subjectType: 'flux_line', subjectId: lineId, data: { explanation: e.id, coverage: d.coverage } });
    return e.id;
  });
}

async function refreshAnalysisStatus(ctx: ServiceContext, analysisId: string): Promise<void> {
  const lines = await ctx.db.find('flux_line', { flux_analysis_id: analysisId, is_material: true });
  if (lines.length && lines.every((l) => l.status === 'approved')) await ctx.db.update('flux_analysis', analysisId, { status: 'approved', approved_by: ctx.actor.userId, approved_at: ctx.clock.nowIso() });
}

/** The entity whose variance an explanation explains. */
async function explanationEntity(ctx: ServiceContext, lineId: string): Promise<string | null> {
  const line = await ctx.db.get('flux_line', lineId);
  return line ? ((await ctx.db.get('flux_analysis', line.flux_analysis_id))?.entity_id ?? null) : null;
}

export async function approveExplanation(ctx: ServiceContext, explanationId: string): Promise<void> {
  requirePermission(ctx, 'flux.approve');
  const e = await ctx.db.get('flux_explanation', explanationId);
  if (!e || e.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Explanation not found');
  requireEntity(ctx, await explanationEntity(ctx, e.flux_line_id));
  if (e.status === 'approved') return;
  let requestedBy: string | null = null;
  if (e.run_id) requestedBy = (await ctx.db.get('agent_run', e.run_id))?.requested_by ?? null;
  await assertSod(ctx, { kind: 'approve_flux', preparedBy: e.author_id, requestedBy });
  const line = (await ctx.db.get('flux_line', e.flux_line_id))!;
  await ctx.db.tx(async (db) => {
    await db.update('flux_explanation', e.id, { status: 'approved', approved_by: ctx.actor.userId, approved_at: ctx.clock.nowIso() });
    await db.update('flux_line', line.id, { status: 'approved' });
    await audit(withDb(ctx, db), { action: 'flux.approved', subjectType: 'flux_line', subjectId: line.id, data: { explanation: e.id } });
  });
  await refreshAnalysisStatus(ctx, line.flux_analysis_id);
}

export async function rejectExplanation(ctx: ServiceContext, explanationId: string, reason: string): Promise<void> {
  requirePermission(ctx, 'flux.approve');
  if (!reason || reason.trim().length < 3) throw new AppError('VALIDATION', 'Say what is missing from the explanation.');
  const e = await ctx.db.get('flux_explanation', explanationId);
  if (!e || e.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Explanation not found');
  requireEntity(ctx, await explanationEntity(ctx, e.flux_line_id));
  await ctx.db.tx(async (db) => {
    await db.update('flux_explanation', e.id, { status: 'rejected', rejection_reason: reason.trim() });
    await db.update('flux_line', e.flux_line_id, { status: 'unexplained' });
    await audit(withDb(ctx, db), { action: 'flux.rejected', subjectType: 'flux_line', subjectId: e.flux_line_id, data: { explanation: e.id, reason: reason.trim() } });
  });
}

export function periodWindow(periodKey: string): { from: string; to: string } {
  return { from: periodStart(periodKey), to: periodEnd(periodKey) };
}

export { refreshAnalysisStatus };
