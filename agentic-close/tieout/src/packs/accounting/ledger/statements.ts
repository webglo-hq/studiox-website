/**
 * Financial statements from the ledger: per entity (functional currency) and consolidated
 * (reporting currency) with ASC 830 translation — balance sheet at closing rate, P&L at monthly
 * average rates, equity at historical rates — CTA as the plug, plus posted eliminations.
 */
import { periodEnd, periodKeyOf, periodRange, shiftPeriod } from '../../../core/util/time';
import type { AccountRow, DbTx, FsLineItemRow } from '../../../schema';
import type { StatementLine } from '../model/types';
import { fxRate } from '../fx/rates';
import { activityByPeriod, balancesAsOf, type BalanceMap } from './balances';
import type { Chart } from './chart';
import { convert } from './money';

const FUNCTION_BY_DEPT: Record<string, string> = { RND: 'IS.OPEX.RD', SALES: 'IS.OPEX.SM', MKTG: 'IS.OPEX.SM', GA: 'IS.OPEX.GA', OPS: 'IS.OPEX.GA', CS: 'IS.OPEX.GA' };
const BS_SECTIONS = ['Current assets', 'Non-current assets', 'Current liabilities', 'Non-current liabilities', 'Equity'] as const;

export interface StatementSet {
  currency: string;
  balanceSheet: StatementLine[];
  incomeStatement: StatementLine[];
  netIncomeMinor: number;
  checks: { balanced: boolean; differenceMinor: number };
}

const isPnl = (a: AccountRow) => a.account_class === 'revenue' || a.account_class === 'expense';
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

function isLines(chart: Chart, fsLines: readonly FsLineItemRow[], rows: readonly PnlRow[], prior?: readonly PnlRow[]): { lines: StatementLine[]; netIncome: number } {
  const bucket = (rs: readonly PnlRow[]) => {
    const m = new Map<string, number>();
    for (const r of rs) {
      const a = chart.byId.get(r.accountId);
      if (!a || !isPnl(a) || !a.fs_line_id) continue;
      const fs = fsLines.find((f) => f.id === a.fs_line_id);
      let code = fs?.code ?? 'IS.OTHER';
      if (code.startsWith('IS.OPEX')) code = FUNCTION_BY_DEPT[r.department ?? ''] ?? code;
      const v = a.account_class === 'revenue' ? -r.netMinor : r.netMinor;
      m.set(code, (m.get(code) ?? 0) + v);
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
  const other = line('IS.OTHER', 'Other', false, undefined, undefined, [-get(cur, 'IS.OTHER'), -get(pri, 'IS.OTHER')]);
  const pti = line('IS.T.PTI', 'Other', true, 'Income (loss) before income taxes', 'us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', [oi[0] + other[0], oi[1] + other[1]]);
  const tax = line('IS.TAX', 'Other');
  const ni = line('IS.T.NI', 'Net income', true, 'Net income (loss)', 'us-gaap:NetIncomeLoss', [pti[0] - tax[0], pti[1] - tax[1]]);
  return { lines, netIncome: ni[0] };
}

async function pnlRows(tx: DbTx, entityIds: readonly string[], fromDate: string, toDate: string): Promise<PnlRow[]> {
  const rows = await tx.sumLines({ entityIds, fromDate, toDate, groupBy: ['account_id', 'department'] });
  return rows.map((r) => ({ accountId: r.account_id!, department: r.department ?? null, netMinor: r.debit_minor - r.credit_minor }));
}

/** Statements for one entity in its functional currency: BS at period end (vs prior period end), IS for the month (vs prior month). */
export async function entityStatements(tx: DbTx, chart: Chart, entityId: string, periodKey: string): Promise<StatementSet> {
  const fsLines = await tx.find('fs_line_items', {});
  const prior = shiftPeriod(periodKey, -1);
  const [bal, balPrior] = await Promise.all([balancesAsOf(tx, [entityId], periodEnd(periodKey)), balancesAsOf(tx, [entityId], periodEnd(prior))]);
  const bs = bsLines(chart, fsLines, bal, balPrior);
  const [cur, pri] = await Promise.all([pnlRows(tx, [entityId], `${periodKey}-01`, periodEnd(periodKey)), pnlRows(tx, [entityId], `${prior}-01`, periodEnd(prior))]);
  const is = isLines(chart, fsLines, cur, pri);
  return { currency: chart.entity(entityId).functional_currency, balanceSheet: bs.lines, incomeStatement: is.lines, netIncomeMinor: is.netIncome, checks: { balanced: bs.diff === 0, differenceMinor: bs.diff } };
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
  // Consolidated P&L for the month: translated monthly activity at the month's average rate
  const rows: PnlRow[] = [];
  for (const e of chart.entities) {
    const r = await pnlRows(tx, [e.id], `${periodKey}-01`, periodEnd(periodKey));
    const rate = await fxRate(tx, e.functional_currency, reporting, periodEnd(periodKey), 'average');
    for (const x of r) rows.push({ ...x, netMinor: convert(x.netMinor, rate) });
  }
  const is = isLines(chart, fsLines, rows);
  return { currency: reporting, balanceSheet: bs.lines, incomeStatement: is.lines, netIncomeMinor: is.netIncome, checks: { balanced: Math.abs(bs.diff) <= 1, differenceMinor: bs.diff }, ctaMinor: cta, eliminationsMinor: elim, closingRate: closing, averageRate: average, translated };
}

export { periodKeyOf };
