/**
 * Reconciliation matching engine (pure, deterministic). Pairs external lines (bank statement,
 * subledger) with ledger lines in four passes, strongest evidence first:
 *
 *   1. exact        same amount, dates within the window, reference or counterparty agrees
 *   2. many_to_one  several bank lines settle one ledger line (split ACH, partial clears)
 *   3. one_to_many  one bank line settles several ledger lines (lockbox deposits, batch payments)
 *   4. fuzzy        same amount within a wider window, or a small rounding difference
 *
 * Subset searches are bounded (≤ 4 items from ≤ 14 candidates) so the engine stays O(n·k⁴) with
 * small k. Every match carries a confidence and a plain-English explanation built from the
 * signals that produced it — the "why" a reviewer sees.
 */
import { diffDays } from '../../../core/util/time';

export interface ExternalLine {
  id: string;
  date: string;
  amountMinor: number;
  description: string;
  counterparty: string | null;
  reference: string | null;
}

export interface LedgerLine {
  id: string;
  date: string;
  /** signed in the external line's direction (+ money in, − money out for bank) */
  amountMinor: number;
  memo: string;
  reference: string | null;
  entryRef: string;
  entryId: string;
}

export type MatchType = 'exact' | 'fuzzy' | 'one_to_many' | 'many_to_one';

export interface Match {
  type: MatchType;
  external: ExternalLine[];
  ledger: LedgerLine[];
  differenceMinor: number;
  confidence: number;
  signals: string[];
  explanation: string;
}

export interface MatchOptions {
  windowDays: number;
  fuzzyWindowDays: number;
  toleranceMinor: number;
  maxSubset: number;
  maxCandidates: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = { windowDays: 3, fuzzyWindowDays: 7, toleranceMinor: 0, maxSubset: 4, maxCandidates: 14 };

const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

function refAgrees(e: ExternalLine, l: LedgerLine): boolean {
  const er = norm(e.reference);
  const lr = norm(l.reference);
  if (er && lr && (er === lr || er.includes(lr) || lr.includes(er))) return true;
  if (lr && lr.length >= 5 && norm(e.description).includes(lr)) return true;
  if (er && er.length >= 5 && norm(l.memo).includes(er)) return true;
  return false;
}

function nameAgrees(e: ExternalLine, l: LedgerLine): boolean {
  const cp = norm(e.counterparty);
  if (!cp) return false;
  const first = cp.split(' ').filter((w) => w.length > 3)[0];
  return !!first && norm(l.memo).includes(first);
}

const money = (m: number) => `${m < 0 ? '−' : ''}$${(Math.abs(m) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function* combinations<T>(items: readonly T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield [...acc];
    return;
  }
  for (let i = start; i <= items.length - (k - acc.length); i++) {
    acc.push(items[i]!);
    yield* combinations(items, k, i + 1, acc);
    acc.pop();
  }
}

/**
 * Smallest subset (size 2..max) of `cands` summing to `target`, preferring a size hint, items
 * recorded on the same day (a deposit batch) and dates close to the anchor.
 */
function subsetSum<T extends { amountMinor: number; date: string }>(cands: readonly T[], target: number, max: number, tol: number, anchorDate: string, sizeHint: number | null): T[] | null {
  let best: { set: T[]; score: number } | null = null;
  const sizes = [...Array(Math.max(0, max - 1)).keys()].map((i) => i + 2);
  if (sizeHint && sizes.includes(sizeHint)) sizes.sort((a, b) => (a === sizeHint ? -1 : b === sizeHint ? 1 : a - b));
  for (const k of sizes) {
    for (const set of combinations(cands, k)) {
      const s = set.reduce((acc, x) => acc + x.amountMinor, 0);
      if (Math.abs(s - target) > tol) continue;
      const spread = set.reduce((acc, x) => acc + Math.abs(diffDays(x.date, anchorDate)), 0);
      const dates = set.map((x) => x.date).sort();
      const dispersion = diffDays(dates[dates.length - 1]!, dates[0]!);
      const score = (sizeHint === k ? 0 : 100) + dispersion * 10 + spread;
      if (!best || score < best.score) best = { set, score };
    }
    if (best && (sizeHint === null || sizeHint === k)) break;
  }
  return best?.set ?? null;
}

export interface MatchResult {
  matches: Match[];
  unmatchedExternal: ExternalLine[];
  unmatchedLedger: LedgerLine[];
}

export function matchLines(external: readonly ExternalLine[], ledger: readonly LedgerLine[], opts: Partial<MatchOptions> = {}): MatchResult {
  const o = { ...DEFAULT_MATCH_OPTIONS, ...opts };
  const ext = [...external].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const led = [...ledger].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const usedE = new Set<string>();
  const usedL = new Set<string>();
  const matches: Match[] = [];

  // ---- pass 1: exact one-to-one
  for (const e of ext) {
    // a shared reference (e.g. a check number) justifies a longer clearing lag
    const cands = led.filter((l) => !usedL.has(l.id) && Math.abs(l.amountMinor - e.amountMinor) <= o.toleranceMinor && (Math.abs(diffDays(l.date, e.date)) <= o.windowDays || (refAgrees(e, l) && diffDays(e.date, l.date) >= 0 && diffDays(e.date, l.date) <= o.fuzzyWindowDays + 3)));
    if (!cands.length) continue;
    const scored = cands
      .map((l) => ({ l, ref: refAgrees(e, l), name: nameAgrees(e, l), gap: Math.abs(diffDays(l.date, e.date)) }))
      .sort((a, b) => Number(b.ref) - Number(a.ref) || Number(b.name) - Number(a.name) || a.gap - b.gap || a.l.id.localeCompare(b.l.id));
    const top = scored[0]!;
    const ambiguous = scored.length > 1 && !top.ref && !top.name && scored[1]!.gap === top.gap;
    if (ambiguous) continue; // leave for the fuzzy pass, which scores it lower
    const signals = [`amount ${money(e.amountMinor)} agrees`, top.gap === 0 ? 'same date' : `dates ${top.gap} day${top.gap === 1 ? '' : 's'} apart`];
    if (top.ref) signals.push('reference agrees');
    if (top.name) signals.push('counterparty agrees');
    if (scored.length === 1) signals.push('only candidate in the window');
    const confidence = top.ref ? (top.gap <= 1 ? 0.99 : 0.97) : top.name ? 0.96 : scored.length === 1 ? (top.gap <= 1 ? 0.95 : 0.92) : 0.88;
    usedE.add(e.id);
    usedL.add(top.l.id);
    matches.push({ type: 'exact', external: [e], ledger: [top.l], differenceMinor: e.amountMinor - top.l.amountMinor, confidence, signals, explanation: `Bank line "${e.description}" and ${top.l.entryRef} (${top.l.memo}): ${signals.join(', ')}.` });
  }

  // ---- pass 2: many external → one ledger (split settlements)
  for (const l of led) {
    if (usedL.has(l.id)) continue;
    const cands = ext
      .filter((e) => !usedE.has(e.id) && Math.sign(e.amountMinor) === Math.sign(l.amountMinor) && Math.abs(e.amountMinor) < Math.abs(l.amountMinor) && Math.abs(diffDays(e.date, l.date)) <= o.windowDays)
      .sort((a, b) => Number(refAgrees(b, l) || nameAgrees(b, l)) - Number(refAgrees(a, l) || nameAgrees(a, l)) || Math.abs(diffDays(a.date, l.date)) - Math.abs(diffDays(b.date, l.date)) || a.id.localeCompare(b.id))
      .slice(0, o.maxCandidates);
    if (cands.length < 2) continue;
    const refCands = cands.filter((e) => refAgrees(e, l) || nameAgrees(e, l));
    const pool = refCands.length >= 2 ? refCands : cands;
    const set = subsetSum(pool, l.amountMinor, o.maxSubset, o.toleranceMinor, l.date, null);
    if (!set) continue;
    const withRef = set.every((e) => refAgrees(e, l) || nameAgrees(e, l));
    set.forEach((e) => usedE.add(e.id));
    usedL.add(l.id);
    const signals = [`${set.length} bank lines total ${money(l.amountMinor)}`, withRef ? 'all share the reference/counterparty' : 'amounts sum exactly'];
    matches.push({ type: 'many_to_one', external: set, ledger: [l], differenceMinor: set.reduce((s, e) => s + e.amountMinor, 0) - l.amountMinor, confidence: withRef ? 0.95 : 0.84, signals, explanation: `${l.entryRef} (${l.memo}) settled in ${set.length} bank lines: ${set.map((e) => money(e.amountMinor)).join(' + ')} = ${money(l.amountMinor)}${withRef ? '; every line carries the same reference' : ''}.` });
  }

  // ---- pass 3: one external → many ledger (deposits of several receipts)
  for (const e of ext) {
    if (usedE.has(e.id)) continue;
    const hint = /(\d+)\s+ITEMS?/i.exec(e.description);
    // deposit batches often carry their batch date in the reference (e.g. LBX-20260915)
    const batch = /(20\d{2})(\d{2})(\d{2})/.exec(`${e.reference ?? ''} ${e.description}`);
    const anchor = batch ? `${batch[1]}-${batch[2]}-${batch[3]}` : e.date;
    // deposits clear after they are recorded (weekends and holidays can stretch the lag)
    const cands = led
      .filter((l) => !usedL.has(l.id) && Math.sign(l.amountMinor) === Math.sign(e.amountMinor) && Math.abs(l.amountMinor) < Math.abs(e.amountMinor) && diffDays(e.date, l.date) >= -1 && diffDays(e.date, l.date) <= o.windowDays + 2)
      .sort((a, b) => Math.abs(diffDays(a.date, anchor)) - Math.abs(diffDays(b.date, anchor)) || a.id.localeCompare(b.id))
      .slice(0, o.maxCandidates);
    if (cands.length < 2) continue;
    const set = subsetSum(cands, e.amountMinor, o.maxSubset, o.toleranceMinor, anchor, hint ? Number(hint[1]) : null);
    if (!set) continue;
    set.forEach((l) => usedL.add(l.id));
    usedE.add(e.id);
    const hinted = hint && Number(hint[1]) === set.length;
    const signals = [`${set.length} ledger lines total ${money(e.amountMinor)}`, hinted ? `bank description says ${hint![0].toLowerCase()}` : 'amounts sum exactly'];
    matches.push({ type: 'one_to_many', external: [e], ledger: set, differenceMinor: e.amountMinor - set.reduce((s, l) => s + l.amountMinor, 0), confidence: hinted ? 0.94 : 0.82, signals, explanation: `Bank line "${e.description}" ${money(e.amountMinor)} = ${set.map((l) => `${l.entryRef} ${money(l.amountMinor)}`).join(' + ')}${hinted ? ` (the bank reports ${hint![1]} items)` : ''}.` });
  }

  // ---- pass 4: fuzzy (wider window or ambiguous exact candidates)
  for (const e of ext) {
    if (usedE.has(e.id)) continue;
    const cands = led
      .filter((l) => !usedL.has(l.id) && Math.abs(l.amountMinor - e.amountMinor) <= Math.max(o.toleranceMinor, 100) && Math.abs(diffDays(l.date, e.date)) <= o.fuzzyWindowDays)
      .map((l) => ({ l, ref: refAgrees(e, l), gap: Math.abs(diffDays(l.date, e.date)), diff: Math.abs(l.amountMinor - e.amountMinor) }))
      .sort((a, b) => Number(b.ref) - Number(a.ref) || a.diff - b.diff || a.gap - b.gap || a.l.id.localeCompare(b.l.id));
    const top = cands[0];
    if (!top) continue;
    usedE.add(e.id);
    usedL.add(top.l.id);
    const signals = [top.diff === 0 ? `amount ${money(e.amountMinor)} agrees` : `amounts differ by ${money(e.amountMinor - top.l.amountMinor)}`, `dates ${top.gap} days apart`];
    if (top.ref) signals.push('reference agrees');
    if (cands.length > 1) signals.push(`${cands.length} candidates; nearest chosen`);
    const confidence = Math.max(0.55, (top.ref ? 0.9 : 0.78) - top.gap * 0.02 - (top.diff ? 0.08 : 0) - (cands.length > 1 ? 0.06 : 0));
    matches.push({ type: 'fuzzy', external: [e], ledger: [top.l], differenceMinor: e.amountMinor - top.l.amountMinor, confidence: Math.round(confidence * 100) / 100, signals, explanation: `Probable match: "${e.description}" and ${top.l.entryRef} (${top.l.memo}); ${signals.join(', ')}.` });
  }

  return { matches, unmatchedExternal: ext.filter((e) => !usedE.has(e.id)), unmatchedLedger: led.filter((l) => !usedL.has(l.id)) };
}

/** Classify a bank-only line (on the statement, not in the books). */
export function classifyBankOnly(e: ExternalLine): { kind: 'bank_fee' | 'interest' | 'unexplained'; confidence: number; reason: string } {
  const d = norm(e.description);
  if (/SERVICE CHARGE|ANALYSIS CHARGE|ACCOUNT FEE|WIRE FEE|BANK FEE|MAINTENANCE FEE/.test(d) && e.amountMinor < 0) return { kind: 'bank_fee', confidence: 0.97, reason: 'The bank describes it as a service charge and it is a small debit.' };
  if (/INTEREST/.test(d) && e.amountMinor > 0) return { kind: 'interest', confidence: 0.97, reason: 'The bank describes it as an interest credit.' };
  return { kind: 'unexplained', confidence: 0.5, reason: 'No ledger entry, vendor, customer or bank-charge pattern explains it.' };
}
