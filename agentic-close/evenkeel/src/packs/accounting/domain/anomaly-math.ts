import { dayOfWeek, diffDays } from '../../../framework/util/dates';

/**
 * Journal-entry testing (PCAOB AS 2401.58–.62 style) and Benford first-digit analysis
 * (Nigrini 2012). Pure functions over plain facts.
 */

export interface EntryFact {
  id: string;
  entryNumber: string;
  entryDate: string;
  entryType: string;
  source: string;
  memo: string;
  amount: number;
  preparedBy: string | null;
  approvedBy: string | null;
  externalPreparer: string | null;
  externalApprover: string | null;
  postedAt: string | null;
  externalPostedAt: string | null;
  accountsDebited: string[];
  accountsCredited: string[];
  controlAccountsTouched: string[];
  revenueTouched: boolean;
}

export interface PaymentFact {
  id: string;
  vendorId: string;
  vendorName: string;
  billId: string | null;
  billNumber: string | null;
  amount: number;
  paymentDate: string;
  method: string;
  reference: string;
}

export interface Finding {
  test: 'duplicate_payment' | 'sod_break' | 'round_amount' | 'weekend_posting' | 'after_hours' | 'control_account_posting' | 'threshold_avoidance' | 'unusual_account_pair' | 'benford_deviation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  subjectIds: string[];
  title: string;
  detail: string;
  amount?: number;
}

export function duplicatePayments(payments: PaymentFact[], windowDays = 45): Finding[] {
  const out: Finding[] = [];
  const sorted = [...payments].sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    if (seen.has(a.id)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (diffDays(b.paymentDate, a.paymentDate) > windowDays) break;
      if (seen.has(b.id) || a.vendorId !== b.vendorId || a.amount !== b.amount) continue;
      const sameBill = (a.billId && a.billId === b.billId) || (a.billNumber && a.billNumber === b.billNumber);
      if (!sameBill) continue;
      seen.add(b.id);
      out.push({
        test: 'duplicate_payment',
        severity: 'high',
        subjectIds: [a.id, b.id],
        title: `Duplicate payment to ${a.vendorName}`,
        detail: `Invoice ${a.billNumber ?? '(unknown)'} was paid twice: ${a.method.toUpperCase()} ${a.reference} on ${a.paymentDate} and ${b.method.toUpperCase()} ${b.reference} on ${b.paymentDate}.`,
        amount: b.amount,
      });
    }
  }
  return out;
}

export function sodBreaks(entries: EntryFact[]): Finding[] {
  return entries
    .filter((e) => (e.preparedBy && e.preparedBy === e.approvedBy) || (e.externalPreparer && e.externalPreparer === e.externalApprover))
    .map((e) => ({
      test: 'sod_break' as const,
      severity: 'high' as const,
      subjectIds: [e.id],
      title: `${e.entryNumber} was prepared and approved by the same person`,
      detail: `Preparer and approver are both ${e.externalPreparer ?? 'the same user'}${e.externalPreparer ? ' (source ERP user)' : ''}. Segregation of duties requires a second person.`,
      amount: e.amount,
    }));
}

export function roundAmounts(entries: EntryFact[], minAmount = 1_000_000, unit = 100_000): Finding[] {
  return entries
    .filter((e) => (e.source === 'manual' || e.source === 'import') && e.amount >= minAmount && e.amount % unit === 0)
    .map((e) => ({
      test: 'round_amount' as const,
      severity: 'medium' as const,
      subjectIds: [e.id],
      title: `${e.entryNumber} is a round-dollar manual entry`,
      detail: `Manual entries in exact thousands are a classic indicator of estimates or management override.`,
      amount: e.amount,
    }));
}

export function weekendPostings(entries: EntryFact[], hourOf: (iso: string) => number): Finding[] {
  const out: Finding[] = [];
  for (const e of entries) {
    if (e.source !== 'manual' && e.source !== 'import') continue;
    const when = e.externalPostedAt ?? e.postedAt;
    const dow = dayOfWeek(e.entryDate);
    const weekend = dow === 0 || dow === 6;
    const hour = when ? hourOf(when) : 12;
    const afterHours = hour < 6 || hour >= 21;
    if (weekend || afterHours) {
      out.push({
        test: weekend ? 'weekend_posting' : 'after_hours',
        severity: 'medium',
        subjectIds: [e.id],
        title: `${e.entryNumber} was ${weekend ? 'dated on a weekend' : 'posted after hours'}`,
        detail: `${weekend ? `Entry date ${e.entryDate} is a ${dow === 0 ? 'Sunday' : 'Saturday'}` : 'Posted'}${afterHours && when ? ` at ${String(hour).padStart(2, '0')}:00 local time` : ''}.`,
        amount: e.amount,
      });
    }
  }
  return out;
}

export function controlAccountPostings(entries: EntryFact[]): Finding[] {
  return entries
    .filter((e) => e.source === 'manual' && e.controlAccountsTouched.length > 0)
    .map((e) => ({
      test: 'control_account_posting' as const,
      severity: 'medium' as const,
      subjectIds: [e.id],
      title: `${e.entryNumber} posts manually to a control account`,
      detail: `Manual postings to ${e.controlAccountsTouched.join(', ')} bypass the subledger and break its tie-out.`,
      amount: e.amount,
    }));
}

export function thresholdAvoidance(entries: EntryFact[], threshold: number): Finding[] {
  return entries
    .filter((e) => e.source === 'manual' && e.amount >= threshold * 0.95 && e.amount < threshold)
    .map((e) => ({
      test: 'threshold_avoidance' as const,
      severity: 'low' as const,
      subjectIds: [e.id],
      title: `${e.entryNumber} is just below the approval threshold`,
      detail: `Amount sits within 5% under the ${threshold / 100} approval threshold.`,
      amount: e.amount,
    }));
}

export function unusualPairs(entries: EntryFact[], knownPairs: Set<string>): Finding[] {
  const out: Finding[] = [];
  for (const e of entries) {
    if (e.source !== 'manual' && e.source !== 'import') continue;
    const pairs = e.accountsDebited.flatMap((d) => e.accountsCredited.map((c) => `${d}>${c}`));
    const novel = pairs.filter((p) => !knownPairs.has(p));
    if (novel.length && e.revenueTouched) {
      out.push({
        test: 'unusual_account_pair',
        severity: 'medium',
        subjectIds: [e.id],
        title: `${e.entryNumber} uses an account combination never seen before`,
        detail: `New debit/credit pairing(s) ${novel.join(', ')} on a revenue entry.`,
        amount: e.amount,
      });
    }
  }
  return out;
}

export interface BenfordResult {
  n: number;
  observed: number[];
  expected: number[];
  mad: number;
  chiSquare: number;
  conformity: 'close' | 'acceptable' | 'marginal' | 'nonconformity' | 'insufficient_data';
  spikes: { digit: number; z: number }[];
}

/** First-digit Benford test with Nigrini's MAD conformity bands. */
export function benfordFirstDigit(amounts: number[]): BenfordResult {
  const expected = Array.from({ length: 9 }, (_, i) => Math.log10(1 + 1 / (i + 1)));
  const counts = new Array<number>(9).fill(0);
  let n = 0;
  for (const a of amounts) {
    const v = Math.abs(a) / 100;
    if (v < 10) continue; // Nigrini: ignore amounts below $10
    const d = Number(String(Math.floor(v))[0]);
    if (d >= 1 && d <= 9) {
      counts[d - 1]!++;
      n++;
    }
  }
  const observed = counts.map((c) => (n ? c / n : 0));
  const mad = n ? observed.reduce((s, o, i) => s + Math.abs(o - expected[i]!), 0) / 9 : 0;
  const chiSquare = n ? counts.reduce((s, c, i) => s + (c - n * expected[i]!) ** 2 / (n * expected[i]!), 0) : 0;
  const spikes = observed
    .map((o, i) => {
      const p = expected[i]!;
      const z = n ? (Math.abs(o - p) - 1 / (2 * n)) / Math.sqrt((p * (1 - p)) / n) : 0;
      return { digit: i + 1, z: Math.round(z * 100) / 100 };
    })
    .filter((s) => s.z > 1.96);
  let conformity: BenfordResult['conformity'];
  if (n < 100) conformity = 'insufficient_data';
  else if (mad < 0.006) conformity = 'close';
  else if (mad < 0.012) conformity = 'acceptable';
  else if (mad < 0.015) conformity = 'marginal';
  else conformity = 'nonconformity';
  return { n, observed, expected, mad: Math.round(mad * 10000) / 10000, chiSquare: Math.round(chiSquare * 100) / 100, conformity, spikes };
}
