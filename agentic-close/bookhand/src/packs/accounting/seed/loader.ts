import { appendAudit } from '../../../audit/audit';
import { importDocument, type ImportResult } from '../../../integrations/importer';
import type { Db, Tx } from '../../../persistence/db';
import type { Insert, TableName } from '../../../persistence/schema';
import { hashPassword } from '../../../security/passwords';
import { type Actor, type DomainContext, fixedClock, SYSTEM_ACTOR } from '../../../shared/context';
import { addDays, monthEnd, monthStart, usBusinessCalendar, workdayToDate } from '../../../shared/dates';
import { postCardTransaction } from '../domain/subledgers';
import { createClose } from '../domain/close';
import { LedgerLookups } from '../domain/lookups';
import { generateScenario, type SeedDataset } from './generator';
import { PEOPLE, SCENARIO } from './scenario';

/**
 * Loads the Brambleway scenario into any Db adapter. Journals are inserted as pending and then POSTED through the
 * database's posting validation (balance, period state, accounts), exactly like production postings; the open
 * month's source files are imported through the real parsers and import pipeline.
 */

export const DEMO_PASSWORD_DEFAULT = 'bookhand-demo';

export interface DemoLogin {
  key: string;
  email: string;
  name: string;
  role: string;
  title: string;
}

export interface SeedResult {
  tenantId: string;
  closeId: string;
  logins: DemoLogin[];
  password: string;
  dataset: SeedDataset;
  imports: ImportResult[];
  timings: Record<string, number>;
}

export interface SeedOptions {
  dataset?: SeedDataset;
  demoPassword?: string;
  log?: (message: string) => void;
  /** Runs inside the final transaction (framework layer: skills registry, policies). */
  extend?: (tx: Tx, ctx: DomainContext, seed: { tenantId: string; closeId: string; dataset: SeedDataset }) => Promise<void>;
}

const REFERENCE_ORDER: TableName[] = [
  'tenants',
  'entities',
  'roles',
  'users',
  'user_roles',
  'sod_rules',
  'departments',
  'locations',
  'classes',
  'projects',
  'accounts',
  'periods',
  'fx_rates',
  'bank_accounts',
  'cards',
  'vendors',
  'customers',
  'connectors',
  'budgets',
  'budget_lines',
  'materiality_settings',
];

const SUBLEDGER_ORDER: TableName[] = [
  'purchase_orders',
  'purchase_order_lines',
  'goods_receipts',
  'bills',
  'bill_lines',
  'vendor_payments',
  'payment_applications',
  'invoices',
  'invoice_lines',
  'customer_receipts',
  'receipt_applications',
  'card_transactions',
  'payroll_runs',
  'payroll_lines',
  'fixed_assets',
  'depreciation_lines',
  'amortization_schedules',
  'amortization_lines',
  'source_documents',
  'import_batches',
  'bank_statements',
  'bank_transactions',
];

async function insertChunked<T extends TableName>(tx: Tx, table: T, rows: Insert<T>[] | undefined, size = 400): Promise<void> {
  if (!rows?.length) return;
  for (let i = 0; i < rows.length; i += size) await tx.insertMany(table, rows.slice(i, i + size));
}

export async function seedScenario(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  const log = opts.log ?? (() => undefined);
  const timings: Record<string, number> = {};
  const t0 = Date.now();
  const lap = (label: string) => {
    timings[label] = Date.now() - t0 - Object.values(timings).reduce((s, x) => s + x, 0);
  };
  const data = opts.dataset ?? generateScenario();
  lap('generate');
  const password = opts.demoPassword ?? DEMO_PASSWORD_DEFAULT;
  const tenantId = data.ids.tenant;
  const U = data.ids.users;
  const userActor = (key: string, label?: string): Actor => ({ type: 'user', userId: U[key]!, label: label ?? PEOPLE.find((p) => p.key === key)!.name });
  const ctxAt = (tx: Tx, actor: Actor, nowIso: string): DomainContext => ({ db, tenantId, actor, clock: fixedClock(nowIso, nowIso.slice(0, 10)) });

  // Password hashes are computed before the transaction (scrypt is deliberately slow).
  const hashes: Record<string, string> = {};
  for (const p of PEOPLE) hashes[p.key] = await hashPassword(password);
  lap('hash');

  const result = await db.tx(async (tx) => {
    log('reference data');
    for (const table of REFERENCE_ORDER) {
      const rows = data.rows[table] as Insert<TableName>[] | undefined;
      if (table === 'users') {
        await insertChunked(tx, 'users', (rows as Insert<'users'>[]).map((u) => ({ ...u, password_hash: hashes[PEOPLE.find((p) => U[p.key] === u.id)!.key]! })));
      } else {
        await insertChunked(tx, table, rows);
      }
    }
    await appendAudit(tx, tenantId, SYSTEM_ACTOR, { action: 'tenant.provision', objectType: 'tenant', objectId: tenantId, summary: `Provisioned ${SCENARIO.tenantName} (fictional demo company)`, details: { scenario: SCENARIO.seed } }, '2025-08-15T14:00:00.000Z');

    log(`journals: ${data.journals.length}`);
    await insertChunked(tx, 'journal_entries', data.journals.map((j) => j.header), 300);
    await insertChunked(tx, 'journal_lines', data.journals.flatMap((j) => j.lines), 1000);
    for (const j of data.journals) {
      await tx.update('journal_entries', j.header.id!, {
        status: 'posted',
        approval_basis: j.basis,
        approved_by: j.approvedBy,
        approved_at: j.approvedBy ? j.postedAt : null,
        posted_at: j.postedAt,
      });
    }
    lap('journals');

    log('subledgers and documents');
    for (const table of SUBLEDGER_ORDER) await insertChunked(tx, table, data.rows[table] as Insert<TableName>[] | undefined);
    lap('subledgers');

    // Close history: lock every closed month (all entities) and record the closes.
    const lookups = await LedgerLookups.load(tx, tenantId);
    const cal = usBusinessCalendar();
    const assignees = { staff_accountant: U.maya!, ap_clerk: U.diego!, fpa_analyst: U.priya!, senior_accountant: U.daniel!, controller: U.hannah!, cfo: U.marcus! };
    for (const m of data.closedMonths) {
      const end = monthEnd(m.year, m.month);
      const wd1 = `${workdayToDate(end, 1, cal)}T13:00:00.000Z`;
      const detailed = data.closedMonths.indexOf(m) >= data.closedMonths.length - 3;
      let closeId: string;
      if (detailed) {
        const close = await createClose(tx, ctxAt(tx, userActor('hannah'), wd1), lookups, { fiscalYear: m.year, periodNumber: m.month, assignees });
        closeId = close.id;
        const tasks = await tx.find('close_tasks', { close_id: close.id }, { orderBy: [['sort_order', 'asc']] });
        for (const t of tasks) {
          const doneAt = `${t.due_date}T19:30:00.000Z`;
          const reviewedAt = `${t.due_date}T22:00:00.000Z`;
          await tx.update('close_tasks', t.id, { status: 'done', started_at: `${t.due_date}T14:00:00.000Z`, completed_at: doneAt, completed_by: t.owner_id, reviewed_at: t.reviewer_id ? reviewedAt : null, reviewed_by: t.reviewer_id });
          if (t.owner_id) await tx.insert('signoffs', { tenant_id: tenantId, object_type: 'close_task', object_id: t.id, role: 'preparer', user_id: t.owner_id, signed_at: doneAt });
          if (t.reviewer_id) await tx.insert('signoffs', { tenant_id: tenantId, object_type: 'close_task', object_id: t.id, role: 'reviewer', user_id: t.reviewer_id, signed_at: reviewedAt });
        }
        await tx.update('closes', close.id, { status: 'closed', closed_at: m.lockedAt, closed_by: U.hannah! });
      } else {
        const close = await tx.insert('closes', {
          tenant_id: tenantId,
          fiscal_year: m.year,
          period_number: m.month,
          name: `${new Date(`${end}T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${m.year} close`,
          period_end: end,
          status: 'closed',
          started_at: wd1,
          closed_at: m.lockedAt,
          closed_by: U.hannah!,
        });
        closeId = close.id;
      }
      for (const e of lookups.entitiesById.values()) {
        const p = lookups.period(e.id, m.year, m.month)!;
        await tx.update('periods', p.id, { status: 'soft_closed', soft_closed_at: m.lockedAt, soft_closed_by: U.hannah! });
        await tx.update('periods', p.id, { status: 'locked', locked_at: m.lockedAt, locked_by: U.hannah! });
        await tx.insert('signoffs', { tenant_id: tenantId, object_type: 'period', object_id: p.id, role: 'approver', user_id: U.hannah!, signed_at: m.lockedAt, comment: 'Period locked after close review' });
      }
      await appendAudit(tx, tenantId, userActor('hannah'), { action: 'period.lock', objectType: 'close', objectId: closeId, summary: `Locked ${monthStart(m.year, m.month).slice(0, 7)} for all entities`, details: { locked_at: m.lockedAt } }, m.lockedAt);
    }
    lap('history');

    // Prior-month reconciliations (August): bank recs carry their outstanding items into September.
    const last = data.closedMonths.at(-1)!;
    const lastEnd = monthEnd(last.year, last.month);
    const reviewedAt = `${workdayToDate(lastEnd, 4, cal)}T21:00:00.000Z`;
    for (const bank of await tx.find('bank_accounts', { tenant_id: tenantId })) {
      const account = lookups.accountsById.get(bank.gl_account_id)!;
      const period = lookups.period(bank.entity_id, last.year, last.month)!;
      const sums = await tx.sumLines({ tenantId, accountIds: [account.id], entityIds: [bank.entity_id], dateTo: lastEnd, groupBy: ['account_id'] });
      const gl = sums.reduce((s, x) => s + x.debit_minor - x.credit_minor, 0);
      const stmt = (await tx.find('bank_statements', { bank_account_id: bank.id, period_end: lastEnd }))[0];
      const outstanding = data.priorOutstanding.filter((o) => o.glAccount === account.number);
      const recTotal = outstanding.reduce((s, o) => s + o.amount, 0);
      const rec = await tx.insert('reconciliations', {
        tenant_id: tenantId,
        entity_id: bank.entity_id,
        period_id: period.id,
        rec_type: 'bank',
        account_id: account.id,
        bank_account_id: bank.id,
        currency: bank.currency,
        gl_balance_minor: gl,
        external_balance_minor: stmt?.closing_balance_minor ?? 0,
        reconciling_total_minor: recTotal,
        difference_minor: gl - (stmt?.closing_balance_minor ?? 0) - recTotal,
        status: 'reviewed',
        risk: 'low',
        prepared_by: U.maya!,
        prepared_at: `${workdayToDate(lastEnd, 2, cal)}T20:00:00.000Z`,
        reviewed_by: U.daniel!,
        reviewed_at: reviewedAt,
        notes: `${outstanding.length} timing item(s) outstanding at ${lastEnd}; expected to clear in the next statement.`,
      });
      for (const o of outstanding) {
        await tx.insert('reconciling_items', {
          tenant_id: tenantId,
          reconciliation_id: rec.id,
          kind: o.amount > 0 ? 'deposit_in_transit' : /^CHECK/.test(o.description) ? 'outstanding_check' : 'timing_difference',
          description: o.description,
          amount_minor: o.amount,
          item_date: o.bookDate,
          expected_clear_date: o.bankDate,
          status: 'open',
          journal_line_id: o.ledgerLineIds[0] ?? null,
          created_by: U.maya!,
        });
      }
      for (const role of ['preparer', 'reviewer'] as const) {
        await tx.insert('signoffs', { tenant_id: tenantId, object_type: 'reconciliation', object_id: rec.id, role, user_id: role === 'preparer' ? U.maya! : U.daniel!, signed_at: role === 'preparer' ? rec.prepared_at! : reviewedAt });
      }
    }
    lap('prior recs');

    // ---- The open month: September close in progress at the start of WD2 (business date 2026-10-02).
    const openEnd = monthEnd(SCENARIO.openPeriod.year, SCENARIO.openPeriod.month);
    const wd1Date = workdayToDate(openEnd, 1, cal);
    const close = await createClose(tx, ctxAt(tx, userActor('hannah'), `${wd1Date}T12:30:00.000Z`), lookups, { fiscalYear: SCENARIO.openPeriod.year, periodNumber: SCENARIO.openPeriod.month, assignees });

    log('importing open-month files');
    const imports: ImportResult[] = [];
    for (const f of data.files) {
      const isPriorDay = f.filename.includes('prior-day');
      const at = f.adapterKey === 'payroll-json' ? `${openEnd}T20:00:00.000Z` : f.adapterKey === 'erp-gl-csv' ? `${wd1Date}T08:00:00.000Z` : isPriorDay ? `${addDays(wd1Date, 1)}T06:00:00.000Z` : `${wd1Date}T06:00:00.000Z`;
      const connector = (await tx.find('connectors', { tenant_id: tenantId, adapter: f.adapterKey }))[0];
      const actor: Actor = f.adapterKey === 'erp-gl-csv' ? userActor(f.importedBy) : { type: 'system', userId: null, label: `Connector: ${connector?.name ?? f.adapterKey}` };
      const bankAccountId = f.bankAccountKey ? data.ids.bankAccounts[f.bankAccountKey] : undefined;
      const payrollCash = f.payrollCash ? data.ids.accounts[f.payrollCash] : undefined;
      const r = await importDocument(tx, ctxAt(tx, actor, at), await LedgerLookups.load(tx, tenantId), {
        adapterKey: f.adapterKey,
        filename: f.filename,
        content: f.content,
        connectorId: connector?.id ?? null,
        bankAccountId: bankAccountId ?? null,
        payrollCashAccountId: payrollCash,
      });
      if (r.status === 'failed') throw new Error(`seed import failed: ${r.summary} ${JSON.stringify(r.errors)}`);
      imports.push(r);
    }
    lap('imports');

    // Planted: Maya coded the laptop order to Office supplies and posted it.
    const laptop = await tx.findOne('card_transactions', { tenant_id: tenantId, external_id: data.manifest.misclassifiedSpend.externalId });
    if (!laptop) throw new Error('seed: planted laptop card transaction missing');
    const mayaCtx = ctxAt(tx, userActor('maya'), `${wd1Date}T15:10:00.000Z`);
    const lookups2 = await LedgerLookups.load(tx, tenantId);
    const office = lookups2.account(data.manifest.misclassifiedSpend.codedTo)!;
    const eng = lookups2.departments.get('ENG')!;
    const je = await postCardTransaction(tx, mayaCtx, lookups2, laptop, { accountId: office.id, departmentId: eng.id }, { preparedBy: U.maya!, basis: { basis: 'system' } });
    await tx.update('card_transactions', laptop.id, { status: 'posted', coded_account_id: office.id, coded_department_id: eng.id, coding_source: 'human', journal_entry_id: je.id });
    await appendAudit(tx, tenantId, mayaCtx.actor, { action: 'card.code', objectType: 'card_transaction', objectId: laptop.id, summary: `Coded ${laptop.merchant_name} $${(laptop.amount_minor / 100).toFixed(2)} to ${office.number} ${office.name} and posted ${je.entry_number}` }, mayaCtx.clock.now());

    // WD1 tasks already done: bank import (Maya, after the prior-day file) and AP cutoff (Diego).
    const tasks = await tx.find('close_tasks', { close_id: close.id });
    for (const t of tasks.filter((x) => x.key === 'import-bank' || x.key === 'ap-cutoff')) {
      const who = t.key === 'import-bank' ? 'maya' : 'diego';
      const at = t.key === 'import-bank' ? `${addDays(wd1Date, 1)}T07:40:00.000Z` : `${wd1Date}T21:15:00.000Z`;
      await tx.update('close_tasks', t.id, { status: 'done', started_at: at, completed_at: at, completed_by: U[who]! });
      await tx.insert('signoffs', { tenant_id: tenantId, object_type: 'close_task', object_id: t.id, role: 'preparer', user_id: U[who]!, signed_at: at, comment: t.key === 'import-bank' ? 'Statements and prior-day files imported; control totals agree.' : 'AP inbox cleared through Sep 30; Brightline BF-778 (received Oct 1) held as draft for accrual review.' });
      await appendAudit(tx, tenantId, userActor(who), { action: 'close_task.complete', objectType: 'close_task', objectId: t.id, summary: `${t.title}: done` }, at);
    }
    await tx.update('tenants', tenantId, { business_date: SCENARIO.businessDate });

    if (opts.extend) await opts.extend(tx, ctxAt(tx, SYSTEM_ACTOR, `${SCENARIO.businessDate}T07:45:00.000Z`), { tenantId, closeId: close.id, dataset: data });
    lap('open month');
    return { closeId: close.id, imports };
  });

  const logins: DemoLogin[] = PEOPLE.map((p) => {
    const user = (data.rows.users ?? []).find((u) => u.id === U[p.key])!;
    return { key: p.key, email: user.email, name: p.name, role: p.role, title: p.title };
  });
  timings.total = Date.now() - t0;
  return { tenantId, closeId: result.closeId, logins, password, dataset: data, imports: result.imports, timings };
}

/** Rows of a table straight from the generated dataset (tests and diagnostics). */
export function datasetRows<T extends TableName>(data: SeedDataset, table: T): Insert<T>[] {
  return (data.rows[table] ?? []) as Insert<T>[];
}
