import { addMonths, periodEnd, periodRange } from '../../../framework/util/dates';
import { convertCents } from '../../../framework/util/money';
import { closeOntology } from '../ontology';
import type { ServiceContext } from './context';
import { ledgerBalances } from './queries';
import { accounts, entities, fxRate, operatingEntities, tenantRow, type AccountRow } from './refdata';

export interface TbRow {
  accountId: string;
  code: string;
  name: string;
  accountClass: AccountRow['account_class'];
  accountType: string;
  normalBalance: 'debit' | 'credit';
  fsLineItemId: string;
  debit: number;
  credit: number;
  /** debit − credit */
  net: number;
}

export interface TrialBalance {
  scope: { kind: 'entity'; entityId: string } | { kind: 'consolidated' };
  periodKey: string;
  asOf: string;
  currency: string;
  rows: TbRow[];
  totals: { debit: number; credit: number };
  balanced: boolean;
  /** Present for consolidated TBs */
  translation?: { entityCode: string; closingRate: number; averageRateNote: string; cta: number }[];
}

function fiscalYearStart(periodKey: string): string {
  return `${periodKey.slice(0, 4)}-01`;
}

function isIncomeStatement(a: AccountRow): boolean {
  return a.account_class === 'revenue' || a.account_class === 'expense';
}

/**
 * Entity trial balance in functional currency as of period end. Balance-sheet accounts are
 * cumulative; income-statement accounts are year-to-date; prior years' income is presented
 * within retained earnings (virtual year-end close), so the TB always nets to zero.
 */
export async function trialBalance(ctx: ServiceContext, entityId: string, periodKey: string): Promise<TrialBalance> {
  const [acctMap, entMap] = await Promise.all([accounts(ctx), entities(ctx)]);
  const entity = entMap.get(entityId);
  const rows = await ctx.db.query(ledgerBalances, { tenantId: ctx.tenantId, entityIds: [entityId], periodTo: periodKey, byPeriod: true });
  const fyStart = fiscalYearStart(periodKey);
  const agg = new Map<string, { debit: number; credit: number }>();
  let priorYearsIncome = 0; // debit − credit of IS accounts before FY start
  for (const r of rows) {
    const a = acctMap.get(r.accountId);
    if (!a) continue;
    if (isIncomeStatement(a) && (r.periodKey ?? '') < fyStart) {
      priorYearsIncome += r.debit - r.credit;
      continue;
    }
    const cur = agg.get(a.id) ?? { debit: 0, credit: 0 };
    cur.debit += r.debit;
    cur.credit += r.credit;
    agg.set(a.id, cur);
  }
  if (priorYearsIncome !== 0) {
    const re = [...acctMap.values()].find((a) => a.account_type === 'ek:RetainedEarningsAccount');
    if (re) {
      const cur = agg.get(re.id) ?? { debit: 0, credit: 0 };
      if (priorYearsIncome > 0) cur.debit += priorYearsIncome;
      else cur.credit += -priorYearsIncome;
      agg.set(re.id, cur);
    }
  }
  const tbRows = toRows(acctMap, agg);
  const totals = sumTotals(tbRows);
  return {
    scope: { kind: 'entity', entityId },
    periodKey,
    asOf: periodEnd(periodKey),
    currency: entity?.functional_currency ?? 'USD',
    rows: tbRows,
    totals,
    balanced: totals.debit === totals.credit,
  };
}

function toRows(acctMap: Map<string, AccountRow>, agg: Map<string, { debit: number; credit: number }>): TbRow[] {
  const out: TbRow[] = [];
  for (const [id, v] of agg) {
    const a = acctMap.get(id)!;
    const net = v.debit - v.credit;
    if (net === 0 && v.debit === 0) continue;
    out.push({
      accountId: id,
      code: a.code,
      name: a.name,
      accountClass: a.account_class,
      accountType: a.account_type,
      normalBalance: a.normal_balance,
      fsLineItemId: a.fs_line_item_id,
      // Present each account's net on one side, like a classic TB
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
      net,
    });
  }
  return out.sort((x, y) => x.code.localeCompare(y.code));
}

function sumTotals(rows: TbRow[]): { debit: number; credit: number } {
  return rows.reduce((t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }), { debit: 0, credit: 0 });
}

const HISTORICAL_EQUITY_TYPES = new Set(['ek:EquityAccount']);

/**
 * Consolidated TB in the reporting currency (ASC 830 translation + ASC 810 eliminations):
 * monetary and other balance-sheet items at the closing rate, income statement at monthly
 * average rates, contributed equity at historical rates, and the CTA as the balancing figure.
 */
export async function consolidatedTrialBalance(ctx: ServiceContext, periodKey: string): Promise<TrialBalance> {
  const tenant = await tenantRow(ctx);
  const reporting = tenant.reporting_currency;
  const acctMap = await accounts(ctx);
  const entMap = await entities(ctx);
  const agg = new Map<string, { debit: number; credit: number }>();
  const translation: NonNullable<TrialBalance['translation']> = [];
  const add = (accountId: string, net: number) => {
    const cur = agg.get(accountId) ?? { debit: 0, credit: 0 };
    if (net > 0) cur.debit += net;
    else cur.credit += -net;
    agg.set(accountId, cur);
  };
  const cta = [...acctMap.values()].find((a) => a.account_type === 'ek:CtaAccount');
  const fyStart = fiscalYearStart(periodKey);

  for (const ent of await operatingEntities(ctx)) {
    if (ent.functional_currency === reporting) {
      const tb = await trialBalance(ctx, ent.id, periodKey);
      for (const r of tb.rows) add(r.accountId, r.net);
      continue;
    }
    const closing = await fxRate(ctx, ent.functional_currency, reporting, periodEnd(periodKey), 'closing');
    const historical = await fxRate(ctx, ent.functional_currency, reporting, periodEnd(periodKey), 'historical').catch(() => closing);
    // Income statement YTD by month at average rates; balance sheet at closing/historical.
    const monthly = await ctx.db.query(ledgerBalances, { tenantId: ctx.tenantId, entityIds: [ent.id], periodTo: periodKey, byPeriod: true });
    let translatedNet = 0;
    const avgCache = new Map<string, number>();
    for (const r of monthly) {
      const a = acctMap.get(r.accountId);
      if (!a) continue;
      const net = r.debit - r.credit;
      let rate: number;
      let accountId = a.id;
      if (isIncomeStatement(a)) {
        const pk = r.periodKey ?? periodKey;
        if (!avgCache.has(pk)) avgCache.set(pk, await fxRate(ctx, ent.functional_currency, reporting, periodEnd(pk), 'average'));
        rate = avgCache.get(pk)!;
        if (pk < fyStart) {
          const re = [...acctMap.values()].find((x) => x.account_type === 'ek:RetainedEarningsAccount');
          if (re) accountId = re.id;
        }
      } else if (HISTORICAL_EQUITY_TYPES.has(a.account_type)) {
        rate = historical;
      } else {
        rate = closing;
      }
      const t = convertCents(net, rate);
      translatedNet += t;
      add(accountId, t);
    }
    if (translatedNet !== 0 && cta) add(cta.id, -translatedNet);
    translation.push({ entityCode: ent.code, closingRate: closing, averageRateNote: 'monthly average rates for income statement', cta: -translatedNet });
  }
  // Eliminations (already in reporting currency)
  for (const ent of entMap.values()) {
    if (!ent.is_elimination) continue;
    const tb = await trialBalance(ctx, ent.id, periodKey);
    for (const r of tb.rows) add(r.accountId, r.net);
  }
  const rows = toRows(acctMap, agg);
  const totals = sumTotals(rows);
  return { scope: { kind: 'consolidated' }, periodKey, asOf: periodEnd(periodKey), currency: reporting, rows, totals, balanced: totals.debit === totals.credit, translation };
}

export interface StatementLine {
  fsLineItemId: string;
  code: string;
  label: string;
  section: string;
  xbrl: string | null;
  amount: number;
  comparison?: number;
  accounts: { accountId: string; code: string; name: string; amount: number }[];
}

export interface Statement {
  kind: 'BS' | 'IS';
  title: string;
  periodKey: string;
  currency: string;
  sections: { name: string; lines: StatementLine[]; total: number; comparisonTotal?: number }[];
  subtotals: { label: string; amount: number; comparison?: number }[];
  check: { label: string; ok: boolean; detail: string };
}

/** Build a balance sheet or income statement from a TB using fs_line_item mappings. */
export async function buildStatement(ctx: ServiceContext, kind: 'BS' | 'IS', tb: TrialBalance, comparisonTb?: TrialBalance): Promise<Statement> {
  const items = await ctx.db.find('fs_line_item', { tenant_id: ctx.tenantId, statement: kind }, { orderBy: [['sort_order', 'asc']] });
  const signed = (net: number, sign: 'debit' | 'credit') => (sign === 'debit' ? net : -net);
  const compByAccount = new Map((comparisonTb?.rows ?? []).map((r) => [r.accountId, r.net]));
  // IS for a single month: use period activity rather than YTD
  const lines: StatementLine[] = items.map((it) => {
    const accs = tb.rows.filter((r) => r.fsLineItemId === it.id);
    const compAccs = (comparisonTb?.rows ?? []).filter((r) => r.fsLineItemId === it.id);
    return {
      fsLineItemId: it.id,
      code: it.code,
      label: it.label,
      section: it.section,
      xbrl: it.xbrl_element,
      amount: accs.reduce((s, r) => s + signed(r.net, it.sign), 0),
      comparison: comparisonTb ? compAccs.reduce((s, r) => s + signed(r.net, it.sign), 0) : undefined,
      accounts: accs.map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, amount: signed(r.net, it.sign) })),
    };
  });
  void compByAccount;
  const sectionNames = [...new Set(items.map((i) => i.section))];
  const sections = sectionNames.map((name) => {
    const ls = lines.filter((l) => l.section === name && (l.amount !== 0 || (l.comparison ?? 0) !== 0));
    return { name, lines: ls, total: ls.reduce((s, l) => s + l.amount, 0), comparisonTotal: comparisonTb ? ls.reduce((s, l) => s + (l.comparison ?? 0), 0) : undefined };
  });
  const sec = (n: string, comp = false) => sections.filter((s) => s.name.startsWith(n)).reduce((t, s) => t + ((comp ? s.comparisonTotal : s.total) ?? 0), 0);
  if (kind === 'BS') {
    const assets = sec('Assets');
    const liabilities = sec('Liabilities');
    const equity = sec('Equity');
    // Current-year earnings close into equity for presentation
    const ytdIncome = -tb.rows.filter((r) => r.accountClass === 'revenue' || r.accountClass === 'expense').reduce((s, r) => s + r.net, 0);
    const ytdIncomeComp = comparisonTb ? -comparisonTb.rows.filter((r) => r.accountClass === 'revenue' || r.accountClass === 'expense').reduce((s, r) => s + r.net, 0) : undefined;
    const eqSection = sections.find((s) => s.name.startsWith('Equity'));
    if (eqSection) {
      eqSection.lines.push({ fsLineItemId: 'current-year-earnings', code: 'BS-CYE', label: 'Current-year earnings', section: eqSection.name, xbrl: 'us-gaap:NetIncomeLoss', amount: ytdIncome, comparison: ytdIncomeComp, accounts: [] });
      eqSection.total += ytdIncome;
      if (eqSection.comparisonTotal !== undefined && ytdIncomeComp !== undefined) eqSection.comparisonTotal += ytdIncomeComp;
    }
    const totalLe = liabilities + equity + ytdIncome;
    return {
      kind,
      title: 'Balance sheet',
      periodKey: tb.periodKey,
      currency: tb.currency,
      sections,
      subtotals: [
        { label: 'Total assets', amount: assets, comparison: comparisonTb ? sec('Assets', true) : undefined },
        { label: 'Total liabilities', amount: liabilities, comparison: comparisonTb ? sec('Liabilities', true) : undefined },
        { label: 'Total liabilities and equity', amount: totalLe, comparison: comparisonTb ? sec('Liabilities', true) + sec('Equity', true) + (ytdIncomeComp ?? 0) : undefined },
      ],
      check: { label: 'Assets = Liabilities + Equity', ok: assets === totalLe, detail: `difference ${assets - totalLe}` },
    };
  }
  const revenue = sec('Revenue');
  const cogs = sec('Cost of revenue');
  const opex = sec('Operating expenses');
  const other = sec('Other');
  const tax = sec('Income tax');
  const net = revenue - cogs - opex + other - tax;
  const c = (n: string) => (comparisonTb ? sec(n, true) : undefined);
  const ni = -tb.rows.filter((r) => r.accountClass === 'revenue' || r.accountClass === 'expense').reduce((s, r) => s + r.net, 0);
  return {
    kind,
    title: 'Income statement',
    periodKey: tb.periodKey,
    currency: tb.currency,
    sections,
    subtotals: [
      { label: 'Gross profit', amount: revenue - cogs, comparison: comparisonTb ? c('Revenue')! - c('Cost of revenue')! : undefined },
      { label: 'Operating income', amount: revenue - cogs - opex, comparison: comparisonTb ? c('Revenue')! - c('Cost of revenue')! - c('Operating expenses')! : undefined },
      { label: 'Net income', amount: net, comparison: comparisonTb ? c('Revenue')! - c('Cost of revenue')! - c('Operating expenses')! + c('Other')! - c('Income tax')! : undefined },
    ],
    check: { label: 'Net income ties to the ledger', ok: ni === net, detail: `ledger ${ni}, statement ${net}` },
  };
}

/** Income-statement TB for a single month (activity only), used for monthly P&L and flux. */
export async function periodActivity(ctx: ServiceContext, entityIds: string[], periodKey: string): Promise<Map<string, number>> {
  const rows = await ctx.db.query(ledgerBalances, { tenantId: ctx.tenantId, entityIds, periodFrom: periodKey, periodTo: periodKey });
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.accountId, (out.get(r.accountId) ?? 0) + r.debit - r.credit);
  return out;
}

export async function monthlyIncomeTb(ctx: ServiceContext, entityId: string, periodKey: string): Promise<TrialBalance> {
  const acctMap = await accounts(ctx);
  const act = await periodActivity(ctx, [entityId], periodKey);
  const agg = new Map<string, { debit: number; credit: number }>();
  for (const [id, net] of act) {
    const a = acctMap.get(id);
    if (!a || !isIncomeStatement(a)) continue;
    agg.set(id, { debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  }
  const rows = toRows(acctMap, agg);
  const ent = (await entities(ctx)).get(entityId);
  return { scope: { kind: 'entity', entityId }, periodKey, asOf: periodEnd(periodKey), currency: ent?.functional_currency ?? 'USD', rows, totals: sumTotals(rows), balanced: true };
}

export function validateTrialBalance(tb: TrialBalance) {
  return closeOntology().validate('ek:TrialBalance', { rows: tb.rows.map((r) => ({ accountClass: r.accountClass, debit: r.debit, credit: r.credit })) }, {});
}

export function trailingPeriods(periodKey: string, n: number): string[] {
  return periodRange(addMonths(periodKey, -(n - 1)), periodKey);
}
