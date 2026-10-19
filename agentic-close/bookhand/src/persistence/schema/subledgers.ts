import { c, check, table } from '../dsl';

const AP = 'Accounts payable';
const AR = 'Accounts receivable';
const CASH = 'Cash & cards';
const SCHED = 'Schedules & payroll';

const provenance = () => ({
  source_document_id: c.uuid().nullable().references('source_documents'),
  import_batch_id: c.uuid().nullable().references('import_batches'),
  /** Where in the source document this record came from (row 42, Ntry[3], STMTTRN[7], ...). */
  source_locator: c.text().nullable(),
});

// ---------------------------------------------------------------- AP

export const vendors = table(
  'vendors',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    code: c.text(),
    name: c.text(),
    legal_name: c.text().nullable(),
    /** Ontology vendor category (saas, cloud_hosting, legal, ...) used by bucketing. */
    category: c.text().nullable(),
    default_account_id: c.uuid().nullable().references('accounts'),
    default_department_id: c.uuid().nullable().references('departments'),
    payment_terms_days: c.int().default(30),
    currency: c.currency(),
    is_1099: c.bool().default(false),
    status: c.enum(['active', 'inactive', 'blocked'] as const).default('active'),
    tax_id_last4: c.text().nullable(),
    remit_bank_last4: c.text().nullable(),
    created_by: c.uuid().nullable().references('users', 'set null'),
    updated_by: c.uuid().nullable().references('users', 'set null'),
    created_at: c.timestamp().defaultNow(),
    updated_at: c.timestamp().defaultNow(),
  },
  { area: AP, description: 'Vendor master (supplier).', ontologyClass: 'bh:Vendor', uniques: [['tenant_id', 'code']] },
);

export const purchaseOrders = table(
  'purchase_orders',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    vendor_id: c.uuid().references('vendors'),
    po_number: c.text(),
    order_date: c.date(),
    status: c.enum(['open', 'partially_received', 'received', 'closed', 'cancelled'] as const).default('open'),
    currency: c.currency(),
    total_minor: c.money().check('> 0', (v) => v > 0),
    description: c.text(),
    requested_by: c.uuid().nullable().references('users', 'set null'),
    approved_by: c.uuid().nullable().references('users', 'set null'),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AP, description: 'Purchase order (commitment, REA).', ontologyClass: 'bh:PurchaseOrder', uniques: [['entity_id', 'po_number']] },
);

export const purchaseOrderLines = table(
  'purchase_order_lines',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    purchase_order_id: c.uuid().references('purchase_orders', 'cascade'),
    line_number: c.int(),
    description: c.text(),
    account_id: c.uuid().references('accounts'),
    department_id: c.uuid().nullable().references('departments'),
    quantity: c.numeric(14, 4).default(1),
    unit_price_minor: c.money(),
    amount_minor: c.money().check('> 0', (v) => v > 0),
    received_amount_minor: c.money().default(0),
    billed_amount_minor: c.money().default(0),
    service_start: c.date().nullable(),
    service_end: c.date().nullable(),
  },
  { area: AP, description: 'Purchase order line.', uniques: [['purchase_order_id', 'line_number']] },
);

export const goodsReceipts = table(
  'goods_receipts',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    purchase_order_id: c.uuid().references('purchase_orders'),
    purchase_order_line_id: c.uuid().references('purchase_order_lines'),
    receipt_date: c.date(),
    quantity: c.numeric(14, 4).default(1),
    amount_minor: c.money().check('> 0', (v) => v > 0),
    received_by: c.uuid().nullable().references('users', 'set null'),
    note: c.text().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AP, description: 'Goods or services received against a PO line (evidence for GRNI accruals).', ontologyClass: 'bh:GoodsReceipt' },
);

export const bills = table(
  'bills',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    vendor_id: c.uuid().references('vendors'),
    bill_number: c.text(),
    bill_date: c.date(),
    received_date: c.date(),
    due_date: c.date(),
    currency: c.currency(),
    amount_minor: c.money().check('> 0', (v) => v > 0),
    status: c.enum(['draft', 'open', 'partially_paid', 'paid', 'void'] as const).default('open'),
    purchase_order_id: c.uuid().nullable().references('purchase_orders'),
    service_start: c.date().nullable(),
    service_end: c.date().nullable(),
    description: c.text(),
    journal_entry_id: c.uuid().nullable().references('journal_entries'),
    ...provenance(),
    created_by: c.uuid().nullable().references('users', 'set null'),
    approved_by: c.uuid().nullable().references('users', 'set null'),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AP,
    description: 'Vendor bill (invoice received). Posting credits AP and debits the coded accounts.',
    ontologyClass: 'bh:VendorBill',
    uniques: [['vendor_id', 'bill_number']],
    indexes: [['entity_id', 'bill_date']],
    checks: [check('bill_due_after', 'due_date >= bill_date', (r) => String(r.due_date) >= String(r.bill_date), 'due date must be on/after bill date')],
  },
);

export const billLines = table(
  'bill_lines',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    bill_id: c.uuid().references('bills', 'cascade'),
    line_number: c.int(),
    account_id: c.uuid().references('accounts'),
    department_id: c.uuid().nullable().references('departments'),
    location_id: c.uuid().nullable().references('locations'),
    class_id: c.uuid().nullable().references('classes'),
    project_id: c.uuid().nullable().references('projects'),
    description: c.text(),
    amount_minor: c.money().check('> 0', (v) => v > 0),
    service_start: c.date().nullable(),
    service_end: c.date().nullable(),
  },
  { area: AP, description: 'Bill line with GL coding and dimensions.', uniques: [['bill_id', 'line_number']] },
);

export const vendorPayments = table(
  'vendor_payments',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    vendor_id: c.uuid().references('vendors'),
    bank_account_id: c.uuid().references('bank_accounts'),
    payment_date: c.date(),
    method: c.enum(['ach', 'wire', 'check', 'card'] as const),
    reference: c.text(),
    amount_minor: c.money().check('> 0', (v) => v > 0),
    currency: c.currency(),
    status: c.enum(['scheduled', 'sent', 'cleared', 'void'] as const).default('sent'),
    journal_entry_id: c.uuid().nullable().references('journal_entries'),
    created_by: c.uuid().nullable().references('users', 'set null'),
    approved_by: c.uuid().nullable().references('users', 'set null'),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AP,
    description: 'Outgoing payment to a vendor (economic event: cash disbursement).',
    ontologyClass: 'bh:VendorPayment',
    indexes: [['vendor_id', 'payment_date']],
    checks: [
      check('payment_sod', 'approved_by IS NULL OR approved_by IS DISTINCT FROM created_by', (r) => r.approved_by == null || r.approved_by !== r.created_by, 'a payment cannot be approved by the person who created it'),
    ],
  },
);

export const paymentApplications = table(
  'payment_applications',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    payment_id: c.uuid().references('vendor_payments', 'cascade'),
    bill_id: c.uuid().references('bills'),
    amount_minor: c.money().check('> 0', (v) => v > 0),
  },
  { area: AP, description: 'Allocation of a payment to the bills it settles.', uniques: [['payment_id', 'bill_id']] },
);

// ---------------------------------------------------------------- AR

export const customers = table(
  'customers',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    code: c.text(),
    name: c.text(),
    segment: c.text().nullable(),
    currency: c.currency(),
    payment_terms_days: c.int().default(30),
    status: c.enum(['active', 'inactive'] as const).default('active'),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AR, description: 'Customer master.', ontologyClass: 'bh:Customer', uniques: [['tenant_id', 'code']] },
);

export const invoices = table(
  'invoices',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    customer_id: c.uuid().references('customers'),
    invoice_number: c.text(),
    invoice_date: c.date(),
    due_date: c.date(),
    currency: c.currency(),
    amount_minor: c.money().check('> 0', (v) => v > 0),
    status: c.enum(['open', 'partially_paid', 'paid', 'void', 'written_off'] as const).default('open'),
    service_start: c.date().nullable(),
    service_end: c.date().nullable(),
    description: c.text(),
    journal_entry_id: c.uuid().nullable().references('journal_entries'),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AR,
    description: 'Customer invoice. Subscription invoices create deferred revenue recognized over the service period (ASC 606).',
    ontologyClass: 'bh:CustomerInvoice',
    uniques: [['entity_id', 'invoice_number']],
    indexes: [['entity_id', 'invoice_date']],
  },
);

export const invoiceLines = table(
  'invoice_lines',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    invoice_id: c.uuid().references('invoices', 'cascade'),
    line_number: c.int(),
    description: c.text(),
    revenue_account_id: c.uuid().references('accounts'),
    class_id: c.uuid().nullable().references('classes'),
    amount_minor: c.money().check('> 0', (v) => v > 0),
    service_start: c.date().nullable(),
    service_end: c.date().nullable(),
    deferred: c.bool().default(false),
  },
  { area: AR, description: 'Invoice line (performance obligation).', uniques: [['invoice_id', 'line_number']] },
);

export const customerReceipts = table(
  'customer_receipts',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    customer_id: c.uuid().references('customers'),
    bank_account_id: c.uuid().references('bank_accounts'),
    receipt_date: c.date(),
    method: c.enum(['ach', 'wire', 'check', 'card'] as const),
    reference: c.text(),
    amount_minor: c.money().check('> 0', (v) => v > 0),
    currency: c.currency(),
    status: c.enum(['received', 'applied', 'void'] as const).default('applied'),
    journal_entry_id: c.uuid().nullable().references('journal_entries'),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AR, description: 'Cash received from a customer.', ontologyClass: 'bh:CustomerReceipt', indexes: [['customer_id', 'receipt_date']] },
);

export const receiptApplications = table(
  'receipt_applications',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    receipt_id: c.uuid().references('customer_receipts', 'cascade'),
    invoice_id: c.uuid().references('invoices'),
    amount_minor: c.money().check('> 0', (v) => v > 0),
  },
  { area: AR, description: 'Allocation of a receipt to invoices.', uniques: [['receipt_id', 'invoice_id']] },
);

// ---------------------------------------------------------------- Cash & cards

export const bankAccounts = table(
  'bank_accounts',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    name: c.text(),
    institution: c.text(),
    account_last4: c.text(),
    currency: c.currency(),
    gl_account_id: c.uuid().references('accounts'),
    status: c.enum(['active', 'closed'] as const).default('active'),
    created_at: c.timestamp().defaultNow(),
  },
  { area: CASH, description: 'Bank account mapped to a GL cash account.', ontologyClass: 'bh:BankAccount', uniques: [['entity_id', 'name']] },
);

export const bankStatements = table(
  'bank_statements',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    bank_account_id: c.uuid().references('bank_accounts'),
    statement_date: c.date(),
    period_start: c.date(),
    period_end: c.date(),
    opening_balance_minor: c.money(),
    closing_balance_minor: c.money(),
    currency: c.currency(),
    ...provenance(),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: CASH,
    description: 'Bank statement (period with opening and closing balances).',
    ontologyClass: 'bh:BankStatement',
    uniques: [['bank_account_id', 'period_start', 'period_end']],
  },
);

export const bankTransactions = table(
  'bank_transactions',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    bank_account_id: c.uuid().references('bank_accounts'),
    statement_id: c.uuid().nullable().references('bank_statements'),
    booking_date: c.date(),
    value_date: c.date().nullable(),
    /** Signed: + money in, - money out. */
    amount_minor: c.money().check('<> 0', (v) => v !== 0),
    currency: c.currency(),
    /** Untrusted text from the bank: treated as data, never as instructions. */
    description: c.text(),
    counterparty: c.text().nullable(),
    reference: c.text().nullable(),
    bank_reference: c.text(),
    type_code: c.text().nullable(),
    status: c.enum(['unmatched', 'matched', 'excluded'] as const).default('unmatched'),
    dedupe_key: c.text(),
    ...provenance(),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: CASH,
    description: 'Bank statement line. Imports are idempotent on (bank account, dedupe key).',
    ontologyClass: 'bh:BankTransaction',
    uniques: [['bank_account_id', 'dedupe_key']],
    indexes: [['bank_account_id', 'booking_date']],
  },
);

export const cards = table(
  'cards',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    cardholder_name: c.text(),
    cardholder_user_id: c.uuid().nullable().references('users', 'set null'),
    last4: c.text(),
    department_id: c.uuid().nullable().references('departments'),
    liability_account_id: c.uuid().references('accounts'),
    status: c.enum(['active', 'frozen', 'closed'] as const).default('active'),
    created_at: c.timestamp().defaultNow(),
  },
  { area: CASH, description: 'Corporate card.', ontologyClass: 'bh:CorporateCard' },
);

export const cardTransactions = table(
  'card_transactions',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    card_id: c.uuid().references('cards'),
    transaction_date: c.date(),
    posted_date: c.date(),
    merchant_name: c.text(),
    mcc: c.text().nullable(),
    amount_minor: c.money().check('<> 0', (v) => v !== 0),
    currency: c.currency(),
    memo: c.text().nullable(),
    receipt_document_id: c.uuid().nullable().references('source_documents'),
    status: c.enum(['pending', 'coded', 'posted', 'excluded'] as const).default('pending'),
    coded_account_id: c.uuid().nullable().references('accounts'),
    coded_department_id: c.uuid().nullable().references('departments'),
    coding_source: c.enum(['rule', 'agent', 'human', 'history'] as const).nullable(),
    coding_confidence: c.numeric(4, 3).nullable(),
    journal_entry_id: c.uuid().nullable().references('journal_entries'),
    external_id: c.text(),
    import_batch_id: c.uuid().nullable().references('import_batches'),
    source_locator: c.text().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: CASH,
    description: 'Card transaction from the card feed; coded to an account and department before posting.',
    ontologyClass: 'bh:CardTransaction',
    uniques: [['card_id', 'external_id']],
    indexes: [['entity_id', 'transaction_date'], ['status']],
  },
);

// ---------------------------------------------------------------- Schedules & payroll

export const fixedAssets = table(
  'fixed_assets',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    asset_number: c.text(),
    description: c.text(),
    asset_class: c.enum(['computer_equipment', 'furniture_fixtures', 'leasehold_improvements', 'machinery', 'software', 'vehicles'] as const),
    acquisition_date: c.date(),
    in_service_date: c.date(),
    cost_minor: c.money().check('> 0', (v) => v > 0),
    salvage_minor: c.money().default(0),
    useful_life_months: c.int().check('> 0', (v) => v > 0),
    method: c.enum(['straight_line'] as const).default('straight_line'),
    asset_account_id: c.uuid().references('accounts'),
    accumulated_depreciation_account_id: c.uuid().references('accounts'),
    depreciation_expense_account_id: c.uuid().references('accounts'),
    department_id: c.uuid().nullable().references('departments'),
    location_id: c.uuid().nullable().references('locations'),
    vendor_id: c.uuid().nullable().references('vendors'),
    bill_id: c.uuid().nullable().references('bills'),
    status: c.enum(['active', 'disposed', 'fully_depreciated'] as const).default('active'),
    disposal_date: c.date().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: SCHED,
    description: 'Fixed asset register (ASC 360).',
    ontologyClass: 'bh:FixedAsset',
    uniques: [['entity_id', 'asset_number']],
    checks: [
      check('fa_salvage', 'salvage_minor >= 0 AND salvage_minor < cost_minor', (r) => Number(r.salvage_minor) >= 0 && Number(r.salvage_minor) < Number(r.cost_minor), 'salvage must be >= 0 and below cost'),
      check('fa_dates', 'in_service_date >= acquisition_date', (r) => String(r.in_service_date) >= String(r.acquisition_date), 'in-service date is on/after acquisition'),
    ],
  },
);

export const depreciationLines = table(
  'depreciation_lines',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    fixed_asset_id: c.uuid().references('fixed_assets', 'cascade'),
    period_id: c.uuid().references('periods'),
    fiscal_year: c.int(),
    period_number: c.int(),
    amount_minor: c.money().check('>= 0', (v) => v >= 0),
    accumulated_minor: c.money(),
    net_book_value_minor: c.money(),
    status: c.enum(['scheduled', 'posted', 'skipped'] as const).default('scheduled'),
    journal_entry_id: c.uuid().nullable().references('journal_entries'),
  },
  { area: SCHED, description: 'Depreciation schedule line per asset per period.', ontologyClass: 'bh:DepreciationScheduleLine', uniques: [['fixed_asset_id', 'period_id']] },
);

export const amortizationSchedules = table(
  'amortization_schedules',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    kind: c.enum(['prepaid_expense', 'deferred_revenue'] as const),
    description: c.text(),
    vendor_id: c.uuid().nullable().references('vendors'),
    customer_id: c.uuid().nullable().references('customers'),
    bill_id: c.uuid().nullable().references('bills'),
    invoice_id: c.uuid().nullable().references('invoices'),
    balance_account_id: c.uuid().references('accounts'),
    pl_account_id: c.uuid().references('accounts'),
    department_id: c.uuid().nullable().references('departments'),
    total_minor: c.money().check('> 0', (v) => v > 0),
    start_date: c.date(),
    end_date: c.date(),
    months: c.int().check('> 0', (v) => v > 0),
    method: c.enum(['straight_line_monthly'] as const).default('straight_line_monthly'),
    status: c.enum(['active', 'completed', 'cancelled'] as const).default('active'),
    created_by: c.uuid().nullable().references('users', 'set null'),
    created_by_run_id: c.uuid().nullable().references('agent_runs'),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: SCHED,
    description: 'Amortization schedule for a prepaid expense (ASC 340) or deferred revenue (ASC 606).',
    ontologyClass: 'bh:AmortizationSchedule',
    checks: [check('amort_dates', 'end_date >= start_date', (r) => String(r.end_date) >= String(r.start_date), 'end date must be on/after start date')],
  },
);

export const amortizationLines = table(
  'amortization_lines',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    schedule_id: c.uuid().references('amortization_schedules', 'cascade'),
    period_id: c.uuid().references('periods'),
    period_end: c.date(),
    amount_minor: c.money().check('>= 0', (v) => v >= 0),
    status: c.enum(['scheduled', 'posted', 'skipped'] as const).default('scheduled'),
    journal_entry_id: c.uuid().nullable().references('journal_entries'),
  },
  { area: SCHED, description: 'Monthly amortization amount.', ontologyClass: 'bh:AmortizationScheduleLine', uniques: [['schedule_id', 'period_id']] },
);

export const payrollRuns = table(
  'payroll_runs',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    provider: c.text(),
    external_id: c.text(),
    pay_period_start: c.date(),
    pay_period_end: c.date(),
    pay_date: c.date(),
    currency: c.currency(),
    gross_minor: c.money(),
    employer_tax_minor: c.money(),
    benefits_minor: c.money(),
    withholding_minor: c.money(),
    net_pay_minor: c.money(),
    headcount: c.int(),
    journal_entry_id: c.uuid().nullable().references('journal_entries'),
    source_document_id: c.uuid().nullable().references('source_documents'),
    import_batch_id: c.uuid().nullable().references('import_batches'),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: SCHED,
    description: 'Payroll run summary from the payroll provider.',
    ontologyClass: 'bh:PayrollRun',
    uniques: [['entity_id', 'provider', 'external_id']],
    checks: [
      check('payroll_net', 'net_pay_minor = gross_minor - withholding_minor', (r) => Number(r.net_pay_minor) === Number(r.gross_minor) - Number(r.withholding_minor), 'net pay = gross - withholdings'),
    ],
  },
);

export const payrollLines = table(
  'payroll_lines',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    payroll_run_id: c.uuid().references('payroll_runs', 'cascade'),
    department_id: c.uuid().nullable().references('departments'),
    category: c.enum(['wages', 'bonus', 'commission', 'employer_tax', 'benefits'] as const),
    amount_minor: c.money(),
  },
  { area: SCHED, description: 'Payroll cost by department and category.' },
);
