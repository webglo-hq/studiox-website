import { c, check, nnd, table } from '../dsl';

const AREA = 'General ledger';

export const accounts = table(
  'accounts',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    number: c.text(),
    name: c.text(),
    account_class: c.enum(['asset', 'liability', 'equity', 'revenue', 'expense'] as const),
    /** Ontology class id (e.g. bh:Cash, bh:PrepaidExpense, bh:SoftwareExpense). */
    subtype: c.text(),
    normal_balance: c.enum(['debit', 'credit'] as const),
    parent_id: c.uuid().nullable().references('accounts'),
    is_postable: c.bool().default(true),
    /** Financial statement line key (e.g. BS.CA.CASH, IS.OPEX.SM). */
    fs_line: c.text(),
    xbrl_element: c.text().nullable(),
    is_reconcilable: c.bool().default(false),
    is_control_account: c.bool().default(false),
    is_intercompany: c.bool().default(false),
    is_monetary: c.bool().default(false),
    requires_department: c.bool().default(false),
    status: c.enum(['active', 'inactive'] as const).default('active'),
    description: c.text().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'Chart of accounts (tenant-wide, shared by entities). Leaf accounts are postable; headers roll up.',
    ontologyClass: 'bh:Account',
    uniques: [['tenant_id', 'number']],
  },
);

function dimension(name: 'departments' | 'locations' | 'classes' | 'projects', ontologyClass: string, description: string) {
  return table(
    name,
    {
      id: c.id(),
      tenant_id: c.uuid().references('tenants'),
      code: c.text(),
      name: c.text(),
      parent_id: c.uuid().nullable().references(name),
      owner_user_id: c.uuid().nullable().references('users', 'set null'),
      status: c.enum(['active', 'inactive'] as const).default('active'),
    },
    { area: 'Dimensions', description, ontologyClass, uniques: [['tenant_id', 'code']] },
  );
}

export const departments = dimension('departments', 'bh:Department', 'Cost-center dimension (who spent it).');
export const locations = dimension('locations', 'bh:Location', 'Geographic dimension (where).');
export const classes = dimension('classes', 'bh:BusinessClass', 'Classification dimension, e.g. product line.');
export const projects = dimension('projects', 'bh:Project', 'Project dimension for capitalizable or tracked work.');

export const periods = table(
  'periods',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    fiscal_year: c.int(),
    period_number: c.int().check('BETWEEN 1 AND 13', (v) => v >= 1 && v <= 13),
    name: c.text(),
    start_date: c.date(),
    end_date: c.date(),
    status: c.enum(['future', 'open', 'soft_closed', 'locked'] as const).default('future'),
    soft_closed_at: c.timestamp().nullable(),
    soft_closed_by: c.uuid().nullable().references('users', 'set null'),
    locked_at: c.timestamp().nullable(),
    locked_by: c.uuid().nullable().references('users', 'set null'),
    reopened_count: c.int().default(0),
  },
  {
    area: AREA,
    description: 'Accounting period per entity with its state machine: future -> open -> soft_closed -> locked.',
    ontologyClass: 'bh:AccountingPeriod',
    uniques: [['entity_id', 'fiscal_year', 'period_number']],
    checks: [
      check('period_dates', 'end_date >= start_date', (r) => String(r.end_date) >= String(r.start_date), 'period end must be on/after start'),
      check('period_lock_meta', "status <> 'locked' OR locked_at IS NOT NULL", (r) => r.status !== 'locked' || r.locked_at != null, 'a locked period records when it was locked'),
    ],
  },
);

export const fxRates = table(
  'fx_rates',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    base_currency: c.currency(),
    quote_currency: c.currency(),
    rate_date: c.date(),
    rate_type: c.enum(['spot', 'average', 'closing'] as const),
    /** 1 unit of base = rate units of quote. */
    rate: c.numeric(18, 8).check('> 0', (v) => v > 0),
    source: c.text().default('seed'),
  },
  {
    area: 'FX',
    description: 'Exchange rates: spot (daily), average (month) and closing (month end).',
    ontologyClass: 'bh:ExchangeRate',
    uniques: [['tenant_id', 'base_currency', 'quote_currency', 'rate_date', 'rate_type']],
  },
);

export const JOURNAL_ENTRY_TYPES = [
  'standard',
  'adjusting',
  'accrual',
  'reversing',
  'recurring',
  'reclass',
  'elimination',
  'revaluation',
  'depreciation',
  'amortization',
  'opening',
] as const;

export const journalEntries = table(
  'journal_entries',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    period_id: c.uuid().references('periods'),
    entry_number: c.text(),
    entry_date: c.date(),
    entry_type: c.enum(JOURNAL_ENTRY_TYPES).default('standard'),
    status: c.enum(['draft', 'pending_approval', 'posted', 'rejected'] as const).default('draft'),
    description: c.text(),
    source: c.enum(['manual', 'agent', 'subledger', 'import', 'system'] as const).default('manual'),
    source_module: c
      .enum(['gl', 'ap', 'ar', 'bank', 'card', 'fixed_assets', 'prepaid', 'payroll', 'intercompany', 'fx', 'revenue'] as const)
      .default('gl'),
    source_document_id: c.uuid().nullable().references('source_documents'),
    import_batch_id: c.uuid().nullable().references('import_batches'),
    source_locator: c.text().nullable(),
    external_ref: c.text().nullable(),
    external_prepared_by: c.text().nullable(),
    external_approved_by: c.text().nullable(),
    /** Transaction currency and rate to the entity's functional currency. */
    currency: c.currency(),
    fx_rate: c.numeric(18, 8).default(1),
    prepared_by: c.uuid().nullable().references('users'),
    prepared_by_run_id: c.uuid().nullable().references('agent_runs'),
    proposal_id: c.uuid().nullable().references('proposals'),
    approval_basis: c.enum(['human_approval', 'autonomy_policy', 'reversal_exemption', 'import', 'system'] as const).nullable(),
    approved_by: c.uuid().nullable().references('users'),
    approved_at: c.timestamp().nullable(),
    posted_at: c.timestamp().nullable(),
    posted_by: c.uuid().nullable().references('users'),
    posted_by_run_id: c.uuid().nullable().references('agent_runs'),
    reverses_entry_id: c.uuid().nullable().unique().references('journal_entries'),
    auto_reverse_date: c.date().nullable(),
    ic_reference: c.text().nullable(),
    counterparty_entity_id: c.uuid().nullable().references('entities'),
    idempotency_key: c.text().nullable().unique(),
    total_minor: c.money().default(0),
    line_count: c.int().default(0),
    created_at: c.timestamp().defaultNow(),
    updated_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description:
      'Journal entry header. Posting is a state transition the database validates (>= 2 lines, debits = credits, period open, dates in period). Posted entries are immutable; corrections are reversing entries.',
    ontologyClass: 'bh:JournalEntry',
    uniques: [['entity_id', 'entry_number']],
    indexes: [['entity_id', 'period_id', 'status'], ['tenant_id', 'status'], ['prepared_by_run_id']],
    checks: [
      check(
        'je_maker_checker',
        "approval_basis IS DISTINCT FROM 'human_approval' OR (approved_by IS NOT NULL AND approved_by IS DISTINCT FROM prepared_by)",
        (r) => r.approval_basis !== 'human_approval' || (r.approved_by != null && r.approved_by !== r.prepared_by),
        'maker-checker: the approver of a journal entry must be a different person than its preparer',
      ),
      check(
        'je_posted_meta',
        "status <> 'posted' OR (posted_at IS NOT NULL AND approval_basis IS NOT NULL)",
        (r) => r.status !== 'posted' || (r.posted_at != null && r.approval_basis != null),
        'a posted entry records when and on what basis it was posted',
      ),
      check(
        'je_auto_reverse_after',
        'auto_reverse_date IS NULL OR auto_reverse_date > entry_date',
        (r) => r.auto_reverse_date == null || String(r.auto_reverse_date) > String(r.entry_date),
        'auto-reverse date must be after the entry date',
      ),
      check('je_not_self_reversal', 'reverses_entry_id IS NULL OR reverses_entry_id <> id', (r) => r.reverses_entry_id == null || r.reverses_entry_id !== r.id, 'an entry cannot reverse itself'),
      check('je_fx_rate', 'fx_rate > 0', (r) => Number(r.fx_rate) > 0, 'fx rate must be positive'),
    ],
  },
);

export const journalLines = table(
  'journal_lines',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    journal_entry_id: c.uuid().references('journal_entries', 'cascade'),
    line_number: c.int(),
    /** Denormalized from the header (kept in sync by trigger/guard) for fast aggregation. */
    entity_id: c.uuid().references('entities'),
    period_id: c.uuid().references('periods'),
    entry_date: c.date(),
    account_id: c.uuid().references('accounts'),
    debit_minor: c.money().default(0).check('>= 0', (v) => v >= 0),
    credit_minor: c.money().default(0).check('>= 0', (v) => v >= 0),
    txn_currency: c.currency(),
    /** Signed amount in transaction currency, debit-positive. */
    txn_amount_minor: c.money(),
    department_id: c.uuid().nullable().references('departments'),
    location_id: c.uuid().nullable().references('locations'),
    class_id: c.uuid().nullable().references('classes'),
    project_id: c.uuid().nullable().references('projects'),
    counterparty_entity_id: c.uuid().nullable().references('entities'),
    vendor_id: c.uuid().nullable().references('vendors'),
    customer_id: c.uuid().nullable().references('customers'),
    memo: c.text().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'Journal line: exactly one side positive (debit XOR credit), functional-currency amounts plus the transaction-currency amount.',
    ontologyClass: 'bh:JournalLine',
    uniques: [['journal_entry_id', 'line_number']],
    indexes: [['entity_id', 'period_id', 'account_id'], ['account_id'], ['vendor_id']],
    checks: [
      check(
        'jl_one_sided',
        '(debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0)',
        (r) => (Number(r.debit_minor) > 0 && Number(r.credit_minor) === 0) || (Number(r.credit_minor) > 0 && Number(r.debit_minor) === 0),
        'each line is either a debit or a credit, and not zero',
      ),
      check(
        'jl_txn_sign',
        '(debit_minor > 0 AND txn_amount_minor >= 0) OR (credit_minor > 0 AND txn_amount_minor <= 0)',
        (r) => (Number(r.debit_minor) > 0 && Number(r.txn_amount_minor) >= 0) || (Number(r.credit_minor) > 0 && Number(r.txn_amount_minor) <= 0),
        'transaction amount sign must match the debit/credit side',
      ),
    ],
  },
);

export const recurringTemplates = table(
  'recurring_templates',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    name: c.text(),
    description: c.text(),
    frequency: c.enum(['monthly', 'quarterly'] as const).default('monthly'),
    lines: c.json<Array<{ account_number: string; debit_minor: number; credit_minor: number; department_code?: string; memo?: string }>>(),
    auto_reverse: c.bool().default(false),
    next_run_date: c.date(),
    status: c.enum(['active', 'paused'] as const).default('active'),
    created_by: c.uuid().nullable().references('users', 'set null'),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'Template for recurring journal entries (e.g. rent, management fee).', ontologyClass: 'bh:RecurringEntry' },
);

export const budgets = table(
  'budgets',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    name: c.text(),
    fiscal_year: c.int(),
    kind: c.enum(['budget', 'forecast'] as const).default('budget'),
    version: c.int().default(1),
    status: c.enum(['draft', 'approved', 'superseded'] as const).default('draft'),
    created_by: c.uuid().nullable().references('users', 'set null'),
    approved_by: c.uuid().nullable().references('users', 'set null'),
    approved_at: c.timestamp().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: 'Planning',
    description: 'Budget or forecast version for an entity and fiscal year.',
    ontologyClass: 'bh:Budget',
    uniques: [['entity_id', 'fiscal_year', 'kind', 'version']],
  },
);

export const budgetLines = table(
  'budget_lines',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    budget_id: c.uuid().references('budgets', 'cascade'),
    account_id: c.uuid().references('accounts'),
    department_id: c.uuid().nullable().references('departments'),
    period_number: c.int().check('BETWEEN 1 AND 12', (v) => v >= 1 && v <= 12),
    /** Net amount, debit-positive (expenses positive, revenue negative). */
    amount_minor: c.money(),
    driver: c.text().nullable(),
  },
  {
    area: 'Planning',
    description: 'Budget amount per account, department and month.',
    uniques: [nnd('budget_id', 'account_id', 'department_id', 'period_number')],
  },
);

export const materialitySettings = table(
  'materiality_settings',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    fiscal_year: c.int(),
    version: c.int().default(1),
    benchmark: c.enum(['revenue', 'pretax_income', 'total_assets', 'total_expenses'] as const),
    benchmark_minor: c.money(),
    overall_pct: c.numeric(8, 6),
    overall_minor: c.money(),
    performance_pct: c.numeric(8, 6),
    performance_minor: c.money(),
    trivial_pct: c.numeric(8, 6),
    trivial_minor: c.money(),
    rationale: c.text(),
    set_by: c.uuid().nullable().references('users', 'set null'),
    approved_by: c.uuid().nullable().references('users', 'set null'),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: 'Controls',
    description: 'Materiality: overall, performance and clearly-trivial thresholds (AS 2105 / ISA 320).',
    ontologyClass: 'bh:Materiality',
    uniques: [['tenant_id', 'fiscal_year', 'version']],
    checks: [
      check(
        'materiality_order',
        'trivial_minor <= performance_minor AND performance_minor <= overall_minor',
        (r) => Number(r.trivial_minor) <= Number(r.performance_minor) && Number(r.performance_minor) <= Number(r.overall_minor),
        'clearly trivial <= performance materiality <= overall materiality',
      ),
    ],
  },
);
