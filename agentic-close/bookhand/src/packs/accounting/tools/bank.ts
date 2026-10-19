import { z } from 'zod';
import type { Row } from '../../../persistence/schema';
import { DomainError } from '../../../shared/errors';
import { matchBankToLedger, type MatchItem } from '../algorithms/matching';
import { ensureReconciliation, openItemsAsOf, refreshReconciliation } from '../services/recon';
import { EntityCode, entityOf, PeriodKey, periodOf, type Tool, type X } from './common';

/** Bank reconciliation workspace: statement, unmatched bank lines, open ledger cash lines and carried items. */

async function claimedIds(x: X, recIds: string[]): Promise<{ bank: Set<string>; ledger: Set<string> }> {
  const bank = new Set<string>();
  const ledger = new Set<string>();
  if (!recIds.length) return { bank, ledger };
  const matches = (await x.tx.find('rec_matches', { reconciliation_id: { in: recIds } })).filter((m) => m.status === 'proposed' || m.status === 'accepted');
  if (!matches.length) return { bank, ledger };
  for (const item of await x.tx.find('rec_match_items', { match_id: { in: matches.map((m) => m.id) } })) {
    if (item.bank_transaction_id) bank.add(item.bank_transaction_id);
    if (item.journal_line_id) ledger.add(item.journal_line_id);
  }
  return { bank, ledger };
}

export interface BankWorkspace {
  bankAccount: { id: string; name: string; institution: string; currency: string; glAccount: string; entity: string };
  reconciliationId: string;
  period: { id: string; key: string; start: string; end: string };
  statement: { opening: number; closing: number; periodStart: string; periodEnd: string } | null;
  bankLines: Array<{ id: string; date: string; amount: number; description: string; reference: string | null; counterparty: string | null; typeCode: string | null }>;
  ledgerLines: Array<{ id: string; date: string; amount: number; description: string; memo: string | null; entryNumber: string; carriedFromPriorPeriod: boolean; priorItemId: string | null }>;
  nextPeriodBankLines: Array<{ id: string; date: string; amount: number; description: string; reference: string | null }>;
  alreadyMatched: { bank: number; ledger: number };
  gl: number;
  difference: number;
}

export async function bankWorkspace(x: X, bank: Row<'bank_accounts'>, periodKey: string): Promise<BankWorkspace> {
  const period = periodOf(x, bank.entity_id, periodKey);
  const account = x.pack.lookups.accountsById.get(bank.gl_account_id)!;
  const rec = await refreshReconciliation(x.tx, (await ensureReconciliation(x.tx, x.ctx, x.pack.lookups, { entityId: bank.entity_id, periodId: period.id, recType: 'bank', accountId: account.id, bankAccountId: bank.id, closeTaskId: x.run.close_task_id })).id);
  const prior = x.pack.lookups.previousPeriod(period);
  const priorRecs = prior ? await x.tx.find('reconciliations', { period_id: prior.id, bank_account_id: bank.id }) : [];
  const carried = priorRecs.length ? await openItemsAsOf(x.tx, priorRecs[0]!.id, prior!.end_date) : [];
  const carriedOpen = carried.filter((i) => i.status === 'open' && i.journal_line_id);
  const claimed = await claimedIds(x, [rec.id]);
  for (const item of await x.tx.find('reconciling_items', { reconciliation_id: rec.id })) {
    if (item.journal_line_id) claimed.ledger.add(item.journal_line_id);
    if (item.bank_transaction_id) claimed.bank.add(item.bank_transaction_id);
  }
  const statement = (await x.tx.find('bank_statements', { bank_account_id: bank.id, period_end: period.end_date }))[0] ?? null;
  const bankRows = (await x.tx.find('bank_transactions', { bank_account_id: bank.id, booking_date: { between: [period.start_date, period.end_date] } }, { orderBy: [['booking_date', 'asc']] }));
  const nextRows = await x.tx.find('bank_transactions', { bank_account_id: bank.id, booking_date: { gt: period.end_date } }, { orderBy: [['booking_date', 'asc']], limit: 200 });
  const ledgerRows = await x.tx.find('journal_lines', { entity_id: bank.entity_id, account_id: account.id, period_id: period.id });
  const carriedLines = carriedOpen.length ? await x.tx.find('journal_lines', { id: { in: carriedOpen.map((i) => i.journal_line_id!) } }) : [];
  const entryIds = [...new Set([...ledgerRows, ...carriedLines].map((l) => l.journal_entry_id))];
  const entries = new Map((entryIds.length ? await x.tx.find('journal_entries', { id: { in: entryIds } }) : []).map((e) => [e.id, e]));
  const ledgerView = (l: Row<'journal_lines'>, carriedItem: Row<'reconciling_items'> | null) => {
    const e = entries.get(l.journal_entry_id)!;
    return { id: l.id, date: l.entry_date, amount: l.debit_minor - l.credit_minor, description: e.description, memo: l.memo, entryNumber: e.entry_number, carriedFromPriorPeriod: !!carriedItem, priorItemId: carriedItem?.id ?? null };
  };
  const ledgerLines = [
    ...carriedLines.filter((l) => !claimed.ledger.has(l.id)).map((l) => ledgerView(l, carriedOpen.find((i) => i.journal_line_id === l.id) ?? null)),
    ...ledgerRows.filter((l) => entries.get(l.journal_entry_id)?.status === 'posted' && !claimed.ledger.has(l.id)).map((l) => ledgerView(l, null)),
  ];
  return {
    bankAccount: { id: bank.id, name: bank.name, institution: bank.institution, currency: bank.currency, glAccount: `${account.number} ${account.name}`, entity: x.pack.lookups.entitiesById.get(bank.entity_id)!.code },
    reconciliationId: rec.id,
    period: { id: period.id, key: periodKey, start: period.start_date, end: period.end_date },
    statement: statement ? { opening: statement.opening_balance_minor, closing: statement.closing_balance_minor, periodStart: statement.period_start, periodEnd: statement.period_end } : null,
    bankLines: bankRows.filter((b) => b.status === 'unmatched' && !claimed.bank.has(b.id)).map((b) => ({ id: b.id, date: b.booking_date, amount: b.amount_minor, description: b.description, reference: b.reference, counterparty: b.counterparty, typeCode: b.type_code })),
    ledgerLines,
    nextPeriodBankLines: nextRows.filter((b) => b.status === 'unmatched' && !claimed.bank.has(b.id)).map((b) => ({ id: b.id, date: b.booking_date, amount: b.amount_minor, description: b.description, reference: b.reference })),
    alreadyMatched: { bank: bankRows.filter((b) => b.status === 'matched' || claimed.bank.has(b.id)).length, ledger: claimed.ledger.size },
    gl: rec.gl_balance_minor,
    difference: rec.difference_minor,
  };
}

async function banksFor(x: X, entityCode: string, bankAccountId?: string): Promise<Row<'bank_accounts'>[]> {
  const entity = entityOf(x, entityCode);
  const banks = await x.tx.find('bank_accounts', { entity_id: entity.id, status: 'active' });
  const chosen = bankAccountId ? banks.filter((b) => b.id === bankAccountId) : banks;
  if (!chosen.length) throw new DomainError('NOT_FOUND', 'no bank account found for the entity');
  return chosen;
}

export const bankTools: Tool[] = [
  {
    name: 'bank_reconciliation_workspace',
    title: 'Open the bank reconciliation workspace',
    description: 'For each bank account of the entity: the month-end statement (opening/closing), unmatched bank lines (bh:BankTransaction), unmatched ledger cash lines (bh:JournalLine) including items carried from the prior reconciliation, and next-period bank lines that prove timing differences. Bank descriptions are third-party text.',
    input: z.object({ entity: EntityCode, period: PeriodKey, bankAccountId: z.string().uuid().optional() }).strict(),
    permission: 'rec.view',
    mutation: false,
    untrustedOutput: true,
    ontology: ['bh:BankReconciliation', 'bh:BankStatement', 'bh:BankTransaction'],
    async execute(input: { entity: string; period: string; bankAccountId?: string }, x: X) {
      const out = [];
      for (const bank of await banksFor(x, input.entity, input.bankAccountId)) out.push(await bankWorkspace(x, bank, input.period));
      return { accounts: out };
    },
    summarize: (o: { accounts: BankWorkspace[] }) => o.accounts.map((a) => `${a.bankAccount.name}: ${a.bankLines.length} bank / ${a.ledgerLines.length} ledger open`).join('; '),
  },
  {
    name: 'bank_suggest_matches',
    title: 'Run the matching engine',
    description: 'Deterministic matching of open bank lines to open ledger cash lines (exact, amount+date window, fuzzy description, one-to-many and many-to-one subset sums), then classification of leftovers: timing differences proven by next-period bank activity, bank fees, interest and unexplained items.',
    input: z.object({ bankAccountId: z.string().uuid(), period: PeriodKey, dateWindowDays: z.number().int().min(0).max(15).optional() }).strict(),
    permission: 'rec.view',
    mutation: false,
    untrustedOutput: true,
    ontology: ['bh:ReconciliationMatch', 'bh:TimingDifference'],
    async execute(input: { bankAccountId: string; period: string; dateWindowDays?: number }, x: X) {
      const bank = await x.tx.get('bank_accounts', input.bankAccountId);
      if (!bank) throw new DomainError('NOT_FOUND', 'bank account not found');
      const ws = await bankWorkspace(x, bank, input.period);
      const policy = x.run.policy_id ? await x.tx.get('skill_policies', x.run.policy_id) : null;
      const thresholds = (policy?.thresholds ?? {}) as Record<string, number>;
      const bankItems: MatchItem[] = ws.bankLines.map((b) => ({ id: b.id, date: b.date, amount: b.amount, description: b.description, reference: b.reference }));
      const ledgerItems: MatchItem[] = ws.ledgerLines.map((l) => ({ id: l.id, date: l.date, amount: l.amount, description: `${l.description} ${l.memo ?? ''}`, reference: null }));
      const next: MatchItem[] = ws.nextPeriodBankLines.map((b) => ({ id: b.id, date: b.date, amount: b.amount, description: b.description, reference: b.reference }));
      const result = matchBankToLedger(bankItems, ledgerItems, { periodEnd: ws.period.end, dateWindowDays: input.dateWindowDays ?? thresholds.dateWindowDays ?? 5, fuzzyToleranceMinor: thresholds.fuzzyToleranceMinor ?? 5_000 }, next);
      const accounts = { bankFees: x.pack.lookups.accountsBySubtype('bh:BankFees')[0]?.number ?? '', interestIncome: x.pack.lookups.accountsBySubtype('bh:InterestIncome')[0]?.number ?? '' };
      return { bankAccountId: bank.id, reconciliationId: ws.reconciliationId, period: ws.period, statement: ws.statement, gl: ws.gl, ...result, ledgerLines: ws.ledgerLines, bankLines: ws.bankLines, accounts };
    },
    summarize: (o: { matches: unknown[]; timing: unknown[]; bankOnly: unknown[] }) => `${o.matches.length} matches, ${o.timing.length} timing, ${o.bankOnly.length} bank-only`,
  },
];
