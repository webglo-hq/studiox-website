import { dayOfWeek, type BusinessCalendar } from '../../../shared/dates';
import { normalizeDocNumber } from './text';

/**
 * Journal-entry review and anomaly detection (PCAOB AS 2401-style JE testing): duplicates (including
 * duplicate vendor payments), round amounts, weekend/holiday postings, SoD breaks, manual entries to
 * control and revenue accounts, amounts just below approval limits, and Benford first-digit conformity.
 */

export type AnomalyKind =
  | 'duplicate_payment'
  | 'duplicate_entry'
  | 'round_amount'
  | 'weekend_posting'
  | 'holiday_posting'
  | 'sod_break'
  | 'control_account_manual'
  | 'revenue_manual'
  | 'just_below_limit'
  | 'benford';

export interface ReviewLine {
  accountNumber: string;
  accountName: string;
  accountClass: string;
  isControlAccount: boolean;
  debit: number;
  credit: number;
}

export interface ReviewEntry {
  id: string;
  entryNumber: string;
  entityId: string;
  date: string;
  type: string;
  source: string;
  description: string;
  total: number;
  lines: ReviewLine[];
  preparedBy: string | null;
  approvedBy: string | null;
  externalPreparedBy: string | null;
  externalApprovedBy: string | null;
  preparedByRunId: string | null;
}

export interface ReviewPayment {
  id: string;
  vendorId: string;
  vendorName: string;
  date: string;
  amount: number;
  reference: string;
  bills: Array<{ id: string; billNumber: string; amount: number; billDate: string }>;
}

export interface AnomalyFinding {
  kind: AnomalyKind;
  severity: 'high' | 'medium' | 'low';
  score: number;
  title: string;
  why: string;
  subjectIds: string[];
  amount: number;
  evidence: Array<{ type: string; id: string; label: string }>;
  recommendedAction: string;
  flags: AnomalyKind[];
}

const fmt = (m: number) => `$${(Math.abs(m) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const isManual = (e: ReviewEntry) => (e.source === 'manual' || e.source === 'import') && !['depreciation', 'amortization', 'revaluation', 'elimination', 'reversing'].includes(e.type);

/** Same vendor paid twice for the same invoice (normalized number) or the same amount within 10 days. */
export function detectDuplicatePayments(payments: ReviewPayment[]): AnomalyFinding[] {
  const findings: AnomalyFinding[] = [];
  const byVendor = new Map<string, ReviewPayment[]>();
  for (const p of payments) {
    const list = byVendor.get(p.vendorId) ?? [];
    list.push(p);
    byVendor.set(p.vendorId, list);
  }
  for (const list of byVendor.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.amount !== b.amount) continue;
        const aNums = new Set(a.bills.map((x) => normalizeDocNumber(x.billNumber)));
        const sharedInvoice = b.bills.find((x) => aNums.has(normalizeDocNumber(x.billNumber)));
        const days = Math.abs((Date.parse(b.date) - Date.parse(a.date)) / 86_400_000);
        if (!sharedInvoice && days > 10) continue;
        const invoiceNote = sharedInvoice
          ? `both settle invoice ${sharedInvoice.billNumber} (entered twice as ${a.bills.map((x) => x.billNumber).join(', ')} and ${b.bills.map((x) => x.billNumber).join(', ')})`
          : `same amount ${days.toFixed(0)} days apart`;
        findings.push({
          kind: 'duplicate_payment',
          severity: 'high',
          score: sharedInvoice ? 0.95 : 0.7,
          title: `Possible duplicate payment to ${a.vendorName}: ${fmt(a.amount)}`,
          why: `Two payments of ${fmt(a.amount)} to ${a.vendorName} on ${a.date} and ${b.date}; ${invoiceNote}.`,
          subjectIds: [a.id, b.id],
          amount: a.amount,
          evidence: [
            { type: 'vendor_payment', id: a.id, label: `${a.reference} on ${a.date}` },
            { type: 'vendor_payment', id: b.id, label: `${b.reference} on ${b.date}` },
            ...a.bills.map((x) => ({ type: 'bill', id: x.id, label: `Bill ${x.billNumber}` })),
            ...b.bills.map((x) => ({ type: 'bill', id: x.id, label: `Bill ${x.billNumber}` })),
          ],
          recommendedAction: 'Reclassify the second payment to a vendor refund receivable and request the refund; void the duplicate bill.',
          flags: ['duplicate_payment'],
        });
      }
    }
  }
  return findings;
}

/** Benford first-digit test (Nigrini 2012 MAD thresholds). */
export function benford(amounts: number[]): { n: number; mad: number; conformity: 'close' | 'acceptable' | 'marginal' | 'nonconformity' | 'insufficient'; observed: number[]; expected: number[] } {
  const counts = new Array(9).fill(0) as number[];
  let n = 0;
  for (const a of amounts) {
    const abs = Math.abs(a) / 100;
    if (abs < 10) continue;
    const digit = Number(String(Math.floor(abs)).replace(/^0+/, '')[0]);
    if (digit >= 1 && digit <= 9) {
      counts[digit - 1]!++;
      n++;
    }
  }
  const expected = counts.map((_, i) => Math.log10(1 + 1 / (i + 1)));
  const observed = counts.map((c) => (n ? c / n : 0));
  const mad = n ? observed.reduce((s, o, i) => s + Math.abs(o - expected[i]!), 0) / 9 : 0;
  const conformity = n < 50 ? 'insufficient' : mad <= 0.006 ? 'close' : mad <= 0.012 ? 'acceptable' : mad <= 0.015 ? 'marginal' : 'nonconformity';
  return { n, mad: Number(mad.toFixed(5)), conformity, observed, expected };
}

export interface ReviewOptions {
  calendar: BusinessCalendar;
  roundAmountMinMinor: number;
  approvalLimits: number[];
}

/** Per-entry red flags; multiple flags on one entry are merged into one finding with combined severity. */
export function reviewEntries(entries: ReviewEntry[], options: ReviewOptions): AnomalyFinding[] {
  const findings: AnomalyFinding[] = [];
  const seen = new Map<string, ReviewEntry>();
  for (const e of [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const flags: Array<{ kind: AnomalyKind; weight: number; text: string }> = [];
    const manual = isManual(e);
    // SoD: same person prepared and approved (internal or as recorded by the source ERP)
    if (e.preparedBy && e.approvedBy && e.preparedBy === e.approvedBy) flags.push({ kind: 'sod_break', weight: 0.6, text: 'prepared and approved by the same user' });
    if (e.externalPreparedBy && e.externalApprovedBy && e.externalPreparedBy.toLowerCase() === e.externalApprovedBy.toLowerCase()) {
      flags.push({ kind: 'sod_break', weight: 0.6, text: `prepared and approved by the same ERP user "${e.externalPreparedBy}"` });
    }
    if (manual) {
      const dow = dayOfWeek(e.date);
      if (dow === 0 || dow === 6) flags.push({ kind: 'weekend_posting', weight: 0.2, text: `dated on a ${dow === 0 ? 'Sunday' : 'Saturday'}` });
      else if (!options.calendar.isBusinessDay(e.date)) flags.push({ kind: 'holiday_posting', weight: 0.2, text: `dated on a bank holiday (${options.calendar.holidayName(e.date)})` });
      if (e.total >= options.roundAmountMinMinor && e.total % 100_000 === 0) flags.push({ kind: 'round_amount', weight: 0.15, text: `round amount ${fmt(e.total)}` });
      if (e.lines.some((l) => l.isControlAccount)) flags.push({ kind: 'control_account_manual', weight: 0.25, text: 'manual posting to a subledger control account' });
      if (e.lines.some((l) => l.accountClass === 'revenue' && l.credit > 0)) flags.push({ kind: 'revenue_manual', weight: 0.25, text: 'manual entry crediting revenue' });
      for (const limit of options.approvalLimits) {
        if (e.total < limit && e.total >= limit * 0.95) flags.push({ kind: 'just_below_limit', weight: 0.2, text: `${fmt(e.total)} is just below the ${fmt(limit)} approval limit` });
      }
      const key = `${e.entityId}|${e.total}|${e.lines.map((l) => `${l.accountNumber}:${l.debit}:${l.credit}`).sort().join(',')}`;
      const prior = seen.get(key);
      if (prior && Math.abs(Date.parse(e.date) - Date.parse(prior.date)) <= 3 * 86_400_000) {
        flags.push({ kind: 'duplicate_entry', weight: 0.5, text: `same accounts and amounts as ${prior.entryNumber} (${prior.date})` });
      }
      seen.set(key, e);
    }
    if (!flags.length) continue;
    const score = Math.min(0.99, flags.reduce((s, f) => s + f.weight, 0));
    const severity: AnomalyFinding['severity'] = score >= 0.6 ? 'high' : score >= 0.35 ? 'medium' : 'low';
    if (severity === 'low' && flags.length === 1 && flags[0]!.kind === 'round_amount') continue; // round amounts alone are noise
    const primary = flags.slice().sort((a, b) => b.weight - a.weight)[0]!;
    findings.push({
      kind: primary.kind,
      severity,
      score: Number(score.toFixed(3)),
      title: `${e.entryNumber}: ${flags.map((f) => f.kind.replace(/_/g, ' ')).join(', ')}`,
      why: `Entry ${e.entryNumber} (${fmt(e.total)}, "${e.description}") is ${flags.map((f) => f.text).join('; ')}.`,
      subjectIds: [e.id],
      amount: e.total,
      evidence: [{ type: 'journal_entry', id: e.id, label: `${e.entryNumber} on ${e.date}` }],
      recommendedAction: flags.some((f) => f.kind === 'sod_break')
        ? 'Have an independent reviewer examine the support; reverse the entry if it cannot be substantiated.'
        : flags.some((f) => f.kind === 'duplicate_entry')
          ? 'Confirm whether the entry was posted twice; reverse the duplicate.'
          : 'Review the support for this entry.',
      flags: flags.map((f) => f.kind),
    });
  }
  return findings.sort((a, b) => b.score - a.score || b.amount - a.amount);
}
