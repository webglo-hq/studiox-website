import { c, check, nnd, table } from '../dsl';

const AREA = 'Reconciliation';

export const REC_TYPES = [
  'bank',
  'credit_card',
  'subledger_ap',
  'subledger_ar',
  'intercompany',
  'prepaid',
  'fixed_assets',
  'accrued_liabilities',
  'payroll_liabilities',
  'deferred_revenue',
  'balance_sheet',
] as const;

export const reconciliations = table(
  'reconciliations',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    entity_id: c.uuid().references('entities'),
    period_id: c.uuid().references('periods'),
    close_task_id: c.uuid().nullable().references('close_tasks', 'set null'),
    rec_type: c.enum(REC_TYPES),
    account_id: c.uuid().references('accounts'),
    bank_account_id: c.uuid().nullable().references('bank_accounts'),
    counterparty_entity_id: c.uuid().nullable().references('entities'),
    currency: c.currency(),
    gl_balance_minor: c.money().default(0),
    /** Statement, subledger or counterparty balance. */
    external_balance_minor: c.money().default(0),
    reconciling_total_minor: c.money().default(0),
    /** Unexplained = gl - external - reconciling items. Certification requires 0 (or below clearly-trivial with a note). */
    difference_minor: c.money().default(0),
    status: c.enum(['not_started', 'in_progress', 'prepared', 'reviewed', 'reopened'] as const).default('not_started'),
    risk: c.enum(['low', 'medium', 'high'] as const).default('medium'),
    prepared_by: c.uuid().nullable().references('users', 'set null'),
    prepared_at: c.timestamp().nullable(),
    reviewed_by: c.uuid().nullable().references('users', 'set null'),
    reviewed_at: c.timestamp().nullable(),
    last_run_id: c.uuid().nullable().references('agent_runs'),
    notes: c.text().nullable(),
    created_at: c.timestamp().defaultNow(),
    updated_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'Account reconciliation for one period: GL vs. external balance, reconciling items, certification.',
    ontologyClass: 'bh:Reconciliation',
    uniques: [nnd('period_id', 'account_id', 'rec_type', 'bank_account_id', 'counterparty_entity_id')],
    indexes: [['entity_id', 'period_id']],
    checks: [
      check(
        'rec_certify_sod',
        'reviewed_by IS NULL OR reviewed_by IS DISTINCT FROM prepared_by',
        (r) => r.reviewed_by == null || r.reviewed_by !== r.prepared_by,
        'a reconciliation must be reviewed by someone other than its preparer',
      ),
      check(
        'rec_reviewed_meta',
        "status <> 'reviewed' OR (reviewed_by IS NOT NULL AND prepared_by IS NOT NULL)",
        (r) => r.status !== 'reviewed' || (r.reviewed_by != null && r.prepared_by != null),
        'a reviewed reconciliation has both a preparer and a reviewer',
      ),
    ],
  },
);

export const recMatches = table(
  'rec_matches',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    reconciliation_id: c.uuid().references('reconciliations', 'cascade'),
    match_type: c.enum(['exact', 'fuzzy', 'one_to_many', 'many_to_one', 'many_to_many', 'manual'] as const),
    status: c.enum(['proposed', 'accepted', 'rejected'] as const).default('proposed'),
    confidence: c.numeric(4, 3).check('BETWEEN 0 AND 1', (v) => v >= 0 && v <= 1),
    rule: c.text(),
    explanation: c.text(),
    proposal_id: c.uuid().nullable().references('proposals'),
    accepted_by: c.uuid().nullable().references('users', 'set null'),
    accepted_at: c.timestamp().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'A match group between external items and ledger items.', ontologyClass: 'bh:ReconciliationMatch', indexes: [['reconciliation_id']] },
);

export const recMatchItems = table(
  'rec_match_items',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    match_id: c.uuid().references('rec_matches', 'cascade'),
    side: c.enum(['external', 'ledger'] as const),
    bank_transaction_id: c.uuid().nullable().references('bank_transactions'),
    journal_line_id: c.uuid().nullable().references('journal_lines'),
    amount_minor: c.money(),
  },
  {
    area: AREA,
    description: 'Member of a match group (exactly one referenced item).',
    indexes: [['bank_transaction_id'], ['journal_line_id']],
    checks: [
      check(
        'match_item_one_ref',
        'num_nonnulls(bank_transaction_id, journal_line_id) = 1',
        (r) => [r.bank_transaction_id, r.journal_line_id].filter((v) => v != null).length === 1,
        'a match item references exactly one bank transaction or journal line',
      ),
    ],
  },
);

export const reconcilingItems = table(
  'reconciling_items',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    reconciliation_id: c.uuid().references('reconciliations', 'cascade'),
    kind: c.enum([
      'deposit_in_transit',
      'outstanding_check',
      'bank_fee',
      'interest',
      'bank_error',
      'book_error',
      'timing_difference',
      'unrecorded_transaction',
      'fx_difference',
      'unexplained',
    ] as const),
    description: c.text(),
    /** Signed effect: gl_balance - external_balance = sum(reconciling items) when fully explained. */
    amount_minor: c.money(),
    item_date: c.date(),
    expected_clear_date: c.date().nullable(),
    cleared_date: c.date().nullable(),
    status: c.enum(['open', 'resolved', 'written_off'] as const).default('open'),
    bank_transaction_id: c.uuid().nullable().references('bank_transactions'),
    journal_line_id: c.uuid().nullable().references('journal_lines'),
    resolution_entry_id: c.uuid().nullable().references('journal_entries'),
    proposal_id: c.uuid().nullable().references('proposals'),
    created_by: c.uuid().nullable().references('users', 'set null'),
    created_by_run_id: c.uuid().nullable().references('agent_runs'),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'Explained difference between GL and external balance (timing or error), with aging.', ontologyClass: 'bh:ReconcilingItem', indexes: [['reconciliation_id']] },
);
