/**
 * Deterministic verification of every agent proposal before it is stored (the "verify" phase).
 * Re-derives what can be re-derived and checks the ontology axioms; the model's own arithmetic
 * and claims are never trusted.
 */
import type { RunContext } from '../../../core/agent/runtime';
import type { ProposalDraft, VerificationResult } from '../../../core/agent/types';
import type { AxiomOutcome } from '../../../core/ontology/types';
import { periodKeyOf } from '../../../core/util/time';
import { evaluateEntry, reversalLines, type JournalDraftInput } from '../ledger/journal';
import { closeOntology } from '../ontology';
import type { AccountingServices } from '../services';
import { covers } from '../services/flux';
import { CodingPayloadSchema, FindingPayloadSchema, FluxPayloadSchema, JePayloadSchema, money, PAYLOAD_SCHEMAS, RecMatchPayloadSchema, ReconcilingItemPayloadSchema, ReportPayloadSchema, type JePayload } from './payloads';

const ok = (check: string, message: string, axiomId?: string): VerificationResult => ({ check, axiomId, passed: true, severity: 'info', message });
const fail = (check: string, message: string, axiomId?: string, severity: 'error' | 'warning' = 'error'): VerificationResult => ({ check, axiomId, passed: false, severity, message });

function fromOutcome(o: AxiomOutcome): VerificationResult {
  return { check: o.title, axiomId: o.axiomId, passed: o.passed, severity: o.passed ? 'info' : o.severity === 'error' ? 'error' : 'warning', message: o.passed ? 'Holds' : o.messages.join('; ') };
}

export function jeInput(p: JePayload, preparedBy: string, extra: Partial<JournalDraftInput> = {}): JournalDraftInput {
  return {
    entityId: p.entityId,
    postingDate: p.postingDate,
    entryType: p.entryType,
    memo: p.memo,
    source: p.source,
    preparedBy,
    lines: p.lines,
    autoReverseOn: p.autoReverseOn ?? null,
    counterpartyEntityId: p.counterpartyEntityId ?? null,
    sourceRef: p.sourceRef ?? null,
    reversesJeId: p.reversesJeId ?? null,
    ...extra,
  };
}

export async function verifyDraft(svc: AccountingServices, draft: ProposalDraft, run: RunContext): Promise<VerificationResult[]> {
  const out: VerificationResult[] = [];
  const schema = PAYLOAD_SCHEMAS[draft.kind as keyof typeof PAYLOAD_SCHEMAS];
  if (!schema) return [fail('Known proposal kind', `Unsupported proposal kind ${draft.kind}`)];
  const parsed = schema.safeParse(draft.payload);
  if (!parsed.success) return [fail('Payload is well-formed', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))];
  out.push(ok('Payload is well-formed', 'Matches the typed contract for this proposal kind'));
  if (draft.entityId && run.agent.entityScope && !run.agent.entityScope.includes(draft.entityId)) out.push(fail('Entity in scope', 'The entity is outside the requesting user’s scope'));
  if (run.entityId && draft.entityId && run.entityId !== draft.entityId && draft.kind !== 'journal_entry') out.push(fail('Entity matches the run', 'The proposal is for a different entity than the run'));
  const onto = closeOntology();
  const tx = svc.tx;
  const chart = await svc.ctx.chart();

  switch (draft.kind) {
    case 'journal_entry': {
      const p = JePayloadSchema.parse(draft.payload);
      if (periodKeyOf(p.postingDate) !== p.periodKey) out.push(fail('Posting date inside the period', `${p.postingDate} is not in ${p.periodKey}`, 'AX-PD-02'));
      try {
        const { outcomes } = await evaluateEntry(await svc.ctx.ledger(), jeInput(p, run.agent.id));
        out.push(...outcomes.map(fromOutcome));
      } catch (e) {
        out.push(fail('Period exists and is usable', (e as Error).message, 'AX-PD-01'));
      }
      if (p.entryType === 'accrual') out.push(fromOutcome(onto.check('AX-ACR-02', { evidenceKinds: draft.evidence.filter((e) => e.kind === 'record' || e.kind === 'source_document').map((e) => e.refType ?? e.kind) })));
      if (p.fx) out.push(fromOutcome(onto.check('AX-FX-01', { foreignMinor: p.fx.foreignMinor, closingRate: p.fx.closingRate, revaluedFunctionalMinor: p.fx.revaluedFunctionalMinor })));
      if (p.reversesJeId) {
        // a reversal cancels the posted entry exactly, once (AX-IM-02): never the drafter's version of it
        const orig = await tx.get('journal_entries', p.reversesJeId);
        const already = orig ? await tx.findOne('journal_entries', { reverses_je_id: orig.id }) : undefined;
        const mirror = orig ? reversalLines(orig, await tx.find('journal_lines', { journal_entry_id: orig.id }), chart) : [];
        const key = (l: { account: string; debit?: number; credit?: number; department?: string | null; location?: string | null; project?: string | null; product_class?: string | null }) => [l.account, l.debit ?? 0, l.credit ?? 0, l.department ?? '', l.location ?? '', l.project ?? '', l.product_class ?? ''].join('|');
        const same = mirror.map(key).sort().join('\n') === p.lines.map(key).sort().join('\n');
        if (!orig || orig.entity_id !== p.entityId || orig.status !== 'posted') out.push(fail('Reverses a posted entry', orig ? `${orig.je_number} is ${orig.status}` : 'the entry to reverse does not exist', 'AX-IM-02'));
        else if (already) out.push(fail('Reverses a posted entry', `${orig.je_number} is already reversed by ${already.je_number}`, 'AX-IM-02'));
        else out.push(same ? ok('Reversal mirrors the entry', `${orig.je_number}, line for line`, 'AX-IM-02') : fail('Reversal mirrors the entry', `the lines do not cancel ${orig.je_number} exactly`, 'AX-IM-02'));
      }
      for (const id of p.dependsOnProposalIds ?? []) {
        const dep = await tx.get('proposals', id);
        out.push(dep ? ok('Prerequisite proposal exists', `${dep.ref} (${dep.status})`) : fail('Prerequisite proposal exists', `Proposal ${id} not found`));
      }
      if (p.effects?.depreciationLineIds?.length) {
        const lines = await tx.find('depreciation_lines', { id: { in: p.effects.depreciationLineIds } });
        const scheduled = lines.filter((l) => l.status === 'scheduled' && !l.journal_entry_id);
        const total = scheduled.reduce((s, l) => s + l.amount_minor, 0);
        const debits = p.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
        out.push(scheduled.length === p.effects.depreciationLineIds.length && total === debits ? ok('Schedule lines still open and tie to the entry', `${scheduled.length} lines, ${total} minor units`, 'AX-SCH-01') : fail('Schedule lines still open and tie to the entry', `expected ${debits}, open scheduled lines total ${total}`, 'AX-SCH-01'));
      }
      if (p.effects?.prepaidLineIds?.length) {
        const lines = await tx.find('prepaid_lines', { id: { in: p.effects.prepaidLineIds } });
        const open = lines.filter((l) => l.status === 'scheduled' && !l.journal_entry_id);
        out.push(open.length === p.effects.prepaidLineIds.length ? ok('Prepaid lines still open', `${open.length} line(s)`, 'AX-SCH-01') : fail('Prepaid lines still open', 'a prepaid line was already posted', 'AX-SCH-01'));
      }
      if (p.effects?.bankMatch) {
        const t = await tx.get('bank_transactions', p.effects.bankMatch.bankTxnId);
        out.push(t && t.status === 'unmatched' ? ok('Bank line is unmatched', t.description) : fail('Bank line is unmatched', 'the bank line is already matched or missing', 'AX-REC-02'));
      }
      if (p.effects?.fixedAsset) {
        const fa = p.effects.fixedAsset;
        const a = chart.tryAccount(fa.assetAccount);
        out.push(a?.ontology_class === 'tie:PropertyPlantEquipment' ? ok('Asset account is PP&E', `${a.code} ${a.name}`, 'AX-SCH-03') : fail('Asset account is PP&E', `${fa.assetAccount} is not a property-and-equipment account`, 'AX-SCH-03'));
      }
      break;
    }
    case 'coding': {
      const p = CodingPayloadSchema.parse(draft.payload);
      const t = await tx.get('card_transactions', p.target.id);
      if (!t) out.push(fail('Card transaction exists', p.target.id));
      else out.push(t.status === 'pending_coding' ? ok('Still waiting for coding', `${t.merchant_name} ${t.txn_date}`) : fail('Still waiting for coding', `status is ${t.status}`));
      const a = chart.tryAccount(p.accountCode);
      if (!a) out.push(fail('Account exists', p.accountCode, 'AX-AC-01'));
      else {
        out.push(a.is_postable && a.status === 'active' ? ok('Active leaf account', `${a.code} ${a.name}`, 'AX-AC-01') : fail('Active leaf account', `${a.code} is not postable`, 'AX-AC-01'));
        out.push(!a.required_dimensions.includes('department') || p.department ? ok('Required dimensions present', p.department ?? 'none required', 'AX-AC-02') : fail('Required dimensions present', `${a.code} needs a department`, 'AX-AC-02'));
        out.push(!a.control_subledger || a.control_subledger === 'fixed_assets' ? ok('Not a control account', a.code, 'AX-AC-04') : fail('Not a control account', `${a.code} is a ${a.control_subledger} control account`, 'AX-AC-04'));
        const cap = run.policy.thresholds.capitalizationMinor ?? 500_000;
        if (a.account_class === 'expense' && Math.abs(p.amountMinor) >= cap) out.push(fail('Capitalization threshold', `${(p.amountMinor / 100).toFixed(2)} is at or above the capitalization threshold; confirm it is not equipment`, 'AX-SCH-03', 'warning'));
      }
      break;
    }
    case 'rec_match': {
      const p = RecMatchPayloadSchema.parse(draft.payload);
      const ba = await tx.get('bank_accounts', p.bankAccountId);
      const ext = await tx.find('bank_transactions', { id: { in: p.externalIds } });
      const led = await tx.find('journal_lines', { id: { in: p.ledgerLineIds } });
      const extSum = ext.reduce((s, t) => s + t.amount_minor, 0);
      const ledSum = led.reduce((s, l) => s + l.debit_minor - l.credit_minor, 0);
      out.push(ext.length === p.externalIds.length && ext.every((t) => t.bank_account_id === p.bankAccountId) ? ok('Bank lines exist on this account', `${ext.length} line(s)`) : fail('Bank lines exist on this account', 'a bank line is missing or belongs to another account'));
      out.push(led.length === p.ledgerLineIds.length && !!ba && led.every((l) => l.account_id === ba.gl_account_id) ? ok('Ledger lines are on the cash account', `${led.length} line(s)`) : fail('Ledger lines are on the cash account', 'a ledger line is missing or on another account'));
      const confirmed = new Set((await tx.find('rec_matches', { status: 'confirmed' })).map((m) => m.id));
      const used = (await tx.find('rec_match_items', { item_id: { in: [...p.externalIds, ...p.ledgerLineIds] } })).filter((i) => confirmed.has(i.rec_match_id));
      const counts = [...p.externalIds, ...p.ledgerLineIds].map((id) => 1 + used.filter((u) => u.item_id === id).length);
      out.push(fromOutcome(onto.check('AX-REC-02', { itemMatchCounts: counts })));
      out.push(fromOutcome(onto.check('AX-REC-03', { externalSumMinor: extSum, ledgerSumMinor: ledSum, toleranceMinor: 0 })));
      if (ext.some((t) => t.status !== 'unmatched')) out.push(fail('Bank lines unmatched', 'a bank line was matched already', 'AX-REC-02'));
      break;
    }
    case 'reconciling_item': {
      const p = ReconcilingItemPayloadSchema.parse(draft.payload);
      const ba = await tx.get('bank_accounts', p.bankAccountId);
      out.push(ba ? ok('Bank account exists', ba.name) : fail('Bank account exists', p.bankAccountId));
      if (p.relatedItemId) {
        const exists = p.relatedItemType === 'bank_transaction' ? await tx.get('bank_transactions', p.relatedItemId) : await tx.get('journal_lines', p.relatedItemId);
        out.push(exists ? ok('Related record exists', p.relatedItemId) : fail('Related record exists', `${p.relatedItemType} ${p.relatedItemId} not found`));
        const dup = (await tx.find('reconciling_items', { related_item_id: p.relatedItemId, status: 'open' })).length;
        out.push(dup ? fail('Not already a reconciling item', 'an open reconciling item already covers this record', 'AX-REC-02') : ok('Not already a reconciling item', 'new'));
      }
      const expectSign = p.kind === 'deposit_in_transit' || p.kind === 'interest' ? 1 : p.kind === 'outstanding_check' || p.kind === 'bank_fee' ? -1 : 0;
      if (expectSign && Math.sign(p.amountMinor) !== expectSign) out.push(fail('Sign follows the item type', `${p.kind} should be ${expectSign > 0 ? 'positive' : 'negative'}`));
      break;
    }
    case 'flux_explanation': {
      const p = FluxPayloadSchema.parse(draft.payload);
      out.push(chart.tryAccount(p.accountCode) ? ok('Account exists', p.accountCode) : fail('Account exists', p.accountCode));
      out.push(p.currentMinor - p.comparativeMinor === p.varianceMinor ? ok('Variance arithmetic', 'current − comparative = variance') : fail('Variance arithmetic', 'variance does not equal current − comparative'));
      // the explanation is about the variance as the ledger has it now, not figures the drafter supplied
      const live = await svc.flux.line(p.entityId, p.periodKey, p.accountCode, p.comparison);
      const ccy = chart.entity(p.entityId).functional_currency;
      out.push(live && covers(p, live) ? ok('Figures match the ledger', `${p.accountCode} as it stands`, 'AX-FLX-01') : fail('Figures match the ledger', live ? `the ledger shows ${money(live.currentMinor, ccy)} this month against ${money(live.comparativeMinor, ccy)}, not the figures given; restate them from flux.compute` : 'the account has no activity to explain', 'AX-FLX-01'));
      out.push(fromOutcome(onto.check('AX-FLX-02', { varianceMinor: p.varianceMinor, driverMinors: p.drivers.map((d) => d.amountMinor) })));
      out.push(p.text.trim().length >= 20 ? ok('Explanation is substantive', `${p.text.length} characters`, 'AX-FLX-01') : fail('Explanation is substantive', 'too short', 'AX-FLX-01'));
      break;
    }
    case 'finding': {
      const p = FindingPayloadSchema.parse(draft.payload);
      out.push(p.subjects.length ? ok('Finding cites records', `${p.subjects.length} record(s)`) : fail('Finding cites records', 'no subjects'));
      break;
    }
    case 'report': {
      const p = ReportPayloadSchema.parse(draft.payload);
      const tbs = (p.content.trialBalances ?? []) as { entityCode: string; totalDebitMinor: number; totalCreditMinor: number }[];
      for (const tb of tbs) out.push(fromOutcome({ ...onto.check('AX-DE-04', { debits: tb.totalDebitMinor, credits: tb.totalCreditMinor }), title: `Trial balance balances (${tb.entityCode})` }));
      break;
    }
  }
  return out;
}

