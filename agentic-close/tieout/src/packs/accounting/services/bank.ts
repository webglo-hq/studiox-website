/**
 * Bank reconciliation service: statement lines, ledger cash lines, match suggestions, timing
 * classification and the live reconciliation state (AX-REC-01) used by the workbench, the agent
 * and certification.
 */
import { diffDays, periodEnd, periodStart, shiftPeriod } from '../../../core/util/time';
import { notFound } from '../../../core/util/errors';
import type { BankAccountRow, BankStatementRow, BankTransactionRow, ReconciliationRow, ReconcilingItemRow } from '../../../schema';
import { closeOntology } from '../ontology';
import type { AcctContext } from './context';
import { classifyBankOnly, matchLines, type ExternalLine, type LedgerLine, type Match } from './matching';

export interface BankLineView extends ExternalLine {
  status: BankTransactionRow['status'];
  typeCode: string | null;
  sourceDocumentId: string | null;
  sourceLine: number | null;
}

export interface LedgerCashLine extends LedgerLine {
  jeStatus: string;
  source: string;
  matched: boolean;
}

export interface TimingItem {
  kind: 'deposit_in_transit' | 'outstanding_check' | 'timing';
  ledger: LedgerCashLine;
  clearedBy: BankLineView | null;
  confidence: number;
  reason: string;
}

export interface BankOnlyItem {
  kind: 'bank_fee' | 'interest' | 'unexplained';
  line: BankLineView;
  confidence: number;
  reason: string;
  possibleCounterparties: string[];
}

export interface RecState {
  reconciliation: ReconciliationRow | null;
  bankAccount: BankAccountRow;
  periodKey: string;
  statement: BankStatementRow | null;
  glBalanceMinor: number;
  externalBalanceMinor: number;
  items: ReconcilingItemRow[];
  adjustedExternalMinor: number;
  adjustedLedgerMinor: number;
  unreconciledMinor: number;
  unexplainedMinor: number;
  matchedCount: number;
  unmatchedBank: number;
  unmatchedLedger: number;
  tiesOut: boolean;
}

export class BankService {
  constructor(private readonly c: AcctContext) {}

  async accounts(entityId?: string | null): Promise<BankAccountRow[]> {
    const all = await this.c.tx.find('bank_accounts', entityId ? { entity_id: entityId, status: 'active' } : { status: 'active' });
    return all.filter((b) => !this.c.actor.entityScope || this.c.actor.entityScope.includes(b.entity_id));
  }

  async account(id: string): Promise<BankAccountRow> {
    const b = await this.c.tx.get('bank_accounts', id);
    if (!b) throw notFound('Bank account', id);
    this.c.assertEntityInScope(b.entity_id);
    return b;
  }

  async statement(bankAccountId: string, periodKey: string): Promise<{ statement: BankStatementRow | null; lines: BankLineView[]; subsequent: BankLineView[] }> {
    const ba = await this.account(bankAccountId);
    const statement = (await this.c.tx.findOne('bank_statements', { bank_account_id: ba.id, period_key: periodKey })) ?? null;
    const rows = await this.c.tx.find('bank_transactions', { bank_account_id: ba.id, txn_date: { gte: periodStart(periodKey), lte: periodEnd(periodKey) } }, { orderBy: [['txn_date', 'asc'], ['external_id', 'asc']] });
    const until = await this.c.subsequentWindowEnd(periodKey);
    const next = await this.c.tx.find('bank_transactions', { bank_account_id: ba.id, txn_date: { gte: periodStart(shiftPeriod(periodKey, 1)), lte: until } }, { orderBy: [['txn_date', 'asc'], ['external_id', 'asc']] });
    return { statement, lines: rows.map(view), subsequent: next.map(view) };
  }

  /** Posted ledger lines on the bank's GL account within the period. */
  async ledgerLines(bankAccountId: string, periodKey: string): Promise<LedgerCashLine[]> {
    const ba = await this.account(bankAccountId);
    const headers = await this.c.tx.find('journal_entries', { entity_id: ba.entity_id, status: 'posted', posting_date: { gte: periodStart(periodKey), lte: periodEnd(periodKey) } });
    if (!headers.length) return [];
    const byId = new Map(headers.map((h) => [h.id, h]));
    const lines = await this.c.tx.find('journal_lines', { account_id: ba.gl_account_id });
    const confirmed = await this.confirmedMatchIds();
    const matchedItems = await this.c.tx.find('rec_match_items', { item_type: 'journal_line' });
    const confirmedLedger = new Set(matchedItems.filter((i) => confirmed.has(i.rec_match_id)).map((i) => i.item_id));
    const checks = new Map((await this.c.tx.find('payments', { bank_account_id: ba.id, method: 'check' })).filter((p) => p.journal_entry_id).map((p) => [p.journal_entry_id!, p.check_number]));
    const out: LedgerCashLine[] = [];
    for (const l of lines) {
      const h = byId.get(l.journal_entry_id);
      if (!h) continue;
      out.push({
        id: l.id,
        entryId: h.id,
        entryRef: h.je_number,
        date: h.posting_date,
        amountMinor: l.debit_minor - l.credit_minor,
        memo: checks.get(h.id) && !h.memo.includes(String(checks.get(h.id))) ? `${h.memo} · check ${checks.get(h.id)}` : h.memo,
        reference: h.source_ref,
        jeStatus: h.status,
        source: h.source,
        matched: confirmedLedger.has(l.id),
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.entryRef.localeCompare(b.entryRef));
  }

  private async confirmedMatchIds(): Promise<Set<string>> {
    return new Set((await this.c.tx.find('rec_matches', { status: 'confirmed' })).map((m) => m.id));
  }

  /**
   * Suggest matches for unmatched lines, then classify what is left: bank-only lines (fees,
   * interest, unexplained) and book-only lines (deposits in transit, outstanding checks).
   */
  async suggest(bankAccountId: string, periodKey: string) {
    const { statement, lines, subsequent } = await this.statement(bankAccountId, periodKey);
    const ledger = await this.ledgerLines(bankAccountId, periodKey);
    const openBank = lines.filter((l) => l.status === 'unmatched');
    const openLedger = ledger.filter((l) => !l.matched);
    const result = matchLines(openBank, openLedger);
    const bankById = new Map(lines.map((l) => [l.id, l]));
    const ledgerById = new Map(ledger.map((l) => [l.id, l]));
    const vendors = await this.c.tx.find('vendors', {});
    const customers = await this.c.tx.find('customers', {});
    const names = [...vendors.map((v) => v.name), ...customers.map((c) => c.name)];
    const bankOnly: BankOnlyItem[] = result.unmatchedExternal.map((e) => {
      const cls = classifyBankOnly(e);
      const d = e.description.toUpperCase();
      const possible = names.filter((n) => d.includes(n.toUpperCase().split(' ')[0]!) && n.split(' ')[0]!.length > 4).slice(0, 3);
      return { ...cls, line: bankById.get(e.id)!, possibleCounterparties: possible };
    });
    const payments = await this.c.tx.find('payments', { bank_account_id: bankAccountId, method: 'check' });
    const checkByJe = new Map(payments.filter((p) => p.journal_entry_id).map((p) => [p.journal_entry_id!, p]));
    const timing: TimingItem[] = result.unmatchedLedger.map((l0) => {
      const l = ledgerById.get(l0.id)!;
      const cleared = subsequent.find((s) => s.amountMinor === l.amountMinor && (s.reference === l.reference || (l.reference && s.description.toUpperCase().includes(l.reference.toUpperCase()))) && diffDays(s.date, l.date) <= 10) ?? subsequent.find((s) => s.amountMinor === l.amountMinor && diffDays(s.date, l.date) <= 5) ?? null;
      const check = checkByJe.get(l.entryId);
      if (l.amountMinor > 0) {
        return {
          kind: 'deposit_in_transit' as const,
          ledger: l,
          clearedBy: cleared,
          confidence: cleared ? 0.97 : diffDays(periodEnd(periodKey), l.date) <= 3 ? 0.85 : 0.6,
          reason: cleared ? `Recorded ${l.date}; the bank credited it on ${cleared.date} (next statement), so it is a deposit in transit.` : `Recorded ${l.date}, near month-end; not yet on the bank statement.`,
        };
      }
      if (check) {
        return {
          kind: 'outstanding_check' as const,
          ledger: l,
          clearedBy: cleared,
          confidence: cleared ? 0.98 : diffDays(periodEnd(periodKey), l.date) <= 10 ? 0.95 : 0.75,
          reason: `Check ${check.check_number} issued ${l.date} has not been presented${cleared ? ` (presented ${cleared.date})` : ' as of the latest bank data'}.`,
        };
      }
      return { kind: 'timing' as const, ledger: l, clearedBy: cleared, confidence: cleared ? 0.9 : 0.5, reason: cleared ? `Cleared the bank on ${cleared.date}.` : 'In the books but not on the statement and no later clearing found.' };
    });
    return { statement, matches: result.matches, bankOnly, timing, counts: { bankLines: lines.length, ledgerLines: ledger.length, openBank: openBank.length, openLedger: openLedger.length } };
  }

  async glBalance(glAccountId: string, entityId: string, asOf: string): Promise<number> {
    const sums = await this.c.tx.sumLines({ entityIds: [entityId], accountIds: [glAccountId], toDate: asOf, groupBy: ['account_id'] });
    return sums.reduce((s, r) => s + r.debit_minor - r.credit_minor, 0);
  }

  /** Live reconciliation state (AX-REC-01): bank + external items vs GL + ledger items. */
  async state(bankAccountId: string, periodKey: string): Promise<RecState> {
    const ba = await this.account(bankAccountId);
    const period = await this.c.period(ba.entity_id, periodKey);
    const rec = (await this.c.tx.findOne('reconciliations', { entity_id: ba.entity_id, period_id: period.id, account_id: ba.gl_account_id, rec_type: 'bank' })) ?? null;
    const statement = (await this.c.tx.findOne('bank_statements', { bank_account_id: ba.id, period_key: periodKey })) ?? null;
    const gl = await this.glBalance(ba.gl_account_id, ba.entity_id, periodEnd(periodKey));
    const external = statement?.closing_balance_minor ?? 0;
    const items = rec ? await this.c.tx.find('reconciling_items', { reconciliation_id: rec.id }) : [];
    const open = items.filter((i) => i.status === 'open');
    const adjExt = external + open.filter((i) => i.side === 'external').reduce((s, i) => s + i.amount_minor, 0);
    const adjLed = gl + open.filter((i) => i.side === 'ledger').reduce((s, i) => s + i.amount_minor, 0);
    const lines = await this.c.tx.find('bank_transactions', { bank_account_id: ba.id, txn_date: { gte: periodStart(periodKey), lte: periodEnd(periodKey) } });
    const ledger = await this.ledgerLines(ba.id, periodKey);
    const tie = closeOntology().check('AX-REC-01', { glBalanceMinor: gl, externalBalanceMinor: external, items: open.map((i) => ({ side: i.side, amount_minor: i.amount_minor })), toleranceMinor: 0 });
    return {
      reconciliation: rec,
      bankAccount: ba,
      periodKey,
      statement,
      glBalanceMinor: gl,
      externalBalanceMinor: external,
      items,
      adjustedExternalMinor: adjExt,
      adjustedLedgerMinor: adjLed,
      unreconciledMinor: adjExt - adjLed,
      unexplainedMinor: open.filter((i) => i.kind === 'unexplained').reduce((s, i) => s + i.amount_minor, 0),
      matchedCount: lines.filter((l) => l.status === 'matched').length,
      unmatchedBank: lines.filter((l) => l.status === 'unmatched').length,
      unmatchedLedger: ledger.filter((l) => !l.matched).length,
      tiesOut: tie.passed,
    };
  }

  /** Get or create the reconciliation record for a bank account and period. */
  async ensureReconciliation(bankAccountId: string, periodKey: string, agentRunId: string | null = null): Promise<ReconciliationRow> {
    const ba = await this.account(bankAccountId);
    const period = await this.c.period(ba.entity_id, periodKey);
    const existing = await this.c.tx.findOne('reconciliations', { entity_id: ba.entity_id, period_id: period.id, account_id: ba.gl_account_id, rec_type: 'bank' });
    if (existing) return existing;
    return this.c.tx.insert('reconciliations', {
      entity_id: ba.entity_id,
      period_id: period.id,
      account_id: ba.gl_account_id,
      rec_type: 'bank',
      bank_account_id: ba.id,
      gl_balance_minor: 0,
      external_balance_minor: 0,
      external_source: `${ba.bank_name} ••${ba.account_last4} statement`,
      unreconciled_minor: 0,
      status: 'in_progress',
      risk: 'medium',
      preparer_id: null,
      prepared_at: null,
      reviewer_id: null,
      reviewed_at: null,
      agent_run_id: agentRunId,
      notes: null,
    });
  }
}

function view(t: BankTransactionRow): BankLineView {
  return { id: t.id, date: t.txn_date, amountMinor: t.amount_minor, description: t.description, counterparty: t.counterparty, reference: t.reference, status: t.status, typeCode: t.type_code, sourceDocumentId: t.source_document_id, sourceLine: t.source_line };
}

export type { Match };
