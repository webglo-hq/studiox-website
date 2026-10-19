/**
 * Offline brains: the deterministic engine behind every skill when no model is configured (and
 * the reference behaviour the skill evals pin down). Each brain is an async generator that yields
 * typed actions — plan, tool, propose, note — and receives each action's result, exactly like the
 * live loop. Because brains derive every action from tool results, a crashed run is resumed by
 * replaying recorded tool results (see core/agent/runtime.ts).
 */
import { clipText, redactInstructions } from '../../../core/agent/injection';
import type { BrainAction, BrainResult, EvidenceRef, OfflineBrain, ProposeOutcome, SkillRunInput } from '../../../core/agent/types';
import type { JsonValue } from '../../../core/util/json';
import { periodEnd, periodLabel, periodStart, shiftPeriod } from '../../../core/util/time';
import type { AccrualCandidate } from '../services/accruals';
import type { DueDepreciation, DuePrepaid, ScheduleIssue } from '../services/schedules';
import type { FluxLineView } from '../services/flux';
import { fluxNarrative } from '../services/flux';
import type { FxExposure, IcPair } from '../services/intercompany';
import type { BenfordResult, DuplicatePayment, FlaggedEntry } from '../services/anomaly';
import type { CodingSuggestion } from '../services/coding';
import { codingDraft, findingDraft, fluxDraft, jeDraft, money, recMatchDraft, reconcilingItemDraft, reportDraft, type JePayload } from './payloads';

type Gen = AsyncGenerator<BrainAction, BrainResult, unknown>;
const plan = (steps: string[]): BrainAction => ({ type: 'plan', steps });
const tool = (name: string, input: Record<string, JsonValue>): BrainAction => ({ type: 'tool', name, input });
const note = (text: string): BrainAction => ({ type: 'note', text });
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const rec = (label: string, refType: string, refId: string, detail?: string): EvidenceRef => ({ kind: 'record', label, refType, refId, ...(detail ? { detail } : {}) });
const nextStart = (pk: string) => periodStart(shiftPeriod(pk, 1));

function need(input: SkillRunInput): { entityId: string; pk: string } {
  if (!input.entityId || !input.periodKey) throw new Error(`${input.skillKey} runs per entity and period`);
  return { entityId: input.entityId, pk: input.periodKey };
}

interface EntityInfo {
  id: string;
  code: string;
  currency: string;
}

async function* entityInfo(pk: string, entityId: string): AsyncGenerator<BrainAction, EntityInfo, unknown> {
  const s = (yield tool('close.status', { periodKey: pk })) as { entities: EntityInfo[] };
  const e = s.entities.find((x) => x.id === entityId);
  if (!e) throw new Error('entity not found or out of scope');
  return e;
}

// =========================================================================== bank reconciliation
interface SuggestOut {
  counts: Record<string, number>;
  matches: { type: 'exact' | 'fuzzy' | 'one_to_many' | 'many_to_one'; confidence: number; differenceMinor: number; signals: string[]; explanation: string; external: { id: string; date: string; amountMinor: number; description: string; reference: string | null }[]; ledger: { id: string; date: string; amountMinor: number; entry: string; entryId: string; memo: string }[] }[];
  bankOnly: { kind: 'bank_fee' | 'interest' | 'unexplained'; confidence: number; reason: string; possibleCounterparties: string[]; line: { id: string; date: string; amountMinor: number; description: string; sourceDocumentId: string | null } }[];
  timing: { kind: 'deposit_in_transit' | 'outstanding_check' | 'timing'; confidence: number; reason: string; ledger: { id: string; date: string; amountMinor: number; entry: string; entryId: string; memo: string }; clearedBy: { id: string; date: string; description: string } | null }[];
}

const MATCH_WHY: Record<string, string> = {
  exact: 'One bank line and one ledger line agree on amount and date window, so they record the same cash movement.',
  many_to_one: 'The bank settled one ledger payment in several pieces; together they equal the entry exactly.',
  one_to_many: 'The bank deposited several receipts as one credit; the receipts add up to the deposit exactly.',
  fuzzy: 'The amounts agree but the dates are further apart than usual, so a person should confirm.',
};

export const bankReconciliation: OfflineBrain = async function* (input): Gen {
  const { entityId, pk } = need(input);
  yield plan(['Find the entity’s bank accounts', 'Read each statement (provenance and untrusted-text scan)', 'Match bank lines to ledger cash lines (exact → split → batch → fuzzy)', 'Classify what is left: timing items, bank-only charges, unexplained', 'Propose matches, reconciling items and adjusting entries']);
  const e = yield* entityInfo(pk, entityId);
  const accts = (yield tool('bank.accounts', { entityId })) as { items: { id: string; name: string; glAccount: string; currency: string; last4: string }[] };
  let matches = 0;
  let items = 0;
  let adjustments = 0;
  for (const ba of accts.items) {
    const st = (yield tool('bank.statement', { bankAccountId: ba.id, periodKey: pk })) as { closing: number | null; sourceDocumentId: string | null; lines: unknown[] };
    const sug = (yield tool('recon.suggest_matches', { bankAccountId: ba.id, periodKey: pk })) as SuggestOut;
    const stmt: EvidenceRef[] = st.sourceDocumentId ? [{ kind: 'source_document', label: `${ba.name} statement ${pk}`, refType: 'source_document', refId: st.sourceDocumentId }] : [];
    for (const m of sug.matches) {
      const ext = m.external;
      const led = m.ledger;
      const desc = redactInstructions(ext[0]!.description);
      yield {
        type: 'propose',
        draft: recMatchDraft(
          { bankAccountId: ba.id, entityId, periodKey: pk, matchType: m.type, externalIds: ext.map((x) => x.id), ledgerLineIds: led.map((x) => x.id), externalSumMinor: sum(ext.map((x) => x.amountMinor)), ledgerSumMinor: sum(led.map((x) => x.amountMinor)), explanation: redactInstructions(m.explanation).slice(0, 600) },
          {
            title: `${m.type === 'exact' ? 'Match' : m.type === 'fuzzy' ? 'Probable match' : m.type === 'one_to_many' ? 'Deposit batch' : 'Split settlement'}: ${clipText(desc, 60)} ${money(sum(ext.map((x) => x.amountMinor)), e.currency)}`,
            why: `${MATCH_WHY[m.type]} Signals: ${m.signals.join('; ')}.`,
            confidence: m.confidence,
            evidence: [...ext.map((x) => rec(`Bank line ${x.date} ${money(x.amountMinor, e.currency)}`, 'bank_transaction', x.id)), ...led.map((l) => rec(`${l.entry} (${l.date})`, 'journal_entry', l.entryId)), ...stmt],
            dedupeKey: `match:${ext.map((x) => x.id).sort().join('+')}`,
          },
        ),
      };
      matches++;
    }
    for (const t of sug.timing) {
      const kind = t.kind === 'timing' ? 'timing' : t.kind;
      yield {
        type: 'propose',
        draft: reconcilingItemDraft(
          { bankAccountId: ba.id, entityId, periodKey: pk, kind, side: 'external', amountMinor: t.ledger.amountMinor, itemDate: t.ledger.date, description: `${kind === 'deposit_in_transit' ? 'Deposit in transit' : kind === 'outstanding_check' ? 'Outstanding check' : 'Timing difference'}: ${t.ledger.memo}`.slice(0, 300), relatedItemType: 'journal_line', relatedItemId: t.ledger.id, requiresAdjustment: false, clearedBy: t.clearedBy ? { bankTxnId: t.clearedBy.id, date: t.clearedBy.date } : null },
          {
            title: `${kind === 'deposit_in_transit' ? 'Deposit in transit' : kind === 'outstanding_check' ? 'Outstanding check' : 'Timing item'} ${money(t.ledger.amountMinor, e.currency)} – ${t.ledger.memo.slice(0, 70)}`,
            why: `${t.reason} It is in the books but not yet on the ${periodLabel(pk)} statement, so it reconciles the bank balance to the ledger without any entry.`,
            confidence: t.confidence,
            evidence: [rec(`${t.ledger.entry} ${t.ledger.date}`, 'journal_entry', t.ledger.entryId), ...(t.clearedBy ? [rec(`Cleared the bank ${t.clearedBy.date}`, 'bank_transaction', t.clearedBy.id)] : []), ...stmt],
            dedupeKey: `timing:${t.ledger.id}`,
            flags: t.kind === 'timing' && !t.clearedBy ? ['unexplained'] : [],
          },
        ),
      };
      items++;
    }
    for (const b of sug.bankOnly) {
      const desc = redactInstructions(b.line.description);
      if (b.kind === 'bank_fee' || b.kind === 'interest') {
        const amt = Math.abs(b.line.amountMinor);
        const lines: JePayload['lines'] = b.kind === 'bank_fee' ? [{ account: '6900', debit: amt, department: 'GA', memo: desc }, { account: ba.glAccount, credit: amt, memo: desc }] : [{ account: ba.glAccount, debit: amt, memo: desc }, { account: '7000', credit: amt, memo: desc }];
        yield {
          type: 'propose',
          draft: jeDraft(
            { entityId, periodKey: pk, postingDate: b.line.date > periodEnd(pk) ? periodEnd(pk) : b.line.date, entryType: 'adjusting', memo: `${b.kind === 'bank_fee' ? 'Bank service charge' : 'Interest earned'} – ${ba.name} ${pk}`, source: 'agent', lines, effects: { bankMatch: { bankAccountId: ba.id, bankTxnId: b.line.id } }, autoEligible: true, sourceRef: `BANK-${b.kind.toUpperCase()}-${pk}` },
            {
              title: `Book ${b.kind === 'bank_fee' ? 'bank service charge' : 'interest credit'} ${money(amt, e.currency)} (${ba.name})`,
              why: `${b.reason} It is on the ${periodLabel(pk)} statement but not in the ledger; booking it brings cash in the books to what the bank holds. Once posted, the bank line matches the new entry automatically.`,
              confidence: b.confidence,
              evidence: [rec(`Bank line ${b.line.date}: ${desc}`, 'bank_transaction', b.line.id), ...stmt],
              dedupeKey: `bankonly:${b.line.id}`,
            },
          ),
        };
        adjustments++;
      } else {
        yield {
          type: 'propose',
          draft: reconcilingItemDraft(
            { bankAccountId: ba.id, entityId, periodKey: pk, kind: 'unexplained', side: 'ledger', amountMinor: b.line.amountMinor, itemDate: b.line.date, description: `Unexplained bank ${b.line.amountMinor < 0 ? 'debit' : 'credit'}: ${desc}`.slice(0, 300), relatedItemType: 'bank_transaction', relatedItemId: b.line.id, requiresAdjustment: true },
            {
              title: `Investigate unexplained bank ${b.line.amountMinor < 0 ? 'debit' : 'credit'} ${money(b.line.amountMinor, e.currency)}: ${clipText(desc, 60)}`,
              why: `${b.reason} Nothing in the ledger, the vendor master or the customer list explains it${b.possibleCounterparties.length ? ` (closest names: ${b.possibleCounterparties.join(', ')})` : ''}. Ask the bank or treasury what it is before booking anything; it stays open on the reconciliation until resolved.`,
              confidence: 0.6,
              evidence: [rec(`Bank line ${b.line.date}`, 'bank_transaction', b.line.id), ...stmt],
              dedupeKey: `bankonly:${b.line.id}`,
              flags: ['unexplained'],
            },
          ),
        };
        items++;
      }
    }
    yield note(`${ba.name}: ${sug.counts.bankLines} bank lines and ${sug.counts.ledgerLines} ledger lines; ${sug.matches.length} matches, ${sug.timing.length} timing items, ${sug.bankOnly.length} bank-only lines.`);
  }
  return { headline: `Proposed ${matches} matches, ${items} reconciling items and ${adjustments} adjusting entries for ${e.code} ${periodLabel(pk)}` };
};

// =========================================================================== transaction coding
export const transactionCoding: OfflineBrain = async function* (input): Gen {
  const { entityId, pk } = need(input);
  yield plan(['List card charges waiting for coding', 'Classify each one (mapping → rule → history → vendor → ontology signals)', 'Re-check posted spend for misclassification and capital items', 'Propose codings and reclasses']);
  const e = yield* entityInfo(pk, entityId);
  const unc = (yield tool('card.uncoded', { entityId, periodKey: pk })) as { items: { id: string; date: string; merchant: string; amountMinor: number; cardholder: string; mcc: string | null }[] };
  let coded = 0;
  for (const t of unc.items) {
    const s = (yield tool('coding.classify', { cardTransactionId: t.id })) as CodingSuggestion & { id: string };
    const merchant = redactInstructions(t.merchant);
    const top = s.signals.filter((x) => x.accountCode === s.accountCode).map((x) => x.detail);
    yield {
      type: 'propose',
      draft: codingDraft(
        { target: { kind: 'card_transaction', id: t.id }, entityId, periodKey: pk, accountCode: s.accountCode, department: s.department, amountMinor: t.amountMinor, merchant, source: s.source, alternatives: s.alternatives, neverAuto: s.neverAuto },
        {
          title: `Code ${merchant} ${money(t.amountMinor, e.currency)} → ${s.accountCode} ${s.accountName}${s.department ? ` · ${s.department}` : ''}`,
          why: `${t.cardholder}’s ${t.date} charge at ${merchant}. ${top.slice(0, 2).join('. ')}.${s.department ? ` Department ${s.department} follows the cardholder.` : ''}${s.capitalization?.required ? ` ${s.capitalization.reason}` : ''}`,
          confidence: s.confidence,
          evidence: [rec(`Card charge ${t.date} ${merchant}`, 'card_transaction', t.id), { kind: 'computation', label: `Classifier: ${s.source.replace('_', ' ')}`, detail: s.signals.map((x) => `${x.source}→${x.accountCode} (${x.weight})`).join(', ') }],
          dedupeKey: `code:${t.id}`,
          flags: s.capitalization?.required ? ['requires_capitalization'] : [],
        },
      ),
    };
    coded++;
  }
  const rev = (yield tool('coding.review_posted', { entityId, periodKey: pk })) as { reviewed: number; items: { kind: 'card_transaction' | 'bill_line'; id: string; date: string; merchant: string; description: string; amountMinor: number; codedAccount: string; codedDepartment: string | null; vendorId: string | null; suggestion: CodingSuggestion }[] };
  let reclasses = 0;
  for (const it of rev.items) {
    const s = it.suggestion;
    const merchant = redactInstructions(it.merchant);
    const cap = s.capitalization?.required;
    const toDept = s.department ?? null;
    const lines: JePayload['lines'] = [
      { account: s.accountCode, debit: it.amountMinor, department: toDept, memo: `Reclass from ${it.codedAccount}: ${merchant}`.slice(0, 200) },
      { account: it.codedAccount, credit: it.amountMinor, department: it.codedDepartment, memo: `Reclass to ${s.accountCode}`.slice(0, 200) },
    ];
    const category = s.accountCode === '1520' ? 'lab_equipment' : s.accountCode === '1530' ? 'furniture' : 'computer_equipment';
    yield {
      type: 'propose',
      draft: jeDraft(
        {
          entityId,
          periodKey: pk,
          postingDate: it.date,
          entryType: 'reclass',
          memo: `Reclass ${merchant} ${it.date} from ${it.codedAccount} to ${s.accountCode}`.slice(0, 300),
          source: 'agent',
          lines,
          effects: {
            ...(it.kind === 'card_transaction' ? { cardRecode: { cardTxnId: it.id, accountCode: s.accountCode, department: toDept } } : { billLineRecode: { billLineId: it.id, accountCode: s.accountCode, department: toDept } }),
            ...(cap ? { fixedAsset: { description: (it.description || merchant).slice(0, 200), category, inServiceDate: it.date, costMinor: it.amountMinor, usefulLifeMonths: category === 'lab_equipment' ? 60 : category === 'furniture' ? 84 : 36, assetAccount: s.accountCode, department: it.codedDepartment, sourceBillId: null } } : {}),
          },
        },
        {
          title: cap ? `Capitalize ${merchant} ${money(it.amountMinor, e.currency)}: ${it.codedAccount} → ${s.accountCode}` : `Reclassify ${merchant} ${money(it.amountMinor, e.currency)}: ${it.codedAccount} → ${s.accountCode}`,
          why: cap
            ? `${s.capitalization!.reason} It was expensed to ${it.codedAccount}. Capitalizing moves it to the balance sheet and starts depreciation next month (${category.replace('_', ' ')}, straight-line).`
            : `This ${it.kind === 'card_transaction' ? 'card charge' : 'bill line'} was coded to ${it.codedAccount}, but the evidence points to ${s.accountCode} ${s.accountName}: ${s.signals.filter((x) => x.accountCode === s.accountCode).map((x) => x.detail).slice(0, 2).join('; ')}.`,
          confidence: s.confidence,
          evidence: [rec(`${it.kind === 'card_transaction' ? 'Card charge' : 'Bill line'} ${it.date} ${merchant}`, it.kind, it.id), { kind: 'computation', label: 'Classifier disagreement', detail: `coded ${it.codedAccount}; evidence ${s.accountCode} at ${(s.confidence * 100).toFixed(0)}%` }],
          dedupeKey: `reclass:${it.id}`,
          ontologyType: 'tie:ReclassProposal',
        },
      ),
    };
    reclasses++;
  }
  return { headline: `Coded ${coded} card charges and found ${reclasses} misclassified item${reclasses === 1 ? '' : 's'} (${rev.reviewed} posted items re-checked) for ${e.code}` };
};

// =========================================================================== accruals
const BASIS_LABEL: Record<AccrualCandidate['basis'], string> = { subsequent_invoice: 'Subsequent invoice (cut-off)', recurring_gap: 'Recurring vendor pattern', grni: 'Goods received, not invoiced', payroll_calendar: 'Payroll calendar' };

export const accrualDetection: OfflineBrain = async function* (input): Gen {
  const { entityId, pk } = need(input);
  yield plan(['Look for bills received after month-end for this month’s services', 'Find monthly vendors with no bill this month', 'Find goods received without a bill', 'Compute payroll earned but unpaid', 'Propose auto-reversing accruals with evidence']);
  const e = yield* entityInfo(pk, entityId);
  const r = (yield tool('accruals.candidates', { entityId, periodKey: pk })) as { candidates: AccrualCandidate[]; skipped: string[] };
  for (const s of r.skipped) yield note(`Skipped: ${s}`);
  for (const c of r.candidates) {
    yield {
      type: 'propose',
      draft: jeDraft(
        { entityId, periodKey: pk, postingDate: periodEnd(pk), entryType: 'accrual', memo: c.title.slice(0, 300), source: 'agent', lines: [...c.lines.map((l) => ({ account: l.account, debit: l.debit, department: l.department, project: l.project ?? null, memo: l.memo })), { account: c.creditAccount, credit: c.amountMinor, memo: c.vendorName ?? 'Accrual' }], autoReverseOn: nextStart(pk), autoEligible: c.basis === 'subsequent_invoice', basis: c.basis, sourceRef: `ACCR-${c.key}`.slice(0, 80) },
        { title: `${c.title} – ${money(c.amountMinor, e.currency)}`, why: `${BASIS_LABEL[c.basis]}: ${c.reasoning}`, confidence: c.confidence, evidence: c.evidence.map((x) => rec(x.label, x.refType, x.refId, x.detail)), dedupeKey: `accrual:${c.key}` },
      ),
    };
  }
  return { headline: r.candidates.length ? `Proposed ${r.candidates.length} accruals totalling ${money(sum(r.candidates.map((c) => c.amountMinor)), e.currency)} for ${e.code}` : `No unrecorded liabilities found for ${e.code}` };
};

// =========================================================================== schedules
export const scheduleRollforward: OfflineBrain = async function* (input): Gen {
  const { entityId, pk } = need(input);
  yield plan(['Read depreciation and prepaid schedules', 'Check schedule integrity (exact allocation, depreciable base)', 'Propose entries for lines that are due but not posted']);
  const e = yield* entityInfo(pk, entityId);
  const s = (yield tool('schedules.status', { entityId, periodKey: pk })) as { depreciation: DueDepreciation[]; prepaid: DuePrepaid[]; issues: ScheduleIssue[]; postedThisPeriod: { depreciation: number; prepaid: number } };
  for (const i of s.issues) {
    yield {
      type: 'propose',
      draft: findingDraft(
        { entityId, periodKey: pk, category: 'other', severity: 'medium', recommendation: 'Correct the schedule before posting further lines.', subjects: [{ type: i.scheduleType === 'prepaid' ? 'prepaid_schedule' : 'fixed_asset', id: i.id, label: i.label }], tests: [i.axiomId], score: 0 },
        { title: `Schedule problem: ${i.label}`, why: `${i.axiomId}: ${i.message}.`, confidence: 0.95, evidence: [rec(i.label, i.scheduleType === 'prepaid' ? 'prepaid_schedule' : 'fixed_asset', i.id)], dedupeKey: `schedule-issue:${i.id}` },
      ),
    };
  }
  const groups = new Map<string, DueDepreciation[]>();
  for (const d of s.depreciation) groups.set(`${d.category}|${d.periodKey}`, [...(groups.get(`${d.category}|${d.periodKey}`) ?? []), d]);
  let entries = 0;
  for (const [key, lines] of [...groups.entries()].sort()) {
    const [category, linePk] = key.split('|') as [string, string];
    const byDept = new Map<string, number>();
    for (const l of lines) byDept.set(l.department ?? 'GA', (byDept.get(l.department ?? 'GA') ?? 0) + l.amountMinor);
    const total = sum(lines.map((l) => l.amountMinor));
    const exp = lines[0]!.expenseAccount;
    const acc = lines[0]!.accumAccount;
    const postPk = linePk < pk ? pk : linePk;
    yield {
      type: 'propose',
      draft: jeDraft(
        { entityId, periodKey: postPk, postingDate: periodEnd(postPk), entryType: 'recurring', memo: `Depreciation – ${category.replace(/_/g, ' ')} – ${linePk}`, source: 'subledger', lines: [...[...byDept.entries()].sort().map(([dept, v]) => ({ account: exp, debit: v, department: dept })), { account: acc, credit: total }], effects: { depreciationLineIds: lines.map((l) => l.lineId) }, autoEligible: true, sourceRef: `DEP-${e.code}-${category}-${linePk}` },
        {
          title: `Post ${periodLabel(linePk)} depreciation – ${category.replace(/_/g, ' ')} ${money(total, e.currency)}`,
          why: `${lines.length} asset${lines.length === 1 ? '' : 's'} (${lines.map((l) => l.assetTag).join(', ')}) have straight-line depreciation scheduled for ${periodLabel(linePk)} with no journal entry yet. The amounts come straight from the fixed-asset schedule${linePk < pk ? ' (catch-up for an earlier month)' : ''}.`,
          confidence: 0.98,
          evidence: lines.map((l) => rec(`${l.assetTag} ${l.description}: ${money(l.amountMinor, e.currency)}`, 'fixed_asset', l.assetId)),
          dedupeKey: `dep:${category}:${linePk}`,
        },
      ),
    };
    entries++;
  }
  for (const p of s.prepaid) {
    yield {
      type: 'propose',
      draft: jeDraft(
        { entityId, periodKey: pk, postingDate: periodEnd(pk), entryType: 'recurring', memo: `Prepaid amortization – ${p.description} – ${p.periodKey}`.slice(0, 300), source: 'subledger', lines: [{ account: p.expenseAccount, debit: p.amountMinor, department: p.department ?? 'GA' }, { account: p.prepaidAccount, credit: p.amountMinor }], effects: { prepaidLineIds: [p.lineId] }, autoEligible: true, sourceRef: `PPD-${p.scheduleId}-${p.periodKey}`.slice(0, 80) },
        {
          title: `Amortize ${p.description.slice(0, 70)} – ${money(p.amountMinor, e.currency)}`,
          why: `The prepaid schedule for ${p.vendorName ?? 'this contract'} has ${money(p.amountMinor, e.currency)} due for ${periodLabel(p.periodKey)} but nothing was posted. Recording it moves one month of the prepayment into expense; ${money(p.remainingAfterMinor, e.currency)} remains prepaid afterwards.`,
          confidence: 0.98,
          evidence: [rec(`${p.description} schedule`, 'prepaid_schedule', p.scheduleId)],
          dedupeKey: `ppd:${p.lineId}`,
        },
      ),
    };
    entries++;
  }
  return { headline: entries ? `Proposed ${entries} schedule entries for ${e.code} (${s.depreciation.length} depreciation lines, ${s.prepaid.length} prepaid lines due)` : `All schedules are current for ${e.code}` };
};

// =========================================================================== subledger tie-out
export const subledgerTieout: OfflineBrain = async function* (input): Gen {
  const { entityId, pk } = need(input);
  yield plan(['Rebuild the AP aging from bills and payments', 'Rebuild the AR aging from invoices and receipts', 'Agree each to its GL control account', 'Propose reclasses for wrong-sign balances; raise differences as findings']);
  const e = yield* entityInfo(pk, entityId);
  let proposals = 0;
  for (const kind of ['ap', 'ar'] as const) {
    const t = (yield tool('subledger.tieout', { entityId, kind, periodKey: pk })) as { accountCode: string; subledgerMinor: number; glMinor: number; differenceMinor: number; counterparties: number; wrongSign: { id: string; name: string; openMinor: number; documents: { id: string; number: string; openMinor: number }[] }[] };
    yield note(`${kind.toUpperCase()} subledger ${money(t.subledgerMinor, e.currency)} vs GL ${t.accountCode} ${money(t.glMinor, e.currency)}: difference ${money(t.differenceMinor, e.currency)} across ${t.counterparties} counterparties.`);
    if (t.differenceMinor !== 0) {
      yield {
        type: 'propose',
        draft: findingDraft(
          { entityId, periodKey: pk, category: 'subledger_difference', severity: Math.abs(t.differenceMinor) >= 750_000 ? 'high' : 'medium', recommendation: `Investigate entries posted directly to ${t.accountCode} without a subledger document, then correct the subledger or the GL.`, subjects: [{ type: 'account', id: t.accountCode, label: `${t.accountCode} control account` }], tests: ['tie_out'], score: 0 },
          { title: `${kind.toUpperCase()} subledger does not agree to GL ${t.accountCode} (${money(t.differenceMinor, e.currency)})`, why: `The ${kind === 'ap' ? 'payables' : 'receivables'} rebuilt from documents total ${money(t.subledgerMinor, e.currency)} but the control account shows ${money(t.glMinor, e.currency)}.`, confidence: 0.95, evidence: [{ kind: 'computation', label: `${kind.toUpperCase()} tie-out at ${periodEnd(pk)}` }], dedupeKey: `tieout-diff:${kind}` },
        ),
      };
      proposals++;
    }
    for (const w of t.wrongSign) {
      if (kind !== 'ap') continue;
      const amt = -w.openMinor;
      yield {
        type: 'propose',
        draft: jeDraft(
          { entityId, periodKey: pk, postingDate: periodEnd(pk), entryType: 'reclass', memo: `Reclassify ${w.name} debit balance to vendor refunds receivable`, source: 'agent', lines: [{ account: '1250', debit: amt, memo: `${w.name} overpayment` }, { account: '2000', credit: amt, memo: w.name }], sourceRef: `AP-DEBIT-${w.id}`.slice(0, 80) },
          {
            title: `Reclassify ${w.name} overpayment ${money(amt, e.currency)} out of accounts payable`,
            why: `${w.name} has a debit balance of ${money(amt, e.currency)} in accounts payable — we paid more than we owe (${w.documents.map((d) => d.number).join(', ')}). A debit balance is not a liability; presenting it as a receivable from the vendor keeps payables accurate until the refund arrives. See the JE review finding for the duplicate payment.`,
            confidence: 0.93,
            evidence: [rec(`${w.name} AP balance ${money(w.openMinor, e.currency)}`, 'vendor', w.id), ...w.documents.map((d) => rec(`Bill ${d.number}`, 'bill', d.id))],
            dedupeKey: `ap-debit:${w.id}`,
          },
        ),
      };
      proposals++;
    }
  }
  return { headline: proposals ? `Tie-out found ${proposals} item${proposals === 1 ? '' : 's'} to resolve for ${e.code}` : `AP and AR agree to the GL for ${e.code}` };
};

// =========================================================================== intercompany
export const intercompanyMatching: OfflineBrain = async function* (input): Gen {
  const pk = input.periodKey;
  if (!pk) throw new Error('intercompany-matching needs a period');
  yield plan(['Compare due-from and due-to balances for every entity pair in the transaction currency', 'Find one-sided intercompany entries', 'Propose the missing side', 'Draft pro forma eliminations (they wait for the true-ups)']);
  const status = (yield tool('close.status', { periodKey: pk })) as { entities: EntityInfo[] };
  const r = (yield tool('ic.balances', { periodKey: pk })) as { pairs: IcPair[] };
  let n = 0;
  for (const p of r.pairs) {
    const trueUps: string[] = [];
    let trueUpTxn = 0;
    let trueUpUsd = 0;
    for (const o of p.oneSided) {
      // a receivable-side entry the payable side never booked → book the payable side
      if (o.entityId !== p.receivableEntityId) continue;
      const payer = status.entities.find((x) => x.id === p.payableEntityId)!;
      const usd = Math.round(o.txnAmountMinor * p.closingRate);
      const memo = redactInstructions(o.memo);
      const out = (yield {
        type: 'propose',
        draft: jeDraft(
          {
            entityId: p.payableEntityId,
            periodKey: pk,
            postingDate: periodEnd(pk),
            entryType: 'adjusting',
            memo: `Record ${p.receivableEntityCode} recharge ${o.jeNumber}: ${memo}`.slice(0, 300),
            source: 'agent',
            counterpartyEntityId: p.receivableEntityId,
            lines: [
              { account: '6950', debit: usd, department: 'RND', project: /gen-?3/i.test(memo) ? 'PRJ-GEN3' : null, memo: memo.slice(0, 200), counterparty_entity_id: p.receivableEntityId, txn_currency: p.currency, txn_amount_minor: o.txnAmountMinor, fx_rate: p.closingRate },
              { account: '2400', credit: usd, memo: `Due to ${p.receivableEntityCode}`, counterparty_entity_id: p.receivableEntityId, txn_currency: p.currency, txn_amount_minor: -o.txnAmountMinor, fx_rate: p.closingRate },
            ],
            sourceRef: o.sourceRef ?? o.jeNumber,
          },
          {
            title: `Book missing intercompany charge from ${p.receivableEntityCode}: ${money(o.txnAmountMinor, p.currency)} (${money(usd, payer.currency)})`,
            why: `${p.receivableEntityCode} recorded ${o.jeNumber} on ${o.date} (“${memo.slice(0, 80)}”) as owed by ${p.payableEntityCode}, but ${p.payableEntityCode} has no matching entry, so the intercompany balances disagree by ${money(p.differenceTxnMinor, p.currency)}. Booking the payable side at the ${periodEnd(pk)} closing rate (${p.closingRate}) brings both sides into agreement (AX-IC-01) and needs no further remeasurement.`,
            confidence: 0.9,
            evidence: [rec(`${p.receivableEntityCode} ${o.jeNumber}`, 'journal_entry', o.jeId), { kind: 'computation', label: 'Intercompany comparison', detail: `due-from ${money(p.receivableTxnMinor, p.currency)} vs due-to ${money(p.payableTxnMinor, p.currency)}` }],
            dedupeKey: `ic-trueup:${o.jeId}`,
          },
        ),
      }) as ProposeOutcome;
      if (out.proposalId) trueUps.push(out.proposalId);
      trueUpTxn += o.txnAmountMinor;
      trueUpUsd += usd;
      n++;
    }
    if (p.eliminationEntityId) {
      // Pro forma eliminations (ASC 810/830): as if every pending intercompany proposal were posted.
      const pend = p.pending.filter((x) => !trueUps.includes(x.proposalId));
      const pendOn = (entityId: string, code: string) => pend.filter((x) => x.entityId === entityId && x.accountCode === code).reduce((s, x) => s + x.functionalMinor, 0);
      const payUsd = p.payableFunctionalMinor - pendOn(p.payableEntityId, '2400') + trueUpUsd;
      const expUsd = p.expenseFunctionalMinor + pendOn(p.payableEntityId, '6950') + trueUpUsd;
      const recUsd = Math.round((p.receivableTxnMinor + pendOn(p.receivableEntityId, '1400')) * p.closingRate);
      const revUsd = Math.round(p.revenueTxnMinor * p.averageRate);
      const deps = [...new Set([...trueUps, ...pend.map((x) => x.proposalId)])];
      const waitFor = deps.length ? ` It assumes ${deps.length} pending proposal${deps.length === 1 ? ' is' : 's are'} posted, so it can only be approved after ${deps.length === 1 ? 'it' : 'them'}.` : '';
      const d1 = revUsd - expUsd;
      if (revUsd > 0) {
        yield {
          type: 'propose',
          draft: jeDraft(
            { entityId: p.eliminationEntityId, periodKey: pk, postingDate: periodEnd(pk), entryType: 'elimination', memo: `Eliminate intercompany R&D services – ${pk}`, source: 'agent', lines: [{ account: '4900', debit: revUsd }, { account: '6950', credit: expUsd, department: 'RND' }, ...(d1 > 0 ? [{ account: '7120', credit: d1 }] : d1 < 0 ? [{ account: '7120', debit: -d1 }] : [])], dependsOnProposalIds: deps, sourceRef: `ELIM-PL-${pk}` },
            { title: `Eliminate intercompany revenue and expense (${money(revUsd)})`, why: `Group statements must not show sales between group companies. ${p.receivableEntityCode} reports ${money(p.revenueTxnMinor, p.currency)} of intercompany revenue (${money(revUsd)} at the ${p.averageRate} average rate) and ${p.payableEntityCode} ${money(expUsd)} of matching expense; the rate difference of ${money(d1)} goes to the intercompany FX line.${waitFor}`, confidence: 0.9, evidence: [{ kind: 'computation', label: 'Intercompany revenue vs expense', detail: `${money(p.revenueTxnMinor, p.currency)} vs ${money(p.expenseTxnMinor + trueUpTxn, p.currency)}` }], dedupeKey: `elim-pl:${p.receivableEntityId}:${p.payableEntityId}` },
          ),
        };
        n++;
      }
      const d2 = recUsd - payUsd;
      if (recUsd > 0 || payUsd > 0) {
        yield {
          type: 'propose',
          draft: jeDraft(
            { entityId: p.eliminationEntityId, periodKey: pk, postingDate: periodEnd(pk), entryType: 'elimination', memo: `Eliminate intercompany balances at ${pk} (reverses next month)`, source: 'agent', lines: [{ account: '2400', debit: payUsd }, { account: '1400', credit: recUsd }, ...(d2 > 0 ? [{ account: '7120', debit: d2 }] : d2 < 0 ? [{ account: '7120', credit: -d2 }] : [])], autoReverseOn: nextStart(pk), dependsOnProposalIds: deps, sourceRef: `ELIM-BS-${pk}` },
            { title: `Eliminate intercompany balances (${money(recUsd)})`, why: `${p.receivableEntityCode}’s receivable from ${p.payableEntityCode} (${money(recUsd)} at the ${p.closingRate} closing rate) and ${p.payableEntityCode}’s payable (${money(payUsd)}) cancel out in the group balance sheet; the entry reverses on ${nextStart(pk)}.${waitFor}`, confidence: 0.9, evidence: [{ kind: 'computation', label: 'Intercompany balances', detail: `${money(p.receivableTxnMinor, p.currency)} receivable, ${money(p.payableTxnMinor + trueUpTxn, p.currency)} payable after true-up` }], dedupeKey: `elim-bs:${p.receivableEntityId}:${p.payableEntityId}` },
          ),
        };
        n++;
      }
    }
    yield note(`${p.receivableEntityCode}→${p.payableEntityCode}: due-from ${money(p.receivableTxnMinor, p.currency)}, due-to ${money(p.payableTxnMinor, p.currency)}, ${p.oneSided.length} one-sided entr${p.oneSided.length === 1 ? 'y' : 'ies'}.`);
  }
  return { headline: n ? `Proposed ${n} intercompany entries for ${periodLabel(pk)}` : `Intercompany balances agree for ${periodLabel(pk)}` };
};

// =========================================================================== FX revaluation
export const fxRevaluation: OfflineBrain = async function* (input): Gen {
  const { entityId, pk } = need(input);
  yield plan(['Find foreign-currency monetary balances', 'Remeasure each at the closing rate', 'Propose the unrealized gain or loss']);
  const e = yield* entityInfo(pk, entityId);
  const r = (yield tool('fx.exposures', { entityId, periodKey: pk })) as { items: FxExposure[] };
  let n = 0;
  for (const x of r.items) {
    if (x.adjustmentMinor === 0) {
      yield note(`${x.accountCode} ${x.currency} balance is already carried at the closing rate.`);
      continue;
    }
    const adj = x.adjustmentMinor;
    const lines: JePayload['lines'] = adj > 0 ? [{ account: x.accountCode, debit: adj, counterparty_entity_id: x.counterpartyEntityId }, { account: '7110', credit: adj }] : [{ account: '7110', debit: -adj }, { account: x.accountCode, credit: -adj, counterparty_entity_id: x.counterpartyEntityId }];
    const gain = adj > 0; // a debit to the balance (asset up / liability down) is a gain
    yield {
      type: 'propose',
      draft: jeDraft(
        { entityId, periodKey: pk, postingDate: periodEnd(pk), entryType: 'fx_revaluation', memo: `Remeasure ${x.currency} ${x.accountName} at ${x.closingRate} – ${pk}`, source: 'agent', lines, autoEligible: true, fx: { foreignMinor: x.foreignMinor, closingRate: x.closingRate, revaluedFunctionalMinor: x.revaluedMinor, carryingMinor: x.carryingMinor, currency: x.currency }, sourceRef: `FXREV-${pk}-${x.accountCode}` },
        {
          title: `Remeasure ${x.currency} ${x.accountName}: unrealized ${gain ? 'gain' : 'loss'} ${money(Math.abs(adj), e.currency)}`,
          why: `${x.accountCode} holds ${money(Math.abs(x.foreignMinor), x.currency)} carried at ${money(Math.abs(x.carryingMinor), e.currency)}. At the ${periodEnd(pk)} closing rate of ${x.closingRate} it is worth ${money(Math.abs(x.revaluedMinor), e.currency)}, so the difference of ${money(Math.abs(adj), e.currency)} is an unrealized FX ${gain ? 'gain' : 'loss'} (ASC 830, AX-FX-01).`,
          confidence: 0.97,
          evidence: [{ kind: 'computation', label: `${money(x.foreignMinor, x.currency)} × ${x.closingRate} = ${money(x.revaluedMinor, e.currency)}` }, { kind: 'record', label: `${x.lineCount} ${x.currency} lines on ${x.accountCode}`, refType: 'account', refId: x.accountCode }],
          dedupeKey: `fxrev:${x.accountCode}:${x.currency}`,
        },
      ),
    };
    n++;
  }
  return { headline: n ? `Proposed ${n} FX remeasurement entr${n === 1 ? 'y' : 'ies'} for ${e.code}` : `No foreign-currency balances need remeasurement for ${e.code}` };
};

// =========================================================================== JE review
export const jeReview: OfflineBrain = async function* (input): Gen {
  const { entityId, pk } = need(input);
  yield plan(['Scan every posted entry in the period with the risk tests', 'Look for duplicate payments', 'Run the Benford first-digit test', 'Raise findings with recommended actions']);
  const e = yield* entityInfo(pk, entityId);
  const r = (yield tool('anomaly.scan', { entityId, periodKey: pk })) as { flagged: FlaggedEntry[]; duplicates: DuplicatePayment[]; benford: BenfordResult; scanned: number };
  let n = 0;
  for (const f of r.flagged) {
    const severity = f.score >= 60 ? 'critical' : f.score >= 40 ? 'high' : 'medium';
    const memo = redactInstructions(f.memo);
    yield {
      type: 'propose',
      draft: findingDraft(
        { entityId, periodKey: pk, category: f.hits[0]!.test, severity, recommendation: f.hits.some((h) => h.test === 'self_approval') ? 'Have an independent approver review the support. If it cannot be supported, reverse it; either way, remove the ability to approve imported entries you uploaded.' : 'Review the support for this entry and document the business reason.', subjects: [{ type: 'journal_entry', id: f.jeId, label: f.jeNumber }], tests: f.hits.map((h) => h.test), score: f.score },
        { title: `${severity === 'critical' ? 'Critical' : 'Risky'} entry ${f.jeNumber}: ${clipText(memo, 70)} ${money(f.amountMinor, e.currency)}`, why: `${f.hits.map((h) => h.detail).join(' ')} Risk score ${f.score} (self-approval 50, threshold skirting 20, weekend 15, round amount 10).`, confidence: 0.95, evidence: [rec(`${f.jeNumber} prepared by ${f.preparedBy}, approved by ${f.approvedBy ?? 'nobody'}`, 'journal_entry', f.jeId)], dedupeKey: `jerisk:${f.jeId}` },
      ),
    };
    n++;
  }
  for (const d of r.duplicates) {
    yield {
      type: 'propose',
      draft: findingDraft(
        { entityId, periodKey: pk, category: 'duplicate_payment', severity: d.amountMinor >= 750_000 ? 'high' : 'medium', recommendation: `Ask ${d.vendorName} to refund ${money(d.amountMinor, e.currency)} (or apply it as a credit to the next bill) and confirm the payment run controls; the subledger tie-out reclassifies the debit balance meanwhile.`, subjects: d.payments.map((p) => ({ type: 'payment', id: p.id, label: p.number })), tests: ['duplicate_payment'], score: 60 },
        { title: `Duplicate payment to ${d.vendorName}: ${money(d.amountMinor, e.currency)}`, why: d.reason, confidence: 0.97, evidence: [...(d.billId ? [rec(`Bill ${d.billNumber}`, 'bill', d.billId)] : []), ...d.payments.map((p) => rec(`${p.number} on ${p.date}`, 'payment', p.id))], dedupeKey: `dup:${d.payments.map((p) => p.id).sort().join('+')}` },
      ),
    };
    n++;
  }
  yield note(`Benford first-digit test on ${r.benford.sample} line amounts (trailing 12 months): MAD ${r.benford.mad} → ${r.benford.conformity.replace('_', ' ')}. Population-level only; it does not single out entries, so it is reported here rather than as a finding.`);
  return { headline: `Scanned ${r.scanned} entries for ${e.code}: ${n} finding${n === 1 ? '' : 's'}` };
};

// =========================================================================== flux
export const fluxAnalysis: OfflineBrain = async function* (input): Gen {
  const { entityId, pk } = need(input);
  yield plan(['Compare this month with last month and budget for every P&L account', 'Apply the variance thresholds (absolute and %)', 'Decompose each significant variance into drivers that add up', 'Draft plain-English explanations, noting proposals still waiting for approval']);
  const e = yield* entityInfo(pk, entityId);
  const r = (yield tool('flux.compute', { entityId, periodKey: pk })) as { lines: FluxLineView[]; comparativeKey: string; thresholds: { absMinor: number; pct: number; performanceMinor: number }; currency: string };
  let n = 0;
  for (const l of r.lines.filter((x) => x.exceeds)) {
    if (l.explanation && (l.explanation.status === 'approved' || l.explanation.status === 'submitted')) continue;
    const text = fluxNarrative({ ...l, drivers: l.drivers.map((d) => ({ ...d, label: redactInstructions(d.label) })) }, r.currency, pk, r.comparativeKey);
    const coverage = l.drivers.filter((d) => !d.label.startsWith('Other')).reduce((s, d) => s + Math.abs(d.amountMinor), 0) / Math.max(1, Math.abs(l.varianceMinor));
    yield {
      type: 'propose',
      draft: fluxDraft(
        { entityId, periodKey: pk, comparison: 'pop', accountCode: l.code, currentMinor: l.currentMinor, comparativeMinor: l.comparativeMinor, budgetMinor: l.budgetMinor, varianceMinor: l.varianceMinor, variancePct: l.variancePct, thresholdAbsMinor: r.thresholds.absMinor, thresholdPct: r.thresholds.pct, materiality: l.materiality, text, drivers: l.drivers.map((d) => ({ label: redactInstructions(d.label).slice(0, 200), kind: d.kind, amountMinor: d.amountMinor, ...(d.detail ? { detail: d.detail } : {}), ...(d.refType ? { refType: d.refType } : {}), ...(d.refId ? { refId: d.refId } : {}) })), pending: l.pending.map((p) => ({ proposalId: p.proposalId, proposalRef: p.proposalRef, label: p.label.slice(0, 200), amountMinor: p.amountMinor })) },
        {
          title: `Explain ${l.code} ${l.name}: ${l.varianceMinor >= 0 ? '+' : '−'}${money(Math.abs(l.varianceMinor), r.currency)} vs ${periodLabel(r.comparativeKey)}`,
          why: `The change exceeds the review threshold (${money(r.thresholds.absMinor, r.currency)} and ${(r.thresholds.pct * 100).toFixed(0)}%${l.materiality === 'material' ? '; it is above performance materiality' : ''}). The drivers come from the ledger and add up to the variance exactly.`,
          confidence: Math.min(0.95, 0.6 + 0.35 * Math.min(1, coverage)),
          evidence: [{ kind: 'computation', label: `Flux ${l.code} ${pk} vs ${r.comparativeKey}` }, ...l.drivers.filter((d) => d.refType && d.refId).slice(0, 4).map((d) => rec(d.label, d.refType!, d.refId!)), ...l.pending.map((p) => ({ kind: 'run' as const, label: `${p.proposalRef} awaiting approval`, refType: 'proposal', refId: p.proposalId }))],
          dedupeKey: `flux:${l.code}:${r.comparativeKey}`,
        },
      ),
    };
    n++;
  }
  return { headline: n ? `Drafted ${n} variance explanation${n === 1 ? '' : 's'} for ${e.code} ${periodLabel(pk)}` : `No unexplained significant variances for ${e.code}` };
};

// =========================================================================== close package
export const closePackage: OfflineBrain = async function* (input): Gen {
  const pk = input.periodKey;
  if (!pk) throw new Error('close-package needs a period');
  yield plan(['Read the checklist and readiness to lock', 'Assemble trial balances, consolidated statements and commentary', 'Summarise results, open items and agent activity', 'Propose the package for the Controller']);
  yield tool('close.status', { periodKey: pk });
  const d = (yield tool('report.package_data', { periodKey: pk })) as { content: { kpis: { revenueMinor: number; grossMarginPct: number | null; opexMinor: number; netIncomeMinor: number; cashMinor: number }; openItems: { ref: string; title: string }[]; commentary: { entityCode: string; accountName: string; text: string }[]; reconciliations: { status: string; unreconciledMinor: number }[]; agentActivity: { runs: number; proposals: number; autoApplied: number } } & Record<string, unknown>; readiness: { ready: boolean; messages: string[] } };
  const k = d.content.kpis;
  const recsDone = d.content.reconciliations.filter((r) => r.status === 'reviewed').length;
  const highlights = [
    `Revenue ${money(k.revenueMinor)}; gross margin ${k.grossMarginPct ?? '–'}%; operating expenses ${money(k.opexMinor)}; net income ${money(k.netIncomeMinor)}.`,
    `Cash ${money(k.cashMinor)} (consolidated, USD).`,
    `${recsDone} of ${d.content.reconciliations.length} reconciliations reviewed; ${d.content.openItems.length} proposals still open.`,
    `Agents: ${d.content.agentActivity.runs} runs, ${d.content.agentActivity.proposals} proposals, ${d.content.agentActivity.autoApplied} applied by policy.`,
    ...d.content.commentary.slice(0, 4).map((c) => `${c.entityCode} ${c.accountName}: ${c.text.split('. ')[0]}.`),
  ];
  const summary = `${periodLabel(pk)} close package (draft). ${d.readiness.ready ? 'All lock conditions are met.' : `Not ready to lock: ${d.readiness.messages.join('; ')}.`} ${highlights[0]}`;
  yield {
    type: 'propose',
    draft: reportDraft(
      { periodKey: pk, summary, highlights, readiness: { ready: d.readiness.ready, messages: d.readiness.messages }, content: d.content as Record<string, unknown> },
      { title: `${periodLabel(pk)} close package (draft)`, why: `Compiles the trial balances, consolidated statements, approved commentary, reconciliation status and open items so the Controller can review and finalize. ${d.readiness.ready ? 'Every lock condition (AX-CL-02) is met.' : 'It lists what still blocks the lock (AX-CL-02).'}`, confidence: 0.95, evidence: [{ kind: 'computation', label: 'report.package_data' }], dedupeKey: `package:${pk}:${hashLite(JSON.stringify(k))}:${d.content.openItems.length}` },
    ),
  };
  return { headline: `Close package draft for ${periodLabel(pk)} ${d.readiness.ready ? '(ready to lock)' : `(${d.readiness.messages.length} blocker${d.readiness.messages.length === 1 ? '' : 's'})`}` };
};

function hashLite(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export const OFFLINE_BRAINS: Record<string, OfflineBrain> = {
  'bank-reconciliation': bankReconciliation,
  'transaction-coding': transactionCoding,
  'accrual-detection': accrualDetection,
  'schedule-rollforward': scheduleRollforward,
  'subledger-tieout': subledgerTieout,
  'intercompany-matching': intercompanyMatching,
  'fx-revaluation': fxRevaluation,
  'je-review': jeReview,
  'flux-analysis': fluxAnalysis,
  'close-package': closePackage,
};
