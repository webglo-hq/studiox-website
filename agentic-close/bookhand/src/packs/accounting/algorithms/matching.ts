import { diffDays } from '../../../shared/dates';
import { formatMoney } from '../../../shared/money';
import { references, similarity } from './text';

/**
 * Bank reconciliation matching engine. Pure and deterministic: same inputs, same matches.
 * Passes (each consumes what it matches):
 *   1. exact      - same amount and a shared reference, or same amount and same date
 *   2. amount     - same amount within the date window; ambiguity resolved by description similarity
 *   3. fuzzy      - amount within tolerance plus similar description (e.g. wire with a netted fee)
 *   4. one-to-many / many-to-one - subset sums within the date window
 * Then classifies leftovers: timing differences confirmed by next-period bank activity, bank fees,
 * interest, and genuinely unexplained items.
 */

export interface MatchItem {
  id: string;
  date: string;
  /** Signed from the cash account's perspective: + inflow, - outflow (minor units). */
  amount: number;
  description: string;
  reference?: string | null;
}

export type MatchType = 'exact' | 'fuzzy' | 'one_to_many' | 'many_to_one';

export interface Match {
  type: MatchType;
  bankIds: string[];
  ledgerIds: string[];
  bankAmount: number;
  ledgerAmount: number;
  difference: number;
  confidence: number;
  rule: string;
  explanation: string;
}

export interface TimingItem {
  ledgerId: string;
  kind: 'deposit_in_transit' | 'outstanding_check';
  amount: number;
  date: string;
  clearedBankId: string | null;
  clearedDate: string | null;
  confidence: number;
  explanation: string;
}

export interface BankOnlyItem {
  bankId: string;
  kind: 'bank_fee' | 'interest' | 'unexplained';
  amount: number;
  date: string;
  description: string;
  confidence: number;
  explanation: string;
}

export interface MatchOptions {
  /** Currency of the bank account (explanations quote amounts in it). */
  currency: string;
  dateWindowDays: number;
  fuzzyToleranceMinor: number;
  fuzzyTolerancePct: number;
  fuzzyMinSimilarity: number;
  maxGroupSize: number;
  periodEnd: string;
}

export const DEFAULT_MATCH_OPTIONS: Omit<MatchOptions, 'periodEnd'> = {
  currency: 'USD',
  dateWindowDays: 5,
  fuzzyToleranceMinor: 5_000,
  fuzzyTolerancePct: 0.01,
  fuzzyMinSimilarity: 0.45,
  maxGroupSize: 4,
};

export interface MatchResult {
  matches: Match[];
  timing: TimingItem[];
  bankOnly: BankOnlyItem[];
  unmatchedLedger: MatchItem[];
  stats: { bankItems: number; ledgerItems: number; matchedBank: number; matchedLedger: number; autoMatchRate: number };
}


function sortItems(items: MatchItem[]): MatchItem[] {
  return [...items].sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount || a.id.localeCompare(b.id));
}

function sharedReference(a: MatchItem, b: MatchItem): string | null {
  const ra = new Set([...(a.reference ? [a.reference.toLowerCase().replace(/[^a-z0-9]/g, '')] : []), ...references(a.description)]);
  for (const r of [...(b.reference ? [b.reference.toLowerCase().replace(/[^a-z0-9]/g, '')] : []), ...references(b.description)]) {
    if (r.length >= 3 && ra.has(r)) return r;
  }
  return null;
}

export function matchBankToLedger(
  bankInput: MatchItem[],
  ledgerInput: MatchItem[],
  options: Partial<MatchOptions> & { periodEnd: string },
  nextPeriodBank: MatchItem[] = [],
): MatchResult {
  const opt: MatchOptions = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const fmt = (m: number) => formatMoney(Math.abs(m), { currency: opt.currency });
  const bank = sortItems(bankInput);
  const ledger = sortItems(ledgerInput);
  const usedBank = new Set<string>();
  const usedLedger = new Set<string>();
  const matches: Match[] = [];
  const within = (a: MatchItem, b: MatchItem, days = opt.dateWindowDays) => Math.abs(diffDays(a.date, b.date)) <= days;

  const take = (m: Match) => {
    matches.push(m);
    m.bankIds.forEach((id) => usedBank.add(id));
    m.ledgerIds.forEach((id) => usedLedger.add(id));
  };

  // Pass 1: exact (amount + shared reference, or amount + same date)
  for (const b of bank) {
    if (usedBank.has(b.id)) continue;
    const candidates = ledger.filter((l) => !usedLedger.has(l.id) && l.amount === b.amount && within(b, l, opt.dateWindowDays + 3));
    const byRef = candidates.map((l) => ({ l, ref: sharedReference(b, l) })).find((x) => x.ref);
    const sameDay = candidates.filter((l) => l.date === b.date);
    const pick = byRef?.l ?? (sameDay.length === 1 ? sameDay[0] : undefined);
    if (!pick) continue;
    take({
      type: 'exact',
      bankIds: [b.id],
      ledgerIds: [pick.id],
      bankAmount: b.amount,
      ledgerAmount: pick.amount,
      difference: 0,
      confidence: byRef ? 0.99 : 0.97,
      rule: byRef ? `amount = ${fmt(b.amount)} and reference "${byRef.ref}"` : `amount = ${fmt(b.amount)} on the same date`,
      explanation: byRef
        ? `Same amount (${fmt(b.amount)}) and the same reference ${byRef.ref} on both sides.`
        : `Same amount (${fmt(b.amount)}) on the same day (${b.date}).`,
    });
  }

  // Pass 2: same amount within the window, best description
  for (const b of bank) {
    if (usedBank.has(b.id)) continue;
    const candidates = ledger
      .filter((l) => !usedLedger.has(l.id) && l.amount === b.amount && within(b, l))
      .map((l) => ({ l, sim: similarity(b.description, l.description), days: Math.abs(diffDays(b.date, l.date)) }))
      .sort((x, y) => y.sim - x.sim || x.days - y.days || x.l.id.localeCompare(y.l.id));
    if (!candidates.length) continue;
    const best = candidates[0]!;
    const ambiguous = candidates.length > 1 && candidates[1]!.sim >= best.sim - 0.05;
    const confidence = Math.max(0.6, Math.min(0.95, 0.93 - best.days * 0.02 + best.sim * 0.05 - (ambiguous ? 0.15 : 0)));
    take({
      type: 'exact',
      bankIds: [b.id],
      ledgerIds: [best.l.id],
      bankAmount: b.amount,
      ledgerAmount: best.l.amount,
      difference: 0,
      confidence: Number(confidence.toFixed(3)),
      rule: `amount = ${fmt(b.amount)} within ${opt.dateWindowDays} days`,
      explanation: `Same amount (${fmt(b.amount)}) ${best.days === 0 ? 'on the same day' : `${best.days} day(s) apart`}${best.sim > 0.4 ? ', similar description' : ''}${ambiguous ? '; other candidates with the same amount exist' : ''}.`,
    });
  }

  // Pass 3: fuzzy amount + similar description
  for (const b of bank) {
    if (usedBank.has(b.id)) continue;
    const tolerance = (l: MatchItem) => Math.max(opt.fuzzyToleranceMinor > 0 ? Math.min(opt.fuzzyToleranceMinor, Math.abs(l.amount) * opt.fuzzyTolerancePct * 5) : 0, 1);
    const candidates = ledger
      .filter((l) => !usedLedger.has(l.id) && Math.sign(l.amount) === Math.sign(b.amount) && l.amount !== b.amount && Math.abs(l.amount - b.amount) <= tolerance(l) && within(b, l, opt.dateWindowDays + 2))
      .map((l) => ({ l, sim: similarity(b.description, l.description) }))
      .filter((x) => x.sim >= opt.fuzzyMinSimilarity)
      .sort((x, y) => y.sim - x.sim || Math.abs(x.l.amount - b.amount) - Math.abs(y.l.amount - b.amount));
    const best = candidates[0];
    if (!best) continue;
    const diff = b.amount - best.l.amount;
    take({
      type: 'fuzzy',
      bankIds: [b.id],
      ledgerIds: [best.l.id],
      bankAmount: b.amount,
      ledgerAmount: best.l.amount,
      difference: diff,
      confidence: Number(Math.min(0.85, 0.55 + best.sim * 0.35).toFixed(3)),
      rule: `amount within ${fmt(tolerance(best.l))} and description similarity ${best.sim.toFixed(2)}`,
      explanation: `Amounts differ by ${fmt(diff)} (likely a fee netted by the bank) and descriptions match ("${b.description}" vs "${best.l.description}").`,
    });
  }

  // Pass 4: grouped matches via bounded subset sums
  const subsetSum = (target: number, pool: MatchItem[], maxSize: number): MatchItem[] | null => {
    const items = pool.slice(0, 14);
    const n = items.length;
    let found: MatchItem[] | null = null;
    const recur = (start: number, size: number, sum: number, chosen: MatchItem[]) => {
      if (found) return;
      if (size >= 2 && sum === target) {
        found = [...chosen];
        return;
      }
      if (size === maxSize) return;
      for (let i = start; i < n && !found; i++) {
        chosen.push(items[i]!);
        recur(i + 1, size + 1, sum + items[i]!.amount, chosen);
        chosen.pop();
      }
    };
    recur(0, 0, 0, []);
    return found;
  };

  for (const b of bank) {
    if (usedBank.has(b.id)) continue;
    const pool = ledger
      .filter((l) => !usedLedger.has(l.id) && Math.sign(l.amount) === Math.sign(b.amount) && Math.abs(l.amount) < Math.abs(b.amount) && within(b, l))
      .sort((x, y) => Math.abs(diffDays(b.date, x.date)) - Math.abs(diffDays(b.date, y.date)));
    const group = subsetSum(b.amount, pool, opt.maxGroupSize);
    if (!group) continue;
    const g = group as MatchItem[];
    take({
      type: 'one_to_many',
      bankIds: [b.id],
      ledgerIds: g.map((x) => x.id),
      bankAmount: b.amount,
      ledgerAmount: b.amount,
      difference: 0,
      confidence: g.length === 2 ? 0.88 : 0.8,
      rule: `one bank line = sum of ${g.length} ledger lines`,
      explanation: `${fmt(b.amount)} on the statement equals ${g.length} book entries (${g.map((x) => fmt(x.amount)).join(' + ')}), e.g. a batched deposit or payment.`,
    });
  }
  for (const l of ledger) {
    if (usedLedger.has(l.id)) continue;
    const pool = bank
      .filter((b) => !usedBank.has(b.id) && Math.sign(b.amount) === Math.sign(l.amount) && Math.abs(b.amount) < Math.abs(l.amount) && within(l, b))
      .sort((x, y) => Math.abs(diffDays(l.date, x.date)) - Math.abs(diffDays(l.date, y.date)));
    const group = subsetSum(l.amount, pool, opt.maxGroupSize);
    if (!group) continue;
    const g = group as MatchItem[];
    take({
      type: 'many_to_one',
      bankIds: g.map((x) => x.id),
      ledgerIds: [l.id],
      bankAmount: l.amount,
      ledgerAmount: l.amount,
      difference: 0,
      confidence: g.length === 2 ? 0.86 : 0.78,
      rule: `${g.length} bank lines = one ledger line`,
      explanation: `One book entry of ${fmt(l.amount)} cleared the bank in ${g.length} parts (${g.map((x) => fmt(x.amount)).join(' + ')}).`,
    });
  }

  // Leftovers: timing differences confirmed by next period's statement
  const usedNext = new Set<string>();
  const timing: TimingItem[] = [];
  const unmatchedLedger: MatchItem[] = [];
  for (const l of ledger) {
    if (usedLedger.has(l.id)) continue;
    const cleared = nextPeriodBank
      .filter((b) => !usedNext.has(b.id) && b.amount === l.amount && diffDays(b.date, l.date) >= 0 && diffDays(b.date, l.date) <= 15)
      .sort((x, y) => x.date.localeCompare(y.date))[0];
    if (cleared) usedNext.add(cleared.id);
    const kind = l.amount > 0 ? 'deposit_in_transit' : 'outstanding_check';
    if (l.date <= opt.periodEnd && (cleared || diffDays(opt.periodEnd, l.date) <= 4)) {
      timing.push({
        ledgerId: l.id,
        kind,
        amount: l.amount,
        date: l.date,
        clearedBankId: cleared?.id ?? null,
        clearedDate: cleared?.date ?? null,
        confidence: cleared ? 0.96 : 0.7,
        explanation: cleared
          ? `${kind === 'deposit_in_transit' ? 'Deposit' : 'Payment'} of ${fmt(l.amount)} booked ${l.date} cleared the bank on ${cleared.date} (next statement): a timing difference.`
          : `${kind === 'deposit_in_transit' ? 'Deposit' : 'Payment'} of ${fmt(l.amount)} booked ${l.date}, near period end; not on this statement yet.`,
      });
    } else {
      unmatchedLedger.push(l);
    }
  }

  const bankOnly: BankOnlyItem[] = [];
  for (const b of bank) {
    if (usedBank.has(b.id)) continue;
    const d = b.description.toLowerCase();
    if (b.amount < 0 && /\b(fee|fees|service charge|svc chg|analysis|maint|maintenance charge|wire charge)\b/.test(d) && Math.abs(b.amount) <= 250_000) {
      bankOnly.push({ bankId: b.id, kind: 'bank_fee', amount: b.amount, date: b.date, description: b.description, confidence: 0.92, explanation: `Bank-originated fee (${fmt(b.amount)}) not yet recorded in the books.` });
    } else if (b.amount > 0 && /\binterest\b|\bint (credit|paid)\b/.test(d)) {
      bankOnly.push({ bankId: b.id, kind: 'interest', amount: b.amount, date: b.date, description: b.description, confidence: 0.93, explanation: `Interest credited by the bank (${fmt(b.amount)}) not yet recorded.` });
    } else {
      bankOnly.push({ bankId: b.id, kind: 'unexplained', amount: b.amount, date: b.date, description: b.description, confidence: 0.4, explanation: `No ledger entry, fee pattern or interest pattern matches this ${b.amount < 0 ? 'withdrawal' : 'deposit'} of ${fmt(b.amount)}. Investigate before certifying.` });
    }
  }

  const matchedBank = usedBank.size;
  return {
    matches,
    timing,
    bankOnly,
    unmatchedLedger,
    stats: {
      bankItems: bank.length,
      ledgerItems: ledger.length,
      matchedBank,
      matchedLedger: usedLedger.size,
      autoMatchRate: bank.length ? matchedBank / bank.length : 1,
    },
  };
}
