/**
 * Financial statements against an independent reading of the ledger (independent review,
 * 2026-10-19): every income statement's net income equals the income and expenses posted in its
 * period (AX-FS-01), the year-end close is not December activity, and a statement that would not
 * tie is refused by the statements module and by the package and lock gates.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR } from '../../src/core/audit/audit';
import type { MemoryStore } from '../../src/core/store/memory';
import { scenarioClock } from '../../src/core/util/time';
import { bramblewoodFixture, type EvalFixture } from '../../src/packs/accounting/evals/harness';
import { Chart } from '../../src/packs/accounting/ledger/chart';
import { consolidatedStatements, entityStatements, incomeStatementTies } from '../../src/packs/accounting/ledger/statements';
import { SCENARIO } from '../../src/packs/accounting/seed/company';
import { AccountingServices } from '../../src/packs/accounting/services';
import { readLedger } from '../support/ledger';

let fx: EvalFixture;
const OTHER = ['7000', '7100', '7110', '7120'];

beforeAll(async () => {
  fx = await bramblewoodFixture();
}, 120_000);
beforeEach(async () => {
  await (fx.db as unknown as MemoryStore<unknown>).restore(fx.snapshot);
});

describe('income statements tie to the ledger (AX-FS-01)', () => {
  it('TO-ACC-C1: net income and other income (expense) equal the ledger for every entity and month, eliminations included', async () => {
    await fx.db.tx(fx.tenantId, async (tx) => {
      const chart = await Chart.load(tx);
      const l = await readLedger(tx);
      for (const e of chart.entities) {
        for (const pk of ['2025-12', '2026-01', '2026-06', '2026-08', SCENARIO.closeKey]) {
          const s = await entityStatements(tx, chart, e.id, pk);
          expect(s.netIncomeMinor, `${e.code} ${pk} net income`).toBe(l.pnl(e.id, pk));
          expect(s.incomeStatement.find((x) => x.code === 'IS.T.NI')!.amountMinor, `${e.code} ${pk} net income line`).toBe(l.pnl(e.id, pk));
          // "Other income (expense), net" is income-positive: interest earned and FX gains raise it
          expect(s.incomeStatement.find((x) => x.code === 'IS.OTHER')?.amountMinor ?? 0, `${e.code} ${pk} other income`).toBe(l.pnl(e.id, pk, { codes: OTHER }));
        }
      }
      // the booked interest is what made the double negation visible
      expect(l.pnl(chart.entity('BWL-US').id, '2026-08', { codes: OTHER })).not.toBe(0);
    });
  });

  it('TO-ACC-C1: the consolidated income statement equals the translated ledger of every entity', async () => {
    await fx.db.tx(fx.tenantId, async (tx) => {
      const chart = await Chart.load(tx);
      const l = await readLedger(tx);
      for (const pk of ['2026-06', '2026-08']) {
        const c = await consolidatedStatements(tx, chart, pk);
        expect(c.netIncomeMinor, `consolidated ${pk}`).toBe(await l.consolidatedPnl(pk));
        expect(c.incomeStatement.find((x) => x.code === 'IS.T.NI')!.amountMinor).toBe(c.netIncomeMinor);
      }
      const ties = await incomeStatementTies(tx, chart, SCENARIO.closeKey);
      expect(ties.map((t) => t.statement)).toEqual(['BWL-US income statement', 'BWL-UK income statement', 'BWL-ELIM income statement', 'Consolidated income statement']);
      expect(ties.every((t) => t.ties && t.netIncomeMinor === t.ledgerNetIncomeMinor)).toBe(true);
    });
  });

  it('TO-ACC-C1: a statement that does not tie is refused, and the package and lock gates say which one', async () => {
    await fx.db.tx(fx.tenantId, async (tx) => {
      const chart = await Chart.load(tx);
      // a presentation mistake: an expense account mapped to no caption silently drops out of the P&L
      await tx.update('accounts', chart.account('6000').id, { fs_line_id: null });
      const mis = await Chart.load(tx);
      await expect(entityStatements(tx, mis, mis.entity('BWL-US').id, SCENARIO.closeKey)).rejects.toThrow(/^AX-FS-01: the BWL-US September 2026 income statement shows net income/);
      await expect(consolidatedStatements(tx, mis, SCENARIO.closeKey)).rejects.toThrow(/AX-FS-01/);
      const ties = await incomeStatementTies(tx, mis, SCENARIO.closeKey);
      expect(ties.filter((t) => !t.ties).map((t) => t.statement)).toEqual(['BWL-US income statement', 'BWL-UK income statement', 'Consolidated income statement']);
      const svc = new AccountingServices(tx, SYSTEM_ACTOR, scenarioClock(SCENARIO.businessDate));
      const readiness = await svc.close.readiness(SCENARIO.closeKey);
      expect(readiness.untiedStatements).toBe(3);
      expect(readiness.ready).toBe(false);
      expect(readiness.messages).toContain('3 income statements do not tie to the ledger (AX-FS-01)');
      await expect(svc.close.packageContent(SCENARIO.closeKey, 'test')).rejects.toThrow(/^AX-FS-01: /);
    });
  });
});

describe('the year-end close is not December activity', () => {
  it('TO-ACC-M2: December 2025 shows the month’s own result, and so does January’s prior-month column', async () => {
    await fx.db.tx(fx.tenantId, async (tx) => {
      const chart = await Chart.load(tx);
      const l = await readLedger(tx);
      const yec = [...l.entries.values()].filter((j) => String(j.source_ref ?? '').startsWith('YEC-'));
      expect(yec.length).toBe(3); // BWL-US, BWL-UK and the eliminations ledger
      expect(yec.every((j) => j.entry_type === 'closing' && j.posting_date === '2025-12-31')).toBe(true);
      const expected: Record<string, number> = { 'BWL-US': 11_596_820, 'BWL-UK': 10_247_254, 'BWL-ELIM': 0 };
      for (const e of chart.entities) {
        const dec = await entityStatements(tx, chart, e.id, '2025-12');
        const jan = await entityStatements(tx, chart, e.id, '2026-01');
        expect(l.pnl(e.id, '2025-12'), `${e.code} ledger December`).toBe(expected[e.code]);
        expect(dec.netIncomeMinor, `${e.code} December income statement`).toBe(expected[e.code]);
        expect(jan.incomeStatement.find((x) => x.code === 'IS.T.NI')!.priorMinor, `${e.code} January prior-month column`).toBe(expected[e.code]);
        // the balance sheet still reflects the close: the year's profit moved into retained earnings
        expect(dec.balanceSheet.find((x) => x.code === 'BS.EQ.NI')!.amountMinor, `${e.code} net income YTD after the close`).toBe(0);
        expect(dec.checks.balanced).toBe(true);
      }
    });
  });
});
