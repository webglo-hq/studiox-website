import { diffDays } from '../../../framework/util/dates';
import { nameSimilarity, normalize } from '../../../framework/util/text';

/**
 * Reconciliation matching engine (pure, deterministic). Works on signed amounts in the same
 * orientation on both sides (bank deposit = +, ledger cash debit = +).
 *
 * Passes, in order of decisiveness:
 *   1. exact      — equal amount and (same reference or same date), best candidate unique
 *   2. fuzzy      — equal amount within a date window, supported by description similarity
 *   3. many→one   — several bank lines sum to one ledger line (e.g. split payroll funding)
 *   4. one→many   — one bank line equals several ledger lines (e.g. batched deposit)
 * Every match carries a confidence and a human-readable reason.
 */
export interface MatchItem {
  id: string;
  amount: number;
  date: string;
  text: string;
  reference?: string | null;
}

export type EngineMatchType = 'exact' | 'fuzzy' | 'one_to_many' | 'many_to_one';

export interface EngineMatch {
  type: EngineMatchType;
  bank: MatchItem[];
  ledger: MatchItem[];
  confidence: number;
  dateDelta: number;
  nameScore: number;
  reason: string;
}

export interface MatchOptions {
  exactWindowDays: number;
  fuzzyWindowDays: number;
  fuzzyMinScore: number;
  groupWindowDays: number;
  maxGroupSize: number;
  maxGroupCandidates: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  exactWindowDays: 3,
  fuzzyWindowDays: 7,
  fuzzyMinScore: 0.45,
  groupWindowDays: 5,
  maxGroupSize: 4,
  maxGroupCandidates: 24,
};

export interface MatchResult {
  matches: EngineMatch[];
  unmatchedBank: MatchItem[];
  unmatchedLedger: MatchItem[];
}

function refKey(r: string | null | undefined): string | null {
  if (!r) return null;
  const n = normalize(r).replace(/\s+/g, '');
  const digits = n.replace(/\D/g, '');
  return digits.length >= 4 ? digits : n.length >= 4 ? n : null;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function matchTransactions(bankIn: MatchItem[], ledgerIn: MatchItem[], options: Partial<MatchOptions> = {}): MatchResult {
  const opts = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const bank = [...bankIn].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const ledger = [...ledgerIn].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const usedBank = new Set<string>();
  const usedLedger = new Set<string>();
  const matches: EngineMatch[] = [];

  const byAmount = new Map<number, MatchItem[]>();
  for (const l of ledger) {
    const list = byAmount.get(l.amount) ?? [];
    list.push(l);
    byAmount.set(l.amount, list);
  }

  // ---- pass 1 + 2: one-to-one on amount
  for (const pass of ['exact', 'fuzzy'] as const) {
    for (const b of bank) {
      if (usedBank.has(b.id)) continue;
      const window = pass === 'exact' ? opts.exactWindowDays : opts.fuzzyWindowDays;
      const cands = (byAmount.get(b.amount) ?? []).filter((l) => !usedLedger.has(l.id) && Math.abs(diffDays(l.date, b.date)) <= window);
      if (!cands.length) continue;
      const bRef = refKey(b.reference);
      const scored = cands
        .map((l) => {
          const lRef = refKey(l.reference);
          const refMatch = !!bRef && !!lRef && (bRef === lRef || bRef.endsWith(lRef) || lRef.endsWith(bRef));
          const ns = Math.max(nameSimilarity(b.text, l.text), nameSimilarity(l.text, b.text));
          const dd = Math.abs(diffDays(l.date, b.date));
          return { l, refMatch, ns, dd, score: (refMatch ? 2 : 0) + ns - dd * 0.05 };
        })
        .sort((x, y) => y.score - x.score || x.dd - y.dd || x.l.id.localeCompare(y.l.id));
      const best = scored[0]!;
      const runnerUp = scored[1];
      const decisive = !runnerUp || best.score - runnerUp.score > 0.15;
      if (pass === 'exact') {
        if ((best.refMatch || best.dd === 0) && decisive) {
          usedBank.add(b.id);
          usedLedger.add(best.l.id);
          const conf = best.refMatch ? 0.99 : best.ns >= 0.5 ? 0.98 : 0.96;
          matches.push({
            type: 'exact',
            bank: [b],
            ledger: [best.l],
            confidence: conf,
            dateDelta: best.dd,
            nameScore: round3(best.ns),
            reason: best.refMatch ? `Same amount and reference ${b.reference}.` : 'Same amount on the same day.',
          });
        }
      } else {
        const unique = scored.length === 1;
        if ((best.ns >= opts.fuzzyMinScore || (unique && best.ns >= 0.25)) && decisive) {
          usedBank.add(b.id);
          usedLedger.add(best.l.id);
          const conf = Math.max(0.5, Math.min(0.94, 0.62 + 0.32 * best.ns - 0.02 * best.dd + (unique ? 0.07 : 0)));
          matches.push({
            type: 'fuzzy',
            bank: [b],
            ledger: [best.l],
            confidence: round3(conf),
            dateDelta: best.dd,
            nameScore: round3(best.ns),
            reason: `Same amount ${best.dd} day${best.dd === 1 ? '' : 's'} apart; descriptions are ${Math.round(best.ns * 100)}% similar.`,
          });
        }
      }
    }
  }

  // ---- pass 3 + 4: grouped matches via bounded subset-sum
  const groupPass = (singles: MatchItem[], pool: MatchItem[], usedSingles: Set<string>, usedPool: Set<string>, type: EngineMatchType) => {
    for (const s of singles) {
      if (usedSingles.has(s.id)) continue;
      const cands = pool
        .filter((p) => !usedPool.has(p.id) && Math.sign(p.amount) === Math.sign(s.amount) && Math.abs(p.amount) < Math.abs(s.amount) && Math.abs(diffDays(p.date, s.date)) <= opts.groupWindowDays)
        .sort((a, b) => Math.abs(diffDays(a.date, s.date)) - Math.abs(diffDays(b.date, s.date)) || a.id.localeCompare(b.id))
        .slice(0, opts.maxGroupCandidates);
      const found = findSubset(cands, s.amount, opts.maxGroupSize);
      if (!found) continue;
      for (const f of found) usedPool.add(f.id);
      usedSingles.add(s.id);
      const ns = found.reduce((acc, f) => acc + Math.max(nameSimilarity(s.text, f.text), nameSimilarity(f.text, s.text)), 0) / found.length;
      const sRef = refKey(s.reference);
      const refBonus = sRef && found.every((f) => refKey(f.reference) === sRef) ? 0.08 : 0;
      const dd = Math.max(...found.map((f) => Math.abs(diffDays(f.date, s.date))));
      const conf = Math.max(0.55, Math.min(0.93, 0.78 + 0.12 * ns + refBonus - 0.03 * (found.length - 2) - 0.01 * dd));
      matches.push({
        type,
        bank: type === 'many_to_one' ? found : [s],
        ledger: type === 'many_to_one' ? [s] : found,
        confidence: round3(conf),
        dateDelta: dd,
        nameScore: round3(ns),
        reason: type === 'many_to_one' ? `${found.length} bank lines add up exactly to one ledger entry.` : `One bank line equals ${found.length} ledger entries added together.`,
      });
    }
  };
  groupPass(ledger, bank, usedLedger, usedBank, 'many_to_one');
  groupPass(bank, ledger, usedBank, usedLedger, 'one_to_many');

  return {
    matches,
    unmatchedBank: bank.filter((b) => !usedBank.has(b.id)),
    unmatchedLedger: ledger.filter((l) => !usedLedger.has(l.id)),
  };
}

/**
 * Smallest subset (size 2..maxSize) of `items` summing exactly to `target`. Deterministic:
 * explores candidates in the given order and returns the first, smallest solution.
 */
export function findSubset(items: MatchItem[], target: number, maxSize: number): MatchItem[] | null {
  const n = items.length;
  for (let size = 2; size <= Math.min(maxSize, n); size++) {
    const idx: number[] = [];
    const recurse = (start: number, remaining: number): MatchItem[] | null => {
      if (idx.length === size) return remaining === 0 ? idx.map((i) => items[i]!) : null;
      for (let i = start; i <= n - (size - idx.length); i++) {
        const v = items[i]!.amount;
        // prune: same sign as target and not overshooting in magnitude
        if (Math.abs(v) > Math.abs(remaining)) continue;
        idx.push(i);
        const res = recurse(i + 1, remaining - v);
        if (res) return res;
        idx.pop();
      }
      return null;
    };
    const res = recurse(0, target);
    if (res) return res;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classification of unmatched items into reconciling items
// ---------------------------------------------------------------------------

export type UnmatchedClass = 'deposit_in_transit' | 'outstanding_check' | 'bank_fee' | 'bank_interest' | 'unexplained' | 'timing';

export interface ClassifiedItem {
  item: MatchItem;
  side: 'bank' | 'book';
  cls: UnmatchedClass;
  clearedBy: MatchItem | null;
  reason: string;
}

const FEE_RE = /\b(fee|service charge|svc chg|analysis charge|maintenance|wire charge)\b/i;
const INTEREST_RE = /\b(interest|int paid|credit interest)\b/i;

/**
 * Classify unmatched items. Book-side items near period end are timing differences when a
 * matching line appears on the next statement ("subsequent clearing" evidence).
 */
export function classifyUnmatched(unmatchedBank: MatchItem[], unmatchedLedger: MatchItem[], subsequentBank: MatchItem[], periodEndDate: string): ClassifiedItem[] {
  const out: ClassifiedItem[] = [];
  const usedSubsequent = new Set<string>();
  for (const l of unmatchedLedger) {
    const clear = subsequentBank.find((s) => !usedSubsequent.has(s.id) && s.amount === l.amount && diffDays(s.date, l.date) >= 0 && diffDays(s.date, l.date) <= 15);
    if (clear) usedSubsequent.add(clear.id);
    // "Check 10458", "CHK10458", "chk #10458", "cheque 77"
    const isCheck = /\b(check|cheque)\b|\bchk(?:\b|\s*#?\s*\d)/i.test(`${l.text} ${l.reference ?? ''}`);
    const nearEnd = diffDays(periodEndDate, l.date) <= 5;
    if (l.amount > 0) {
      out.push({ item: l, side: 'book', cls: clear || nearEnd ? 'deposit_in_transit' : 'timing', clearedBy: clear ?? null, reason: clear ? `Recorded ${l.date}; the bank credited it on ${clear.date}.` : 'Recorded in the books; not yet on the statement.' });
    } else {
      out.push({ item: l, side: 'book', cls: isCheck ? 'outstanding_check' : 'timing', clearedBy: clear ?? null, reason: clear ? `Issued ${l.date}; cleared the bank on ${clear.date}.` : isCheck ? 'Check issued but not yet cashed.' : 'Payment recorded but not yet on the statement.' });
    }
  }
  for (const b of unmatchedBank) {
    if (b.amount < 0 && FEE_RE.test(b.text)) out.push({ item: b, side: 'bank', cls: 'bank_fee', clearedBy: null, reason: 'Bank charge on the statement with no entry in the books yet.' });
    else if (b.amount > 0 && INTEREST_RE.test(b.text)) out.push({ item: b, side: 'bank', cls: 'bank_interest', clearedBy: null, reason: 'Interest credited by the bank with no entry in the books yet.' });
    else out.push({ item: b, side: 'bank', cls: 'unexplained', clearedBy: null, reason: 'On the statement with no matching entry and no recognisable type — needs investigation.' });
  }
  return out;
}
