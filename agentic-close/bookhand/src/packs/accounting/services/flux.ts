import { appendAudit } from '../../../audit/audit';
import type { Tx } from '../../../persistence/db';
import type { Row } from '../../../persistence/schema';
import { can, type Principal } from '../../../security/principal';
import type { DomainContext } from '../../../shared/context';
import { addMonths } from '../../../shared/dates';
import { DomainError } from '../../../shared/errors';
import { convertMinor } from '../../../shared/money';
import { computeFlux, type DetailItem, type FluxAccountInput, type FluxLineResult } from '../algorithms/flux';
import { consolidatedTrialBalance, entityTrialBalance } from '../domain/reporting';
import type { AccountingScope } from '../scope';

/**
 * Flux workpaper: consolidated income-statement activity for the close month versus a comparison (prior month
 * or budget), thresholded by policy. The agent drafts driver-based explanations as proposals; FP&A accepts
 * them (or writes their own) and the Controller approves the analysis.
 */

export type Comparison = 'prior_month' | 'budget';

const natural = (accountClass: string, net: number) => (accountClass === 'revenue' ? -net : net);

export async function fluxInputs(tx: Tx, scope: AccountingScope, fiscalYear: number, periodNumber: number, comparison: Comparison): Promise<FluxAccountInput[]> {
  const { lookups } = scope;
  const comp = new Map<string, number>();
  let current: { rows: Array<{ accountId: string; net: number }> };
  if (comparison === 'prior_month') {
    current = await consolidatedTrialBalance(tx, lookups, fiscalYear, periodNumber, scope.reportingCurrency, 'activity');
    const prev = addMonths(fiscalYear, periodNumber, -1);
    const prior = await consolidatedTrialBalance(tx, lookups, prev.year, prev.month, scope.reportingCurrency, 'activity');
    for (const r of prior.rows) comp.set(r.accountId, r.net);
  } else {
    // Budgets are set per entity: compare that entity's actuals with its approved budget.
    const budget = (await tx.find('budgets', { tenant_id: scope.tenant.id, fiscal_year: fiscalYear, status: 'approved' }))[0];
    if (!budget) throw new DomainError('NOT_FOUND', `No approved budget for FY${fiscalYear}.`);
    for (const l of await tx.find('budget_lines', { budget_id: budget.id, period_number: periodNumber })) comp.set(l.account_id, (comp.get(l.account_id) ?? 0) + l.amount_minor);
    const period = lookups.period(budget.entity_id, fiscalYear, periodNumber);
    if (!period) throw new DomainError('NOT_FOUND', 'budget period not found');
    current = await entityTrialBalance(tx, lookups, budget.entity_id, period.id, 'activity');
  }
  const curMap = new Map(current.rows.map((r) => [r.accountId, r.net]));
  const ids = new Set([...curMap.keys(), ...comp.keys()]);
  const out: FluxAccountInput[] = [];
  for (const id of ids) {
    const a = lookups.accountsById.get(id);
    if (!a || (a.account_class !== 'revenue' && a.account_class !== 'expense')) continue;
    out.push({ accountId: a.id, number: a.number, name: a.name, accountClass: a.account_class, fsLine: a.fs_line, current: natural(a.account_class, curMap.get(id) ?? 0), comparison: natural(a.account_class, comp.get(id) ?? 0) });
  }
  return out.sort((x, y) => x.number.localeCompare(y.number));
}

export async function ensureFluxAnalysis(
  tx: Tx,
  ctx: DomainContext,
  scope: AccountingScope,
  closeId: string,
  comparison: Comparison,
  policy: { pct: number; minor: number; combine: 'and' | 'or' },
  runId: string | null,
): Promise<{ analysis: Row<'flux_analyses'>; lines: Row<'flux_lines'>[]; results: FluxLineResult[] }> {
  const close = await tx.get('closes', closeId);
  if (!close) throw new DomainError('NOT_FOUND', 'close not found');
  const results = computeFlux(await fluxInputs(tx, scope, close.fiscal_year, close.period_number, comparison), policy);
  let analysis = await tx.findOne('flux_analyses', { close_id: closeId, comparison });
  if (!analysis) {
    analysis = await tx.insert('flux_analyses', { tenant_id: ctx.tenantId, close_id: closeId, entity_id: null, comparison, threshold_pct: policy.pct, threshold_minor: policy.minor, status: 'draft', generated_by_run_id: runId });
  } else if (analysis.status === 'approved') {
    return { analysis, lines: await tx.find('flux_lines', { analysis_id: analysis.id }), results };
  } else {
    analysis = await tx.update('flux_analyses', analysis.id, { threshold_pct: policy.pct, threshold_minor: policy.minor, generated_by_run_id: runId ?? analysis.generated_by_run_id });
  }
  const existing = new Map((await tx.find('flux_lines', { analysis_id: analysis.id })).map((l) => [l.account_id, l]));
  const lines: Row<'flux_lines'>[] = [];
  for (const r of results) {
    const prev = existing.get(r.accountId);
    const numbersChanged = !prev || prev.current_minor !== r.current || prev.comparison_minor !== r.comparison;
    const status: Row<'flux_lines'>['explanation_status'] = !r.isMaterial ? 'not_required' : prev && !numbersChanged && prev.explanation_status !== 'not_required' ? prev.explanation_status : 'missing';
    const row = {
      fs_line: r.fsLine,
      current_minor: r.current,
      comparison_minor: r.comparison,
      variance_minor: r.variance,
      variance_pct: r.variancePct === null ? null : Number(r.variancePct.toFixed(6)),
      is_material: r.isMaterial,
      explanation_status: status,
      ...(numbersChanged && prev ? { explanation: null, drivers: [], proposal_id: null, explained_by: null, explained_by_run_id: null, confidence: null, reviewed_by: null, reviewed_at: null } : {}),
    };
    lines.push(prev ? await tx.update('flux_lines', prev.id, row) : await tx.insert('flux_lines', { tenant_id: ctx.tenantId, analysis_id: analysis.id, account_id: r.accountId, ...row }));
  }
  return { analysis, lines, results };
}

/** Line-level detail for driver decomposition, in the reporting currency. */
export async function fluxDetail(tx: Tx, scope: AccountingScope, accountId: string, fiscalYear: number, periodNumber: number): Promise<DetailItem[]> {
  const { lookups } = scope;
  const fx = await scope.fx();
  const items: DetailItem[] = [];
  const vendors = new Map((await tx.find('vendors', { tenant_id: scope.tenant.id })).map((v) => [v.id, v]));
  for (const entity of [...lookups.operatingEntities(), ...(lookups.eliminationEntity() ? [lookups.eliminationEntity()!] : [])]) {
    const period = lookups.period(entity.id, fiscalYear, periodNumber);
    if (!period) continue;
    const lines = await tx.find('journal_lines', { entity_id: entity.id, period_id: period.id, account_id: accountId });
    if (!lines.length) continue;
    const entries = new Map((await tx.find('journal_entries', { id: { in: [...new Set(lines.map((l) => l.journal_entry_id))] } })).map((e) => [e.id, e]));
    const rate = entity.functional_currency === scope.reportingCurrency ? 1 : fx.has(entity.functional_currency, scope.reportingCurrency, period.end_date, 'average') ? fx.rate(entity.functional_currency, scope.reportingCurrency, period.end_date, 'average') : 1;
    const account = lookups.accountsById.get(accountId)!;
    for (const l of lines) {
      const e = entries.get(l.journal_entry_id);
      if (!e || e.status !== 'posted') continue;
      const amount = convertMinor(natural(account.account_class, l.debit_minor - l.credit_minor), rate);
      const vendor = l.vendor_id ? vendors.get(l.vendor_id) : undefined;
      const merchant = e.source_module === 'card' ? e.description.replace(/^Card:\s*/, '') : null;
      const dept = l.department_id ? lookups.departments.get(l.department_id) : undefined;
      const evidence = [{ type: 'journal_entry', id: e.id, label: e.entry_number }];
      if (vendor) items.push({ key: `v:${vendor.id}`, label: vendor.name, kind: 'vendor', amount, hint: `${e.description} ${l.memo ?? ''}`, evidence });
      else if (merchant) items.push({ key: `m:${merchant}`, label: merchant, kind: 'vendor', amount, hint: l.memo ?? '', evidence });
      else if (account.account_class === 'revenue' || e.entry_type === 'amortization') items.push({ key: `d:${e.entry_type}:${e.source_module}`, label: e.entry_type === 'amortization' ? 'Recognized from deferred revenue' : `${e.source_module.toUpperCase()} entries`, kind: 'description', amount, evidence });
      else items.push({ key: `dept:${dept?.code ?? entity.code}`, label: dept ? `${dept.name} (${entity.code})` : `${entity.code} entries`, kind: 'department', amount, hint: e.description, evidence });
    }
  }
  return items;
}

export async function explainLine(tx: Tx, ctx: DomainContext, principal: Principal, lineId: string, text: string): Promise<Row<'flux_lines'>> {
  if (!can(principal, 'flux.explain')) throw new DomainError('FORBIDDEN', 'Your role cannot write variance explanations.');
  if (!text || text.trim().length < 15) throw new DomainError('VALIDATION', 'Write at least a sentence: what drove the change and whether it recurs.');
  const line = await tx.get('flux_lines', lineId);
  if (!line || line.tenant_id !== ctx.tenantId) throw new DomainError('NOT_FOUND', 'flux line not found');
  const analysis = await tx.get('flux_analyses', line.analysis_id);
  if (analysis?.status === 'approved') throw new DomainError('CONFLICT', 'The flux analysis is already approved.');
  if (line.proposal_id) {
    const p = await tx.get('proposals', line.proposal_id);
    if (p && p.status === 'pending') await tx.update('proposals', p.id, { status: 'superseded', updated_at: ctx.clock.now() });
  }
  const updated = await tx.update('flux_lines', lineId, { explanation: text.trim(), explanation_status: 'accepted', explained_by: principal.user.id, explained_by_run_id: null, reviewed_by: principal.user.id, reviewed_at: ctx.clock.now(), confidence: null });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'flux.explain', objectType: 'flux_line', objectId: lineId, summary: `Explained variance on ${(await tx.get('accounts', line.account_id))?.name ?? 'account'}`, details: { text: text.trim() } }, ctx.clock.now());
  return updated;
}

export async function fluxProblems(tx: Tx, analysisId: string): Promise<string[]> {
  const lines = await tx.find('flux_lines', { analysis_id: analysisId, is_material: true });
  const open = lines.filter((l) => l.explanation_status !== 'accepted');
  return open.length ? [`${open.length} material variance(s) still need an accepted explanation.`] : [];
}

export async function approveFlux(tx: Tx, ctx: DomainContext, principal: Principal, analysisId: string, comment?: string): Promise<Row<'flux_analyses'>> {
  if (!can(principal, 'flux.approve')) throw new DomainError('FORBIDDEN', 'Your role cannot approve the flux analysis.');
  const analysis = await tx.get('flux_analyses', analysisId);
  if (!analysis || analysis.tenant_id !== ctx.tenantId) throw new DomainError('NOT_FOUND', 'analysis not found');
  if (analysis.status === 'approved') return analysis;
  const problems = await fluxProblems(tx, analysisId);
  if (problems.length) throw new DomainError('CONFLICT', problems.join(' '), { problems });
  const lines = await tx.find('flux_lines', { analysis_id: analysisId, is_material: true });
  if (lines.some((l) => l.explained_by === principal.user.id)) throw new DomainError('SOD_VIOLATION', 'Maker-checker: you wrote at least one explanation in this analysis; another person must approve it.');
  const updated = await tx.update('flux_analyses', analysisId, { status: 'approved', approved_by: principal.user.id, approved_at: ctx.clock.now() });
  await tx.insert('signoffs', { tenant_id: ctx.tenantId, object_type: 'flux_analysis', object_id: analysisId, role: 'approver', user_id: principal.user.id, comment: comment ?? null });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'flux.approve', objectType: 'flux_analysis', objectId: analysisId, summary: `Approved flux analysis (${analysis.comparison.replace('_', ' ')}) with ${lines.length} material variance(s) explained` }, ctx.clock.now());
  return updated;
}
