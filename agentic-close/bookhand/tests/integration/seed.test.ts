import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/audit/audit';
import { importDocument } from '../../src/integrations/importer';
import { consolidatedTrialBalance, entityTrialBalance, checkTrialBalance } from '../../src/packs/accounting/domain/reporting';
import { errorsOf, verifyDraft, type EntryDraft } from '../../src/packs/accounting/domain/ledger';
import { LedgerLookups } from '../../src/packs/accounting/domain/lookups';
import { generateScenario } from '../../src/packs/accounting/seed/generator';
import { seedScenario, type SeedResult } from '../../src/packs/accounting/seed/loader';
import type { Db } from '../../src/persistence/db';
import { configurePasswordHashing, DEMO_SCRYPT, verifyPassword } from '../../src/security/passwords';
import { fixedClock } from '../../src/shared/context';
import { adapterCases } from './helpers';

configurePasswordHashing({ params: DEMO_SCRYPT });

describe('scenario generator', () => {
  it('is deterministic (same seed, byte-identical dataset)', () => {
    const a = generateScenario();
    const b = generateScenario();
    expect(JSON.stringify(a.journals)).toBe(JSON.stringify(b.journals));
    expect(JSON.stringify(a.files)).toBe(JSON.stringify(b.files));
    expect(a.closedMonths).toHaveLength(12);
  });

  it('every seeded journal passes the ontology axioms', async () => {
    const data = generateScenario();
    const db = (await adapterCases({ pglite: false, server: false })[0]!.open()).db;
    // Lookups need rows; build them from the dataset directly (no database round-trip needed).
    const lookups = new LedgerLookups(data.ids.tenant, {
      accounts: (data.rows.accounts ?? []).map((a) => ({ is_postable: true, status: 'active', parent_id: null, xbrl_element: null, description: null, created_at: '', ...a })) as never,
      entities: (data.rows.entities ?? []).map((e) => ({ ownership_pct: 1, status: 'active', created_at: '', parent_entity_id: null, ...e })) as never,
      departments: (data.rows.departments ?? []) as never,
      locations: (data.rows.locations ?? []) as never,
      classes: (data.rows.classes ?? []) as never,
      projects: (data.rows.projects ?? []) as never,
      periods: (data.rows.periods ?? []) as never,
    });
    void db;
    const failures: string[] = [];
    for (const j of data.journals) {
      const draft: EntryDraft = {
        entity: j.header.entity_id,
        date: j.header.entry_date,
        type: j.header.entry_type,
        description: j.header.description,
        currency: j.header.currency,
        fxRate: j.header.fx_rate,
        reversesEntryId: j.header.reverses_entry_id,
        autoReverseDate: j.header.auto_reverse_date,
        lines: j.lines.map((l) => ({ account: l.account_id, debit: l.debit_minor, credit: l.credit_minor, department: l.department_id, counterpartyEntity: l.counterparty_entity_id, txnCurrency: l.txn_currency, txnAmount: l.txn_amount_minor, memo: l.memo })),
      };
      const errors = errorsOf(verifyDraft(lookups, draft).violations);
      if (errors.length) failures.push(`${j.header.entry_number} ${j.header.description}: ${errors.map((e) => `${e.axiom} ${e.message}`).join('; ')}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

for (const adapter of adapterCases()) {
  describe(`seeded Brambleway scenario on ${adapter.name}`, () => {
    let db: Db;
    let close: () => Promise<void>;
    let seed: SeedResult;

    beforeAll(async () => {
      ({ db, close } = await adapter.open());
      seed = await seedScenario(db);
    }, 180_000);
    afterAll(async () => close?.());

    it('posts every journal and balances every entity trial balance in every period', async () => {
      await db.read(async (tx) => {
        expect(await tx.count('journal_entries', { status: { ne: 'posted' } })).toBe(0);
        const lookups = await LedgerLookups.load(tx, seed.tenantId);
        let checked = 0;
        for (const e of lookups.entitiesById.values()) {
          for (const p of lookups.periodsOf(e.id)) {
            if (p.status === 'future') continue;
            const tb = await entityTrialBalance(tx, lookups, e.id, p.id, 'balance');
            expect(tb.totalDebit, `${e.code} ${p.name}`).toBe(tb.totalCredit);
            expect(checkTrialBalance(tb).filter((v) => v.severity === 'error')).toEqual([]);
            checked++;
          }
        }
        expect(checked).toBeGreaterThanOrEqual(39);
        const consolidated = await consolidatedTrialBalance(tx, lookups, 2026, 8, 'USD', 'balance');
        expect(consolidated.totalDebit).toBe(consolidated.totalCredit);
      });
    });

    it('locks the twelve closed months and leaves September open', async () => {
      await db.read(async (tx) => {
        const periods = await tx.find('periods', { tenant_id: seed.tenantId });
        expect(periods.filter((p) => p.status === 'locked')).toHaveLength(36);
        const sep = periods.filter((p) => p.fiscal_year === 2026 && p.period_number === 9);
        expect(sep.every((p) => p.status === 'open')).toBe(true);
        const close = await tx.get('closes', seed.closeId);
        expect(close?.status).toBe('in_progress');
        const tasks = await tx.find('close_tasks', { close_id: seed.closeId });
        expect(tasks.length).toBeGreaterThanOrEqual(20);
        expect(tasks.filter((t) => t.status === 'done').map((t) => t.key).sort()).toEqual(['ap-cutoff', 'ap-cutoff', 'import-bank', 'import-bank']);
      });
    });

    it('plants every close issue the agents must find', async () => {
      const m = seed.dataset.manifest;
      await db.read(async (tx) => {
        const t = seed.tenantId;
        const vendors = await tx.find('vendors', { tenant_id: t });
        const vendor = (name: string) => vendors.find((v) => v.name === name)!;
        // 1. Unrecorded liabilities: Nimbus has no September bill; PO-1042 received but unbilled; BF-778 held as draft.
        const nimbus = await tx.find('bills', { vendor_id: vendor('Nimbus Cloud Services').id });
        expect(nimbus.some((b) => b.service_start === '2026-08-01')).toBe(true);
        expect(nimbus.some((b) => b.service_start === '2026-09-01')).toBe(false);
        const po = await tx.findOne('purchase_orders', { po_number: 'PO-1042' });
        const poLine = (await tx.find('purchase_order_lines', { purchase_order_id: po!.id }))[0]!;
        expect([poLine.received_amount_minor, poLine.billed_amount_minor]).toEqual([2_400_000, 0]);
        expect((await tx.findOne('bills', { bill_number: 'BF-778' }))?.status).toBe('draft');
        // 2. Duplicate payment of one Copperline invoice entered twice.
        const copper = vendor('Copperline Legal LLP');
        const dupBills = (await tx.find('bills', { vendor_id: copper.id, amount_minor: 1_840_000 })).map((b) => b.bill_number).sort();
        expect(dupBills).toEqual(['INV-20931', 'INV20931']);
        const payments = await tx.find('vendor_payments', { vendor_id: copper.id, amount_minor: 1_840_000 });
        expect(payments).toHaveLength(2);
        // 3. Laptop order posted to Office supplies.
        const laptop = await tx.findOne('card_transactions', { external_id: m.misclassifiedSpend.externalId });
        expect(laptop?.status).toBe('posted');
        expect(laptop?.coded_account_id).toBe(seed.dataset.ids.accounts['6600']);
        // 4/5. Bank: Orchard wire in transit, check 10422 outstanding, unexplained ACH.
        const bank = await tx.find('bank_transactions', { tenant_id: t, booking_date: { between: ['2026-09-01', '2026-10-02'] } });
        expect(bank.some((b) => b.description.includes('ORIGIN 4471') && b.amount_minor === -125_000 && b.booking_date === '2026-09-22')).toBe(true);
        expect(bank.some((b) => b.description.includes('ORCHARD') && b.booking_date === '2026-10-01')).toBe(true);
        expect(bank.some((b) => b.description === 'CHECK 10422' && b.booking_date === '2026-10-02')).toBe(true);
        expect(bank.some((b) => b.description.includes('IGNORE PRIOR RULES'))).toBe(true);
        // 6. Intercompany mismatch on the September management fee.
        const ic = await tx.find('journal_entries', { ic_reference: m.intercompanyMismatch.reference });
        expect(ic.map((j) => j.total_minor).sort()).not.toEqual([9_250_000, 9_250_000]);
        // 8. Ironclad premium sits in prepaid insurance with no schedule.
        const ironcladSchedules = await tx.find('amortization_schedules', { vendor_id: vendor('Ironclad Mutual Insurance').id, start_date: '2026-08-01' });
        expect(ironcladSchedules).toHaveLength(0);
        // 9. SoD break imported from the legacy ERP.
        const erp = await tx.findOne('journal_entries', { external_ref: m.sodBreak.externalRef });
        expect(erp?.status).toBe('posted');
        expect(erp?.external_prepared_by).toBe(erp?.external_approved_by);
      });
    });

    it('keeps the audit chain intact, demo passwords verify, and re-imports are no-ops', async () => {
      await db.read(async (tx) => {
        const chain = await verifyAuditChain(tx, seed.tenantId);
        expect(chain.ok).toBe(true);
        const maya = await tx.findOne('users', { email: seed.logins.find((l) => l.key === 'maya')!.email });
        expect((await verifyPassword(seed.password, maya!.password_hash)).ok).toBe(true);
        expect((await verifyPassword('wrong-password', maya!.password_hash)).ok).toBe(false);
      });
      const file = seed.dataset.files[0]!;
      const again = await db.tx(async (tx) =>
        importDocument(tx, { db, tenantId: seed.tenantId, actor: { type: 'system', userId: null, label: 'test' }, clock: fixedClock('2026-10-02T09:00:00.000Z', '2026-10-02') }, await LedgerLookups.load(tx, seed.tenantId), { adapterKey: file.adapterKey, filename: file.filename, content: file.content }),
      );
      expect(again.alreadyImported).toBe(true);
      expect(again.created).toBe(0);
    });
  });
}
