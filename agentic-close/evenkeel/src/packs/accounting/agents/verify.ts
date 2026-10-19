import type { ProposalDraft, VerificationCheck, VerificationReport } from '../../../framework/runtime/types';
import { formatMoney } from '../../../framework/util/money';
import { periodEnd } from '../../../framework/util/dates';
import { driversReconcile } from '../domain/flux-math';
import { validateEntry } from '../domain/ledger';
import { accounts, entityById, periodOf } from '../domain/refdata';
import { closeOntology } from '../ontology';
import { ClosePackageDraft, CodingDecision, FixedAssetDraft, FluxExplanationDraft, IssueDraft, JournalEntryDraft, PrepaidScheduleDraft, RecMatch, ReconcilingItemDraft, TaskUpdate } from '../ontology/shapes';
import { settings } from '../services/common';
import { buildPackageContent, contentHash } from '../services/package';
import { computeFluxLines, DEFAULT_THRESHOLD } from '../services/flux';
import type { AgentCtx } from './context';

/**
 * Deterministic verification of every proposal before gating and again at approval time
 * (proposals go stale: a period gets locked, a line gets matched, numbers move). Checks are
 * phrased for the reviewer; passing checks are kept so the inbox can show what was verified.
 */

type Check = VerificationCheck;
const ok = (id: string, label: string, detail?: string): Check => ({ id, label, ok: true, severity: 'error', detail });
const fail = (id: string, label: string, detail?: string, severity: 'error' | 'warning' = 'error'): Check => ({ id, label, ok: false, severity, detail });

function report(checks: Check[]): VerificationReport {
  return { ok: checks.every((c) => c.ok || c.severity === 'warning'), checks };
}

export interface JeLinks {
  recId?: string;
  bankTransactionIds?: string[];
  prepaidLineIds?: string[];
  depreciationLineIds?: string[];
  resolves?: { type: string; id: string }[];
}

export function linksOf(payload: Record<string, unknown>): JeLinks {
  return (payload.links ?? {}) as JeLinks;
}

async function verifyJournalEntry(ctx: AgentCtx, payload: Record<string, unknown>): Promise<Check[]> {
  const parsed = JournalEntryDraft.safeParse(payload);
  if (!parsed.success) return [fail('shape:ek:JournalEntry', 'Entry has the required structure', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))];
  const draft = parsed.data;
  const checks: Check[] = [];
  const { result } = await validateEntry(ctx.svc, draft, { source: 'agent', requestedBy: ctx.run.requestedBy }, ['AX-SOD-01', 'AX-ACC-04']);
  const failedIds = new Set(result.violations.map((v) => v.axiomId));
  const ontology = closeOntology();
  for (const id of result.checked) {
    if (failedIds.has(id)) continue;
    if (!id.startsWith('AX-')) continue;
    checks.push(ok(id, ontology.axiom(id).name));
  }
  for (const v of result.violations) checks.push(fail(v.axiomId, v.axiomName, v.message, v.severity));
  const total = draft.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  checks.push(ok('balance', 'Debits equal credits', formatMoney(total, draft.currency)));
  const links = linksOf(payload);
  if (links.prepaidLineIds?.length) {
    const lines = await ctx.svc.db.find('prepaid_line', { id: { in: links.prepaidLineIds } });
    const posted = lines.filter((l) => l.status !== 'scheduled');
    checks.push(posted.length || lines.length !== links.prepaidLineIds.length ? fail('links:prepaid', 'Schedule lines are still unposted', `${posted.length} already posted`) : ok('links:prepaid', 'Schedule lines are still unposted'));
  }
  if (links.depreciationLineIds?.length) {
    const lines = await ctx.svc.db.find('depreciation_line', { id: { in: links.depreciationLineIds } });
    const posted = lines.filter((l) => l.status !== 'scheduled');
    checks.push(posted.length || lines.length !== links.depreciationLineIds.length ? fail('links:depreciation', 'Depreciation lines are still unposted', `${posted.length} already posted`) : ok('links:depreciation', 'Depreciation lines are still unposted'));
  }
  if (links.bankTransactionIds?.length) {
    const active = await ctx.svc.db.find('rec_match_item', { record_id: { in: links.bankTransactionIds }, active: true });
    checks.push(active.length ? fail('links:bank', 'Statement lines are not matched yet', 'Already matched to another entry') : ok('links:bank', 'Statement lines are not matched yet'));
  }
  if (draft.reversesEntryId) {
    const o = await ctx.svc.db.get('journal_entry', draft.reversesEntryId);
    checks.push(!o || o.status !== 'posted' || o.reversed_by_entry_id ? fail('AX-JE-02', 'Original entry can be reversed', !o ? 'not found' : o.reversed_by_entry_id ? 'already reversed' : `status ${o.status}`) : ok('AX-JE-02', 'Original entry can be reversed', o.entry_number));
  }
  return checks;
}

async function verifyCoding(ctx: AgentCtx, payload: Record<string, unknown>, draft: ProposalDraft): Promise<Check[]> {
  const parsed = CodingDecision.safeParse(payload);
  if (!parsed.success) return [fail('shape:ek:CodingDecision', 'Coding has the required structure', parsed.error.issues[0]?.message)];
  const d = parsed.data;
  const checks: Check[] = [];
  const txn = await ctx.svc.db.get('card_transaction', d.subjectId);
  if (!txn || txn.tenant_id !== ctx.svc.tenantId) return [fail('subject', 'Card transaction exists')];
  checks.push(txn.status === 'posted' || txn.status === 'excluded' ? fail('subject:unposted', 'Transaction is not posted yet', `status ${txn.status}`) : ok('subject:unposted', 'Transaction is not posted yet'));
  const accs = await accounts(ctx.svc);
  const a = accs.get(d.accountId);
  if (!a) return [...checks, fail('AX-ACC-01', 'Account exists')];
  checks.push(a.is_postable && a.is_active ? ok('AX-ACC-01', 'Account is postable and active', `${a.code} ${a.name}`) : fail('AX-ACC-01', 'Account is postable and active', `${a.code} ${a.name}`));
  checks.push(a.requires_department && !d.departmentId ? fail('AX-ACC-03', 'Department provided where required', `${a.code} requires a department`) : ok('AX-ACC-03', 'Department provided where required'));
  checks.push(a.is_control_account && a.subledger !== 'fixed_asset' ? fail('control', 'Not coded to a control account', `${a.code} is a control account`) : ok('control', 'Not coded to a control account'));
  const period = await periodOf(ctx.svc, txn.entity_id, txn.txn_date.slice(0, 7));
  checks.push(period.status === 'open' ? ok('AX-PER-01', 'Period is open', period.period_key) : fail('AX-PER-01', 'Period is open', `${period.period_key} is ${period.status.replace('_', ' ')}`));
  const s = await settings(ctx.svc);
  const qty = Number((draft.payload.quantity as number | undefined) ?? 1) || 1;
  const v = closeOntology().validate('ek:CodingDecision', { treatment: d.treatment, unitAmount: Math.round(Math.abs(txn.amount) / qty), concept: (draft.payload.conceptId as string | null) ?? a.concept, servicePeriodMonths: (draft.payload.servicePeriodMonths as number | null) ?? null, amount: Math.abs(txn.amount) }, { capitalizationThreshold: s.capitalizationThreshold }, { only: ['AX-CAP-01', 'AX-PPD-01'] });
  for (const id of ['AX-CAP-01', 'AX-PPD-01']) {
    const viol = v.violations.find((x) => x.axiomId === id);
    checks.push(viol ? fail(id, closeOntology().axiom(id).name, viol.message, 'warning') : ok(id, closeOntology().axiom(id).name));
  }
  return checks;
}

async function verifyRecMatch(ctx: AgentCtx, payload: Record<string, unknown>): Promise<Check[]> {
  const parsed = RecMatch.safeParse(payload);
  if (!parsed.success) return [fail('shape:ek:Match', 'Match has the required structure', parsed.error.issues[0]?.message)];
  const m = parsed.data;
  if (!m.reconciliationId) return [fail('rec', 'Names its reconciliation')];
  const rec = await ctx.svc.db.get('reconciliation', m.reconciliationId);
  if (!rec) return [fail('rec', 'Reconciliation exists')];
  const checks: Check[] = [];
  checks.push(rec.status === 'prepared' || rec.status === 'reviewed' ? fail('rec:editable', 'Reconciliation is not certified yet', rec.status) : ok('rec:editable', 'Reconciliation is not certified yet'));
  const bankSum = m.bankItems.reduce((s, i) => s + i.amount, 0);
  const ledgerSum = m.ledgerItems.reduce((s, i) => s + i.amount, 0);
  checks.push(bankSum === ledgerSum ? ok('AX-REC-01', 'Matched amounts agree', formatMoney(bankSum)) : fail('AX-REC-01', 'Matched amounts agree', `${formatMoney(bankSum)} vs ${formatMoney(ledgerSum)}`));
  const txs = await ctx.svc.db.find('bank_transaction', { id: { in: m.bankItems.map((b) => b.id) } });
  const real = txs.length === m.bankItems.length && txs.every((t, _i) => t.bank_account_id === rec.bank_account_id && m.bankItems.find((b) => b.id === t.id)?.amount === t.amount);
  checks.push(real ? ok('evidence:bank', 'Statement lines exist with these amounts') : fail('evidence:bank', 'Statement lines exist with these amounts'));
  const lines = await ctx.svc.db.find('journal_line', { id: { in: m.ledgerItems.map((l) => l.id) } });
  const realL = lines.length === m.ledgerItems.length && lines.every((l) => l.account_id === rec.account_id && m.ledgerItems.find((x) => x.id === l.id)?.amount === l.debit - l.credit);
  checks.push(realL ? ok('evidence:ledger', 'Ledger lines exist with these amounts') : fail('evidence:ledger', 'Ledger lines exist with these amounts'));
  const active = await ctx.svc.db.find('rec_match_item', { record_id: { in: [...m.bankItems.map((b) => b.id), ...m.ledgerItems.map((l) => l.id)] }, active: true });
  checks.push(active.length ? fail('unique', 'Lines are not already matched', `${active.length} already matched`) : ok('unique', 'Lines are not already matched'));
  return checks;
}

const BOOK_TYPES = new Set(['deposit_in_transit', 'outstanding_check', 'book_error', 'timing']);
const BANK_TYPES = new Set(['bank_fee', 'bank_interest', 'bank_error']);

async function verifyReconcilingItem(ctx: AgentCtx, payload: Record<string, unknown>): Promise<Check[]> {
  const parsed = ReconcilingItemDraft.safeParse(payload);
  if (!parsed.success) return [fail('shape:ek:ReconcilingItem', 'Item has the required structure', parsed.error.issues[0]?.message)];
  const d = parsed.data;
  if (!d.reconciliationId) return [fail('rec', 'Names its reconciliation')];
  const rec = await ctx.svc.db.get('reconciliation', d.reconciliationId);
  if (!rec) return [fail('rec', 'Reconciliation exists')];
  const checks: Check[] = [];
  checks.push(rec.status === 'prepared' || rec.status === 'reviewed' ? fail('rec:editable', 'Reconciliation is not certified yet', rec.status) : ok('rec:editable', 'Reconciliation is not certified yet'));
  checks.push(d.amount !== 0 ? ok('amount', 'Amount is not zero') : fail('amount', 'Amount is not zero'));
  const sideOk = (BOOK_TYPES.has(d.itemType) && d.side === 'book') || (BANK_TYPES.has(d.itemType) && d.side === 'bank') || (!BOOK_TYPES.has(d.itemType) && !BANK_TYPES.has(d.itemType));
  checks.push(sideOk ? ok('side', 'Item sits on the right side', d.side) : fail('side', 'Item sits on the right side', `${d.itemType} belongs on the ${BOOK_TYPES.has(d.itemType) ? 'book' : 'bank'} side`));
  const open = await ctx.svc.db.find('reconciling_item', { reconciliation_id: rec.id, status: 'open' });
  const refKey = (r: { type: string; id: string }) => `${r.type}:${r.id}`;
  const mine = new Set(d.sourceRefs.map(refKey));
  const dup = open.find((i) => ((i.source_refs ?? []) as { type: string; id: string }[]).some((r) => mine.has(refKey(r))));
  checks.push(dup ? fail('unique', 'Not already carried as a reconciling item', dup.description) : ok('unique', 'Not already carried as a reconciling item'));
  const bankRefs = d.sourceRefs.filter((r) => r.type === 'bank_transaction').map((r) => r.id);
  if (bankRefs.length) {
    const active = await ctx.svc.db.find('rec_match_item', { record_id: { in: bankRefs }, active: true });
    checks.push(active.length ? fail('unmatched', 'Statement line is still unmatched', 'already matched') : ok('unmatched', 'Statement line is still unmatched'));
  }
  if (d.itemType !== 'unexplained' && d.expectedClearDate && d.expectedClearDate < d.originDate) checks.push(fail('dates', 'Expected clearing date is after the origin date'));
  return checks;
}

async function verifyFlux(ctx: AgentCtx, payload: Record<string, unknown>): Promise<Check[]> {
  const parsed = FluxExplanationDraft.safeParse(payload);
  if (!parsed.success) return [fail('shape:ek:VarianceExplanation', 'Explanation has the required structure', parsed.error.issues[0]?.message)];
  const d = parsed.data;
  const checks: Check[] = [ok('narrative', 'Has a narrative', `${d.narrative.length} characters`)];
  const threshold = { abs: ctx.policy.thresholds.absThreshold ?? DEFAULT_THRESHOLD.abs, pct: ctx.policy.thresholds.pctThreshold ?? DEFAULT_THRESHOLD.pct, mode: 'and' as const };
  const line = d.comparison === "prior_year" ? undefined : (await computeFluxLines(ctx.svc, d.entityId, d.periodKey, d.comparison, threshold)).find((l) => l.accountId === d.accountId);
  checks.push(line && line.variance === d.variance ? ok('fresh', 'Variance still matches the ledger', formatMoney(d.variance)) : fail('fresh', 'Variance still matches the ledger', line ? `now ${formatMoney(line.variance)}; re-run the analysis` : 'line no longer exists'));
  if (line && !line.material) checks.push(fail('AX-FLX-01', 'Variance is material', 'below the thresholds now', 'warning'));
  checks.push(d.coverage >= 0.8 ? ok('AX-FLX-02', 'Drivers explain at least 80% of the variance', `${Math.round(d.coverage * 100)}%`) : fail('AX-FLX-02', 'Drivers explain at least 80% of the variance', `${Math.round(d.coverage * 100)}%`, 'warning'));
  const driverSum = d.drivers.reduce((s, x) => s + x.amount, 0);
  checks.push(driversReconcile(d.drivers, d.variance) ? ok('drivers', 'Drivers add up to the variance', formatMoney(driverSum)) : fail('drivers', 'Drivers add up to the variance', `drivers ${formatMoney(driverSum)} vs variance ${formatMoney(d.variance)}`, 'warning'));
  return checks;
}

async function verifyPrepaid(ctx: AgentCtx, payload: Record<string, unknown>): Promise<Check[]> {
  const parsed = PrepaidScheduleDraft.safeParse(payload);
  if (!parsed.success) return [fail('shape:ek:PrepaidSchedule', 'Schedule has the required structure', parsed.error.issues[0]?.message)];
  const d = parsed.data;
  const accs = await accounts(ctx.svc);
  const pp = accs.get(d.prepaidAccountId);
  const ex = accs.get(d.expenseAccountId);
  const checks: Check[] = [];
  checks.push(pp?.account_type === 'ek:PrepaidAccount' ? ok('class', 'Prepaid account is a prepaid asset', `${pp.code} ${pp.name}`) : fail('class', 'Prepaid account is a prepaid asset'));
  checks.push(ex?.account_class === 'expense' ? ok('expense', 'Expense account is an expense', `${ex.code} ${ex.name}`) : fail('expense', 'Expense account is an expense'));
  const existing = (await ctx.svc.db.find('prepaid_schedule', { tenant_id: ctx.svc.tenantId })).find((s) => (s.source_ref as Record<string, unknown> | null)?.id === d.sourceRef.id);
  checks.push(existing ? fail('unique', 'No schedule exists for this purchase yet', existing.description) : ok('unique', 'No schedule exists for this purchase yet'));
  const period = await periodOf(ctx.svc, d.entityId, ctx.periodKey);
  checks.push(period.status !== 'hard_close' ? ok('AX-PER-01', 'Period is open for adjustments', ctx.periodKey) : fail('AX-PER-01', 'Period is open for adjustments'));
  if (d.sourceRef.type === 'bill') {
    const b = await ctx.svc.db.get('bill', d.sourceRef.id);
    checks.push(b && b.amount === d.total ? ok('amount', 'Schedule total equals the bill', formatMoney(d.total)) : fail('amount', 'Schedule total equals the bill'));
  }
  return checks;
}

async function verifyFixedAsset(ctx: AgentCtx, payload: Record<string, unknown>): Promise<Check[]> {
  const parsed = FixedAssetDraft.safeParse(payload);
  if (!parsed.success) return [fail('shape:ek:FixedAsset', 'Asset has the required structure', parsed.error.issues[0]?.message)];
  const d = parsed.data;
  const accs = await accounts(ctx.svc);
  const s = await settings(ctx.svc);
  const checks: Check[] = [];
  checks.push(accs.get(d.assetAccountId)?.account_type === 'ek:FixedAssetAccount' ? ok('asset', 'Cost account is a fixed-asset account') : fail('asset', 'Cost account is a fixed-asset account'));
  checks.push(accs.get(d.accumDeprAccountId)?.account_type === 'ek:AccumulatedDepreciationAccount' ? ok('accum', 'Accumulated depreciation account is correct') : fail('accum', 'Accumulated depreciation account is correct'));
  checks.push(accs.get(d.deprExpenseAccountId)?.account_class === 'expense' ? ok('expense', 'Depreciation expense account is an expense') : fail('expense', 'Depreciation expense account is an expense'));
  const unit = Math.round(d.cost / d.quantity);
  checks.push(unit >= s.capitalizationThreshold ? ok('AX-CAP-01', 'Meets the capitalisation threshold', `${formatMoney(unit)} per unit`) : fail('AX-CAP-01', 'Meets the capitalisation threshold', `${formatMoney(unit)} per unit is below ${formatMoney(s.capitalizationThreshold)}`, 'warning'));
  const registered = (await ctx.svc.db.find('fixed_asset', { tenant_id: ctx.svc.tenantId })).some((a) => (a.source_ref as Record<string, unknown> | null)?.journalLineId === d.sourceRef.id);
  checks.push(registered ? fail('unique', 'Not already in the register') : ok('unique', 'Not already in the register'));
  if (d.sourceRef.type === 'journal_line') {
    const l = await ctx.svc.db.get('journal_line', d.sourceRef.id);
    checks.push(l && l.debit === d.cost && l.account_id === d.assetAccountId ? ok('ledger', 'Cost agrees to the amount capitalised in the ledger', formatMoney(d.cost)) : fail('ledger', 'Cost agrees to the amount capitalised in the ledger'));
  }
  return checks;
}

async function verifyPackage(ctx: AgentCtx, payload: Record<string, unknown>): Promise<Check[]> {
  const parsed = ClosePackageDraft.safeParse(payload);
  if (!parsed.success) return [fail('shape:ek:ClosePackage', 'Package has the required structure', parsed.error.issues[0]?.message)];
  const d = parsed.data;
  const fresh = await buildPackageContent(ctx.svc, d.periodKey, null);
  const same = contentHash(fresh) === d.contentHash;
  const final = await ctx.svc.db.findOne('close_package', { tenant_id: ctx.svc.tenantId, period_key: d.periodKey, status: 'final' });
  return [
    same ? ok('hash', 'Numbers unchanged since the package was built') : fail('hash', 'Numbers unchanged since the package was built', 'The ledger moved; the agent must rebuild the package.'),
    fresh.consolidated.balanced ? ok('AX-DE-05', 'Consolidated trial balance balances') : fail('AX-DE-05', 'Consolidated trial balance balances'),
    final ? fail('final', 'No final package exists yet', `version ${final.version} is final`) : ok('final', 'No final package exists yet'),
  ];
}

export async function verifyProposal(ctx: AgentCtx, draft: ProposalDraft): Promise<VerificationReport> {
  const p = draft.payload;
  switch (draft.kind) {
    case 'journal_entry':
      return report(await verifyJournalEntry(ctx, p));
    case 'coding':
      return report(await verifyCoding(ctx, p, draft));
    case 'rec_match':
      return report(await verifyRecMatch(ctx, p));
    case 'reconciling_item':
      return report(await verifyReconcilingItem(ctx, p));
    case 'flux_explanation':
      return report(await verifyFlux(ctx, p));
    case 'issue': {
      const parsed = IssueDraft.safeParse(p);
      return report(parsed.success ? [ok('shape:ek:Exception', 'Exception has subject references and a recommended action')] : [fail('shape:ek:Exception', 'Exception has the required structure', parsed.error.issues[0]?.message)]);
    }
    case 'prepaid_schedule':
      return report(await verifyPrepaid(ctx, p));
    case 'fixed_asset':
      return report(await verifyFixedAsset(ctx, p));
    case 'task_update': {
      const parsed = TaskUpdate.safeParse(p);
      if (!parsed.success) return report([fail('shape', 'Task update has the required structure')]);
      const t = await ctx.svc.db.get('close_task', parsed.data.taskId);
      return report([t ? ok('task', 'Task exists', t.code) : fail('task', 'Task exists')]);
    }
    case 'close_package':
      return report(await verifyPackage(ctx, p));
    default:
      return report([fail('kind', 'Known proposal kind', draft.kind)]);
  }
}

export async function entityPeriodOpen(ctx: AgentCtx, entityId: string): Promise<boolean> {
  const p = await periodOf(ctx.svc, entityId, ctx.periodKey);
  return p.status !== 'hard_close';
}

export async function entityCurrencyOf(ctx: AgentCtx, entityId: string | null | undefined): Promise<string> {
  if (!entityId) return (await settings(ctx.svc)).reportingCurrency;
  return (await entityById(ctx.svc, entityId)).functional_currency;
}

export function periodEndOf(ctx: AgentCtx): string {
  return periodEnd(ctx.periodKey);
}
