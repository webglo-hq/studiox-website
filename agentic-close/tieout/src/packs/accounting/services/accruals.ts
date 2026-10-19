/**
 * Accrual detection (tie:UnrecordedLiability). Four evidence-backed patterns (AX-ACR-02):
 *
 *   subsequent_invoice  a bill received after month-end for services in the period (cut-off)
 *   recurring_gap       a monthly-service vendor billed in each of the last 3 months but not this one
 *   grni                goods received against a PO with no bill (goods received, not invoiced)
 *   payroll_calendar    paid days (weekdays, holidays included) earned after the last pay period, unpaid at month-end
 *
 * Amounts come from documents (the invoice, the receipt), the vendor's trailing average, or the
 * latest payroll register — never from the model.
 */
import { addDays, isWeekend, periodEnd, periodStart, shiftPeriod } from '../../../core/util/time';
import type { AcctContext } from './context';

export interface AccrualLine {
  account: string;
  debit: number;
  department: string | null;
  project?: string | null;
  memo: string;
}

export interface AccrualCandidate {
  key: string;
  basis: 'subsequent_invoice' | 'recurring_gap' | 'grni' | 'payroll_calendar';
  title: string;
  vendorId: string | null;
  vendorName: string | null;
  amountMinor: number;
  creditAccount: string;
  lines: AccrualLine[];
  confidence: number;
  reasoning: string;
  evidence: { label: string; refType: string; refId: string; detail?: string }[];
}

export class AccrualService {
  constructor(private readonly c: AcctContext) {}

  async candidates(entityId: string, periodKey: string): Promise<{ candidates: AccrualCandidate[]; skipped: string[] }> {
    const start = periodStart(periodKey);
    const end = periodEnd(periodKey);
    const chart = await this.c.chart();
    const entity = await this.c.entity(entityId);
    const visibleTo = await this.c.subsequentWindowEnd(periodKey, 20);
    const out: AccrualCandidate[] = [];
    const skipped: string[] = [];
    const vendors = (await this.c.tx.find('vendors', {})).filter((v) => v.entity_id === entityId);
    const bills = await this.c.tx.find('bills', { entity_id: entityId });
    const existingAccruals = await this.c.tx.find('journal_entries', { entity_id: entityId, entry_type: 'accrual', posting_date: { gte: start, lte: end }, status: { in: ['posted', 'pending_approval', 'approved'] } });
    const accrued = (needle: string) => existingAccruals.some((j) => j.memo.toLowerCase().includes(needle.toLowerCase()));
    const handledVendors = new Set<string>();

    // 1. subsequent invoices (cut-off): bills dated/received after month-end for service in the period
    for (const b of bills) {
      if (b.bill_date <= end || b.received_date > visibleTo) continue;
      if (!b.service_period_end || b.service_period_end < start || b.service_period_end > end) continue;
      const v = vendors.find((x) => x.id === b.vendor_id);
      if (!v) continue;
      if (accrued(v.name)) {
        skipped.push(`${v.name}: already accrued`);
        continue;
      }
      const lines = await this.c.tx.find('bill_lines', { bill_id: b.id }, { orderBy: [['line_no', 'asc']] });
      handledVendors.add(v.id);
      out.push({
        key: `subsequent:${b.id}`,
        basis: 'subsequent_invoice',
        title: `Accrue ${v.name} ${periodLabel(periodKey)} invoice received ${b.received_date}`,
        vendorId: v.id,
        vendorName: v.name,
        amountMinor: b.total_minor,
        creditAccount: '2110',
        lines: lines.map((l) => ({ account: chart.account(l.account_id ?? v.default_account_id!).code, debit: l.amount_minor, department: l.department, project: l.project, memo: `${v.name} ${b.bill_number}: ${l.description}`.slice(0, 200) })),
        confidence: 0.97,
        reasoning: `${v.name} invoice ${b.bill_number} (dated ${b.bill_date}, received ${b.received_date}) covers ${b.service_period_start} to ${b.service_period_end}. The service was used in ${periodLabel(periodKey)}, so the cost belongs in ${periodLabel(periodKey)} even though the bill arrived after month-end.`,
        evidence: [{ label: `Bill ${b.bill_number} (service ${b.service_period_start} – ${b.service_period_end})`, refType: 'bill', refId: b.id }],
      });
    }

    // 2. recurring monthly-service vendors with no bill for the period
    const prior = [1, 2, 3].map((n) => shiftPeriod(periodKey, -n));
    for (const v of vendors) {
      if (handledVendors.has(v.id) || !v.default_account_id) continue;
      const monthly = (pk: string) => bills.filter((b) => b.vendor_id === v.id && b.service_period_start === periodStart(pk) && b.service_period_end === periodEnd(pk) && b.status !== 'void');
      if (!prior.every((pk) => monthly(pk).length > 0)) continue;
      if (monthly(periodKey).length > 0) continue;
      if (accrued(v.name)) {
        skipped.push(`${v.name}: already accrued`);
        continue;
      }
      const history = prior.map((pk) => monthly(pk).reduce((s, b) => s + b.total_minor, 0));
      const avg = Math.round(history.reduce((s, x) => s + x, 0) / history.length / 100) * 100;
      const spread = Math.max(...history) - Math.min(...history);
      const last = prior.map((pk) => monthly(pk)[0]!);
      const lastLines = await this.c.tx.find('bill_lines', { bill_id: last[0]!.id });
      out.push({
        key: `recurring:${v.id}`,
        basis: 'recurring_gap',
        title: `Accrue ${v.name} for ${periodLabel(periodKey)} (no bill received)`,
        vendorId: v.id,
        vendorName: v.name,
        amountMinor: avg,
        creditAccount: '2110',
        lines: [{ account: chart.account(lastLines[0]?.account_id ?? v.default_account_id).code, debit: avg, department: lastLines[0]?.department ?? v.default_department, memo: `${v.name} – ${periodLabel(periodKey)} estimate (3-month average)` }],
        confidence: spread / Math.max(avg, 1) < 0.25 ? 0.9 : 0.78,
        reasoning: `${v.name} has billed for monthly service in each of the last three months (${history.map((h) => fmt(h, entity.functional_currency)).join(', ')}) but nothing has arrived for ${periodLabel(periodKey)}. Accruing the three-month average keeps expenses in the right month; the accrual reverses on day one of next month so the real bill can post normally.`,
        evidence: last.map((b, i) => ({ label: `${prior[i]} bill ${b.bill_number}: ${fmt(b.total_minor, entity.functional_currency)}`, refType: 'bill', refId: b.id })),
      });
    }

    // 3. goods received, not invoiced
    const pos = await this.c.tx.find('purchase_orders', { entity_id: entityId });
    for (const po of pos) {
      const receipts = (await this.c.tx.find('goods_receipts', { purchase_order_id: po.id })).filter((r) => r.receipt_date <= end);
      if (!receipts.length) continue;
      const billed = bills.filter((b) => b.purchase_order_id === po.id && b.bill_date <= visibleTo && b.status !== 'received').reduce((s, b) => s + b.total_minor, 0);
      const received = receipts.reduce((s, r) => s + r.amount_minor, 0);
      const gap = received - billed;
      if (gap <= 0) continue;
      const v = vendors.find((x) => x.id === po.vendor_id);
      if (accrued(po.po_number)) {
        skipped.push(`${po.po_number}: already accrued`);
        continue;
      }
      out.push({
        key: `grni:${po.id}`,
        basis: 'grni',
        title: `Accrue goods received not invoiced – ${po.po_number}`,
        vendorId: po.vendor_id,
        vendorName: v?.name ?? null,
        amountMinor: gap,
        creditAccount: '2110',
        lines: [{ account: po.account_id ? chart.account(po.account_id).code : '1300', debit: gap, department: null, memo: `GRNI ${po.po_number} – ${po.description}`.slice(0, 200) }],
        confidence: 0.96,
        reasoning: `${receipts.map((r) => r.description).join('; ')} on ${receipts.map((r) => r.receipt_date).join(', ')} against ${po.po_number} (${v?.name ?? 'vendor'}), but no bill has been recorded. We own the goods and owe the vendor, so both the inventory and the liability belong on the ${periodLabel(periodKey)} balance sheet.`,
        evidence: [{ label: `${po.po_number} (${fmt(po.total_minor, po.currency)})`, refType: 'purchase_order', refId: po.id }, ...receipts.map((r) => ({ label: `Goods receipt ${r.receipt_date}: ${fmt(r.amount_minor, po.currency)}`, refType: 'goods_receipt', refId: r.id }))],
      });
    }

    // 4. payroll earned but unpaid at month-end
    const runs = (await this.c.tx.find('payroll_runs', { entity_id: entityId }, { orderBy: [['period_end', 'desc']] })).filter((r) => r.pay_date <= end);
    const lastRun = runs[0];
    if (lastRun && lastRun.period_end < end) {
      // salaried staff are paid for every weekday, public holidays included: a biweekly run pays
      // 10 days whatever the holiday calendar says, and each unpaid weekday at month-end is owed
      let days = 0;
      for (let d = addDays(lastRun.period_end, 1); d <= end; d = addDays(d, 1)) if (!isWeekend(d)) days++;
      let runDays = 0;
      for (let d = lastRun.period_start; d <= lastRun.period_end; d = addDays(d, 1)) if (!isWeekend(d)) runDays++;
      const already = existingAccruals.some((j) => /payroll/i.test(j.memo));
      if (days > 0 && runDays > 0 && !already) {
        const factor = days / runDays;
        const gross = lastRun.gross_minor;
        const lines: AccrualLine[] = [];
        for (const [dept, g] of Object.entries(lastRun.by_department).sort()) {
          const share = g / gross;
          const wages = Math.round((g * factor) / 100) * 100;
          const taxes = Math.round((lastRun.employer_taxes_minor * share * factor) / 100) * 100;
          const benefits = Math.round((lastRun.benefits_minor * share * factor) / 100) * 100;
          if (wages) lines.push({ account: '6000', debit: wages, department: dept, memo: `Accrued wages ${dept}` });
          if (taxes) lines.push({ account: '6010', debit: taxes, department: dept, memo: `Accrued employer taxes ${dept}` });
          if (benefits) lines.push({ account: '6020', debit: benefits, department: dept, memo: `Accrued benefits ${dept}` });
        }
        const total = lines.reduce((s, l) => s + l.debit, 0);
        out.push({
          key: `payroll:${periodKey}`,
          basis: 'payroll_calendar',
          title: `Accrue ${days} unpaid payroll days (${addDays(lastRun.period_end, 1)} to ${end})`,
          vendorId: null,
          vendorName: lastRun.provider,
          amountMinor: total,
          creditAccount: '2120',
          lines,
          confidence: 0.93,
          reasoning: `The last pay period ended ${lastRun.period_end} (paid ${lastRun.pay_date}). Employees earned ${days} more paid days in ${periodLabel(periodKey)} that will be paid next month. The daily cost comes from the latest payroll register (${fmt(gross + lastRun.employer_taxes_minor + lastRun.benefits_minor, lastRun.currency)} for ${runDays} paid days, public holidays included), split by department.`,
          evidence: [{ label: `Payroll register ${lastRun.pay_date} (${lastRun.period_start} – ${lastRun.period_end})`, refType: 'payroll_run', refId: lastRun.id }],
        });
      }
    }
    return { candidates: out, skipped };
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function periodLabel(pk: string): string {
  return `${MONTHS[Number(pk.slice(5)) - 1]} ${pk.slice(0, 4)}`;
}

export function fmt(minor: number, ccy: string): string {
  const sym = ccy === 'GBP' ? '£' : ccy === 'EUR' ? '€' : '$';
  return `${minor < 0 ? '−' : ''}${sym}${(Math.abs(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
