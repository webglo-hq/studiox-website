import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../../src/schema/factory';
import { seedScenario, DEMO_TENANT_ID } from '../../src/packs/accounting/seed/scenario';
import { DEMO_SCRYPT, PasswordHasher, nobleScrypt } from '../../src/core/auth/password';
import { Chart } from '../../src/packs/accounting/ledger/chart';
import { balancesAsOf, trialBalanceRows } from '../../src/packs/accounting/ledger/balances';
import { consolidatedStatements, entityStatements } from '../../src/packs/accounting/ledger/statements';

describe('demo scenario (memory store)', () => {
  it('seeds a balanced, consistent ledger', async () => {
    const db = createMemoryDb();
    const hasher = new PasswordHasher(nobleScrypt, DEMO_SCRYPT);
    const t0 = Date.now();
    const summary = await seedScenario(db, { demoPassword: 'close-the-books', hashPassword: (p) => hasher.hash(p) });
    const ms = Date.now() - t0;
    console.info('seed counts', summary.counts, `${ms}ms`);
    expect(summary.counts.journal_entries).toBeGreaterThan(2000);
    await db.tx(DEMO_TENANT_ID, async (tx) => {
      const chart = await Chart.load(tx);
      for (const e of chart.entities) {
        const bal = await balancesAsOf(tx, [e.id], '2026-09-30');
        const tb = trialBalanceRows(chart, bal);
        expect(tb.totalDebitMinor, e.code).toBe(tb.totalCreditMinor);
        const st = await entityStatements(tx, chart, e.id, '2026-08');
        expect(st.checks.balanced, `${e.code} BS balances`).toBe(true);
      }
      const cons = await consolidatedStatements(tx, chart, '2026-08');
      expect(cons.checks.balanced).toBe(true);
    });
  }, 120_000);
});
