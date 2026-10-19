import { describe, expect, it } from 'vitest';
import { matchBankToLedger, type MatchItem } from './matching';
import { normalizeDocNumber, similarity } from './text';

const b = (id: string, date: string, amount: number, description: string, reference?: string): MatchItem => ({ id, date, amount, description, reference });

describe('bank matching engine', () => {
  it('matches exactly on amount + reference, and on amount + same date', () => {
    const r = matchBankToLedger(
      [b('b1', '2026-09-10', -1_840_000, 'ACH DEBIT COPPERLINE LEGAL INV-20931'), b('b2', '2026-09-12', 865_000, 'DEPOSIT HALCYON FREIGHT')],
      [b('l1', '2026-09-09', -1_840_000, 'Payment Copperline Legal INV-20931'), b('l2', '2026-09-12', 865_000, 'Receipt Halcyon Freight')],
      { periodEnd: '2026-09-30' },
    );
    expect(r.matches.map((m) => [m.type, m.bankIds[0], m.ledgerIds[0], m.confidence >= 0.97])).toEqual([
      ['exact', 'b1', 'l1', true],
      ['exact', 'b2', 'l2', true],
    ]);
    expect(r.matches[0]!.rule).toMatch(/reference/);
  });

  it('resolves same-amount ambiguity by description and date proximity', () => {
    const r = matchBankToLedger(
      [b('b1', '2026-09-15', -45_000, 'FIGMA INC SAN FRANCISCO')],
      [b('l1', '2026-09-13', -45_000, 'Notion Labs subscription'), b('l2', '2026-09-14', -45_000, 'Figma subscription')],
      { periodEnd: '2026-09-30' },
    );
    expect(r.matches[0]!.ledgerIds).toEqual(['l2']);
    expect(r.matches[0]!.confidence).toBeLessThan(0.97);
  });

  it('fuzzy-matches a wire with a netted fee and reports the difference', () => {
    const r = matchBankToLedger(
      [b('b1', '2026-09-20', -1_002_500, 'WIRE OUT NIMBUS CLOUD SVCS')],
      [b('l1', '2026-09-19', -1_000_000, 'Nimbus Cloud Services payment')],
      { periodEnd: '2026-09-30' },
    );
    expect(r.matches[0]!.type).toBe('fuzzy');
    expect(r.matches[0]!.difference).toBe(-2_500);
  });

  it('finds one-to-many (batched deposit) and many-to-one (split clearing) groups', () => {
    const oneToMany = matchBankToLedger(
      [b('b1', '2026-09-18', 300_000, 'BATCH DEPOSIT')],
      [b('l1', '2026-09-17', 100_000, 'Receipt A'), b('l2', '2026-09-17', 150_000, 'Receipt B'), b('l3', '2026-09-18', 50_000, 'Receipt C'), b('l4', '2026-09-18', 70_000, 'Receipt D')],
      { periodEnd: '2026-09-30' },
    );
    const g = oneToMany.matches.find((m) => m.type === 'one_to_many')!;
    expect(g.ledgerIds.sort()).toEqual(['l1', 'l2', 'l3']);
    const manyToOne = matchBankToLedger(
      [b('b1', '2026-09-30', -400_000, 'PAYROLL FUNDING 1'), b('b2', '2026-09-30', -250_000, 'PAYROLL FUNDING 2')],
      [b('l1', '2026-09-30', -650_000, 'Payroll Sep 30 net pay')],
      { periodEnd: '2026-09-30' },
    );
    expect(manyToOne.matches[0]!.type).toBe('many_to_one');
    expect(manyToOne.matches[0]!.bankIds.sort()).toEqual(['b1', 'b2']);
  });

  it('classifies timing differences using next-period bank activity', () => {
    const r = matchBankToLedger(
      [],
      [b('l1', '2026-09-29', -420_000, 'Check 10422 Brightline Facilities'), b('l2', '2026-09-30', 1_210_000, 'Receipt Orchard Analytics')],
      { periodEnd: '2026-09-30' },
      [b('n1', '2026-10-02', -420_000, 'CHECK 10422'), b('n2', '2026-10-01', 1_210_000, 'DEPOSIT ORCHARD')],
    );
    expect(r.timing.map((t) => [t.kind, t.clearedBankId])).toEqual([
      ['outstanding_check', 'n1'],
      ['deposit_in_transit', 'n2'],
    ]);
  });

  it('classifies bank-only items as fees, interest or unexplained', () => {
    const r = matchBankToLedger(
      [b('b1', '2026-09-30', -8_500, 'ACCOUNT ANALYSIS FEE'), b('b2', '2026-09-30', 12_345, 'INTEREST CREDIT'), b('b3', '2026-09-22', -125_000, 'ACH WD ORIGIN 4471 TRN 99812')],
      [],
      { periodEnd: '2026-09-30' },
    );
    expect(r.bankOnly.map((x) => x.kind)).toEqual(['unexplained', 'bank_fee', 'interest']);
    expect(r.stats.autoMatchRate).toBe(0);
  });

  it('is deterministic regardless of input order', () => {
    const bank = [b('b1', '2026-09-05', -10_000, 'A'), b('b2', '2026-09-05', -10_000, 'B'), b('b3', '2026-09-06', 5_000, 'C')];
    const ledger = [b('l1', '2026-09-05', -10_000, 'A'), b('l2', '2026-09-05', -10_000, 'B'), b('l3', '2026-09-06', 5_000, 'C')];
    const one = matchBankToLedger(bank, ledger, { periodEnd: '2026-09-30' });
    const two = matchBankToLedger([...bank].reverse(), [...ledger].reverse(), { periodEnd: '2026-09-30' });
    expect(one.matches).toEqual(two.matches);
  });

  it('text helpers normalize document numbers and score similarity', () => {
    expect(normalizeDocNumber('INV-20931')).toBe(normalizeDocNumber('INV20931'));
    expect(similarity('NIMBUS CLD SVCS', 'Nimbus Cloud Services')).toBeGreaterThan(0.45);
    expect(similarity('FIGMA', 'Payroll')).toBeLessThan(0.3);
  });
});
