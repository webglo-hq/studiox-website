/**
 * MemoryStore emulation of the accounting pack's triggers and multi-column CHECKs
 * (mirrors migrations/0002_accounting.sql). The store contract tests run the same scenarios
 * against Postgres and this emulation to prove the invariants hold identically.
 */
import type { HookReader, MemoryHooks } from '../../core/store/memory';
import { StoreError } from '../../core/store/types';

type Row = Record<string, unknown>;
const fail = (axiom: string, msg: string, code = '23514') => {
  throw new StoreError(code, `${axiom}: ${msg}`);
};
const ADJUSTING = new Set(['adjusting', 'accrual', 'reversing', 'reclass', 'elimination', 'fx_revaluation', 'opening', 'closing']);

function postingChecks(je: Row, db: HookReader) {
  const period = db.get('periods', je.period_id as string);
  if (!period) fail('AX-PD-01', `period ${String(je.period_id)} not found`, '23503');
  const ps = period!.status as string;
  if (ps === 'locked' || ps === 'future' || (ps === 'soft_closed' && !ADJUSTING.has(je.entry_type as string)))
    fail('AX-PD-01', `cannot post ${String(je.entry_type)} entry ${String(je.je_number)} into a ${ps} period`);
  const d = je.posting_date as string;
  if (d < (period!.start_date as string) || d > (period!.end_date as string)) fail('AX-PD-02', `posting date ${d} is outside period ${String(period!.start_date)} to ${String(period!.end_date)}`);
  const lines = db.find('journal_lines', { journal_entry_id: je.id });
  if (lines.length < 2) fail('AX-DE-03', `journal entry ${String(je.je_number)} needs at least two lines (has ${lines.length})`);
  let dr = 0;
  let cr = 0;
  for (const l of lines) {
    dr += l.debit_minor as number;
    cr += l.credit_minor as number;
  }
  if (dr !== cr || dr === 0) fail('AX-DE-01', `journal entry ${String(je.je_number)} does not balance (debits ${dr} <> credits ${cr})`);
  if (je.total_minor !== dr) fail('AX-DE-01', `journal entry ${String(je.je_number)} header total ${String(je.total_minor)} disagrees with lines ${dr}`);
  if ((je.source === 'manual' || je.source === 'agent') && je.approval_route === 'human' && (!je.approved_by || je.approved_by === je.prepared_by))
    fail('AX-SOD-01', `journal entry ${String(je.je_number)} must be approved by someone other than its preparer`);
  if (je.reverses_je_id) {
    const orig = db.get('journal_entries', je.reverses_je_id as string);
    if (!orig || orig.status !== 'posted') fail('AX-IM-02', 'only posted entries can be reversed');
  }
  if (!je.posted_at || !je.posted_by || !je.approval_route) fail('AX-DE-01', 'posted entries need posted_at, posted_by and approval_route');
}

function jeRowChecks(je: Row) {
  if ((je.total_minor as number) < 0) fail('AX-DE-01', 'total must be non-negative');
  if (je.reverses_je_id && je.reverses_je_id === je.id) fail('AX-IM-02', 'an entry cannot reverse itself');
  if (je.auto_reverse_on && (je.auto_reverse_on as string) <= (je.posting_date as string)) fail('AX-ACR-01', 'auto-reversal must be after the posting date');
}

function lineGuard(jeId: string, db: HookReader) {
  const je = db.get('journal_entries', jeId);
  if (je && je.status !== 'draft' && je.status !== 'pending_approval') fail('AX-IM-01', `lines of a ${String(je.status)} journal entry cannot change`, '23000');
}

function lineRowChecks(l: Row, db: HookReader) {
  const dr = l.debit_minor as number;
  const cr = l.credit_minor as number;
  if (dr < 0 || cr < 0 || !((dr > 0 && cr === 0) || (cr > 0 && dr === 0))) fail('AX-DE-02', 'each line must have exactly one positive side');
  if ((l.txn_currency === null) !== (l.txn_amount_minor === null)) fail('AX-DE-02', 'transaction currency and amount go together');
  const acct = db.get('accounts', l.account_id as string);
  if (acct && (!acct.is_postable || acct.status !== 'active')) fail('AX-AC-01', `account ${String(acct.code)} is not an active postable account`);
}

export const accountingHooks: MemoryHooks = {
  beforeInsert: {
    accounts: (a) => {
      const debitClass = a.account_class === 'asset' || a.account_class === 'expense';
      const expected = debitClass !== !!a.is_contra ? 'debit' : 'credit';
      if (a.normal_balance !== expected) fail('AX-AC-03', `account ${String(a.code)} should be ${expected}-normal`);
    },
    journal_entries: (je, db) => {
      jeRowChecks(je);
      if (je.status === 'posted') postingChecks(je, db);
    },
    journal_lines: (l, db) => {
      lineGuard(l.journal_entry_id as string, db);
      lineRowChecks(l, db);
    },
    periods: (p) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(p.period_key))) fail('AX-PD-02', 'period key must be YYYY-MM');
      if ((p.end_date as string) < (p.start_date as string)) fail('AX-PD-02', 'period end before start');
    },
    reconciliations: (r) => recChecks(r),
    flux_explanations: (x) => fluxExplanationChecks(x),
    close_tasks: (t) => taskRowChecks(t),
    payroll_runs: (p) => {
      if (p.net_pay_minor !== (p.gross_minor as number) - (p.withholdings_minor as number)) fail('AX-DE-01', 'net pay must equal gross pay minus withholdings');
    },
    close_task_dependencies: (d) => {
      if (d.task_id === d.depends_on_task_id) fail('AX-CL-01', 'a task cannot depend on itself');
    },
    entities: (e) => {
      if (e.parent_id && e.parent_id === e.id) fail('AX-IC-01', 'an entity cannot be its own parent');
    },
  },
  beforeUpdate: {
    journal_entries: (old, next, db) => {
      if (old.status === 'posted') fail('AX-IM-01', `posted journal entry ${String(old.je_number)} is immutable; post a reversing entry`, '23000');
      jeRowChecks(next);
      if (next.status === 'posted') postingChecks(next, db);
    },
    journal_lines: (old, next, db) => {
      // the entry a line leaves and the entry it joins must both still be editable (AX-IM-01)
      lineGuard(old.journal_entry_id as string, db);
      if (next.journal_entry_id !== old.journal_entry_id) lineGuard(next.journal_entry_id as string, db);
      lineRowChecks(next, db);
    },
    periods: (old, next) => {
      if (old.status === next.status) return;
      const ok = new Set(['future>open', 'open>soft_closed', 'soft_closed>open', 'soft_closed>locked', 'locked>soft_closed']).has(`${String(old.status)}>${String(next.status)}`);
      if (!ok) fail('AX-PD-03', `period ${String(old.period_key)} cannot move from ${String(old.status)} to ${String(next.status)}`);
      if (old.status === 'locked' && (!next.status_reason || String(next.status_reason).length < 10)) fail('AX-PD-03', `unlocking period ${String(old.period_key)} requires a documented reason`);
    },
    close_tasks: (old, next, db) => {
      taskRowChecks(next);
      if (next.status === 'done' && old.status !== 'done') {
        const deps = db.find('close_task_dependencies', { task_id: old.id });
        const open = deps.filter((d) => {
          const t = db.get('close_tasks', d.depends_on_task_id as string);
          return t && t.status !== 'done' && t.status !== 'skipped';
        });
        if (open.length) fail('AX-CL-01', `task ${String(old.key)} has ${open.length} unfinished dependencies`);
      }
    },
    close_packages: (old) => {
      if (old.status === 'final') fail('AX-AUD-01', 'a final close package is immutable; generate a new version', '23000');
    },
    reconciliations: (_old, next) => recChecks(next),
    flux_explanations: (_old, next) => fluxExplanationChecks(next),
  },
  beforeDelete: {
    journal_entries: (je) => {
      if (je.status === 'posted' || je.status === 'approved') fail('AX-IM-01', `${String(je.status)} journal entry ${String(je.je_number)} cannot be deleted; reverse it instead`, '23000');
    },
    journal_lines: (l, db) => lineGuard(l.journal_entry_id as string, db),
    close_packages: (p) => {
      if (p.status === 'final') fail('AX-AUD-01', 'a final close package is immutable', '23000');
    },
  },
};

function recChecks(r: Row) {
  if (r.reviewer_id && r.preparer_id && r.reviewer_id === r.preparer_id) fail('AX-SOD-03', 'reconciliation reviewer must differ from preparer');
  if ((r.status === 'prepared' || r.status === 'reviewed') && !r.preparer_id) fail('AX-SOD-03', 'a prepared reconciliation needs a preparer');
  if (r.status === 'reviewed' && !r.reviewer_id) fail('AX-SOD-03', 'a reviewed reconciliation needs a reviewer');
}

function fluxExplanationChecks(x: Row) {
  if (String(x.text ?? '').length < 20) fail('AX-FLX-01', 'explanations need at least 20 characters');
  if (x.approved_by && x.approved_by === x.author_id) fail('AX-SOD-01', 'an explanation cannot be approved by its author');
}

function taskRowChecks(t: Row) {
  if (t.status === 'blocked' && !t.blocked_reason) fail('AX-CL-01', 'a blocked task needs a reason');
  if (t.reviewed_by && t.completed_by && t.reviewed_by === t.completed_by) fail('AX-SOD-01', 'the reviewer of a task must differ from the person who completed it');
}
