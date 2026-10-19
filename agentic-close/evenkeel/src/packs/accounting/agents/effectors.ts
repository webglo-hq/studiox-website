import type { ProposalRecord } from '../../../framework/runtime/types';
import { addMonths, periodEnd } from '../../../framework/util/dates';
import { AppError } from '../../../framework/util/errors';
import { audit } from '../domain/audit';
import { withDb, type ServiceContext } from '../domain/context';
import { createEntry, postEntry, reverseEntry } from '../domain/ledger';
import { accountByCode, accounts, entityById } from '../domain/refdata';
import { depreciationForPeriod, prepaidSchedule } from '../domain/schedule-math';
import { ClosePackageDraft, CodingDecision, FixedAssetDraft, FluxExplanationDraft, IssueDraft, JournalEntryDraft, PrepaidScheduleDraft, RecMatch, ReconcilingItemDraft, TaskUpdate, type JournalEntryDraftInput } from '../ontology/shapes';
import { DEFAULT_THRESHOLD, ensureAnalysis, refreshAnalysisStatus, type Comparison } from '../services/flux';
import { createPackage } from '../services/package';
import { createMatch, refreshRec } from '../services/recs';
import type { AgentCtx } from './context';
import { linksOf } from './verify';

/**
 * Effectors turn an approved (or policy-auto-approved) proposal into ledger and subledger
 * changes. Each runs in one transaction: either everything the proposal promised happens,
 * or nothing does. Posting always goes through the ledger service, so every axiom and every
 * database trigger applies again at this point.
 */

export interface Decision {
  decidedBy: string | null;
  policyLabel: string | null;
}

function jeOpts(ctx: AgentCtx, p: ProposalRecord, decision: Decision) {
  return {
    source: 'agent' as const,
    preparedBy: null,
    preparedByAgent: ctx.skill.id,
    requestedBy: ctx.run.requestedBy,
    proposalId: p.id,
    sourceRef: { ...((p.payload.meta ?? {}) as Record<string, unknown>), proposal: p.id, run: ctx.run.id, skill: ctx.skill.id },
    approvedBy: decision.decidedBy,
    approvalPolicy: decision.decidedBy ? 'human-approval' : decision.policyLabel,
    postedBy: decision.decidedBy,
  };
}

async function postJe(t: ServiceContext, ctx: AgentCtx, p: ProposalRecord, decision: Decision, input: JournalEntryDraftInput, keySuffix = '') {
  const o = jeOpts(ctx, p, decision);
  const je = await createEntry(t, input, { source: o.source, preparedBy: o.preparedBy, preparedByAgent: o.preparedByAgent, requestedBy: o.requestedBy, proposalId: o.proposalId, sourceRef: o.sourceRef, idempotencyKey: `proposal:${p.id}${keySuffix}`, skipAxioms: ['AX-ACC-04'] });
  return postEntry(t, je.id, { approvedBy: o.approvedBy, approvalPolicy: o.approvalPolicy, postedBy: o.postedBy });
}

/** Resolve open reconciling items that point at any of the given records. */
async function resolveItemsFor(t: ServiceContext, refs: { type: string; id: string }[], entryId: string, by: string | null): Promise<string[]> {
  if (!refs.length) return [];
  const keys = new Set(refs.map((r) => `${r.type}:${r.id}`));
  const open = await t.db.find('reconciling_item', { tenant_id: t.tenantId, status: 'open' });
  const hit = open.filter((i) => ((i.source_refs ?? []) as { type: string; id: string }[]).some((r) => keys.has(`${r.type}:${r.id}`)));
  for (const i of hit) await t.db.update('reconciling_item', i.id, { status: 'resolved', resolution_entry_id: entryId, resolved_at: t.clock.nowIso(), resolved_by: by });
  return [...new Set(hit.map((i) => i.reconciliation_id))];
}

async function applyJournalEntry(t: ServiceContext, ctx: AgentCtx, p: ProposalRecord, decision: Decision) {
  const draft = JournalEntryDraft.parse(p.payload);
  const links = linksOf(p.payload);
  const posted = await postJe(t, ctx, p, decision, draft);
  const out: Record<string, unknown> = { journalEntryId: posted.id, entryNumber: posted.entry_number };
  if (links.prepaidLineIds?.length) await t.db.updateWhere('prepaid_line', { id: { in: links.prepaidLineIds } }, { status: 'posted', journal_entry_id: posted.id });
  if (links.depreciationLineIds?.length) await t.db.updateWhere('depreciation_line', { id: { in: links.depreciationLineIds } }, { status: 'posted', journal_entry_id: posted.id });
  const touched = new Set<string>();
  if (links.bankTransactionIds?.length && links.recId) {
    const rec = (await t.db.get('reconciliation', links.recId))!;
    const cashLines = await t.db.find('journal_line', { journal_entry_id: posted.id, account_id: rec.account_id });
    await createMatch(t, { reconciliationId: rec.id, bankTransactionIds: links.bankTransactionIds, journalLineIds: cashLines.map((l) => l.id), rationale: `Matched to ${posted.entry_number}, which records this statement line.`, proposalId: p.id, createdBy: 'agent', acceptedBy: decision.decidedBy });
    touched.add(rec.id);
    out.matched = links.bankTransactionIds.length;
  }
  const resolves = [...(links.resolves ?? []), ...(draft.reversesEntryId ? [{ type: 'journal_entry', id: draft.reversesEntryId }] : [])];
  for (const r of await resolveItemsFor(t, resolves, posted.id, decision.decidedBy)) touched.add(r);
  if ((draft.entryType === 'accrual' || draft.entryType === 'elimination') && draft.autoReverseDate) {
    const rev = await reverseEntry(t, posted.id, { entryDate: draft.autoReverseDate, periodKey: draft.autoReverseDate.slice(0, 7), reason: draft.entryType === 'accrual' ? 'Automatic reversal of month-end accrual' : 'Automatic reversal of balance elimination', source: 'system' });
    out.reversalEntryId = rev.id;
    out.reversalEntryNumber = rev.entry_number;
  }
  out.recsTouched = [...touched];
  return out;
}

async function applyCoding(t: ServiceContext, ctx: AgentCtx, p: ProposalRecord, decision: Decision) {
  const d = CodingDecision.parse(p.payload);
  const txn = await t.db.get('card_transaction', d.subjectId);
  if (!txn) throw new AppError('NOT_FOUND', 'Card transaction not found');
  if (txn.status === 'posted') throw new AppError('CONFLICT', 'This card transaction is already posted.');
  const ent = await entityById(t, txn.entity_id);
  const cardPayable = await accountByCode(t, '2200');
  const posted = await postJe(t, ctx, p, decision, {
    entityId: ent.id,
    entryDate: txn.txn_date,
    periodKey: txn.txn_date.slice(0, 7),
    entryType: 'standard',
    memo: `Card ${txn.card_last4} — ${txn.merchant_name}`.slice(0, 200),
    currency: ent.functional_currency,
    lines: [
      { accountId: d.accountId, debit: txn.amount, credit: 0, departmentId: d.departmentId ?? null, memo: (txn.memo ?? '').slice(0, 200) || undefined, sourceRef: { type: 'card_transaction', id: txn.id } },
      { accountId: cardPayable.id, debit: 0, credit: txn.amount, sourceRef: { type: 'card_transaction', id: txn.id } },
    ],
  });
  await t.db.update('card_transaction', txn.id, { status: 'posted', account_id: d.accountId, department_id: d.departmentId ?? null, coding_source: 'agent', coding_confidence: p.confidence, journal_entry_id: posted.id });
  return { journalEntryId: posted.id, entryNumber: posted.entry_number, accountId: d.accountId };
}

async function applyRecMatch(t: ServiceContext, p: ProposalRecord, decision: Decision) {
  const m = RecMatch.parse(p.payload);
  const id = await createMatch(t, { reconciliationId: m.reconciliationId!, bankTransactionIds: m.bankItems.map((b) => b.id), journalLineIds: m.ledgerItems.map((l) => l.id), matchType: m.matchType, confidence: m.confidence, rationale: p.why, proposalId: p.id, createdBy: 'agent', acceptedBy: decision.decidedBy });
  return { matchId: id, recsTouched: [m.reconciliationId] };
}

async function applyReconcilingItem(t: ServiceContext, p: ProposalRecord) {
  const d = ReconcilingItemDraft.parse(p.payload);
  const row = await t.db.insert('reconciling_item', { tenant_id: t.tenantId, reconciliation_id: d.reconciliationId!, item_type: d.itemType, side: d.side, amount: d.amount, description: d.description, origin_date: d.originDate, expected_clear_date: d.expectedClearDate ?? null, status: 'open', cleared_by: d.clearedBy ?? null, source_refs: d.sourceRefs, proposal_id: p.id, created_by_type: 'agent', created_at: t.clock.nowIso() });
  return { reconcilingItemId: row.id, recsTouched: [d.reconciliationId] };
}

async function applyFlux(t: ServiceContext, ctx: AgentCtx, p: ProposalRecord, decision: Decision) {
  const d = FluxExplanationDraft.parse(p.payload);
  const threshold = { abs: ctx.policy.thresholds.absThreshold ?? DEFAULT_THRESHOLD.abs, pct: ctx.policy.thresholds.pctThreshold ?? DEFAULT_THRESHOLD.pct, mode: 'and' as const };
  const ensured = await ensureAnalysis(t, d.entityId, d.periodKey, d.comparison as Comparison, threshold, ctx.run.id);
  const lineId = ensured.lines.get(d.accountId);
  if (!lineId) throw new AppError('NOT_FOUND', 'No variance line for this account any more.');
  const approved = !!decision.decidedBy;
  const ex = await t.db.insert('flux_explanation', { tenant_id: t.tenantId, flux_line_id: lineId, narrative: d.narrative, drivers: d.drivers, coverage: d.coverage, author_type: 'agent', author_id: ctx.run.requestedBy, run_id: ctx.run.id, status: approved ? 'approved' : 'submitted', approved_by: decision.decidedBy, approved_at: approved ? t.clock.nowIso() : null, created_at: t.clock.nowIso() });
  await t.db.update('flux_line', lineId, { status: approved ? 'approved' : 'explained' });
  if (approved) await refreshAnalysisStatus(t, ensured.analysisId);
  return { explanationId: ex.id, fluxLineId: lineId, analysisId: ensured.analysisId };
}

async function applyIssue(t: ServiceContext, ctx: AgentCtx, p: ProposalRecord) {
  const d = IssueDraft.parse(p.payload);
  const refs = new Set(d.subjectRefs.map((r) => `${r.type}:${r.id}`));
  const open = await t.db.find('issue', { tenant_id: t.tenantId, period_key: p.periodKey ?? ctx.periodKey, status: { in: ['open', 'acknowledged'] } });
  const existing = open.find((i) => ((i.subject_refs ?? []) as { type: string; id: string }[]).some((r) => refs.has(`${r.type}:${r.id}`)) && (i.category === d.category || d.category === 'other' || i.category === 'other'));
  if (existing) {
    const merged = [...(existing.subject_refs as unknown[]), ...d.subjectRefs.filter((r) => !((existing.subject_refs ?? []) as { type: string; id: string }[]).some((x) => x.type === r.type && x.id === r.id))];
    const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
    await t.db.update('issue', existing.id, { subject_refs: merged, severity: rank[d.severity] > rank[existing.severity] ? d.severity : existing.severity, description: `${existing.description}\n\nAlso found by ${ctx.skill.manifest.title}: ${d.description}`.slice(0, 4000) });
    return { issueId: existing.id, merged: true };
  }
  const task = ctx.run.taskId ? await t.db.get('close_task', ctx.run.taskId) : null;
  const row = await t.db.insert('issue', { tenant_id: t.tenantId, proposal_id: p.id, category: d.category, severity: d.severity, title: d.title, description: d.description, amount: d.amount ?? null, entity_id: d.entityId ?? p.entityId, period_key: p.periodKey ?? ctx.periodKey, subject_refs: d.subjectRefs, recommended_action: d.recommendedAction, status: 'open', owner_id: task?.reviewer_id ?? null, created_at: t.clock.nowIso() });
  return { issueId: row.id, merged: false };
}

async function applyPrepaid(t: ServiceContext, ctx: AgentCtx, p: ProposalRecord, decision: Decision) {
  const d = PrepaidScheduleDraft.parse(p.payload);
  const ent = await entityById(t, d.entityId);
  const today = periodEnd(ctx.periodKey);
  const reclass = await postJe(t, ctx, p, decision, {
    entityId: d.entityId,
    entryDate: today,
    periodKey: ctx.periodKey,
    entryType: 'reclass',
    memo: `Reclassify ${d.description} to prepaid`.slice(0, 300),
    currency: ent.functional_currency,
    lines: [
      { accountId: d.prepaidAccountId, debit: d.total, credit: 0, sourceRef: d.sourceRef },
      { accountId: d.expenseAccountId, debit: 0, credit: d.total, departmentId: d.departmentId ?? null, sourceRef: d.sourceRef },
    ],
  }, ':reclass');
  const sched = await t.db.insert('prepaid_schedule', { tenant_id: t.tenantId, entity_id: d.entityId, description: d.description, vendor_id: d.vendorId ?? null, total: d.total, start_period: d.startPeriod, months: d.months, prepaid_account_id: d.prepaidAccountId, expense_account_id: d.expenseAccountId, department_id: d.departmentId ?? null, source_ref: { ...d.sourceRef, proposal: p.id }, status: 'active', created_at: t.clock.nowIso() });
  const lines = prepaidSchedule(d.total, d.startPeriod, d.months);
  await t.db.insertMany('prepaid_line', lines.map((l) => ({ tenant_id: t.tenantId, schedule_id: sched.id, period_key: l.periodKey, amount: l.amount, status: 'scheduled' as const })));
  const due = lines.filter((l) => l.periodKey <= ctx.periodKey);
  let amortEntry: string | null = null;
  if (due.length) {
    const amount = due.reduce((s, l) => s + l.amount, 0);
    const am = await postJe(t, ctx, p, decision, {
      entityId: d.entityId,
      entryDate: today,
      periodKey: ctx.periodKey,
      entryType: 'amortization',
      memo: `Amortise ${d.description} — ${due.map((l) => l.periodKey).join(', ')}`.slice(0, 300),
      currency: ent.functional_currency,
      lines: [
        { accountId: d.expenseAccountId, debit: amount, credit: 0, departmentId: d.departmentId ?? null, sourceRef: { type: 'prepaid_schedule', id: sched.id } },
        { accountId: d.prepaidAccountId, debit: 0, credit: amount, sourceRef: { type: 'prepaid_schedule', id: sched.id } },
      ],
    }, ':amortization');
    amortEntry = am.entry_number;
    const created = await t.db.find('prepaid_line', { schedule_id: sched.id });
    await t.db.updateWhere('prepaid_line', { id: { in: created.filter((l) => l.period_key <= ctx.periodKey).map((l) => l.id) } }, { status: 'posted', journal_entry_id: am.id });
  }
  return { scheduleId: sched.id, reclassEntry: reclass.entry_number, amortizationEntry: amortEntry };
}

async function nextAssetTag(t: ServiceContext): Promise<string> {
  const assets = await t.db.find('fixed_asset', { tenant_id: t.tenantId });
  const max = assets.reduce((m, a) => Math.max(m, Number(/FA-(\d+)/.exec(a.tag)?.[1] ?? 0)), 0);
  return `FA-${String(max + 1).padStart(4, '0')}`;
}

async function applyFixedAsset(t: ServiceContext, ctx: AgentCtx, p: ProposalRecord, decision: Decision) {
  const d = FixedAssetDraft.parse(p.payload);
  const ent = await entityById(t, d.entityId);
  const tag = await nextAssetTag(t);
  const asset = await t.db.insert('fixed_asset', { tenant_id: t.tenantId, entity_id: d.entityId, tag, name: d.name, asset_class: d.assetClass, acquisition_date: d.inServiceDate, in_service_date: d.inServiceDate, cost: d.cost, salvage: d.salvage, useful_life_months: d.usefulLifeMonths, method: 'straight_line', asset_account_id: d.assetAccountId, accum_depr_account_id: d.accumDeprAccountId, depr_expense_account_id: d.deprExpenseAccountId, department_id: d.departmentId ?? null, status: 'in_service', source_ref: { journalLineId: d.sourceRef.id, type: d.sourceRef.type, proposal: p.id, quantity: d.quantity }, created_at: t.clock.nowIso() });
  const fact = { id: asset.id, tag, name: d.name, cost: d.cost, salvage: d.salvage, usefulLifeMonths: d.usefulLifeMonths, inServiceDate: d.inServiceDate, departmentId: d.departmentId ?? null, status: 'in_service' };
  const start = d.inServiceDate.slice(0, 7);
  const rows = [];
  for (let i = 0; i < d.usefulLifeMonths; i++) {
    const pk = addMonths(start, i);
    rows.push({ tenant_id: t.tenantId, fixed_asset_id: asset.id, period_key: pk, amount: depreciationForPeriod(fact, pk), status: 'scheduled' as const });
  }
  await t.db.insertMany('depreciation_line', rows);
  // Catch up depreciation for months up to the current period (full-month convention).
  const due = rows.filter((r) => r.period_key <= ctx.periodKey);
  let entry: string | null = null;
  if (due.length) {
    const amount = due.reduce((s, r) => s + r.amount, 0);
    const deprExp = d.deprExpenseAccountId;
    const posted = await postJe(t, ctx, p, decision, {
      entityId: d.entityId,
      entryDate: periodEnd(ctx.periodKey),
      periodKey: ctx.periodKey,
      entryType: 'depreciation',
      memo: `Depreciation — ${tag} ${d.name} (${due.map((r) => r.period_key).join(', ')})`.slice(0, 300),
      currency: ent.functional_currency,
      lines: [
        { accountId: deprExp, debit: amount, credit: 0, departmentId: d.departmentId ?? null, sourceRef: { type: 'fixed_asset', id: asset.id } },
        { accountId: d.accumDeprAccountId, debit: 0, credit: amount, sourceRef: { type: 'fixed_asset', id: asset.id } },
      ],
    }, ':depreciation');
    entry = posted.entry_number;
    const created = await t.db.find('depreciation_line', { fixed_asset_id: asset.id });
    await t.db.updateWhere('depreciation_line', { id: { in: created.filter((r) => r.period_key <= ctx.periodKey).map((r) => r.id) } }, { status: 'posted', journal_entry_id: posted.id });
  }
  return { assetId: asset.id, tag, depreciationEntry: entry };
}

async function applyTaskUpdate(t: ServiceContext, p: ProposalRecord) {
  const d = TaskUpdate.parse(p.payload);
  await t.db.update('close_task', d.taskId, { status: d.status, notes: d.note ?? null });
  return { taskId: d.taskId, status: d.status };
}

async function applyPackage(t: ServiceContext, ctx: AgentCtx, p: ProposalRecord) {
  const d = ClosePackageDraft.parse(p.payload);
  const pkg = await createPackage(t, d.periodKey, { commentary: d.commentary, runId: ctx.run.id, generatedBy: ctx.run.requestedBy });
  return { packageId: pkg.id, version: pkg.version, contentHash: pkg.contentHash };
}

export async function applyProposal(ctx: AgentCtx, p: ProposalRecord, decision: Decision): Promise<Record<string, unknown>> {
  const result = await ctx.svc.db.tx(async (db) => {
    const t = withDb(ctx.svc, db);
    let out: Record<string, unknown>;
    switch (p.kind) {
      case 'journal_entry':
        out = await applyJournalEntry(t, ctx, p, decision);
        break;
      case 'coding':
        out = await applyCoding(t, ctx, p, decision);
        break;
      case 'rec_match':
        out = await applyRecMatch(t, p, decision);
        break;
      case 'reconciling_item':
        out = await applyReconcilingItem(t, p);
        break;
      case 'flux_explanation':
        out = await applyFlux(t, ctx, p, decision);
        break;
      case 'issue':
        out = await applyIssue(t, ctx, p);
        break;
      case 'prepaid_schedule':
        out = await applyPrepaid(t, ctx, p, decision);
        break;
      case 'fixed_asset':
        out = await applyFixedAsset(t, ctx, p, decision);
        break;
      case 'task_update':
        out = await applyTaskUpdate(t, p);
        break;
      case 'close_package':
        out = await applyPackage(t, ctx, p);
        break;
      default:
        throw new AppError('VALIDATION', `Unknown proposal kind ${p.kind}`);
    }
    await audit(t, { action: 'agent.proposal.applied', subjectType: 'proposal', subjectId: p.id, data: { kind: p.kind, by: decision.decidedBy, policy: decision.policyLabel, result: out } });
    return out;
  });
  for (const recId of (result.recsTouched as string[] | undefined) ?? []) await refreshRec(ctx.svc, recId);
  return result;
}

export async function accountsForCodes(ctx: ServiceContext, codes: string[]): Promise<Record<string, string>> {
  const accs = [...(await accounts(ctx)).values()];
  return Object.fromEntries(codes.map((c) => [c, accs.find((a) => a.code === c)?.id ?? '']));
}
