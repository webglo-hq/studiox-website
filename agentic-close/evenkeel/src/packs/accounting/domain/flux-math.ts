import { formatMoney, formatPct } from '../../../framework/util/money';
import type { SourceRef, VarianceDriver } from '../ontology/shapes';

/** Pure flux/variance mathematics and driver analysis (no I/O). */

export interface FluxThreshold {
  /** absolute variance threshold in cents */
  abs: number;
  /** relative threshold as a ratio (0.1 = 10%) */
  pct: number;
  /** 'and' = both must be exceeded; 'or' = either */
  mode: 'and' | 'or';
}

export interface Variance {
  current: number;
  comparison: number;
  variance: number;
  variancePct: number | null;
}

export function computeVariance(current: number, comparison: number): Variance {
  const variance = current - comparison;
  const variancePct = comparison === 0 ? null : variance / Math.abs(comparison);
  return { current, comparison, variance, variancePct };
}

export function isMaterialVariance(v: Variance, t: FluxThreshold): boolean {
  const absHit = Math.abs(v.variance) >= t.abs;
  // A brand-new balance (comparison 0) is treated as a 100%+ move.
  const pctHit = v.variancePct === null ? v.variance !== 0 : Math.abs(v.variancePct) >= t.pct;
  return t.mode === 'and' ? absHit && pctHit : absHit || pctHit;
}

/** Convert ledger net (debit − credit) to natural sign: revenue/liability/equity positive when credit. */
export function naturalSign(net: number, normalBalance: 'debit' | 'credit'): number {
  return normalBalance === 'debit' ? net : -net;
}

export interface ActivityLine {
  /** grouping key: vendor id or normalised counterparty */
  key: string;
  label: string;
  period: 'current' | 'comparison';
  amount: number;
  ref?: SourceRef;
  entryType?: string;
}

export interface DriverAnalysis {
  drivers: VarianceDriver[];
  coverage: number;
}

/** Label of the driver that groups everything beyond the named drivers. */
export const OTHER_DRIVERS_LABEL = 'All other counterparties';
/** Label of the driver for any part of the variance the activity lines do not account for. */
export const UNTRACED_DRIVER_LABEL = 'Not traced to a counterparty';

/**
 * Decompose a variance into counterparty-level drivers: new and lost counterparties,
 * volume/rate changes, accrual and one-time items. The drivers reconcile to the variance
 * exactly: the largest movements are named whatever their direction (an offsetting driver is
 * part of the story), the rest are grouped, and anything the lines do not explain is shown as
 * untraced. Coverage is the share of the variance the named drivers explain.
 */
export function analyzeDrivers(lines: ActivityLine[], variance: number, maxDrivers = 4): DriverAnalysis {
  const groups = new Map<string, { label: string; cur: number; cmp: number; curRefs: SourceRef[]; curCount: number; cmpCount: number; accrual: boolean; maxSingle: number }>();
  for (const l of lines) {
    const g = groups.get(l.key) ?? { label: l.label, cur: 0, cmp: 0, curRefs: [], curCount: 0, cmpCount: 0, accrual: false, maxSingle: 0 };
    if (l.period === 'current') {
      g.cur += l.amount;
      g.curCount++;
      if (l.ref && g.curRefs.length < 5) g.curRefs.push(l.ref);
      if (l.entryType === 'accrual') g.accrual = true;
      g.maxSingle = Math.max(g.maxSingle, Math.abs(l.amount));
    } else {
      g.cmp += l.amount;
      g.cmpCount++;
    }
    groups.set(l.key, g);
  }
  const deltas = [...groups.entries()]
    .map(([key, g]) => ({ key, ...g, delta: g.cur - g.cmp }))
    .filter((g) => g.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key));
  const named: VarianceDriver[] = deltas.slice(0, maxDrivers).map((g) => {
    let kind: VarianceDriver['kind'];
    let label: string;
    if (g.accrual) {
      kind = 'accrual';
      label = `${g.label} — accrued this month`;
    } else if (g.cmp === 0 && g.cur !== 0) {
      const oneTime = g.curCount <= 2 && g.maxSingle >= Math.abs(g.delta) * 0.8;
      kind = oneTime ? 'one_time' : 'new_vendor';
      label = oneTime ? `${g.label} — new, one-time` : `${g.label} — new this month`;
    } else if (g.cur === 0 && g.cmp !== 0) {
      kind = 'lost_vendor';
      label = `${g.label} — none this month`;
    } else if (g.curCount !== g.cmpCount) {
      kind = 'volume';
      label = `${g.label} — ${g.curCount} vs ${g.cmpCount} transactions`;
    } else {
      kind = 'rate';
      label = `${g.label} — higher amounts`;
      if (g.delta < 0) label = `${g.label} — lower amounts`;
    }
    return { label, kind, amount: g.delta, evidence: g.curRefs };
  });
  const drivers = [...named];
  const rest = deltas.slice(maxDrivers);
  const restAmount = rest.reduce((s, g) => s + g.delta, 0);
  if (restAmount !== 0) drivers.push({ label: `${OTHER_DRIVERS_LABEL} (${rest.length})`, kind: 'other', amount: restAmount, evidence: [] });
  const untraced = variance - deltas.reduce((s, g) => s + g.delta, 0);
  if (untraced !== 0) drivers.push({ label: UNTRACED_DRIVER_LABEL, kind: 'other', amount: untraced, evidence: [] });
  const explained = named.reduce((s, d) => s + d.amount, 0);
  const coverage = variance === 0 ? 1 : Math.max(0, Math.min(2, explained / variance));
  return { drivers, coverage: Math.round(coverage * 1000) / 1000 };
}

/** True when the drivers add up to the variance (the check every explanation must pass). */
export function driversReconcile(drivers: { amount: number }[], variance: number): boolean {
  return drivers.reduce((s, d) => s + d.amount, 0) === variance;
}

export interface NarrativeInput {
  accountName: string;
  periodLabel: string;
  comparisonLabel: string;
  variance: Variance;
  currency: string;
  drivers: VarianceDriver[];
  coverage: number;
  budget?: { amount: number; variance: number } | null;
}

/** Deterministic, plain-English narrative (offline engine; live mode may rewrite it). */
export function fluxNarrative(n: NarrativeInput): string {
  const dir = n.variance.variance >= 0 ? 'rose' : 'fell';
  const amt = formatMoney(Math.abs(n.variance.variance), n.currency, { whole: true });
  const pct = n.variance.variancePct === null ? 'new this period' : formatPct(n.variance.variancePct, 0);
  const parts = [`${n.accountName} ${dir} ${amt} (${pct}) vs ${n.comparisonLabel}.`];
  const fmt = (d: VarianceDriver) => `${d.label} (${formatMoney(d.amount, n.currency, { whole: true, signed: true, accounting: false })})`;
  const remainder = n.drivers.filter((d) => d.label === UNTRACED_DRIVER_LABEL || d.label.startsWith(OTHER_DRIVERS_LABEL));
  const main = n.drivers.filter((d) => !remainder.includes(d));
  if (main.length) {
    parts.push(`Main drivers: ${main.map(fmt).join('; ')}.`);
    const share = Math.round(Math.min(n.coverage, 1) * 100);
    parts.push(remainder.length ? `These explain ${share}% of the change; ${remainder.map(fmt).join(' and ')} make up the rest.` : share < 100 ? `Together these explain ${share}% of the change.` : 'Together these account for the whole change.');
  } else {
    parts.push('No single counterparty explains the change; review the detail.');
  }
  if (n.budget) {
    const over = n.budget.variance >= 0 ? 'over' : 'under';
    parts.push(`Against budget the account is ${formatMoney(Math.abs(n.budget.variance), n.currency, { whole: true })} ${over} plan.`);
  }
  return parts.join(' ');
}
