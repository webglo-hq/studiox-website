import { z } from 'zod';
import { addMonths, monthEnd } from '../../../shared/dates';
import { detectCutoffBills, detectGrni, detectRecurringGaps, mergeCandidates, type LateBill, type PoLineStatus, type VendorHistory } from '../algorithms/accruals';
import { findMissedLines, monthsCovered } from '../algorithms/schedules';
import { closeOntology } from '../ontology';
import { apSubledger, arSubledger, ensureReconciliation, glBalance, refreshReconciliation } from '../services/recon';
import { EntityCode, entityOf, PeriodKey, periodOf, type Tool, type X } from './common';

/** Accruals, prepaid amortization, depreciation and subledger tie-outs. */

export const periodEndTools: Tool[] = [
  {
    name: 'ap_accrual_signals',
    title: 'Find unrecorded liabilities',
    description: 'Three independent signals of costs that belong in the period but have no bill yet (bh:UnrecordedLiability): recurring vendors whose monthly bill is missing, purchase-order receipts not yet invoiced (bh:GoodsReceivedNotInvoiced), and bills received after period end for services performed in the period (cutoff). Returns merged accrual candidates with evidence.',
    input: z.object({ entity: EntityCode, period: PeriodKey }).strict(),
    permission: 'je.view',
    mutation: false,
    untrustedOutput: true,
    ontology: ['bh:Accrual', 'bh:UnrecordedLiability', 'bh:GoodsReceivedNotInvoiced'],
    async execute(input: { entity: string; period: string }, x: X) {
      const entity = entityOf(x, input.entity);
      const period = periodOf(x, entity.id, input.period);
      const { lookups } = x.pack;
      const vendors = new Map((await x.tx.find('vendors', { tenant_id: x.ctx.tenantId })).map((v) => [v.id, v]));
      const lookbackStart = (() => {
        const m = addMonths(period.fiscal_year, period.period_number, -7);
        return `${m.year}-${String(m.month).padStart(2, '0')}-01`;
      })();
      const bills = (await x.tx.find('bills', { entity_id: entity.id, bill_date: { gte: lookbackStart } })).filter((b) => b.status !== 'void');
      const lines = bills.length ? await x.tx.find('bill_lines', { bill_id: { in: bills.map((b) => b.id) } }) : [];
      const lineOf = new Map(lines.map((l) => [l.bill_id, l]));
      const histories = new Map<string, VendorHistory>();
      const late: LateBill[] = [];
      for (const b of bills) {
        const l = lineOf.get(b.id);
        const v = vendors.get(b.vendor_id);
        if (!l || !v) continue;
        const acct = lookups.accountsById.get(l.account_id);
        const hb = { billId: b.id, billNumber: b.bill_number, billDate: b.bill_date, receivedDate: b.received_date, serviceStart: b.service_start, serviceEnd: b.service_end, amount: b.amount_minor, accountNumber: acct?.number ?? '', departmentCode: l.department_id ? (lookups.departments.get(l.department_id)?.code ?? null) : null };
        if (b.status !== 'draft' && b.journal_entry_id) {
          const h = histories.get(v.id) ?? { vendorId: v.id, vendorName: v.name, bills: [] };
          h.bills.push(hb);
          histories.set(v.id, h);
        }
        if (b.received_date > period.end_date) late.push({ ...hb, vendorId: v.id, vendorName: v.name, postedInPeriod: !!b.journal_entry_id && b.bill_date <= period.end_date });
      }
      const pos = await x.tx.find('purchase_orders', { entity_id: entity.id, status: { in: ['open', 'partially_received', 'received'] } });
      const poLines: PoLineStatus[] = [];
      for (const po of pos) {
        for (const l of await x.tx.find('purchase_order_lines', { purchase_order_id: po.id })) {
          const receipts = await x.tx.find('goods_receipts', { purchase_order_line_id: l.id });
          poLines.push({ poId: po.id, poNumber: po.po_number, poLineId: l.id, vendorId: po.vendor_id, vendorName: vendors.get(po.vendor_id)?.name ?? 'vendor', description: l.description, accountNumber: lookups.accountsById.get(l.account_id)?.number ?? '', departmentCode: l.department_id ? (lookups.departments.get(l.department_id)?.code ?? null) : null, receipts: receipts.map((r) => ({ id: r.id, date: r.receipt_date, amount: r.amount_minor })), billedAmount: l.billed_amount_minor });
        }
      }
      const candidates = mergeCandidates([...detectRecurringGaps([...histories.values()], period.fiscal_year, period.period_number), ...detectGrni(poLines, period.end_date), ...detectCutoffBills(late, period.fiscal_year, period.period_number)]);
      const accrued = await x.tx.find('journal_entries', { entity_id: entity.id, period_id: period.id, entry_type: 'accrual', status: 'posted' });
      return {
        entity: entity.code,
        currency: entity.functional_currency,
        period: input.period,
        periodEnd: period.end_date,
        reversalDate: x.pack.lookups.nextPeriod(period)?.start_date ?? null,
        accrualAccount: lookups.accountsBySubtype('bh:AccruedLiabilities')[0]?.number ?? null,
        candidates,
        alreadyAccrued: accrued.map((e) => ({ id: e.id, entryNumber: e.entry_number, description: e.description, total: e.total_minor })),
      };
    },
    summarize: (o: { candidates: unknown[] }) => `${o.candidates.length} accrual candidate(s)`,
  },
  {
    name: 'prepaid_schedules_due',
    title: 'Read prepaid amortization due',
    description: 'Prepaid amortization schedules (bh:PrepaidSchedule) with lines due in the period and any earlier lines that were never posted (missed months), per schedule.',
    input: z.object({ entity: EntityCode, period: PeriodKey }).strict(),
    permission: 'je.view',
    mutation: false,
    ontology: ['bh:PrepaidSchedule', 'bh:AmortizationScheduleLine'],
    async execute(input: { entity: string; period: string }, x: X) {
      const entity = entityOf(x, input.entity);
      const period = periodOf(x, entity.id, input.period);
      const schedules = (await x.tx.find('amortization_schedules', { entity_id: entity.id, kind: 'prepaid_expense' })).filter((s) => s.status === 'active');
      const out = [];
      for (const s of schedules) {
        const lines = await x.tx.find('amortization_lines', { schedule_id: s.id }, { orderBy: [['period_end', 'asc']] });
        const states = lines.map((l) => ({ scheduleId: s.id, label: s.description, periodKey: l.period_end.slice(0, 7), amount: l.amount_minor, status: l.status, lineId: l.id }));
        const due = findMissedLines(states, input.period);
        if (!due.length) continue;
        out.push({
          scheduleId: s.id,
          description: s.description,
          balanceAccount: x.pack.lookups.accountsById.get(s.balance_account_id)?.number,
          plAccount: x.pack.lookups.accountsById.get(s.pl_account_id)?.number,
          department: s.department_id ? (x.pack.lookups.departments.get(s.department_id)?.code ?? null) : null,
          vendorId: s.vendor_id,
          lines: due.map((d) => ({ id: d.lineId, period: d.periodKey, amount: d.amount, missed: d.periodKey < input.period })),
        });
      }
      return { entity: entity.code, currency: entity.functional_currency, period: input.period, periodEnd: period.end_date, schedules: out };
    },
    summarize: (o: { schedules: unknown[] }) => `${o.schedules.length} schedule(s) due`,
  },
  {
    name: 'prepaid_unscheduled_balances',
    title: 'Find prepaid balances without a schedule',
    description: 'Compares each prepaid account (bh:PrepaidExpense) balance at period end with what its amortization schedules still carry; the unexplained part is traced to bills coded to the prepaid account that have no schedule. Returns months elapsed and the catch-up amortization a schedule would need.',
    input: z.object({ entity: EntityCode, period: PeriodKey }).strict(),
    permission: 'je.view',
    mutation: false,
    ontology: ['bh:PrepaidExpense', 'bh:AmortizationSchedule'],
    async execute(input: { entity: string; period: string }, x: X) {
      const entity = entityOf(x, input.entity);
      const period = periodOf(x, entity.id, input.period);
      const { lookups } = x.pack;
      const prepaidAccounts = [...lookups.accountsById.values()].filter((a) => a.is_postable && closeOntology.isA(a.subtype, 'bh:PrepaidExpense'));
      const schedules = await x.tx.find('amortization_schedules', { entity_id: entity.id, kind: 'prepaid_expense' });
      const vendors = new Map((await x.tx.find('vendors', { tenant_id: x.ctx.tenantId })).map((v) => [v.id, v]));
      const out = [];
      for (const a of prepaidAccounts) {
        const gl = await glBalance(x.tx, x.ctx.tenantId, entity.id, a.id, period.end_date);
        let carried = 0;
        for (const s of schedules.filter((s) => s.balance_account_id === a.id)) {
          const lines = await x.tx.find('amortization_lines', { schedule_id: s.id });
          carried += lines.filter((l) => l.status !== 'posted').reduce((t, l) => t + l.amount_minor, 0);
        }
        const unexplained = gl - carried;
        if (unexplained === 0) continue;
        const scheduledBills = new Set(schedules.map((s) => s.bill_id).filter(Boolean));
        const billLines = await x.tx.find('bill_lines', { account_id: a.id });
        const candidates = [];
        for (const bl of billLines) {
          const b = await x.tx.get('bills', bl.bill_id);
          if (!b || b.entity_id !== entity.id || scheduledBills.has(b.id) || b.status === 'void' || !b.journal_entry_id || b.bill_date > period.end_date) continue;
          const start = b.service_start ?? b.bill_date;
          const end = b.service_end ?? b.bill_date;
          const months = monthsCovered(start, end);
          const elapsed = Math.max(0, Math.min(months, monthsCovered(start, period.end_date)));
          const monthly = Math.round(bl.amount_minor / months);
          candidates.push({ billId: b.id, billNumber: b.bill_number, vendorId: b.vendor_id, vendor: vendors.get(b.vendor_id)?.name ?? '', amount: bl.amount_minor, serviceStart: start, serviceEnd: end, months, monthsElapsedThroughPeriod: elapsed, monthly, catchUpAmount: elapsed === months ? bl.amount_minor : monthly * elapsed, department: bl.department_id ? (lookups.departments.get(bl.department_id)?.code ?? null) : null });
        }
        const expenseAccount = lookups.accountsBySubtype(a.subtype === 'bh:PrepaidInsurance' ? 'bh:InsuranceExpense' : a.subtype === 'bh:PrepaidSoftware' ? 'bh:SoftwareExpense' : 'bh:OperatingExpense')[0];
        out.push({ account: a.number, accountName: a.name, glBalance: gl, scheduledRemaining: carried, unexplained, suggestedExpenseAccount: expenseAccount?.number ?? null, candidates });
      }
      return { entity: entity.code, currency: entity.functional_currency, period: input.period, periodEnd: period.end_date, accounts: out };
    },
    summarize: (o: { accounts: unknown[] }) => `${o.accounts.length} prepaid account(s) with unscheduled balances`,
  },
  {
    name: 'fa_depreciation_due',
    title: 'Read depreciation due',
    description: 'Fixed-asset register (bh:FixedAssetRegister) depreciation lines scheduled for the period, by asset and department, with the expense and accumulated-depreciation accounts.',
    input: z.object({ entity: EntityCode, period: PeriodKey }).strict(),
    permission: 'je.view',
    mutation: false,
    ontology: ['bh:FixedAsset', 'bh:Depreciation'],
    async execute(input: { entity: string; period: string }, x: X) {
      const entity = entityOf(x, input.entity);
      const period = periodOf(x, entity.id, input.period);
      const lines = (await x.tx.find('depreciation_lines', { period_id: period.id })).filter((l) => l.status === 'scheduled');
      const assets = new Map((await x.tx.find('fixed_assets', { entity_id: entity.id })).map((a) => [a.id, a]));
      const out = lines
        .filter((l) => assets.has(l.fixed_asset_id))
        .map((l) => {
          const a = assets.get(l.fixed_asset_id)!;
          return { id: l.id, assetNumber: a.asset_number, description: a.description, amount: l.amount_minor, department: a.department_id ? (x.pack.lookups.departments.get(a.department_id)?.code ?? null) : null, expenseAccount: x.pack.lookups.accountsById.get(a.depreciation_expense_account_id)?.number, accumulatedAccount: x.pack.lookups.accountsById.get(a.accumulated_depreciation_account_id)?.number, netBookValueAfter: l.net_book_value_minor };
        });
      return { entity: entity.code, currency: entity.functional_currency, period: input.period, periodEnd: period.end_date, lines: out, total: out.reduce((s, l) => s + l.amount, 0) };
    },
    summarize: (o: { lines: unknown[]; total: number }) => `${o.lines.length} asset line(s), ${(o.total / 100).toFixed(2)}`,
  },
  {
    name: 'subledger_tieout',
    title: 'Tie out a subledger to the GL',
    description: 'Compares the AP or AR subledger (bh:AccountsPayableSubledger / bh:AccountsReceivableSubledger) with its GL control account (bh:ControlAccount) at period end, refreshes the tie-out workpaper and lists manual or imported entries posted straight to the control account (they bypass the subledger).',
    input: z.object({ entity: EntityCode, period: PeriodKey, ledger: z.enum(['ap', 'ar']) }).strict(),
    permission: 'rec.view',
    mutation: false,
    untrustedOutput: true,
    ontology: ['bh:SubledgerTieOut', 'bh:ControlAccount'],
    async execute(input: { entity: string; period: string; ledger: 'ap' | 'ar' }, x: X) {
      const entity = entityOf(x, input.entity);
      const period = periodOf(x, entity.id, input.period);
      const { lookups } = x.pack;
      const control = lookups.accountsBySubtype(input.ledger === 'ap' ? 'bh:AccountsPayable' : 'bh:AccountsReceivable')[0]!;
      const rec = await ensureReconciliation(x.tx, x.ctx, lookups, { entityId: entity.id, periodId: period.id, recType: input.ledger === 'ap' ? 'subledger_ap' : 'subledger_ar', accountId: control.id, closeTaskId: x.run.close_task_id });
      const refreshed = await refreshReconciliation(x.tx, rec.id);
      const sub = input.ledger === 'ap' ? await apSubledger(x.tx, x.ctx.tenantId, entity.id, period.end_date) : await arSubledger(x.tx, x.ctx.tenantId, entity.id, period.end_date);
      const lines = await x.tx.find('journal_lines', { entity_id: entity.id, period_id: period.id, account_id: control.id });
      const entries = lines.length ? await x.tx.find('journal_entries', { id: { in: [...new Set(lines.map((l) => l.journal_entry_id))] } }) : [];
      const direct = entries.filter((e) => e.status === 'posted' && (e.source === 'manual' || e.source === 'import') && e.entry_type !== 'opening');
      const top = sub.open
        .slice()
        .sort((a, b) => Math.abs(b.open) - Math.abs(a.open))
        .slice(0, 8)
        .map((o) => ('bill' in o ? { id: o.bill.id, number: o.bill.bill_number, date: o.bill.bill_date, open: o.open } : { id: o.invoice.id, number: o.invoice.invoice_number, date: o.invoice.invoice_date, open: o.open }));
      return {
        reconciliationId: refreshed.id,
        entity: entity.code,
        currency: entity.functional_currency,
        ledger: input.ledger,
        controlAccount: `${control.number} ${control.name}`,
        gl: refreshed.gl_balance_minor,
        subledger: refreshed.external_balance_minor,
        difference: refreshed.difference_minor,
        openDocuments: sub.open.length,
        largestOpen: top,
        directEntriesToControlAccount: direct.map((e) => ({ id: e.id, entryNumber: e.entry_number, date: e.entry_date, description: e.description, total: e.total_minor, source: e.source, externalRef: e.external_ref, externalPreparedBy: e.external_prepared_by, externalApprovedBy: e.external_approved_by, net: lines.filter((l) => l.journal_entry_id === e.id).reduce((s, l) => s + l.debit_minor - l.credit_minor, 0) })),
        periodEnd: monthEnd(period.fiscal_year, period.period_number),
      };
    },
    summarize: (o: { controlAccount: string; difference: number }) => `${o.controlAccount}: difference ${(o.difference / 100).toFixed(2)}`,
  },
];
