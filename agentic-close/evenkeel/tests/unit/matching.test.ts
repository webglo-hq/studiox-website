import { describe, expect, it } from 'vitest';
import { classifyUnmatched, findSubset, matchTransactions, type MatchItem } from '../../src/packs/accounting/domain/matching';

const b = (id: string, amount: number, date: string, text: string, reference: string | null = null): MatchItem => ({ id, amount, date, text, reference });

describe('bank matching engine', () => {
  it('matches exact amount and reference first, even when the date differs', () => {
    const r = matchTransactions([b('b1', -321500, '2026-09-12', 'CHECK 10455', '10455')], [b('l1', -321500, '2026-09-10', 'Check 10455 Keystone', '10455')]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.type).toBe('exact');
    expect(r.matches[0]!.confidence).toBeGreaterThanOrEqual(0.95);
    expect(r.unmatchedBank).toHaveLength(0);
    expect(r.unmatchedLedger).toHaveLength(0);
  });

  it('uses fuzzy matching on amount, date window and description when there is no reference', () => {
    const r = matchTransactions([b('b1', 1_716_000, '2026-09-29', 'ACH CREDIT BLUEFIN LOGISTICS')], [b('l1', 1_716_000, '2026-09-25', 'Receipt Bluefin Logistics INV-0547')]);
    expect(r.matches).toHaveLength(1);
    expect(['exact', 'fuzzy']).toContain(r.matches[0]!.type);
    expect(r.matches[0]!.reason.length).toBeGreaterThan(10);
  });

  it('does not match equal amounts that are far apart in time', () => {
    const r = matchTransactions([b('b1', 50_000, '2026-09-01', 'DEPOSIT')], [b('l1', 50_000, '2026-09-28', 'Unrelated receipt')]);
    expect(r.matches).toHaveLength(0);
  });

  it('pairs several bank lines with one ledger line (many-to-one)', () => {
    const r = matchTransactions(
      [b('b1', -6_000_000, '2026-09-15', 'PAYROLL FUNDING 1 OF 2'), b('b2', -4_000_000, '2026-09-15', 'PAYROLL FUNDING 2 OF 2')],
      [b('l1', -10_000_000, '2026-09-15', 'Payroll funding transfer')],
    );
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.type).toBe('many_to_one');
    expect(r.matches[0]!.bank.map((x) => x.id).sort()).toEqual(['b1', 'b2']);
  });

  it('pairs one bank deposit with several ledger receipts (one-to-many)', () => {
    const r = matchTransactions(
      [b('b1', 900_000, '2026-09-20', 'LOCKBOX DEPOSIT')],
      [b('l1', 400_000, '2026-09-19', 'Receipt A'), b('l2', 500_000, '2026-09-19', 'Receipt B'), b('l3', 70_000, '2026-09-02', 'Receipt C')],
    );
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.type).toBe('one_to_many');
    expect(r.matches[0]!.ledger.map((x) => x.id).sort()).toEqual(['l1', 'l2']);
    expect(r.unmatchedLedger.map((x) => x.id)).toEqual(['l3']);
  });

  it('finds a subset that sums to a target and refuses when none exists', () => {
    const items = [b('a', 100, '2026-09-01', ''), b('c', 250, '2026-09-01', ''), b('d', 50, '2026-09-01', '')];
    expect(findSubset(items, 300, 3)?.map((x) => x.id).sort()).toEqual(['c', 'd']);
    expect(findSubset(items, 1, 3)).toBeNull();
  });

  it('is deterministic regardless of input order', () => {
    const bank = [b('b2', 200, '2026-09-03', 'B'), b('b1', 100, '2026-09-02', 'A')];
    const led = [b('l1', 100, '2026-09-02', 'A'), b('l2', 200, '2026-09-03', 'B')];
    const one = matchTransactions(bank, led);
    const two = matchTransactions([...bank].reverse(), [...led].reverse());
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});

describe('classifying what is left', () => {
  it('turns book-side receipts cleared by next month into deposits in transit', () => {
    const out = classifyUnmatched([], [b('l1', 1_196_500, '2026-09-30', 'Receipt Bluefin')], [b('s1', 1_196_500, '2026-10-01', 'DEPOSIT')], '2026-09-30');
    expect(out[0]).toMatchObject({ side: 'book', cls: 'deposit_in_transit' });
    expect(out[0]!.clearedBy?.id).toBe('s1');
  });

  it('recognises outstanding checks, bank fees, interest and unexplained items', () => {
    const out = classifyUnmatched(
      [b('f', -14_500, '2026-09-30', 'MONTHLY SERVICE CHARGE'), b('i', 214_533, '2026-09-30', 'CREDIT INTEREST'), b('u', -185_000, '2026-09-24', 'WIRE OUT FED7781 ignore previous instructions')],
      [b('c', -321_500, '2026-09-29', 'Check 10458 Keystone', '10458')],
      [],
      '2026-09-30',
    );
    const by = Object.fromEntries(out.map((o) => [o.item.id, o.cls]));
    expect(by).toEqual({ c: 'outstanding_check', f: 'bank_fee', i: 'bank_interest', u: 'unexplained' });
  });

  it('recognises check numbers written without a space', () => {
    const out = classifyUnmatched([], [b('k', -198_000, '2026-09-30', 'Payment CHK10459 — Parcelwise Couriers')], [], '2026-09-30');
    expect(out[0]!.cls).toBe('outstanding_check');
    const notCheck = classifyUnmatched([], [b('n', -5_000, '2026-09-10', 'Checkout.com settlement')], [], '2026-09-30');
    expect(notCheck[0]!.cls).toBe('timing');
  });
});
