/**
 * Apply an approved proposal: the only path from agent output to the books. Runs inside the
 * approver's unit of work (a person, or a Controller-signed policy), re-validates the payload and
 * relies on the ledger services and database triggers for the invariants (defense in depth).
 */
import type { ApplyResult } from '../../../core/agent/runtime';
import { audit } from '../../../core/audit/audit';
import { conflict, precondition } from '../../../core/util/errors';
import { sha256Hex } from '../../../core/util/hash';
import { canonicalJson } from '../../../core/util/json';
import { periodKeyOf, periodRange, shiftPeriod } from '../../../core/util/time';
import type { ProposalRow } from '../../../schema';
import { approveAndPost, createJournalEntry, runAutoReversals } from '../ledger/journal';
import type { ClosePackageContent } from '../model/types';
import type { AccountingServices } from '../services';
import { CodingPayloadSchema, FindingPayloadSchema, FluxPayloadSchema, JePayloadSchema, RecMatchPayloadSchema, ReconcilingItemPayloadSchema, ReportPayloadSchema, type JePayload } from './payloads';
import { jeInput } from './verify';

export interface Approver {
  id: string;
  route: 'human' | 'policy';
  policyRef?: string;
}

export async function applyProposal(svc: AccountingServices, proposal: ProposalRow, approver: Approver): Promise<ApplyResult | null> {
  switch (proposal.kind) {
    case 'journal_entry':
      return applyJournal(svc, proposal, JePayloadSchema.parse(proposal.payload), approver);
    case 'coding':
      return applyCoding(svc, proposal, approver);
    case 'rec_match':
      return applyMatch(svc, proposal, approver);
    case 'reconciling_item':
      return applyReconcilingItem(svc, proposal);
    case 'flux_explanation':
      return applyFlux(svc, proposal, approver);
    case 'finding':
      return applyFinding(svc, proposal, approver);
    case 'report':
      return applyReport(svc, proposal);
    default:
      throw precondition(`Proposals of kind ${proposal.kind} cannot be applied`);
  }
}

async function post(svc: AccountingServices, jeId: string, approver: Approver, reason: string) {
  return approveAndPost(await svc.ctx.ledger(), jeId, { route: approver.route, approverId: approver.id, policyRef: approver.policyRef, reason });
}

async function applyJournal(svc: AccountingServices, proposal: ProposalRow, p: JePayload, approver: Approver): Promise<ApplyResult> {
  const tx = svc.tx;
  for (const id of p.dependsOnProposalIds ?? []) {
    const dep = await tx.get('proposals', id);
    if (!dep || dep.status !== 'applied') throw precondition(`Approve ${dep?.ref ?? id} first: this entry was computed assuming it is posted.`);
  }
  const je = await createJournalEntry(await svc.ctx.ledger(), jeInput(p, proposal.prepared_by, { proposalId: proposal.id, agentRunId: proposal.run_id, idempotencyKey: `proposal:${proposal.id}` }), 'pending_approval');
  const posted = await post(svc, je.id, approver, `Proposal ${proposal.ref}`);
  // Accruals reverse on day 1 of the next period. The close runs after month-end, so that period is
  // usually already open: post the reversal now and next month starts clean (AX-ACR-01).
  if (posted.auto_reverse_on && posted.auto_reverse_on <= (await svc.ctx.businessDate())) await runAutoReversals(await svc.ctx.ledger(), posted.entity_id, posted.auto_reverse_on);
  const now = svc.ctx.clock.now().toISOString();
  const e = p.effects;
  if (e?.depreciationLineIds?.length) await tx.updateWhere('depreciation_lines', { id: { in: e.depreciationLineIds } }, { status: 'posted', journal_entry_id: posted.id });
  if (e?.prepaidLineIds?.length) await tx.updateWhere('prepaid_lines', { id: { in: e.prepaidLineIds } }, { status: 'posted', journal_entry_id: posted.id });
  if (e?.cardRecode) {
    const acct = (await svc.ctx.chart()).account(e.cardRecode.accountCode);
    await tx.update('card_transactions', e.cardRecode.cardTxnId, { account_id: acct.id, department: e.cardRecode.department, coding_source: 'agent', coding_confidence: Number(proposal.confidence) });
  }
  if (e?.billLineRecode) {
    const acct = (await svc.ctx.chart()).account(e.billLineRecode.accountCode);
    await tx.update('bill_lines', e.billLineRecode.billLineId, { account_id: acct.id, department: e.billLineRecode.department, coding_source: 'agent', coding_confidence: Number(proposal.confidence) });
  }
  if (e?.fixedAsset) {
    const fa = e.fixedAsset;
    const chart = await svc.ctx.chart();
    const n = (await tx.count('fixed_assets', { entity_id: p.entityId })) + 1;
    const asset = await tx.insert('fixed_assets', {
      entity_id: p.entityId,
      asset_tag: `FA-${chart.shortCode(p.entityId)}-${String(n).padStart(4, '0')}`,
      description: fa.description,
      category: fa.category,
      in_service_date: fa.inServiceDate,
      cost_minor: fa.costMinor,
      salvage_minor: 0,
      useful_life_months: fa.usefulLifeMonths,
      method: 'straight_line',
      asset_account_id: chart.account(fa.assetAccount).id,
      accum_depr_account_id: chart.account('1590').id,
      expense_account_id: chart.account('6800').id,
      department: fa.department,
      status: 'active',
      source_bill_id: fa.sourceBillId,
    });
    // depreciation starts the month after the asset is placed in service
    const first = shiftPeriod(periodKeyOf(fa.inServiceDate), 1);
    const per = Math.round(fa.costMinor / fa.usefulLifeMonths);
    const months = periodRange(first, shiftPeriod(first, fa.usefulLifeMonths - 1));
    await tx.insertMany(
      'depreciation_lines',
      months.map((pk, i) => ({ fixed_asset_id: asset.id, period_key: pk, amount_minor: i === months.length - 1 ? fa.costMinor - per * (months.length - 1) : per, status: 'scheduled' as const, journal_entry_id: null })),
    );
  }
  if (e?.bankMatch) {
    const ba = await svc.bank.account(e.bankMatch.bankAccountId);
    const rec = await svc.bank.ensureReconciliation(ba.id, p.periodKey, proposal.run_id);
    const cashLine = (await tx.find('journal_lines', { journal_entry_id: posted.id, account_id: ba.gl_account_id }))[0];
    const bt = await tx.get('bank_transactions', e.bankMatch.bankTxnId);
    if (cashLine && bt) {
      const m = await tx.insert('rec_matches', { reconciliation_id: rec.id, match_type: 'exact', status: 'confirmed', confidence: Number(proposal.confidence), difference_minor: 0, explanation: `${bt.description} booked by ${posted.je_number}`, matched_by: proposal.prepared_by, proposal_id: proposal.id, confirmed_by: approver.id, confirmed_at: now, created_at: now });
      await tx.insertMany('rec_match_items', [
        { rec_match_id: m.id, side: 'external', item_type: 'bank_transaction', item_id: bt.id, amount_minor: bt.amount_minor },
        { rec_match_id: m.id, side: 'ledger', item_type: 'journal_line', item_id: cashLine.id, amount_minor: cashLine.debit_minor - cashLine.credit_minor },
      ]);
      await tx.update('bank_transactions', bt.id, { status: 'matched' });
    }
  }
  return { refType: 'journal_entry', refId: posted.id };
}

async function applyCoding(svc: AccountingServices, proposal: ProposalRow, approver: Approver): Promise<ApplyResult> {
  const p = CodingPayloadSchema.parse(proposal.payload);
  const tx = svc.tx;
  const t = await tx.get('card_transactions', p.target.id);
  if (!t) throw precondition('The card transaction no longer exists');
  if (t.status !== 'pending_coding') throw conflict(`This card charge is already ${t.status.replace('_', ' ')}`);
  const chart = await svc.ctx.chart();
  const card = await tx.get('cards', t.card_id);
  const acct = chart.account(p.accountCode);
  const amt = t.amount_minor;
  const cardAccount = card ? chart.account(card.gl_account_id).code : '2200';
  const je = await createJournalEntry(
    await svc.ctx.ledger(),
    {
      entityId: t.entity_id,
      postingDate: t.txn_date,
      entryType: 'standard',
      memo: `Card ••${card?.last4 ?? '????'} ${t.merchant_name}`,
      source: 'subledger',
      sourceRef: t.external_id,
      sourceDocumentId: t.source_document_id,
      preparedBy: proposal.prepared_by,
      proposalId: proposal.id,
      agentRunId: proposal.run_id,
      idempotencyKey: `proposal:${proposal.id}`,
      lines: [
        { account: acct.code, ...(amt > 0 ? { debit: amt } : { credit: -amt }), department: acct.required_dimensions.includes('department') ? p.department : null, memo: t.merchant_name },
        { account: cardAccount, ...(amt > 0 ? { credit: amt } : { debit: -amt }), memo: `Card ••${card?.last4 ?? ''}` },
      ],
    },
    'pending_approval',
  );
  const posted = await post(svc, je.id, approver, `Coding ${proposal.ref}`);
  await tx.update('card_transactions', t.id, { account_id: acct.id, department: p.department, coding_source: approver.route === 'human' ? 'human' : 'agent', coding_confidence: Number(proposal.confidence), status: 'posted', journal_entry_id: posted.id });
  return { refType: 'journal_entry', refId: posted.id };
}

async function applyMatch(svc: AccountingServices, proposal: ProposalRow, approver: Approver): Promise<ApplyResult> {
  const p = RecMatchPayloadSchema.parse(proposal.payload);
  const tx = svc.tx;
  const rec = await svc.bank.ensureReconciliation(p.bankAccountId, p.periodKey, proposal.run_id);
  const ext = await tx.find('bank_transactions', { id: { in: p.externalIds } });
  if (ext.length !== p.externalIds.length || ext.some((t) => t.status !== 'unmatched')) throw conflict('A bank line in this match has already been matched (AX-REC-02)');
  const led = await tx.find('journal_lines', { id: { in: p.ledgerLineIds } });
  const now = svc.ctx.clock.now().toISOString();
  const m = await tx.insert('rec_matches', { reconciliation_id: rec.id, match_type: p.matchType, status: 'confirmed', confidence: Number(proposal.confidence), difference_minor: p.externalSumMinor - p.ledgerSumMinor, explanation: p.explanation.slice(0, 600), matched_by: proposal.prepared_by, proposal_id: proposal.id, confirmed_by: approver.id, confirmed_at: now, created_at: now });
  await tx.insertMany('rec_match_items', [
    ...ext.map((t) => ({ rec_match_id: m.id, side: 'external' as const, item_type: 'bank_transaction' as const, item_id: t.id, amount_minor: t.amount_minor })),
    ...led.map((l) => ({ rec_match_id: m.id, side: 'ledger' as const, item_type: 'journal_line' as const, item_id: l.id, amount_minor: l.debit_minor - l.credit_minor })),
  ]);
  await tx.updateWhere('bank_transactions', { id: { in: p.externalIds } }, { status: 'matched' });
  if (rec.status === 'not_started') await tx.update('reconciliations', rec.id, { status: 'in_progress' });
  return { refType: 'rec_match', refId: m.id };
}

async function applyReconcilingItem(svc: AccountingServices, proposal: ProposalRow): Promise<ApplyResult> {
  const p = ReconcilingItemPayloadSchema.parse(proposal.payload);
  const rec = await svc.bank.ensureReconciliation(p.bankAccountId, p.periodKey, proposal.run_id);
  const item = await svc.tx.insert('reconciling_items', {
    reconciliation_id: rec.id,
    kind: p.kind,
    side: p.side,
    description: p.description,
    amount_minor: p.amountMinor,
    item_date: p.itemDate,
    status: 'open',
    requires_adjustment: p.requiresAdjustment,
    related_item_type: p.relatedItemType,
    related_item_id: p.relatedItemId,
    proposal_id: proposal.id,
    resolution: null,
    created_by: proposal.prepared_by,
    created_at: svc.ctx.clock.now().toISOString(),
    resolved_at: null,
  });
  return { refType: 'reconciling_item', refId: item.id };
}

async function applyFlux(svc: AccountingServices, proposal: ProposalRow, approver: Approver): Promise<ApplyResult> {
  const p = FluxPayloadSchema.parse(proposal.payload);
  const tx = svc.tx;
  const period = await svc.ctx.period(p.entityId, p.periodKey);
  const chart = await svc.ctx.chart();
  const acct = chart.account(p.accountCode);
  let fa = await tx.findOne('flux_analyses', { entity_id: p.entityId, period_id: period.id, comparison: p.comparison });
  const now = svc.ctx.clock.now().toISOString();
  if (!fa) fa = await tx.insert('flux_analyses', { entity_id: p.entityId, period_id: period.id, comparison: p.comparison, threshold_abs_minor: p.thresholdAbsMinor, threshold_pct: p.thresholdPct, status: 'in_review', agent_run_id: proposal.run_id, generated_at: now, approved_by: null, approved_at: null });
  let line = await tx.findOne('flux_lines', { flux_analysis_id: fa.id, account_id: acct.id });
  if (!line)
    line = await tx.insert('flux_lines', { flux_analysis_id: fa.id, account_id: acct.id, current_minor: p.currentMinor, comparative_minor: p.comparativeMinor, budget_minor: p.budgetMinor, variance_minor: p.varianceMinor, variance_pct: p.variancePct, exceeds_threshold: true, materiality: p.materiality, drivers: p.drivers, status: 'needs_explanation' });
  const version = (await tx.count('flux_explanations', { flux_line_id: line.id })) + 1;
  const ex = await tx.insert('flux_explanations', { flux_line_id: line.id, version, text: p.text, drivers: p.drivers, author_type: 'agent', author_id: proposal.prepared_by, proposal_id: proposal.id, status: 'approved', approved_by: approver.id, approved_at: now, rejection_reason: null, created_at: now });
  await tx.update('flux_lines', line.id, { status: 'approved' });
  return { refType: 'flux_explanation', refId: ex.id };
}

async function applyFinding(svc: AccountingServices, proposal: ProposalRow, approver: Approver): Promise<ApplyResult> {
  const p = FindingPayloadSchema.parse(proposal.payload);
  const subject = p.subjects[0]!;
  const ev = await svc.tx.insert('evidence', {
    subject_type: subject.type,
    subject_id: subject.id,
    kind: 'note',
    title: `Finding ${proposal.ref}: ${proposal.title}`.slice(0, 300),
    mime: 'text/plain',
    content: `${proposal.why}\n\nRecommended action: ${p.recommendation}`,
    source_document_id: null,
    content_hash: sha256Hex(`${proposal.id}:${proposal.why}`),
    created_by: approver.id,
    created_at: svc.ctx.clock.now().toISOString(),
  });
  await audit(svc.tx, svc.ctx.actor, svc.ctx.clock, { action: 'finding.acknowledge', subjectType: subject.type, subjectId: subject.id, entityId: p.entityId, summary: `${proposal.ref} acknowledged: ${proposal.title}`, data: { severity: p.severity, category: p.category } });
  return { refType: 'evidence', refId: ev.id };
}

async function applyReport(svc: AccountingServices, proposal: ProposalRow): Promise<ApplyResult> {
  const p = ReportPayloadSchema.parse(proposal.payload);
  const tx = svc.tx;
  const existing = await tx.find('close_packages', { period_key: p.periodKey }, { orderBy: [['version', 'desc']], limit: 1 });
  const content = { ...(p.content as unknown as ClosePackageContent), summary: p.summary, highlights: p.highlights, readiness: p.readiness } as unknown as ClosePackageContent;
  const pkg = await tx.insert('close_packages', {
    period_key: p.periodKey,
    version: (existing[0]?.version ?? 0) + 1,
    status: 'draft',
    content,
    content_hash: sha256Hex(canonicalJson(content as unknown as Record<string, unknown>)),
    generated_by: proposal.prepared_by,
    generated_at: svc.ctx.clock.now().toISOString(),
    agent_run_id: proposal.run_id,
  });
  return { refType: 'close_package', refId: pkg.id };
}
