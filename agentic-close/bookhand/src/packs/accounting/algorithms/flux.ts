import type { FluxDriver } from '../../../persistence/schema';

/**
 * Flux (variance) analysis: thresholding and driver-based explanations.
 * Amounts are in natural sign (normal balance positive) so "up" means more revenue, more expense, more cash.
 */

export interface FluxAccountInput {
  accountId: string;
  number: string;
  name: string;
  accountClass: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  fsLine: string;
  current: number;
  comparison: number;
}

export interface FluxThresholdPolicy {
  /** Relative threshold, e.g. 0.10 for 10%. */
  pct: number;
  /** Absolute threshold in minor units, e.g. 2_500_000 for $25,000. */
  minor: number;
  /** 'and': both must be exceeded (common practice); 'or': either. */
  combine: 'and' | 'or';
}

export interface FluxLineResult extends FluxAccountInput {
  variance: number;
  variancePct: number | null;
  isMaterial: boolean;
  direction: 'up' | 'down' | 'flat';
}

export function computeFlux(accounts: FluxAccountInput[], policy: FluxThresholdPolicy): FluxLineResult[] {
  return accounts
    .map((a) => {
      const variance = a.current - a.comparison;
      const variancePct = a.comparison === 0 ? (a.current === 0 ? 0 : null) : variance / Math.abs(a.comparison);
      const pctHit = variancePct === null ? true : Math.abs(variancePct) >= policy.pct;
      const absHit = Math.abs(variance) >= policy.minor;
      const isMaterial = policy.combine === 'and' ? pctHit && absHit : pctHit || absHit;
      return { ...a, variance, variancePct, isMaterial, direction: variance > 0 ? 'up' : variance < 0 ? 'down' : 'flat' } as FluxLineResult;
    })
    .sort((x, y) => Math.abs(y.variance) - Math.abs(x.variance));
}

export interface DetailItem {
  /** Grouping key, e.g. vendor id, department code or normalized description. */
  key: string;
  label: string;
  kind: 'vendor' | 'department' | 'customer' | 'description';
  amount: number;
  /** Text hints for one-time items (conference, one-time, settlement...). */
  hint?: string;
  evidence?: Array<{ type: string; id: string; label: string }>;
}

const ONE_TIME = /\b(conference|summit|expo|booth|trade ?show|one[- ]time|settlement|offsite|launch|sponsorship|annual|kickoff|signing bonus|severance)\b/i;

/**
 * Decompose a variance into drivers by comparing grouped detail between periods. Returns the fewest drivers
 * that explain >= 80% of the variance (max 4) plus an "other, net" remainder.
 */
export function decomposeDrivers(current: DetailItem[], comparison: DetailItem[], variance: number): { drivers: FluxDriver[]; coverage: number } {
  const byKey = new Map<string, { label: string; kind: DetailItem['kind']; cur: number; cmp: number; hint: string; evidence: DetailItem['evidence'] }>();
  for (const d of current) {
    const e = byKey.get(d.key) ?? { label: d.label, kind: d.kind, cur: 0, cmp: 0, hint: '', evidence: [] };
    e.cur += d.amount;
    e.hint += ` ${d.hint ?? ''} ${d.label}`;
    e.evidence = [...(e.evidence ?? []), ...(d.evidence ?? [])].slice(0, 5);
    byKey.set(d.key, e);
  }
  for (const d of comparison) {
    const e = byKey.get(d.key) ?? { label: d.label, kind: d.kind, cur: 0, cmp: 0, hint: '', evidence: [] };
    e.cmp += d.amount;
    byKey.set(d.key, e);
  }
  const deltas = Array.from(byKey.entries())
    .map(([key, e]) => ({ key, ...e, delta: e.cur - e.cmp }))
    .filter((d) => d.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key));

  const drivers: FluxDriver[] = [];
  let explained = 0;
  const target = Math.abs(variance);
  for (const d of deltas) {
    if (drivers.length >= 4 || (target > 0 && Math.abs(explained) >= target * 0.8 && Math.sign(explained) === Math.sign(variance))) break;
    // Only take drivers moving in the direction of the variance (or large offsets).
    if (Math.sign(d.delta) !== Math.sign(variance) && Math.abs(d.delta) < target * 0.25) continue;
    let kind: FluxDriver['kind'] = d.kind === 'department' ? 'department' : d.kind === 'customer' ? 'customer' : 'vendor';
    let label = d.label;
    if (d.cmp === 0 && d.cur !== 0) {
      kind = ONE_TIME.test(d.hint) ? 'one_time' : 'new_item';
      label = `${d.label} (${kind === 'one_time' ? 'one-time' : 'new this period'})`;
    } else if (d.cur === 0 && d.cmp !== 0) {
      kind = 'timing';
      label = `${d.label} (did not recur)`;
    }
    drivers.push({ kind, label, amount_minor: d.delta, evidence: d.evidence });
    explained += d.delta;
  }
  const remainder = variance - explained;
  if (drivers.length && remainder !== 0) drivers.push({ kind: 'other', label: 'Other, net', amount_minor: remainder });
  const coverage = target === 0 ? 1 : Math.max(0, Math.min(1, 1 - Math.abs(remainder) / target));
  return { drivers, coverage };
}

const fmt = (m: number) => `$${(Math.abs(m) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function draftExplanation(line: FluxLineResult, drivers: FluxDriver[], coverage: number, comparisonLabel: string): { text: string; confidence: number } {
  const verb = line.accountClass === 'revenue' ? (line.variance > 0 ? 'grew' : 'declined') : line.variance > 0 ? 'rose' : 'fell';
  const pct = line.variancePct === null ? 'from zero' : `${(line.variancePct * 100).toFixed(0)}%`;
  const main = drivers.filter((d) => d.kind !== 'other');
  const parts = main.map((d) => `${d.label} (${d.amount_minor > 0 ? '+' : '-'}${fmt(d.amount_minor)})`);
  let text = `${line.name} ${verb} ${fmt(line.variance)} (${pct}) vs ${comparisonLabel}.`;
  if (parts.length) text += ` Main driver${parts.length > 1 ? 's' : ''}: ${parts.join('; ')}.`;
  const other = drivers.find((d) => d.kind === 'other');
  if (other) text += ` Other activity ${other.amount_minor >= 0 ? 'added' : 'offset'} ${fmt(other.amount_minor)}.`;
  if (main.some((d) => d.kind === 'one_time')) text += ' The one-time item should not recur next month.';
  const confidence = Number(Math.min(0.95, 0.45 + 0.5 * coverage).toFixed(3));
  return { text, confidence };
}
