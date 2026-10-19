import { GENESIS_HASH, sha256Hex } from '../shared/hash';
import { DbConstraintError } from './db';
import type { Row, TableName } from './schema';

/**
 * Procedural invariants enforced by the memory adapter. Each mirrors a trigger in
 * db/migrations/0002_invariants.sql; tests/integration/invariant-parity runs the same violation suite against
 * both adapters and asserts identical error kinds.
 */

export interface GuardContext {
  get<T extends TableName>(table: T, id: string): Row<T> | null;
  where<T extends TableName>(table: T, column: keyof Row<T> & string, value: string): Row<T>[];
}

export interface TableGuard {
  beforeInsert?(row: Record<string, unknown>, ctx: GuardContext): void;
  beforeUpdate?(before: Record<string, unknown>, after: Record<string, unknown>, ctx: GuardContext): void;
  beforeDelete?(row: Record<string, unknown>, ctx: GuardContext): void;
}

export const MSG = {
  postedImmutable: 'posted journal entries are immutable; correct them with a reversing entry',
  insertPosted: 'journal entries must be created as draft or pending_approval and posted by a state transition',
  unbalanced: 'journal entry does not balance: total debits must equal total credits',
  tooFewLines: 'a journal entry needs at least two lines',
  periodLocked: 'the accounting period is locked or not yet open; no postings are allowed',
  softClosedType: 'the period is soft-closed; only adjusting-type entries may be posted',
  dateOutsidePeriod: 'entry date falls outside the accounting period',
  periodEntity: 'the period belongs to a different entity',
  lineParentPosted: 'lines of a posted journal entry cannot be added, changed or removed',
  lineHeaderMismatch: 'line entity, period and date must match the journal entry header',
  accountNotPostable: 'lines may only post to active, postable (leaf) accounts',
  totalsMismatch: 'header totals must equal the sum of the lines',
  reversalTarget: 'a reversal must reference a posted entry of the same entity with equal totals',
  deletePosted: 'posted journal entries cannot be deleted',
  periodTransition: 'invalid period status transition',
  reopenCount: 'reopening a locked period must increment reopened_count',
  auditChain: 'audit log chain broken: prev_hash/seq/hash do not continue the chain',
  appendOnly: 'append-only table: rows cannot be updated or deleted',
  postedDocument: 'the amount of a posted document cannot change; reverse and re-enter it',
} as const;

const ADJUSTING_TYPES = new Set([
  'adjusting',
  'accrual',
  'reclass',
  'elimination',
  'revaluation',
  'depreciation',
  'amortization',
  'reversing',
]);

function fail(kind: ConstructorParameters<typeof DbConstraintError>[0], message: string, table: string, constraint: string): never {
  throw new DbConstraintError(kind, message, { table, constraint });
}

function validatePosting(je: Record<string, unknown>, ctx: GuardContext): void {
  const lines = ctx.where('journal_lines', 'journal_entry_id', String(je.id));
  if (lines.length < 2) fail('invariant_violation', MSG.tooFewLines, 'journal_entries', 'je_post_min_lines');
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    debit += line.debit_minor;
    credit += line.credit_minor;
    const account = ctx.get('accounts', line.account_id);
    if (!account || !account.is_postable || account.status !== 'active') {
      fail('invariant_violation', MSG.accountNotPostable, 'journal_entries', 'je_post_accounts');
    }
  }
  if (debit !== credit || debit <= 0) fail('invariant_violation', MSG.unbalanced, 'journal_entries', 'je_post_balanced');
  if (Number(je.total_minor) !== debit || Number(je.line_count) !== lines.length) {
    fail('invariant_violation', MSG.totalsMismatch, 'journal_entries', 'je_post_totals');
  }
  const period = ctx.get('periods', String(je.period_id));
  if (!period) fail('invariant_violation', MSG.periodEntity, 'journal_entries', 'je_post_period');
  if (period.entity_id !== je.entity_id) fail('invariant_violation', MSG.periodEntity, 'journal_entries', 'je_post_period');
  if (String(je.entry_date) < period.start_date || String(je.entry_date) > period.end_date) {
    fail('invariant_violation', MSG.dateOutsidePeriod, 'journal_entries', 'je_post_date');
  }
  if (period.status === 'locked' || period.status === 'future') fail('period_locked', MSG.periodLocked, 'journal_entries', 'je_post_period_open');
  if (period.status === 'soft_closed' && !ADJUSTING_TYPES.has(String(je.entry_type))) {
    fail('period_locked', MSG.softClosedType, 'journal_entries', 'je_post_soft_close');
  }
  if (je.reverses_entry_id) {
    const target = ctx.get('journal_entries', String(je.reverses_entry_id));
    if (!target || target.status !== 'posted' || target.entity_id !== je.entity_id || target.total_minor !== debit) {
      fail('invariant_violation', MSG.reversalTarget, 'journal_entries', 'je_post_reversal');
    }
  }
}

const IMMUTABLE_DOC_AMOUNT: Array<[TableName, string]> = [
  ['bills', 'amount_minor'],
  ['invoices', 'amount_minor'],
  ['vendor_payments', 'amount_minor'],
  ['customer_receipts', 'amount_minor'],
];

const PERIOD_TRANSITIONS: Record<string, string[]> = {
  future: ['open'],
  open: ['soft_closed'],
  soft_closed: ['open', 'locked'],
  locked: ['soft_closed'],
};

export const memoryGuards: Partial<Record<TableName, TableGuard>> = {
  journal_entries: {
    beforeInsert(row, ctx) {
      if (row.status === 'posted') fail('invariant_violation', MSG.insertPosted, 'journal_entries', 'je_insert_not_posted');
      const period = ctx.get('periods', String(row.period_id));
      if (period && period.entity_id !== row.entity_id) fail('invariant_violation', MSG.periodEntity, 'journal_entries', 'je_period_entity');
    },
    beforeUpdate(before, after, ctx) {
      if (before.status === 'posted') fail('immutable_row', MSG.postedImmutable, 'journal_entries', 'je_posted_immutable');
      if (after.status === 'posted') validatePosting(after, ctx);
      const period = ctx.get('periods', String(after.period_id));
      if (period && period.entity_id !== after.entity_id) fail('invariant_violation', MSG.periodEntity, 'journal_entries', 'je_period_entity');
    },
    beforeDelete(row) {
      if (row.status === 'posted') fail('immutable_row', MSG.deletePosted, 'journal_entries', 'je_posted_no_delete');
    },
  },
  journal_lines: {
    beforeInsert(row, ctx) {
      const je = ctx.get('journal_entries', String(row.journal_entry_id));
      if (!je) return; // FK check reports it
      if (je.status === 'posted') fail('immutable_row', MSG.lineParentPosted, 'journal_lines', 'jl_parent_posted');
      if (je.entity_id !== row.entity_id || je.period_id !== row.period_id || je.entry_date !== row.entry_date) {
        fail('invariant_violation', MSG.lineHeaderMismatch, 'journal_lines', 'jl_header_match');
      }
    },
    beforeUpdate(before, after, ctx) {
      const je = ctx.get('journal_entries', String(before.journal_entry_id));
      if (je && je.status === 'posted') fail('immutable_row', MSG.lineParentPosted, 'journal_lines', 'jl_parent_posted');
      const nextJe = ctx.get('journal_entries', String(after.journal_entry_id));
      if (nextJe && (nextJe.entity_id !== after.entity_id || nextJe.period_id !== after.period_id || nextJe.entry_date !== after.entry_date)) {
        fail('invariant_violation', MSG.lineHeaderMismatch, 'journal_lines', 'jl_header_match');
      }
    },
    beforeDelete(row, ctx) {
      const je = ctx.get('journal_entries', String(row.journal_entry_id));
      if (je && je.status === 'posted') fail('immutable_row', MSG.lineParentPosted, 'journal_lines', 'jl_parent_posted');
    },
  },
  periods: {
    beforeUpdate(before, after) {
      if (before.status !== after.status) {
        const allowed = PERIOD_TRANSITIONS[String(before.status)] ?? [];
        if (!allowed.includes(String(after.status))) fail('invariant_violation', `${MSG.periodTransition}: ${String(before.status)} -> ${String(after.status)}`, 'periods', 'period_transition');
        if (before.status === 'locked' && Number(after.reopened_count) !== Number(before.reopened_count) + 1) {
          fail('invariant_violation', MSG.reopenCount, 'periods', 'period_reopen_count');
        }
      }
    },
  },
  audit_log: {
    beforeInsert(row, ctx) {
      const prior = ctx.where('audit_log', 'tenant_id', String(row.tenant_id));
      let last: Row<'audit_log'> | null = null;
      for (const r of prior) if (!last || r.seq > last.seq) last = r;
      const expectedSeq = last ? last.seq + 1 : 1;
      const expectedPrev = last ? last.hash : GENESIS_HASH;
      const expectedHash = sha256Hex(`${String(row.prev_hash)}\n${String(row.record)}`);
      if (Number(row.seq) !== expectedSeq || row.prev_hash !== expectedPrev || row.hash !== expectedHash) {
        fail('audit_chain', MSG.auditChain, 'audit_log', 'audit_chain');
      }
    },
  },
};

for (const [table, column] of IMMUTABLE_DOC_AMOUNT) {
  memoryGuards[table] = {
    beforeUpdate(before, after) {
      if (before.journal_entry_id != null && before[column] !== after[column]) {
        fail('immutable_row', MSG.postedDocument, table, `${table}_posted_amount`);
      }
    },
  };
}
