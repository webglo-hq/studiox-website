import { beforeAll, describe, expect, it } from 'vitest';
import { periodEnd } from '../../src/framework/util/dates';
import { convertCents } from '../../src/framework/util/money';
import { makeContext, systemActor, type ServiceContext } from '../../src/packs/accounting/domain/context';
import { ledgerBalances } from '../../src/packs/accounting/domain/queries';
import { accounts, entityByCode, fxRate } from '../../src/packs/accounting/domain/refdata';
import { buildStatement, consolidatedTrialBalance, trialBalance, type Statement } from '../../src/packs/accounting/domain/reporting';
import { SCENARIO } from '../../src/packs/accounting/seed/scenario';
import { computeFluxLines, DEFAULT_THRESHOLD, varianceDrivers } from '../../src/packs/accounting/services/flux';
import { statementsFor, type PackageContent } from '../../src/packs/accounting/services/package';
import { loadTestScenario, type Scenario } from '../shared/scenario';

/** Statements, consolidation and variance drivers on the seeded Kitewell scenario. */

const total = (st: Statement, label: string, column: 'amount' | 'comparison') => st.subtotals.find((s) => s.label === label)![column]!;

describe('financial statements on the seeded scenario', () => {
  let s: Scenario;
  let ctx: ServiceContext;
  beforeAll(async () => {
    s = await loadTestScenario();
    ctx = makeContext(s.db, s.info.tenantId, systemActor('test'), s.clock);
  }, 120_000);

  it('E-1: the prior-month balance-sheet column foots (current-year earnings counted once)', async () => {
    const august = '2026-08';
    for (const scope of ['consolidated', (await entityByCode(ctx, 'US')).id, (await entityByCode(ctx, 'UK')).id]) {
      const { bs } = await statementsFor(ctx, scope, august);
      // July (the comparison column) holds seven months of earnings: they must appear once.
      expect(total(bs, 'Total liabilities and equity', 'comparison')).toBe(total(bs, 'Total assets', 'comparison'));
      expect(total(bs, 'Total liabilities and equity', 'amount')).toBe(total(bs, 'Total assets', 'amount'));
      const equity = bs.sections.find((x) => x.name.startsWith('Equity'))!;
      const liabilities = bs.sections.filter((x) => x.name.startsWith('Liabilities')).reduce((t, x) => t + x.comparisonTotal!, 0);
      expect(liabilities + equity.comparisonTotal!).toBe(total(bs, 'Total assets', 'comparison'));
    }
    // The signed August package was built with the same statements.
    const pkg = (await s.db.find('close_package', { tenant_id: s.info.tenantId, period_key: august, status: 'final' }))[0]!;
    const content = pkg.content as unknown as PackageContent;
    const bs = content.consolidated.balanceSheet;
    expect(total(bs, 'Total liabilities and equity', 'comparison')).toBe(total(bs, 'Total assets', 'comparison'));
  });

  it('E-1: every column of every statement carries a footing check', async () => {
    const { bs, is } = await statementsFor(ctx, 'consolidated', SCENARIO.openPeriod);
    for (const st of [bs, is]) {
      expect(st.checks.map((c) => c.column)).toEqual(['current', 'comparison']);
      expect(st.checks.every((c) => c.ok && c.difference === 0)).toBe(true);
      expect(st.check.ok).toBe(true);
    }
    // A statement that does not foot in its comparison column says so in that column.
    const tbNow = await consolidatedTrialBalance(ctx, SCENARIO.openPeriod);
    const prior = await consolidatedTrialBalance(ctx, '2026-08');
    const cash = prior.rows.find((r) => r.code === '1000')!;
    const lopsided = { ...prior, rows: prior.rows.map((r) => (r === cash ? { ...r, net: r.net + 100, debit: r.debit + 100 } : r)) };
    const odd = await buildStatement(ctx, 'BS', tbNow, lopsided);
    expect(odd.checks.find((c) => c.column === 'current')!.ok).toBe(true);
    expect(odd.checks.find((c) => c.column === 'comparison')).toMatchObject({ ok: false, difference: 100 });
    expect(odd.check.ok).toBe(false);
  });

  it('ACC-M2: translates retained earnings at historical rates, leaving the CTA as the only plug', async () => {
    const pk = SCENARIO.openPeriod;
    const accs = await accounts(ctx);
    const re = [...accs.values()].find((a) => a.account_type === 'ek:RetainedEarningsAccount')!;
    const us = await entityByCode(ctx, 'US');
    const uk = await entityByCode(ctx, 'UK');
    const consol = await entityByCode(ctx, 'CONSOL');
    const reNet = (rows: { accountId: string; net: number }[]) => rows.find((r) => r.accountId === re.id)?.net ?? 0;
    const historical = await fxRate(ctx, 'GBP', 'USD', periodEnd(pk), 'historical');
    const closing = await fxRate(ctx, 'GBP', 'USD', periodEnd(pk), 'closing');
    expect(historical).toBe(1.25);
    // UK retained earnings: what was posted, at the historical rate, plus prior years' income
    // at the average rate of each month it was earned.
    let ukRe = 0;
    let ukPostedRe = 0;
    for (const r of await s.db.query(ledgerBalances, { tenantId: s.info.tenantId, entityIds: [uk.id], periodTo: pk, byPeriod: true })) {
      const a = accs.get(r.accountId)!;
      if (a.id === re.id) {
        ukPostedRe += r.debit - r.credit;
        ukRe += convertCents(r.debit - r.credit, historical);
      } else if ((a.account_class === 'revenue' || a.account_class === 'expense') && r.periodKey! < `${pk.slice(0, 4)}-01`) {
        ukRe += convertCents(r.debit - r.credit, await fxRate(ctx, 'GBP', 'USD', periodEnd(r.periodKey!), 'average'));
      }
    }
    expect(ukPostedRe).toBe(-31_983_481); // £319,834.81 credit
    expect(convertCents(ukPostedRe, historical)).toBe(-39_979_351); // $399,793.51, not $428,962.45 at the closing rate
    const consolidated = await consolidatedTrialBalance(ctx, pk);
    const expected = reNet((await trialBalance(ctx, us.id, pk)).rows) + ukRe + reNet((await trialBalance(ctx, consol.id, pk)).rows);
    expect(reNet(consolidated.rows)).toBe(expected);
    // Translating the posted balance at the closing rate would have moved $29,168.93 out of the CTA.
    expect(convertCents(ukPostedRe, closing) - convertCents(ukPostedRe, historical)).toBe(-2_916_894);
    expect(consolidated.balanced).toBe(true);
  });

  it('ACC-m2: budget-vs-actual drivers are measured against the budget and add up to the variance', async () => {
    let material = 0;
    for (const code of ['US', 'UK']) {
      const ent = await entityByCode(ctx, code);
      for (const comparison of ['budget', 'prior_month'] as const) {
        const lines = (await computeFluxLines(ctx, ent.id, SCENARIO.openPeriod, comparison, DEFAULT_THRESHOLD)).filter((l) => l.variance !== 0);
        material += lines.filter((l) => l.material).length;
        for (const l of lines) {
          const d = await varianceDrivers(ctx, { entityId: ent.id, accountId: l.accountId, periodKey: SCENARIO.openPeriod, comparison });
          expect(d.variance).toBe(l.variance);
          expect(d.drivers.reduce((t, x) => t + x.amount, 0), `${code} ${l.code} vs ${comparison}: ${JSON.stringify(d.drivers.map((x) => [x.label, x.amount]))}`).toBe(l.variance);
          expect(d.drivers.some((x) => x.label.startsWith('Not traced'))).toBe(false);
        }
      }
    }
    expect(material).toBeGreaterThan(0);
    // US marketing against budget: the unbudgeted Brightstage sponsorship is a named driver.
    const us = await entityByCode(ctx, 'US');
    const mkt = [...(await accounts(ctx)).values()].find((a) => a.code === '6400')!;
    const bva = await varianceDrivers(ctx, { entityId: us.id, accountId: mkt.id, periodKey: SCENARIO.openPeriod, comparison: 'budget' });
    expect(bva.drivers[0]!.label).toMatch(/Brightstage/);
    expect(bva.narrative).toMatch(/vs budget/);
  });
});
