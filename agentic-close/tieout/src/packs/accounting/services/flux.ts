/**
 * Flux (variance) analysis: period-over-period and budget-vs-actual for every income-statement
 * account, with variance drivers that add up to the variance exactly (AX-FLX-02 by
 * construction) and pending agent proposals shown as "pending drivers" (not yet in the ledger).
 *
 * Significance (tie:VarianceThreshold): |Δ| ≥ absolute threshold AND |Δ%| ≥ percent threshold,
 * or |Δ| ≥ performance materiality regardless of percentage.
 */
import { periodEnd, periodLabel, periodStart, shiftPeriod } from '../../../core/util/time';
import type { AccountRow, FluxExplanationRow, JournalEntryRow } from '../../../schema';
import { NOT_PERIOD_ACTIVITY } from '../ledger/balances';
import type { FluxDriver } from '../model/types';
import type { AcctContext } from './context';

export interface PendingDriver {
  label: string;
  amountMinor: number;
  proposalId: string;
  proposalRef: string;
  status: string;
}

export interface FluxLineView {
  accountId: string;
  code: string;
  name: string;
  accountClass: AccountRow['account_class'];
  currentMinor: number;
  comparativeMinor: number;
  budgetMinor: number | null;
  varianceMinor: number;
  variancePct: number | null;
  budgetVarianceMinor: number | null;
  exceeds: boolean;
  materiality: 'trivial' | 'below_pm' | 'material';
  drivers: FluxDriver[];
  pending: PendingDriver[];
  explanation: (Pick<FluxExplanationRow, 'id' | 'text' | 'status' | 'author_type' | 'author_id' | 'approved_by' | 'version'> & { proposalId: string | null }) | null;
}

export interface FluxResult {
  entityId: string;
  entityCode: string;
  currency: string;
  periodKey: string;
  comparativeKey: string;
  comparison: 'pop' | 'yoy';
  thresholds: { absMinor: number; pct: number; performanceMinor: number; clearlyTrivialMinor: number };
  lines: FluxLineView[];
  significant: number;
  explained: number;
}

const natural = (a: AccountRow, dr: number, cr: number) => (a.account_class === 'revenue' ? cr - dr : dr - cr);

export class FluxService {
  constructor(private readonly c: AcctContext) {}

  async compute(entityId: string, periodKey: string, opts: { comparison?: 'pop' | 'yoy'; absMinor?: number; pct?: number } = {}): Promise<FluxResult> {
    const chart = await this.c.chart();
    const entity = chart.entity(entityId);
    const m = entity.materiality;
    const comparison = opts.comparison ?? 'pop';
    const compKey = shiftPeriod(periodKey, comparison === 'pop' ? -1 : -12);
    const th = { absMinor: opts.absMinor ?? m.fluxAbsMinor, pct: opts.pct ?? m.fluxPct, performanceMinor: m.performanceMinor, clearlyTrivialMinor: m.clearlyTrivialMinor };
    const pl = chart.accounts.filter((a) => (a.account_class === 'revenue' || a.account_class === 'expense') && a.is_postable);
    const plIds = new Set(pl.map((a) => a.id));
    const [cur, comp] = await Promise.all([this.driverSums(entityId, periodKey, plIds), this.driverSums(entityId, compKey, plIds)]);
    const budget = await this.budgetFor(entityId, periodKey);
    const pending = await this.pendingDrivers(entityId, periodKey);
    const stored = await this.storedExplanations(entityId, periodKey, comparison);
    const lines: FluxLineView[] = [];
    for (const a of pl) {
      const c = cur.get(a.id);
      const p = comp.get(a.id);
      const currentMinor = c ? natural(a, c.dr, c.cr) : 0;
      const comparativeMinor = p ? natural(a, p.dr, p.cr) : 0;
      const b = budget.get(a.id) ?? null;
      if (!currentMinor && !comparativeMinor && !b) continue;
      const varianceMinor = currentMinor - comparativeMinor;
      const variancePct = comparativeMinor !== 0 ? varianceMinor / Math.abs(comparativeMinor) : null;
      const abs = Math.abs(varianceMinor);
      const exceeds = (abs >= th.absMinor && (variancePct === null || Math.abs(variancePct) >= th.pct)) || abs >= th.performanceMinor;
      lines.push({
        accountId: a.id,
        code: a.code,
        name: a.name,
        accountClass: a.account_class,
        currentMinor,
        comparativeMinor,
        budgetMinor: b,
        varianceMinor,
        variancePct: variancePct === null ? null : Math.round(variancePct * 10000) / 10000,
        budgetVarianceMinor: b === null ? null : currentMinor - b,
        exceeds,
        materiality: abs >= th.performanceMinor ? 'material' : abs >= th.clearlyTrivialMinor ? 'below_pm' : 'trivial',
        drivers: drivers(a, c?.byKey ?? new Map(), p?.byKey ?? new Map(), varianceMinor),
        pending: pending.get(a.code) ?? [],
        explanation: stored.get(a.id) ?? null,
      });
    }
    lines.sort((x, y) => Number(y.exceeds) - Number(x.exceeds) || Math.abs(y.varianceMinor) - Math.abs(x.varianceMinor));
    return {
      entityId,
      entityCode: entity.code,
      currency: entity.functional_currency,
      periodKey,
      comparativeKey: compKey,
      comparison,
      thresholds: th,
      lines,
      significant: lines.filter((l) => l.exceeds).length,
      explained: lines.filter((l) => l.exceeds && l.explanation && (l.explanation.status === 'approved' || l.explanation.status === 'submitted')).length,
    };
  }

  /** Activity by account and by driver key for one period (year-end closing entries are not activity). */
  private async driverSums(entityId: string, periodKey: string, accountIds: Set<string>) {
    const headers = await this.c.tx.find('journal_entries', { entity_id: entityId, status: 'posted', entry_type: { notIn: NOT_PERIOD_ACTIVITY }, posting_date: { gte: periodStart(periodKey), lte: periodEnd(periodKey) } });
    const byId = new Map(headers.map((h) => [h.id, h]));
    const bills = new Map((await this.c.tx.find('bills', { entity_id: entityId })).map((b) => [b.bill_number, b]));
    const invoices = new Map((await this.c.tx.find('invoices', { entity_id: entityId, invoice_date: { gte: periodStart(shiftPeriod(periodKey, -1)), lte: periodEnd(periodKey) } })).map((i) => [i.invoice_number, i]));
    const vendors = new Map((await this.c.tx.find('vendors', {})).map((v) => [v.id, v.name]));
    const customers = new Map((await this.c.tx.find('customers', {})).map((c) => [c.id, c.name]));
    const out = new Map<string, { dr: number; cr: number; byKey: Map<string, { label: string; kind: FluxDriver['kind']; net: number; refType?: string; refId?: string }> }>();
    const lines = headers.length ? await this.c.tx.find('journal_lines', { journal_entry_id: { in: headers.map((h) => h.id) } }) : [];
    const reversedIds = headers.map((h) => h.reverses_je_id).filter((x): x is string => !!x);
    const reversed = new Map((reversedIds.length ? await this.c.tx.find('journal_entries', { id: { in: reversedIds } }) : []).map((j) => [j.id, j]));
    for (const l of lines) {
      if (!accountIds.has(l.account_id)) continue;
      const h = byId.get(l.journal_entry_id)!;
      const k = driverKey(h, bills, invoices, vendors, customers, reversed);
      const acc = out.get(l.account_id) ?? { dr: 0, cr: 0, byKey: new Map() };
      acc.dr += l.debit_minor;
      acc.cr += l.credit_minor;
      const d = acc.byKey.get(k.key) ?? { label: k.label, kind: k.kind, net: 0, refType: k.refType, refId: k.refId };
      d.net += l.debit_minor - l.credit_minor;
      acc.byKey.set(k.key, d);
      out.set(l.account_id, acc);
    }
    return out;
  }

  private async budgetFor(entityId: string, periodKey: string): Promise<Map<string, number>> {
    const budgets = await this.c.tx.find('budgets', { entity_id: entityId, kind: 'budget', fiscal_year: Number(periodKey.slice(0, 4)), status: 'approved' });
    const out = new Map<string, number>();
    for (const b of budgets) for (const l of await this.c.tx.find('budget_lines', { budget_id: b.id, period_key: periodKey })) out.set(l.account_id, (out.get(l.account_id) ?? 0) + l.amount_minor);
    return out;
  }

  /** Proposed (not yet posted) journal entries touching P&L accounts in the period. */
  private async pendingDrivers(entityId: string, periodKey: string): Promise<Map<string, PendingDriver[]>> {
    const chart = await this.c.chart();
    const props = await this.c.tx.find('proposals', { entity_id: entityId, period_key: periodKey, kind: 'journal_entry', status: { in: ['pending_approval', 'suggested', 'approved', 'auto_approved'] } });
    const out = new Map<string, PendingDriver[]>();
    for (const p of props) {
      const lines = (p.payload.lines ?? []) as { account: string; debit?: number; credit?: number }[];
      const byAcct = new Map<string, number>();
      for (const l of lines) {
        const a = chart.tryAccount(l.account);
        if (!a || (a.account_class !== 'revenue' && a.account_class !== 'expense')) continue;
        byAcct.set(a.code, (byAcct.get(a.code) ?? 0) + natural(a, l.debit ?? 0, l.credit ?? 0));
      }
      for (const [code, amt] of byAcct) out.set(code, [...(out.get(code) ?? []), { label: p.title, amountMinor: amt, proposalId: p.id, proposalRef: p.ref, status: p.status }]);
    }
    return out;
  }

  private async storedExplanations(entityId: string, periodKey: string, comparison: 'pop' | 'yoy') {
    const out = new Map<string, NonNullable<FluxLineView['explanation']>>();
    const period = await this.c.tx.findOne('periods', { entity_id: entityId, period_key: periodKey });
    if (!period) return out;
    const fa = await this.c.tx.findOne('flux_analyses', { entity_id: entityId, period_id: period.id, comparison });
    if (!fa) return out;
    for (const fl of await this.c.tx.find('flux_lines', { flux_analysis_id: fa.id })) {
      const ex = await this.c.tx.find('flux_explanations', { flux_line_id: fl.id }, { orderBy: [['version', 'desc']], limit: 1 });
      if (ex[0]) out.set(fl.account_id, { id: ex[0].id, text: ex[0].text, status: ex[0].status, author_type: ex[0].author_type, author_id: ex[0].author_id, approved_by: ex[0].approved_by, version: ex[0].version, proposalId: ex[0].proposal_id });
    }
    return out;
  }
}

/** Recurring memo shape without numbers, dates or parentheticals, e.g. "Accrue unpaid payroll days". */
const memoShape = (m: string) => m.replace(/\(.*?\)/g, '').replace(/[0-9]+/g, '').replace(/\s+/g, ' ').replace(/\s+[–-]\s*$/, '').trim();

function driverKey(h: JournalEntryRow, bills: Map<string, { vendor_id: string; id: string }>, invoices: Map<string, { customer_id: string; id: string }>, vendors: Map<string, string>, customers: Map<string, string>, reversed: Map<string, JournalEntryRow>): { key: string; label: string; kind: FluxDriver['kind']; refType?: string; refId?: string } {
  const ref = h.source_ref ?? '';
  const bill = bills.get(ref);
  if (bill) {
    const v = vendors.get(bill.vendor_id) ?? 'Vendor';
    return { key: `vendor:${bill.vendor_id}`, label: v, kind: 'vendor', refType: 'vendor', refId: bill.vendor_id };
  }
  const inv = invoices.get(ref);
  if (inv) return { key: `customer:${inv.customer_id}`, label: customers.get(inv.customer_id) ?? 'Customer', kind: 'customer', refType: 'customer', refId: inv.customer_id };
  const card = /^Card ••\d{4} (.+)$/.exec(h.memo);
  if (card) return { key: `merchant:${card[1]}`, label: `${card[1]} (card)`, kind: 'vendor' };
  if (h.entry_type === 'reversing') {
    const orig = h.reverses_je_id ? reversed.get(h.reverses_je_id) : undefined;
    const shape = orig ? memoShape(orig.memo) : 'accrual';
    return { key: `reversal:${shape}`, label: `Reversal of last month’s accrual (${shape.toLowerCase()})`.slice(0, 120), kind: 'timing' };
  }
  if (h.entry_type === 'accrual') {
    const shape = memoShape(h.memo);
    return { key: `accrual:${shape}`, label: `Month-end accrual (${shape.toLowerCase()})`.slice(0, 120), kind: 'timing' };
  }
  if (ref.startsWith('PR-')) return { key: 'payroll', label: 'Payroll runs', kind: 'volume' };
  if (ref.startsWith('DEP-')) return { key: 'depreciation', label: 'Depreciation', kind: 'other' };
  if (ref.startsWith('DEFREV-')) return { key: 'defrev', label: 'Deferred revenue release', kind: 'customer' };
  if (ref.startsWith('COGS-')) return { key: 'cogs', label: 'Hardware shipments (COGS)', kind: 'volume' };
  if (ref.startsWith('IC-')) return { key: 'ic', label: 'Intercompany R&D services', kind: 'other' };
  return { key: `entry:${h.memo.slice(0, 40)}`, label: h.memo.slice(0, 80), kind: 'other', refType: 'journal_entry', refId: h.id };
}

/** Driver decomposition: top movers by key, remainder as "Other", summing exactly to the variance. */
function drivers(a: AccountRow, cur: Map<string, { label: string; kind: FluxDriver['kind']; net: number; refType?: string; refId?: string }>, comp: Map<string, { label: string; kind: FluxDriver['kind']; net: number; refType?: string; refId?: string }>, variance: number): FluxDriver[] {
  const sign = a.account_class === 'revenue' ? -1 : 1;
  const keys = new Set([...cur.keys(), ...comp.keys()]);
  const moves: FluxDriver[] = [];
  for (const k of keys) {
    const c = cur.get(k);
    const p = comp.get(k);
    const delta = sign * ((c?.net ?? 0) - (p?.net ?? 0));
    if (!delta) continue;
    const base = c ?? p!;
    const kind: FluxDriver['kind'] = !p && c ? (base.kind === 'vendor' || base.kind === 'customer' ? 'new_item' : base.kind) : base.kind;
    moves.push({ label: base.label, kind, amountMinor: delta, detail: !p ? 'new this month' : !c ? 'none this month' : undefined, refType: base.refType, refId: base.refId });
  }
  moves.sort((x, y) => Math.abs(y.amountMinor) - Math.abs(x.amountMinor) || x.label.localeCompare(y.label));
  const top = moves.slice(0, 4);
  const rest = variance - top.reduce((s, d) => s + d.amountMinor, 0);
  if (rest !== 0) top.push({ label: `Other (${Math.max(moves.length - 4, 1)} smaller items)`, kind: 'other', amountMinor: rest });
  return top;
}

export function fluxNarrative(line: FluxLineView, currency: string, periodKey: string, comparativeKey: string): string {
  const f = (m: number) => `${currency === 'GBP' ? '£' : '$'}${(Math.abs(m) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const signed = (m: number) => `${m < 0 ? '−' : '+'}${f(m)}`;
  const dir = line.varianceMinor >= 0 ? 'rose' : 'fell';
  const pct = line.variancePct === null ? 'new this month' : `${line.variancePct >= 0 ? '+' : '−'}${Math.abs(line.variancePct * 100).toFixed(0)}%`;
  const main = line.drivers.filter((d) => !d.label.startsWith('Other')).slice(0, 3);
  const parts = [`${line.name} ${dir} ${f(line.varianceMinor)} (${pct}) from ${periodLabel(comparativeKey)} to ${f(line.currentMinor)} in ${periodLabel(periodKey)}.`];
  if (main.length) parts.push(`${main.length === 1 ? 'The driver is' : 'The main drivers are'} ${main.map((d) => `${d.label}${d.detail ? ` – ${d.kind === 'timing' && d.detail === 'none this month' ? 'not booked yet this month' : d.detail}` : ''} (${signed(d.amountMinor)})`).join('; ')}.`);
  if (line.pending.length) {
    const p = line.pending.reduce((s, x) => s + x.amountMinor, 0);
    parts.push(`Not yet in the ledger: ${line.pending.map((x) => `${x.proposalRef} ${x.label} (${signed(x.amountMinor)}, awaiting approval)`).join('; ')}; once approved the month would be ${f(line.currentMinor + p)}.`);
  }
  if (line.budgetMinor !== null && line.budgetVarianceMinor !== null) parts.push(`Against the ${f(line.budgetMinor)} budget the month is ${f(line.budgetVarianceMinor)} ${line.budgetVarianceMinor >= 0 ? 'over' : 'under'}.`);
  return parts.join(' ');
}
