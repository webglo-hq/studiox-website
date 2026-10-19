import type { Tx } from '../../../persistence/db';
import type { Row } from '../../../persistence/schema';
import { DomainError } from '../../../shared/errors';
import { convertMinor } from '../../../shared/money';
import { closeOntology, FS_LINES } from '../ontology';
import type { TrialBalanceSubject } from '../ontology/subjects';
import { FxTable } from './fx';
import type { LedgerLookups } from './lookups';

export type TbMode = 'activity' | 'balance';

export interface TbRow {
  accountId: string;
  number: string;
  name: string;
  accountClass: Row<'accounts'>['account_class'];
  normalBalance: 'debit' | 'credit';
  subtype: string;
  fsLine: string;
  /** Net, debit-positive. */
  net: number;
  /** Presented on its side. */
  debit: number;
  credit: number;
  /** Natural sign: positive when on the normal side. */
  balance: number;
}

export interface TrialBalance {
  entityId: string | null;
  label: string;
  currency: string;
  mode: TbMode;
  periodId: string;
  periodName: string;
  rows: TbRow[];
  totalDebit: number;
  totalCredit: number;
}

function isBalanceSheet(cls: string): boolean {
  return cls === 'asset' || cls === 'liability' || cls === 'equity';
}

function makeRow(account: Row<'accounts'>, net: number): TbRow {
  return {
    accountId: account.id,
    number: account.number,
    name: account.name,
    accountClass: account.account_class,
    normalBalance: account.normal_balance,
    subtype: account.subtype,
    fsLine: account.fs_line,
    net,
    debit: net > 0 ? net : 0,
    credit: net < 0 ? -net : 0,
    balance: account.normal_balance === 'debit' ? net : -net,
  };
}

/** Net by account and period for an entity up to (and including) a period. */
async function netsByAccountPeriod(tx: Tx, lookups: LedgerLookups, entityId: string, upTo: Row<'periods'>) {
  const periods = lookups.periodsOf(entityId).filter((p) => p.end_date <= upTo.end_date);
  const sums = await tx.sumLines({ tenantId: lookups.tenantId, entityIds: [entityId], periodIds: periods.map((p) => p.id), groupBy: ['account_id', 'period_id'] });
  return { sums, periods };
}

/**
 * Entity trial balance in functional currency.
 * - activity: the period's postings only.
 * - balance: balance-sheet accounts cumulative to period end; income-statement accounts year-to-date; prior
 *   fiscal years' earnings presented in retained earnings (virtual year-end close), so the TB balances.
 */
export async function entityTrialBalance(tx: Tx, lookups: LedgerLookups, entityId: string, periodId: string, mode: TbMode = 'balance'): Promise<TrialBalance> {
  const entity = lookups.entitiesById.get(entityId);
  const period = lookups.periodsById.get(periodId);
  if (!entity || !period || period.entity_id !== entityId) throw new DomainError('NOT_FOUND', 'Entity or period not found');
  const nets = new Map<string, number>();
  const add = (accountId: string, v: number) => nets.set(accountId, (nets.get(accountId) ?? 0) + v);
  if (mode === 'activity') {
    const sums = await tx.sumLines({ tenantId: lookups.tenantId, entityIds: [entityId], periodIds: [periodId], groupBy: ['account_id'] });
    for (const s of sums) add(s.key.account_id!, s.debit_minor - s.credit_minor);
  } else {
    const { sums } = await netsByAccountPeriod(tx, lookups, entityId, period);
    const retained = Array.from(lookups.accountsById.values()).find((a) => a.subtype === 'bh:RetainedEarnings');
    for (const s of sums) {
      const account = lookups.accountsById.get(s.key.account_id!);
      const p = lookups.periodsById.get(s.key.period_id!);
      if (!account || !p) continue;
      const net = s.debit_minor - s.credit_minor;
      if (isBalanceSheet(account.account_class) || p.fiscal_year === period.fiscal_year) add(account.id, net);
      else if (retained) add(retained.id, net); // prior-year P&L folded into retained earnings
    }
  }
  const rows: TbRow[] = [];
  for (const [accountId, net] of nets) {
    const account = lookups.accountsById.get(accountId);
    if (account && net !== 0) rows.push(makeRow(account, net));
  }
  rows.sort((a, b) => a.number.localeCompare(b.number));
  return {
    entityId,
    label: entity.code,
    currency: entity.functional_currency,
    mode,
    periodId,
    periodName: period.name,
    rows,
    totalDebit: rows.reduce((s, r) => s + r.debit, 0),
    totalCredit: rows.reduce((s, r) => s + r.credit, 0),
  };
}

export function tbSubject(tb: TrialBalance): TrialBalanceSubject {
  return {
    entityLabel: tb.label,
    rows: tb.rows.map((r) => ({ accountNumber: r.number, accountName: r.name, accountClass: r.accountClass, normalBalance: r.normalBalance, subtype: r.subtype, debit: r.debit, credit: r.credit })),
  };
}

/** Ontology checks on a TB (balance, accounting equation, normal-balance anomalies). */
export function checkTrialBalance(tb: TrialBalance) {
  return closeOntology.evaluate('bh:TrialBalance', tbSubject(tb), {});
}

// ------------------------------------------------------------------ Consolidation & translation

export interface ConsolidatedColumn {
  entityId: string;
  code: string;
  functionalCurrency: string;
  kind: 'operating' | 'elimination';
  rates?: { closing: number; historical: number };
  /** accountId -> net in reporting currency */
  nets: Map<string, number>;
  cta: number;
}

export interface ConsolidatedTrialBalance extends TrialBalance {
  columns: Array<{ code: string; currency: string; kind: string; rates?: { closing: number; historical: number }; cta: number }>;
  /** accountId -> per-column nets in reporting currency */
  byColumn: Record<string, Record<string, number>>;
}

/**
 * Consolidated TB in the reporting currency (ASC 830 / ASC 810):
 *   assets & liabilities at the closing rate; revenue & expense month by month at average rates;
 *   equity at the historical rate; the translation difference goes to CTA; eliminations come from the
 *   elimination entity's posted entries.
 */
export async function consolidatedTrialBalance(tx: Tx, lookups: LedgerLookups, fiscalYear: number, periodNumber: number, reportingCurrency: string, mode: TbMode = 'balance'): Promise<ConsolidatedTrialBalance> {
  const fx = await FxTable.load(tx, lookups.tenantId);
  const ctaAccount = Array.from(lookups.accountsById.values()).find((a) => a.subtype === 'bh:CumulativeTranslationAdjustment');
  const retained = Array.from(lookups.accountsById.values()).find((a) => a.subtype === 'bh:RetainedEarnings');
  const columns: ConsolidatedColumn[] = [];
  let periodName = '';
  for (const entity of [...lookups.operatingEntities(), ...(lookups.eliminationEntity() ? [lookups.eliminationEntity()!] : [])]) {
    const period = lookups.period(entity.id, fiscalYear, periodNumber);
    if (!period) continue;
    periodName = period.name;
    const col: ConsolidatedColumn = { entityId: entity.id, code: entity.code, functionalCurrency: entity.functional_currency, kind: entity.kind, nets: new Map(), cta: 0 };
    const add = (id: string, v: number) => col.nets.set(id, (col.nets.get(id) ?? 0) + v);
    const sums =
      mode === 'activity'
        ? await tx.sumLines({ tenantId: lookups.tenantId, entityIds: [entity.id], periodIds: [period.id], groupBy: ['account_id', 'period_id'] })
        : (await netsByAccountPeriod(tx, lookups, entity.id, period)).sums;
    const foreign = entity.functional_currency !== reportingCurrency;
    const closing = foreign ? fx.rate(entity.functional_currency, reportingCurrency, period.end_date, 'closing') : 1;
    const historical = foreign ? historicalRate(fx, entity.functional_currency, reportingCurrency, lookups, entity.id) : 1;
    if (foreign) col.rates = { closing, historical };
    for (const s of sums) {
      const account = lookups.accountsById.get(s.key.account_id!);
      const p = lookups.periodsById.get(s.key.period_id!);
      if (!account || !p) continue;
      const net = s.debit_minor - s.credit_minor;
      const bs = isBalanceSheet(account.account_class);
      const target = mode === 'balance' && !bs && p.fiscal_year !== fiscalYear && retained ? retained.id : account.id;
      if (!foreign) {
        add(target, net);
        continue;
      }
      let rate: number;
      if (bs) rate = account.account_class === 'equity' ? historical : closing;
      else rate = fx.has(entity.functional_currency, reportingCurrency, p.end_date, 'average') ? fx.rate(entity.functional_currency, reportingCurrency, p.end_date, 'average') : closing;
      add(target, convertMinor(net, rate));
    }
    if (foreign) {
      // Translation difference: whatever makes the translated TB balance goes to CTA (equity, OCI).
      let total = 0;
      for (const v of col.nets.values()) total += v;
      col.cta = -total;
      if (ctaAccount && total !== 0) add(ctaAccount.id, -total);
    }
    columns.push(col);
  }
  const consolidated = new Map<string, number>();
  const byColumn: Record<string, Record<string, number>> = {};
  for (const col of columns) {
    for (const [id, v] of col.nets) {
      consolidated.set(id, (consolidated.get(id) ?? 0) + v);
      (byColumn[id] ??= {})[col.code] = v;
    }
  }
  const rows: TbRow[] = [];
  for (const [id, net] of consolidated) {
    const account = lookups.accountsById.get(id);
    if (account && (net !== 0 || Object.values(byColumn[id] ?? {}).some((v) => v !== 0))) rows.push(makeRow(account, net));
  }
  rows.sort((a, b) => a.number.localeCompare(b.number));
  return {
    entityId: null,
    label: 'Consolidated',
    currency: reportingCurrency,
    mode,
    periodId: '',
    periodName,
    rows,
    totalDebit: rows.reduce((s, r) => s + r.debit, 0),
    totalCredit: rows.reduce((s, r) => s + r.credit, 0),
    columns: columns.map((c) => ({ code: c.code, currency: c.functionalCurrency, kind: c.kind, rates: c.rates, cta: c.cta })),
    byColumn,
  };
}

/** Historical rate for equity: the earliest closing rate on record (opening balances were set up then). */
function historicalRate(fx: FxTable, base: string, quote: string, lookups: LedgerLookups, entityId: string): number {
  const first = lookups.periodsOf(entityId)[0];
  return first ? fx.rate(base, quote, first.end_date, 'closing') : 1;
}

// ------------------------------------------------------------------ Statements

export interface StatementLine {
  key: string;
  label: string;
  section: string;
  order: number;
  amount: number;
  accounts: Array<{ accountId: string; number: string; name: string; amount: number }>;
}

export interface BalanceSheet {
  currency: string;
  label: string;
  periodName: string;
  sections: Array<{ name: string; lines: StatementLine[]; total: number }>;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** Current-year earnings shown inside equity. */
  currentEarnings: number;
  balances: boolean;
}

export interface IncomeStatement {
  currency: string;
  label: string;
  periodName: string;
  sections: Array<{ name: string; lines: StatementLine[]; total: number }>;
  revenue: number;
  costOfRevenue: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingIncome: number;
  intercompany: number;
  otherIncome: number;
  netIncome: number;
}

/**
 * Natural statement signs. Balance sheet: assets debit-positive, liabilities and equity credit-positive.
 * Income statement: revenue positive, costs and expenses positive, and the intercompany and other-income
 * sections shown as their effect on income (gains positive).
 */
function statementSign(statement: 'BS' | 'IS', section: string, accountClass: string): number {
  if (statement === 'BS') return accountClass === 'asset' ? 1 : -1;
  if (section === 'Cost of revenue' || section === 'Operating expenses') return 1;
  return -1;
}

function groupLines(tb: TrialBalance, statement: 'BS' | 'IS'): StatementLine[] {
  const defs = FS_LINES.filter((l) => l.statement === statement);
  const lines = new Map<string, StatementLine>(defs.map((d) => [d.key, { key: d.key, label: d.label, section: d.section, order: d.order, amount: 0, accounts: [] }]));
  for (const r of tb.rows) {
    const line = lines.get(r.fsLine);
    if (!line) continue;
    const amount = statementSign(statement, line.section, r.accountClass) * r.net;
    line.amount += amount;
    line.accounts.push({ accountId: r.accountId, number: r.number, name: r.name, amount });
  }
  return Array.from(lines.values()).sort((a, b) => a.order - b.order);
}

function sections(lines: StatementLine[]) {
  const map = new Map<string, StatementLine[]>();
  for (const l of lines) {
    const list = map.get(l.section) ?? [];
    list.push(l);
    map.set(l.section, list);
  }
  return Array.from(map.entries()).map(([name, ls]) => ({ name, lines: ls, total: ls.reduce((s, l) => s + l.amount, 0) }));
}

export function balanceSheet(tb: TrialBalance): BalanceSheet {
  const lines = groupLines(tb, 'BS');
  const sec = sections(lines);
  const sum = (names: string[]) => sec.filter((s) => names.includes(s.name)).reduce((t, s) => t + s.total, 0);
  const totalAssets = sum(['Current assets', 'Non-current assets']);
  const totalLiabilities = sum(['Current liabilities']);
  const currentEarnings = tb.rows.filter((r) => r.accountClass === 'revenue' || r.accountClass === 'expense').reduce((s, r) => s - r.net, 0);
  const equityLines = sum(['Equity']);
  const totalEquity = equityLines + currentEarnings;
  return {
    currency: tb.currency,
    label: tb.label,
    periodName: tb.periodName,
    sections: sec,
    totalAssets,
    totalLiabilities,
    totalEquity,
    currentEarnings,
    balances: totalAssets === totalLiabilities + totalEquity,
  };
}

export function incomeStatement(tb: TrialBalance): IncomeStatement {
  const lines = groupLines(tb, 'IS');
  const sec = sections(lines);
  const total = (name: string) => sec.find((s) => s.name === name)?.total ?? 0;
  const revenue = total('Revenue');
  const costOfRevenue = total('Cost of revenue');
  const operatingExpenses = total('Operating expenses');
  const intercompany = total('Intercompany');
  const otherIncome = total('Other income (expense)');
  const grossProfit = revenue - costOfRevenue;
  const operatingIncome = grossProfit - operatingExpenses;
  return {
    currency: tb.currency,
    label: tb.label,
    periodName: tb.periodName,
    sections: sec,
    revenue,
    costOfRevenue,
    grossProfit,
    operatingExpenses,
    operatingIncome,
    intercompany,
    otherIncome,
    netIncome: operatingIncome + intercompany + otherIncome,
  };
}
