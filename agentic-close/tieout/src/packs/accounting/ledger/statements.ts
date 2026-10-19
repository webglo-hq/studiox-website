/**
 * Financial statements from the ledger: per entity (functional currency) and consolidated
 * (reporting currency) with ASC 830 translation — balance sheet at closing rate, P&L at monthly
 * average rates, equity at historical rates — CTA as the plug, plus posted eliminations.
 *
 * Every income statement ties to the ledger (AX-FS-01): its net income must equal the income and
 * expenses posted in the period, or the statement is refused rather than shown.
 */
import { invariant } from '../../../core/util/errors';
import { periodEnd, periodKeyOf, periodLabel, periodRange, shiftPeriod } from '../../../core/util/time';
import type { AccountRow, DbTx, FsLineItemRow } from '../../../schema';
import type { StatementLine } from '../model/types';
import { closeOntology } from '../ontology';
import { fxRate } from '../fx/rates';
import { activityByPeriod, balancesAsOf, NOT_PERIOD_ACTIVITY, type BalanceMap } from './balances';
import type { Chart } from './chart';
import { convert } from './money';

const FUNCTION_BY_DEPT: Record<string, string> = { RND: 'IS.OPEX.RD', SALES: 'IS.OPEX.SM', MKTG: 'IS.OPEX.SM', GA: 'IS.OPEX.GA', OPS: 'IS.OPEX.GA', CS: 'IS.OPEX.GA' };
const BS_SECTIONS = ['Current assets', 'Non-current assets', 'Current liabilities', 'Non-current liabilities', 'Equity'] as const;

export interface StatementSet {
  currency: string;
  balanceSheet: StatementLine[];
  incomeStatement: StatementLine[];
  netIncomeMinor: number;
  /** net income per the ledger (AX-FS-01); a statement is only returned when it equals netIncomeMinor */
  ledgerNetIncomeMinor: number;
  checks: { balanced: boolean; differenceMinor: number };
}

const isPnl = (a: AccountRow) => a.account_class === 'revenue' || a.account_class === 'expense';
/**
 * Income-statement captions shown credit-positive: revenue and "Other income (expense), net".
 * Every other caption is a cost, shown debit-positive. The caption decides the sign, not the
 * account class, so however accounts are mapped to captions net income stays intact.
 */
const isIncomeCaption = (code: string) => code.startsWith('IS.REV') || code === 'IS.OTHER';
/** Positive = in the account's presentation direction (assets/expenses debit; others credit). */
const presented = (a: AccountRow, net: number) => (a.account_class === 'asset' || a.account_class === 'expense' ? net : -net);

function bsLines(chart: Chart, fsLines: readonly FsLineItemRow[], balances: BalanceMap, prior?: BalanceMap): { lines: StatementLine[]; diff: number; netIncome: number } {
  const byLine = new Map<string, { cur: number; pri: number }>();
  let netIncome = 0;
  let netIncomePrior = 0;
  for (const a of chart.accounts) {
    const cur = balances.get(a.id)?.netMinor ?? 0;
    const pri = prior?.get(a.id)?.netMinor ?? 0;
    if (isPnl(a)) {
      netIncome -= cur;
      netIncomePrior -= pri;
      continue;
    }
    if (!a.fs_line_id) continue;
    const agg = byLine.get(a.fs_line_id) ?? { cur: 0, pri: 0 };
    agg.cur += presented(a, cur);
    agg.pri += presented(a, pri);
    byLine.set(a.fs_line_id, agg);
  }
  const lines: StatementLine[] = [];
  const totals: Record<string, { cur: number; pri: number }> = {};
  for (const section of BS_SECTIONS) {
    const rows = fsLines.filter((f) => f.statement === 'BS' && f.section === section).sort((x, y) => x.sort_order - y.sort_order);
    let cur = 0;
    let pri = 0;
    for (const f of rows) {
      const v = byLine.get(f.id) ?? { cur: 0, pri: 0 };
      if (v.cur === 0 && v.pri === 0) continue;
      lines.push({ code: f.code, label: f.label, section, amountMinor: v.cur, priorMinor: v.pri, xbrl: f.xbrl_concept, level: 1 });
      cur += v.cur;
      pri += v.pri;
    }
    if (section === 'Equity') {
      lines.push({ code: 'BS.EQ.NI', label: 'Net income, year to date', section, amountMinor: netIncome, priorMinor: netIncomePrior, xbrl: 'us-gaap:NetIncomeLoss', level: 1 });
      cur += netIncome;
      pri += netIncomePrior;
    }
    totals[section] = { cur, pri };
    lines.push({ code: `BS.T.${section.replace(/\W+/g, '').toUpperCase()}`, label: `Total ${section.toLowerCase()}`, section, amountMinor: cur, priorMinor: pri, level: 0, isTotal: true });
    if (section === 'Non-current assets') {
      const t = { cur: totals['Current assets']!.cur + cur, pri: totals['Current assets']!.pri + pri };
      totals.assets = t;
      lines.push({ code: 'BS.T.ASSETS', label: 'Total assets', section, amountMinor: t.cur, priorMinor: t.pri, xbrl: 'us-gaap:Assets', level: 0, isTotal: true });
    }
    if (section === 'Non-current liabilities') {
      const t = { cur: totals['Current liabilities']!.cur + cur, pri: totals['Current liabilities']!.pri + pri };
      totals.liabilities = t;
      lines.push({ code: 'BS.T.LIABILITIES', label: 'Total liabilities', section, amountMinor: t.cur, priorMinor: t.pri, xbrl: 'us-gaap:Liabilities', level: 0, isTotal: true });
    }
  }
  const le = { cur: totals.liabilities!.cur + totals.Equity!.cur, pri: totals.liabilities!.pri + totals.Equity!.pri };
  lines.push({ code: 'BS.T.LE', label: 'Total liabilities and equity', section: 'Equity', amountMinor: le.cur, priorMinor: le.pri, xbrl: 'us-gaap:LiabilitiesAndStockholdersEquity', level: 0, isTotal: true });
  return { lines, diff: totals.assets!.cur - le.cur, netIncome };
}

interface PnlRow {
  accountId: string;
  department: string | null;
  netMinor: number;
}

function isLines(chart: Chart, fsLines: readonly FsLineItemRow[], rows: readonly PnlRow[], prior?: readonly PnlRow[]): { lines: StatementLine[]; netIncome: number; netIncomePrior: number } {
  const bucket = (rs: readonly PnlRow[]) => {
    const m = new Map<string, number>();
    for (const r of rs) {
      const a = chart.byId.get(r.accountId);
      if (!a || !isPnl(a) || !a.fs_line_id) continue;
      const fs = fsLines.find((f) => f.id === a.fs_line_id);
      let code = fs?.code ?? 'IS.OTHER';
      if (code.startsWith('IS.OPEX')) code = FUNCTION_BY_DEPT[r.department ?? ''] ?? code;
      m.set(code, (m.get(code) ?? 0) + (isIncomeCaption(code) ? -r.netMinor : r.netMinor));
    }
    return m;
  };
  const cur = bucket(rows);
  const pri = prior ? bucket(prior) : new Map<string, number>();
  const get = (m: Map<string, number>, code: string) => m.get(code) ?? 0;
  const fsByCode = new Map(fsLines.map((f) => [f.code, f]));
  const lines: StatementLine[] = [];
  const line = (code: string, section: string, isTotal = false, label?: string, xbrl?: string, value?: [number, number]) => {
    const f = fsByCode.get(code);
    const [c, p] = value ?? [get(cur, code), get(pri, code)];
    lines.push({ code, label: label ?? f?.label ?? code, section, amountMinor: c, priorMinor: p, ...(xbrl || f ? { xbrl: xbrl ?? f!.xbrl_concept } : {}), level: isTotal ? 0 : 1, ...(isTotal ? { isTotal } : {}) });
    return [c, p] as [number, number];
  };
  const sumCodes = (codes: string[]): [number, number] => [codes.reduce((s, c) => s + get(cur, c), 0), codes.reduce((s, c) => s + get(pri, c), 0)];
  const revCodes = ['IS.REV.SUB', 'IS.REV.HW', 'IS.REV.SVC', 'IS.REV.IC'].filter((c) => cur.has(c) || pri.has(c));
  for (const c of revCodes) line(c, 'Revenue');
  const rev = line('IS.T.REV', 'Revenue', true, 'Total revenue', 'us-gaap:Revenues', sumCodes(revCodes));
  const cor = line('IS.COR', 'Cost of revenue');
  const gp = line('IS.T.GP', 'Gross profit', true, 'Gross profit', 'us-gaap:GrossProfit', [rev[0] - cor[0], rev[1] - cor[1]]);
  const opexCodes = ['IS.OPEX.RD', 'IS.OPEX.SM', 'IS.OPEX.GA'];
  for (const c of opexCodes) line(c, 'Operating expenses');
  const opex = line('IS.T.OPEX', 'Operating expenses', true, 'Total operating expenses', 'us-gaap:OperatingExpenses', sumCodes(opexCodes));
  const oi = line('IS.T.OI', 'Operating income', true, 'Operating income (loss)', 'us-gaap:OperatingIncomeLoss', [gp[0] - opex[0], gp[1] - opex[1]]);
  const other = line('IS.OTHER', 'Other');
  const pti = line('IS.T.PTI', 'Other', true, 'Income (loss) before income taxes', 'us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', [oi[0] + other[0], oi[1] + other[1]]);
  const tax = line('IS.TAX', 'Other');
  const ni = line('IS.T.NI', 'Net income', true, 'Net income (loss)', 'us-gaap:NetIncomeLoss', [pti[0] - tax[0], pti[1] - tax[1]]);
  return { lines, netIncome: ni[0], netIncomePrior: ni[1] };
}

/** The month's income and expense activity by account and department (closing entries excluded). */
async function pnlRows(tx: DbTx, entityIds: readonly string[], fromDate: string, toDate: string): Promise<PnlRow[]> {
  const rows = await tx.sumLines({ entityIds, fromDate, toDate, groupBy: ['account_id', 'department'], excludeEntryTypes: NOT_PERIOD_ACTIVITY });
  return rows.map((r) => ({ accountId: r.account_id!, department: r.department ?? null, netMinor: r.debit_minor - r.credit_minor }));
}

/** Net income straight from the ledger, by its own query: −Σ(debit − credit) over income and expense accounts. */
async function ledgerNetIncome(tx: DbTx, chart: Chart, entityIds: readonly string[], periodKey: string): Promise<number> {
  const rows = await tx.sumLines({ entityIds, fromDate: `${periodKey}-01`, toDate: periodEnd(periodKey), groupBy: ['account_id'], excludeEntryTypes: NOT_PERIOD_ACTIVITY });
  return rows.reduce((s, r) => (isPnl(chart.account(r.account_id!)) ? s - (r.debit_minor - r.credit_minor) : s), 0);
}

/** AX-FS-01: refuse an income statement whose net income differs from the ledger's. */
function assertTies(statement: string, netIncomeMinor: number, ledgerNetIncomeMinor: number) {
  const r = closeOntology().check('AX-FS-01', { statement, netIncomeMinor, ledgerNetIncomeMinor });
  if (!r.passed) throw invariant('AX-FS-01', r.messages.join('; '), { statement, netIncomeMinor, ledgerNetIncomeMinor });
}

interface IncomeStatement {
  lines: StatementLine[];
  netIncomeMinor: number;
  ledgerNetIncomeMinor: number;
}

/** One entity's income statement for the month (vs the prior month), both columns tied to the ledger. */
async function entityIncomeStatement(tx: DbTx, chart: Chart, fsLines: readonly FsLineItemRow[], entityId: string, periodKey: string): Promise<IncomeStatement> {
  const prior = shiftPeriod(periodKey, -1);
  const [cur, pri] = await Promise.all([pnlRows(tx, [entityId], `${periodKey}-01`, periodEnd(periodKey)), pnlRows(tx, [entityId], `${prior}-01`, periodEnd(prior))]);
  const is = isLines(chart, fsLines, cur, pri);
  const [ledgerCur, ledgerPri] = await Promise.all([ledgerNetIncome(tx, chart, [entityId], periodKey), ledgerNetIncome(tx, chart, [entityId], prior)]);
  const code = chart.entity(entityId).code;
  assertTies(`the ${code} ${periodLabel(periodKey)} income statement`, is.netIncome, ledgerCur);
  assertTies(`the ${code} ${periodLabel(prior)} income statement (prior-month column)`, is.netIncomePrior, ledgerPri);
  return { lines: is.lines, netIncomeMinor: is.netIncome, ledgerNetIncomeMinor: ledgerCur };
}

/**
 * The group's income statement for the month: each entity's activity at the month's average rate.
 * Each entity's activity first ties to its own ledger; the group's ledger figure is then the sum of
 * the same translated amounts, before any caption mapping.
 */
async function consolidatedIncomeStatement(tx: DbTx, chart: Chart, fsLines: readonly FsLineItemRow[], periodKey: string, reporting: string): Promise<IncomeStatement> {
  const rows: PnlRow[] = [];
  let ledgerNi = 0;
  for (const e of chart.entities) {
    const r = await pnlRows(tx, [e.id], `${periodKey}-01`, periodEnd(periodKey));
    const activity = -r.filter((x) => isPnl(chart.account(x.accountId))).reduce((s, x) => s + x.netMinor, 0);
    assertTies(`the ${e.code} ${periodLabel(periodKey)} activity`, activity, await ledgerNetIncome(tx, chart, [e.id], periodKey));
    const rate = await fxRate(tx, e.functional_currency, reporting, periodEnd(periodKey), 'average');
    for (const x of r) {
      const t = { ...x, netMinor: convert(x.netMinor, rate) };
      rows.push(t);
      if (isPnl(chart.account(x.accountId))) ledgerNi -= t.netMinor;
    }
  }
  const is = isLines(chart, fsLines, rows);
  assertTies(`the consolidated ${periodLabel(periodKey)} income statement`, is.netIncome, ledgerNi);
  return { lines: is.lines, netIncomeMinor: is.netIncome, ledgerNetIncomeMinor: ledgerNi };
}

/** Statements for one entity in its functional currency: BS at period end (vs prior period end), IS for the month (vs prior month). */
export async function entityStatements(tx: DbTx, chart: Chart, entityId: string, periodKey: string): Promise<StatementSet> {
  const fsLines = await tx.find('fs_line_items', {});
  const prior = shiftPeriod(periodKey, -1);
  const [bal, balPrior] = await Promise.all([balancesAsOf(tx, [entityId], periodEnd(periodKey)), balancesAsOf(tx, [entityId], periodEnd(prior))]);
  const bs = bsLines(chart, fsLines, bal, balPrior);
  const is = await entityIncomeStatement(tx, chart, fsLines, entityId, periodKey);
  return { currency: chart.entity(entityId).functional_currency, balanceSheet: bs.lines, incomeStatement: is.lines, netIncomeMinor: is.netIncomeMinor, ledgerNetIncomeMinor: is.ledgerNetIncomeMinor, checks: { balanced: bs.diff === 0, differenceMinor: bs.diff } };
}

export interface ConsolidationResult extends StatementSet {
  ctaMinor: number;
  eliminationsMinor: number;
  closingRate: number | null;
  averageRate: number | null;
  translated: { entityCode: string; balances: BalanceMap }[];
}

/**
 * Translate each foreign entity into the reporting currency and add eliminations.
 * BS non-equity @ closing; equity @ historical (period-by-period average, opening @ closing);
 * P&L @ monthly averages; CTA balances the translated trial balance (AX-FX-02).
 */
export async function translateEntity(tx: DbTx, chart: Chart, entityId: string, periodKey: string, reporting: string): Promise<{ balances: BalanceMap; ctaMinor: number; closingRate: number; averageRate: number }> {
  const entity = chart.entity(entityId);
  const fc = entity.functional_currency;
  const end = periodEnd(periodKey);
  const closingRate = await fxRate(tx, fc, reporting, end, 'closing');
  const averageRate = await fxRate(tx, fc, reporting, end, 'average');
  const out: BalanceMap = new Map();
  const add = (accountId: string, net: number) => {
    const b = out.get(accountId) ?? { debitMinor: 0, creditMinor: 0, netMinor: 0 };
    b.netMinor += net;
    b.debitMinor = Math.max(b.netMinor, 0);
    b.creditMinor = Math.max(-b.netMinor, 0);
    out.set(accountId, b);
  };
  if (fc === reporting) {
    const bal = await balancesAsOf(tx, [entityId], end);
    for (const [id, b] of bal) add(id, b.netMinor);
    return { balances: out, ctaMinor: 0, closingRate: 1, averageRate: 1 };
  }
  const bal = await balancesAsOf(tx, [entityId], end);
  for (const [id, b] of bal) {
    const a = chart.byId.get(id)!;
    if (a.account_class === 'asset' || a.account_class === 'liability') add(id, convert(b.netMinor, closingRate));
  }
  // Equity and P&L: period-by-period history (equity at historical, P&L at average rates).
  const firstPeriod = (await tx.find('periods', { entity_id: entityId }, { orderBy: [['period_key', 'asc']], limit: 1 }))[0]?.period_key ?? periodKey;
  const byPeriod = await activityByPeriod(tx, [entityId], firstPeriod, periodKey);
  const fyStart = `${periodKey.slice(0, 4)}-01`;
  for (const pk of periodRange(firstPeriod, periodKey)) {
    const m = byPeriod.get(pk);
    if (!m) continue;
    const rate = pk === firstPeriod ? await fxRate(tx, fc, reporting, periodEnd(pk), 'closing') : await fxRate(tx, fc, reporting, periodEnd(pk), 'average');
    for (const [id, net] of m) {
      const a = chart.byId.get(id)!;
      // Equity at historical rates since inception; P&L only for the current fiscal year (prior years
      // were closed into retained earnings, which carries them at their historical rates).
      if (a.account_class === 'equity' || (isPnl(a) && pk >= fyStart)) add(id, convert(net, rate));
    }
  }
  let sum = 0;
  for (const b of out.values()) sum += b.netMinor;
  const cta = chart.tryAccount('3300');
  if (cta && sum !== 0) add(cta.id, -sum);
  return { balances: out, ctaMinor: -sum, closingRate, averageRate };
}

export async function consolidatedStatements(tx: DbTx, chart: Chart, periodKey: string, reporting = 'USD'): Promise<ConsolidationResult> {
  const fsLines = await tx.find('fs_line_items', {});
  const total: BalanceMap = new Map();
  const translated: ConsolidationResult['translated'] = [];
  let cta = 0;
  let closing: number | null = null;
  let average: number | null = null;
  let elim = 0;
  for (const e of chart.entities) {
    const t = await translateEntity(tx, chart, e.id, periodKey, reporting);
    translated.push({ entityCode: e.code, balances: t.balances });
    if (e.functional_currency !== reporting) {
      cta += t.ctaMinor;
      closing = t.closingRate;
      average = t.averageRate;
    }
    if (e.kind === 'elimination') for (const b of t.balances.values()) elim += Math.max(b.netMinor, 0);
    for (const [id, b] of t.balances) {
      const cur = total.get(id) ?? { debitMinor: 0, creditMinor: 0, netMinor: 0 };
      cur.netMinor += b.netMinor;
      cur.debitMinor = Math.max(cur.netMinor, 0);
      cur.creditMinor = Math.max(-cur.netMinor, 0);
      total.set(id, cur);
    }
  }
  const bs = bsLines(chart, fsLines, total);
  const is = await consolidatedIncomeStatement(tx, chart, fsLines, periodKey, reporting);
  return { currency: reporting, balanceSheet: bs.lines, incomeStatement: is.lines, netIncomeMinor: is.netIncomeMinor, ledgerNetIncomeMinor: is.ledgerNetIncomeMinor, checks: { balanced: Math.abs(bs.diff) <= 1, differenceMinor: bs.diff }, ctaMinor: cta, eliminationsMinor: elim, closingRate: closing, averageRate: average, translated };
}

export interface IncomeStatementTie {
  statement: string;
  entityCode: string | null;
  currency: string;
  netIncomeMinor: number | null;
  ledgerNetIncomeMinor: number | null;
  ties: boolean;
  message: string | null;
}

/**
 * AX-FS-01 for the close gates: the income statement of every entity (the eliminations ledger
 * included) and the consolidated one, for the period. A statement that does not tie is reported
 * here rather than thrown, so the gates can say which one.
 */
export async function incomeStatementTies(tx: DbTx, chart: Chart, periodKey: string, reporting = 'USD'): Promise<IncomeStatementTie[]> {
  const fsLines = await tx.find('fs_line_items', {});
  const out: IncomeStatementTie[] = [];
  const attempt = async (statement: string, entityCode: string | null, currency: string, build: () => Promise<IncomeStatement>) => {
    try {
      const s = await build();
      out.push({ statement, entityCode, currency, netIncomeMinor: s.netIncomeMinor, ledgerNetIncomeMinor: s.ledgerNetIncomeMinor, ties: true, message: null });
    } catch (e) {
      const details = (e as { details?: { axiomId?: string; netIncomeMinor?: number; ledgerNetIncomeMinor?: number } }).details;
      if (details?.axiomId !== 'AX-FS-01') throw e;
      out.push({ statement, entityCode, currency, netIncomeMinor: details.netIncomeMinor ?? null, ledgerNetIncomeMinor: details.ledgerNetIncomeMinor ?? null, ties: false, message: (e as Error).message });
    }
  };
  for (const e of chart.entities) await attempt(`${e.code} income statement`, e.code, e.functional_currency, () => entityIncomeStatement(tx, chart, fsLines, e.id, periodKey));
  await attempt('Consolidated income statement', null, reporting, () => consolidatedIncomeStatement(tx, chart, fsLines, periodKey, reporting));
  return out;
}

export { periodKeyOf };
