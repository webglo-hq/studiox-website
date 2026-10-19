import type { Tx } from '../../../persistence/db';
import type { Row } from '../../../persistence/schema';
import type { DomainContext } from '../../../shared/context';
import { DomainError } from '../../../shared/errors';
import { createAndPost, type EntryMeta, type LineDraft, type PostBasis } from './ledger';
import type { LedgerLookups } from './lookups';

/**
 * Subledger postings: each business document produces its journal entry through the same verified posting
 * path as everything else (no side doors into the ledger).
 */

const SYSTEM_BASIS: PostBasis = { basis: 'system' };

function acct(lookups: LedgerLookups, subtype: string, entity?: Row<'entities'>): Row<'accounts'> {
  const list = lookups.accountsBySubtype(subtype);
  if (!list.length) throw new DomainError('INVARIANT', `No active account for ${subtype}`);
  if (entity && subtype === 'bh:Cash') return list[0]!;
  return list[0]!;
}

export async function postBill(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  bill: Row<'bills'>,
  lines: Row<'bill_lines'>[],
  meta: Partial<EntryMeta> = {},
): Promise<Row<'journal_entries'>> {
  const vendor = await tx.get('vendors', bill.vendor_id);
  const ap = acct(lookups, 'bh:AccountsPayable');
  const drafts: LineDraft[] = lines.map((l) => ({
    account: l.account_id,
    debit: l.amount_minor,
    department: l.department_id,
    location: l.location_id,
    class: l.class_id,
    project: l.project_id,
    vendorId: bill.vendor_id,
    memo: l.description,
  }));
  drafts.push({ account: ap.id, credit: bill.amount_minor, vendorId: bill.vendor_id, memo: `${vendor?.name ?? 'Vendor'} ${bill.bill_number}` });
  const entry = await createAndPost(
    tx,
    ctx,
    lookups,
    { entity: bill.entity_id, date: bill.bill_date, type: 'standard', description: `Bill ${bill.bill_number} - ${vendor?.name ?? ''}: ${bill.description}`, lines: drafts },
    { source: 'subledger', sourceModule: 'ap', sourceDocumentId: bill.source_document_id, ...meta },
    SYSTEM_BASIS,
  );
  await tx.update('bills', bill.id, { journal_entry_id: entry.id });
  return entry;
}

export async function postVendorPayment(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  payment: Row<'vendor_payments'>,
  meta: Partial<EntryMeta> = {},
): Promise<Row<'journal_entries'>> {
  const vendor = await tx.get('vendors', payment.vendor_id);
  const bank = await tx.get('bank_accounts', payment.bank_account_id);
  if (!bank) throw new DomainError('NOT_FOUND', 'bank account not found');
  const ap = acct(lookups, 'bh:AccountsPayable');
  const entry = await createAndPost(
    tx,
    ctx,
    lookups,
    {
      entity: payment.entity_id,
      date: payment.payment_date,
      description: `Payment ${payment.reference} to ${vendor?.name ?? 'vendor'}`,
      lines: [
        { account: ap.id, debit: payment.amount_minor, vendorId: payment.vendor_id, memo: `${vendor?.name ?? ''} ${payment.reference}` },
        { account: bank.gl_account_id, credit: payment.amount_minor, vendorId: payment.vendor_id, memo: `${payment.method.toUpperCase()} ${payment.reference} ${vendor?.name ?? ''}` },
      ],
    },
    { source: 'subledger', sourceModule: 'ap', ...meta },
    SYSTEM_BASIS,
  );
  await tx.update('vendor_payments', payment.id, { journal_entry_id: entry.id });
  return entry;
}

export async function postInvoice(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  invoice: Row<'invoices'>,
  lines: Row<'invoice_lines'>[],
  meta: Partial<EntryMeta> = {},
): Promise<Row<'journal_entries'>> {
  const customer = await tx.get('customers', invoice.customer_id);
  const ar = acct(lookups, 'bh:AccountsReceivable');
  const deferred = acct(lookups, 'bh:DeferredRevenue');
  const drafts: LineDraft[] = [{ account: ar.id, debit: invoice.amount_minor, customerId: invoice.customer_id, memo: `${customer?.name ?? ''} ${invoice.invoice_number}` }];
  for (const l of lines) {
    drafts.push({ account: l.deferred ? deferred.id : l.revenue_account_id, credit: l.amount_minor, class: l.class_id, customerId: invoice.customer_id, memo: l.description });
  }
  const entry = await createAndPost(
    tx,
    ctx,
    lookups,
    { entity: invoice.entity_id, date: invoice.invoice_date, description: `Invoice ${invoice.invoice_number} - ${customer?.name ?? ''}`, lines: drafts },
    { source: 'subledger', sourceModule: 'ar', ...meta },
    SYSTEM_BASIS,
  );
  await tx.update('invoices', invoice.id, { journal_entry_id: entry.id });
  return entry;
}

export async function postReceipt(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  receipt: Row<'customer_receipts'>,
  meta: Partial<EntryMeta> = {},
): Promise<Row<'journal_entries'>> {
  const customer = await tx.get('customers', receipt.customer_id);
  const bank = await tx.get('bank_accounts', receipt.bank_account_id);
  if (!bank) throw new DomainError('NOT_FOUND', 'bank account not found');
  const ar = acct(lookups, 'bh:AccountsReceivable');
  const entry = await createAndPost(
    tx,
    ctx,
    lookups,
    {
      entity: receipt.entity_id,
      date: receipt.receipt_date,
      description: `Receipt ${receipt.reference} from ${customer?.name ?? 'customer'}`,
      lines: [
        { account: bank.gl_account_id, debit: receipt.amount_minor, customerId: receipt.customer_id, memo: `${receipt.method.toUpperCase()} ${customer?.name ?? ''} ${receipt.reference}` },
        { account: ar.id, credit: receipt.amount_minor, customerId: receipt.customer_id, memo: receipt.reference },
      ],
    },
    { source: 'subledger', sourceModule: 'ar', ...meta },
    SYSTEM_BASIS,
  );
  await tx.update('customer_receipts', receipt.id, { journal_entry_id: entry.id });
  return entry;
}

export async function postCardTransaction(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  txn: Row<'card_transactions'>,
  coding: { accountId: string; departmentId: string | null },
  meta: Partial<EntryMeta> & { basis?: PostBasis } = {},
): Promise<Row<'journal_entries'>> {
  const card = await tx.get('cards', txn.card_id);
  if (!card) throw new DomainError('NOT_FOUND', 'card not found');
  const amount = Math.abs(txn.amount_minor);
  const refund = txn.amount_minor < 0;
  const expenseLine: LineDraft = { account: coding.accountId, debit: refund ? 0 : amount, credit: refund ? amount : 0, department: coding.departmentId, memo: `${txn.merchant_name}${txn.memo ? ` - ${txn.memo}` : ''}` };
  const payableLine: LineDraft = { account: card.liability_account_id, debit: refund ? amount : 0, credit: refund ? 0 : amount, memo: `Card ${card.last4} ${card.cardholder_name}` };
  const { basis, ...rest } = meta;
  const entry = await createAndPost(
    tx,
    ctx,
    lookups,
    { entity: txn.entity_id, date: txn.transaction_date, description: `Card: ${txn.merchant_name}`, lines: [expenseLine, payableLine] },
    { source: 'subledger', sourceModule: 'card', ...rest },
    basis ?? SYSTEM_BASIS,
  );
  return entry;
}

export interface PayrollPostingAccounts {
  wages: string;
  taxes: string;
  benefits: string;
  liabilities: string;
  cash: string;
}

export async function postPayrollRun(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  run: Row<'payroll_runs'>,
  lines: Row<'payroll_lines'>[],
  accounts: PayrollPostingAccounts,
  meta: Partial<EntryMeta> = {},
): Promise<Row<'journal_entries'>> {
  const drafts: LineDraft[] = [];
  for (const l of lines) {
    if (l.amount_minor === 0) continue;
    const account = l.category === 'employer_tax' ? accounts.taxes : l.category === 'benefits' ? accounts.benefits : accounts.wages;
    drafts.push({ account, debit: l.amount_minor, department: l.department_id, memo: `${l.category} ${run.pay_period_start}..${run.pay_period_end}` });
  }
  drafts.push({ account: accounts.cash, credit: run.net_pay_minor + run.benefits_minor, memo: `Net pay and benefits ${run.pay_date.replace(/-/g, '')} ${run.external_id}` });
  drafts.push({ account: accounts.liabilities, credit: run.withholding_minor + run.employer_tax_minor, memo: 'Withholdings and employer taxes payable' });
  const entry = await createAndPost(
    tx,
    ctx,
    lookups,
    { entity: run.entity_id, date: run.pay_date, description: `Payroll ${run.pay_period_start} to ${run.pay_period_end} (${run.headcount} employees)`, lines: drafts },
    { source: 'subledger', sourceModule: 'payroll', sourceDocumentId: run.source_document_id, importBatchId: run.import_batch_id, ...meta },
    SYSTEM_BASIS,
  );
  await tx.update('payroll_runs', run.id, { journal_entry_id: entry.id });
  return entry;
}
