import { beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/framework/audit/chain';
import type { EkDb } from '../../src/packs/accounting/store';

/**
 * One invariant suite, many stores: the same tests run against the in-memory store (emulated
 * triggers), embedded PGlite and a real PostgreSQL 16 server, proving the database enforces
 * the ledger's rules itself — not only the application code.
 */
export interface MiniTenant {
  tenantId: string;
  userA: string;
  userB: string;
  entityId: string;
  periodOpen: string;
  periodLocked: string;
  cash: string;
  expense: string;
  summary: string;
  fs: string;
}

const T = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export async function buildMiniTenant(db: EkDb): Promise<MiniTenant> {
  await db.insert('tenant', { id: T, name: 'Invariant Co', slug: 'invariant-co' });
  await db.insert('currency', { code: 'USD', name: 'US Dollar', minor_units: 2 });
  await db.insert('app_user', { id: id(1), tenant_id: T, email: 'a@inv.example', display_name: 'A' });
  await db.insert('app_user', { id: id(2), tenant_id: T, email: 'b@inv.example', display_name: 'B' });
  await db.insert('entity', { id: id(10), tenant_id: T, code: 'US', name: 'Inv US', legal_name: 'Invariant Co Inc', functional_currency: 'USD', country: 'US' });
  await db.insert('fs_line_item', { id: id(20), tenant_id: T, statement: 'BS', code: 'BS-CASH', label: 'Cash', section: 'Assets — current', sort_order: 1, sign: 'debit' });
  await db.insert('account', { id: id(30), tenant_id: T, code: '1000', name: 'Cash', account_class: 'asset', account_type: 'ek:CashAccount', normal_balance: 'debit', fs_line_item_id: id(20), is_control_account: true, subledger: 'bank' });
  await db.insert('account', { id: id(31), tenant_id: T, code: '6000', name: 'Expense', account_class: 'expense', account_type: 'ek:ExpenseAccount', normal_balance: 'debit', fs_line_item_id: id(20) });
  await db.insert('account', { id: id(32), tenant_id: T, code: '6999', name: 'Summary', account_class: 'expense', account_type: 'ek:ExpenseAccount', normal_balance: 'debit', fs_line_item_id: id(20), is_postable: false });
  await db.insert('fiscal_period', { id: id(40), tenant_id: T, entity_id: id(10), period_key: '2026-09', fiscal_year: 2026, start_date: '2026-09-01', end_date: '2026-09-30', status: 'open' });
  await db.insert('fiscal_period', { id: id(41), tenant_id: T, entity_id: id(10), period_key: '2026-08', fiscal_year: 2026, start_date: '2026-08-01', end_date: '2026-08-31', status: 'open' });
  return { tenantId: T, userA: id(1), userB: id(2), entityId: id(10), periodOpen: id(40), periodLocked: id(41), cash: id(30), expense: id(31), summary: id(32), fs: id(20) };
}

let seq = 1000;
export async function draftEntry(db: EkDb, m: MiniTenant, lines: { account: string; debit: number; credit: number }[], over: Record<string, unknown> = {}) {
  const n = ++seq;
  const je = await db.insert('journal_entry', {
    tenant_id: m.tenantId,
    entity_id: m.entityId,
    period_id: (over.period_id as string) ?? m.periodOpen,
    period_key: (over.period_key as string) ?? '2026-09',
    entry_number: `JE-T-${n}`,
    entry_date: (over.entry_date as string) ?? '2026-09-15',
    entry_type: (over.entry_type as 'standard') ?? 'standard',
    memo: 'test',
    currency: 'USD',
    source: (over.source as 'manual') ?? 'manual',
    prepared_by: (over.prepared_by as string) ?? m.userA,
    reverses_entry_id: (over.reverses_entry_id as string) ?? null,
  });
  let i = 0;
  for (const l of lines) await db.insert('journal_line', { tenant_id: m.tenantId, journal_entry_id: je.id, line_no: ++i, account_id: l.account, debit: l.debit, credit: l.credit });
  return je;
}

async function expectCode(p: Promise<unknown>, pattern: RegExp | string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, 'expected the store to reject').toBeTruthy();
  const msg = `${(err as { code?: string }).code ?? ''} ${(err as Error).message}`;
  expect(msg).toMatch(pattern);
}

export function defineInvariantSuite(name: string, makeDb: () => Promise<EkDb>) {
  describe(`database invariants — ${name}`, () => {
    let db: EkDb;
    let m: MiniTenant;
    beforeAll(async () => {
      db = await makeDb();
      m = await buildMiniTenant(db);
    }, 120_000);

    it('posts a balanced entry and computes its total', async () => {
      const je = await draftEntry(db, m, [
        { account: m.expense, debit: 12_345, credit: 0 },
        { account: m.cash, debit: 0, credit: 12_345 },
      ]);
      const posted = await db.update('journal_entry', je.id, { status: 'posted', approved_by: m.userB });
      expect(posted.status).toBe('posted');
      expect(posted.total_debit).toBe(12_345);
      expect(posted.posted_at).toBeTruthy();
    });

    it('rejects posting an unbalanced entry (AX-DE-01)', async () => {
      const je = await draftEntry(db, m, [
        { account: m.expense, debit: 100, credit: 0 },
        { account: m.cash, debit: 0, credit: 99 },
      ]);
      await expectCode(db.update('journal_entry', je.id, { status: 'posted' }), /EK-DE-01/);
    });

    it('rejects a single-line entry (AX-DE-03) and two-sided lines (AX-DE-02)', async () => {
      const je = await draftEntry(db, m, [{ account: m.expense, debit: 100, credit: 0 }]);
      await expectCode(db.update('journal_entry', je.id, { status: 'posted' }), /EK-DE-03/);
      await expectCode(db.insert('journal_line', { tenant_id: m.tenantId, journal_entry_id: je.id, line_no: 9, account_id: m.cash, debit: 5, credit: 5 }), /23514|one_sided/);
    });

    it('rejects posting to summary accounts (AX-ACC-01)', async () => {
      const je = await draftEntry(db, m, [
        { account: m.summary, debit: 100, credit: 0 },
        { account: m.cash, debit: 0, credit: 100 },
      ]);
      await expectCode(db.update('journal_entry', je.id, { status: 'posted' }), /EK-ACC-01/);
    });

    it('refuses inserting an entry directly as posted', async () => {
      await expectCode(
        db.insert('journal_entry', { tenant_id: m.tenantId, entity_id: m.entityId, period_id: m.periodOpen, period_key: '2026-09', entry_number: 'JE-DIRECT', entry_date: '2026-09-02', entry_type: 'standard', status: 'posted', memo: 'x', currency: 'USD', source: 'manual' }),
        /EK-JE-POST-VIA-DRAFT/,
      );
    });

    it('keeps posted entries immutable (no update, delete or new lines)', async () => {
      const je = await draftEntry(db, m, [
        { account: m.expense, debit: 500, credit: 0 },
        { account: m.cash, debit: 0, credit: 500 },
      ]);
      await db.update('journal_entry', je.id, { status: 'posted', approved_by: m.userB });
      await expectCode(db.update('journal_entry', je.id, { memo: 'tampered' }), /EK-JE-IMMUTABLE/);
      await expectCode(db.delete('journal_entry', je.id), /EK-JE-IMMUTABLE|cannot be deleted/);
      await expectCode(db.insert('journal_line', { tenant_id: m.tenantId, journal_entry_id: je.id, line_no: 3, account_id: m.cash, debit: 1, credit: 0 }), /EK-JE-IMMUTABLE/);
      const lines = await db.find('journal_line', { journal_entry_id: je.id });
      await expectCode(db.update('journal_line', lines[0]!.id, { debit: 1 }), /EK-JE-IMMUTABLE/);
    });

    it('corrects only by an exact mirror reversal, once (AX-JE-02)', async () => {
      const orig = await draftEntry(db, m, [
        { account: m.expense, debit: 700, credit: 0 },
        { account: m.cash, debit: 0, credit: 700 },
      ]);
      await db.update('journal_entry', orig.id, { status: 'posted', approved_by: m.userB });
      const bad = await draftEntry(db, m, [
        { account: m.expense, debit: 0, credit: 600 },
        { account: m.cash, debit: 600, credit: 0 },
      ], { reverses_entry_id: orig.id, entry_type: 'reversing' });
      await expectCode(db.update('journal_entry', bad.id, { status: 'posted' }), /EK-JE-02/);
      const rev = await draftEntry(db, m, [
        { account: m.expense, debit: 0, credit: 700 },
        { account: m.cash, debit: 700, credit: 0 },
      ], { reverses_entry_id: orig.id, entry_type: 'reversing' });
      await db.update('journal_entry', rev.id, { status: 'posted' });
      expect((await db.get('journal_entry', orig.id))!.reversed_by_entry_id).toBe(rev.id);
      const again = await draftEntry(db, m, [
        { account: m.expense, debit: 0, credit: 700 },
        { account: m.cash, debit: 700, credit: 0 },
      ], { reverses_entry_id: orig.id, entry_type: 'reversing' });
      await expectCode(db.update('journal_entry', again.id, { status: 'posted' }), /EK-JE-02/);
    });

    it('enforces maker-checker on journal entries (AX-SOD-01)', async () => {
      const je = await draftEntry(db, m, [
        { account: m.expense, debit: 800, credit: 0 },
        { account: m.cash, debit: 0, credit: 800 },
      ]);
      await expectCode(db.update('journal_entry', je.id, { status: 'posted', approved_by: m.userA }), /EK-SOD-01|maker_checker|23514/);
    });

    it('EK-m1: posts a manual entry only with an approver (mirror reversals and system entries excepted)', async () => {
      const je = await draftEntry(db, m, [
        { account: m.expense, debit: 950, credit: 0 },
        { account: m.cash, debit: 0, credit: 950 },
      ]);
      await expectCode(db.update('journal_entry', je.id, { status: 'posted' }), /EK-SOD-01: manual entry/);
      await expectCode(db.update('journal_entry', je.id, { status: 'posted', approved_by: m.userA }), /EK-SOD-01|maker_checker|23514/);
      expect((await db.update('journal_entry', je.id, { status: 'posted', approved_by: m.userB })).status).toBe('posted');
      // Undo by reversal mirrors the approved entry, so it needs no second approval.
      const rev = await draftEntry(db, m, [
        { account: m.expense, debit: 0, credit: 950 },
        { account: m.cash, debit: 950, credit: 0 },
      ], { reverses_entry_id: je.id, entry_type: 'reversing' });
      expect((await db.update('journal_entry', rev.id, { status: 'posted' })).status).toBe('posted');
      // System entries (e.g. an accrual's automatic reversal) post under their own policy.
      const sys = await draftEntry(db, m, [
        { account: m.expense, debit: 120, credit: 0 },
        { account: m.cash, debit: 0, credit: 120 },
      ], { source: 'system' });
      expect((await db.update('journal_entry', sys.id, { status: 'posted' })).status).toBe('posted');
    });

    it('walks periods open → soft close → hard close and locks posting', async () => {
      await expectCode(db.update('fiscal_period', m.periodLocked, { status: 'hard_close' }), /EK-PERIOD-TRANSITION/);
      const je = await draftEntry(db, m, [
        { account: m.expense, debit: 900, credit: 0 },
        { account: m.cash, debit: 0, credit: 900 },
      ], { period_id: m.periodLocked, period_key: '2026-08', entry_date: '2026-08-20' });
      await db.update('fiscal_period', m.periodLocked, { status: 'soft_close' });
      await expectCode(db.update('journal_entry', je.id, { status: 'posted', approved_by: m.userB }), /EK-PERIOD-SOFT-CLOSE/);
      await db.update('fiscal_period', m.periodLocked, { status: 'hard_close' });
      await expectCode(db.update('journal_entry', je.id, { status: 'posted', approved_by: m.userB }), /EK-PERIOD-LOCKED/);
      await expectCode(draftEntry(db, m, [{ account: m.cash, debit: 1, credit: 0 }], { period_id: m.periodLocked, period_key: '2026-08', entry_date: '2026-08-21' }), /EK-PERIOD-LOCKED/);
      await expectCode(db.update('fiscal_period', m.periodLocked, { status: 'soft_close' }), /EK-PERIOD-REOPEN/);
      await db.update('fiscal_period', m.periodLocked, { status: 'soft_close', reopen_reason: 'Audit adjustment approved by CFO' });
    });

    it('rejects entries dated outside their period (AX-PER-02)', async () => {
      const je = await draftEntry(db, m, [
        { account: m.expense, debit: 50, credit: 0 },
        { account: m.cash, debit: 0, credit: 50 },
      ], { entry_date: '2026-10-01' });
      await expectCode(db.update('journal_entry', je.id, { status: 'posted', approved_by: m.userB }), /EK-PER-02/);
    });

    it('chains audit events and refuses edits (tamper-evident, append-only)', async () => {
      for (let i = 0; i < 3; i++) {
        await db.insert('audit_log', { tenant_id: m.tenantId, occurred_at: `2026-10-02T16:0${i}:00.123Z`, actor_type: 'user', actor_id: m.userA, actor_label: 'A', action: 'test.event', subject_type: 'x', subject_id: String(i), data: { i, note: 'ünïcödé "quoted"', nested: { b: 1, a: [1, 2] } } });
      }
      const rows = await db.find('audit_log', { tenant_id: m.tenantId }, { orderBy: [['seq', 'asc']] });
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
      const v = verifyChain(rows.map((r) => ({ seq: r.seq, tenantId: r.tenant_id, occurredAt: r.occurred_at, actorType: r.actor_type, actorId: r.actor_id, action: r.action, subjectType: r.subject_type, subjectId: r.subject_id, data: r.data, prevHash: r.prev_hash, hash: r.hash })));
      expect(v.ok).toBe(true);
      await expectCode(db.update('audit_log', rows[1]!.id, { action: 'tampered' }), /EK-AUDIT-APPEND-ONLY/);
      await expectCode(db.delete('audit_log', rows[1]!.id), /EK-AUDIT-APPEND-ONLY|cannot be deleted/);
      // Tampering in memory is detected by the verifier
      const tampered = rows.map((r, i) => ({ seq: r.seq, tenantId: r.tenant_id, occurredAt: r.occurred_at, actorType: r.actor_type, actorId: r.actor_id, action: i === 1 ? 'edited' : r.action, subjectType: r.subject_type, subjectId: r.subject_id, data: r.data, prevHash: r.prev_hash, hash: r.hash }));
      expect(verifyChain(tampered)).toMatchObject({ ok: false, firstBadSeq: 2 });
    });

    it('prevents dependency cycles in the close calendar (AX-CLS-01)', async () => {
      const cycle = await db.insert('close_cycle', { tenant_id: m.tenantId, period_key: '2026-09' });
      const mk = (code: string) => db.insert('close_task', { tenant_id: m.tenantId, close_cycle_id: cycle.id, code, title: code, description: code, category: 'review', workday: 1, due_date: '2026-10-01' });
      const a = await mk('A');
      const b = await mk('B');
      const c = await mk('C');
      await db.insert('close_task_dependency', { tenant_id: m.tenantId, task_id: b.id, depends_on_task_id: a.id });
      await db.insert('close_task_dependency', { tenant_id: m.tenantId, task_id: c.id, depends_on_task_id: b.id });
      await expectCode(db.insert('close_task_dependency', { tenant_id: m.tenantId, task_id: a.id, depends_on_task_id: c.id }), /EK-CLS-01/);
      await expectCode(db.insert('close_task_dependency', { tenant_id: m.tenantId, task_id: a.id, depends_on_task_id: a.id }), /23514|not_self|EK-CLS-01/);
    });

    it('requires an independent reviewer and zero difference on reconciliations', async () => {
      const rec = await db.insert('reconciliation', { tenant_id: m.tenantId, entity_id: m.entityId, period_key: '2026-09', account_id: m.cash, rec_type: 'bank', status: 'in_progress', unexplained: 0 });
      await expectCode(db.update('reconciliation', rec.id, { status: 'reviewed', prepared_by: m.userA, reviewed_by: m.userA }), /23514|review_sod/);
      await expectCode(db.update('reconciliation', rec.id, { status: 'prepared', prepared_by: m.userA, unexplained: 185_000 }), /23514|prepared_ties/);
      const ok = await db.update('reconciliation', rec.id, { status: 'reviewed', prepared_by: m.userA, reviewed_by: m.userB, unexplained: 0 });
      expect(ok.status).toBe('reviewed');
    });

    it('enforces maker-checker and immutability on agent proposals', async () => {
      const run = await db.insert('agent_run', { tenant_id: m.tenantId, skill_id: 'test', skill_version: '1.0.0', policy_version: 1, trigger: 'manual', requested_by: m.userA, engine: 'offline', idempotency_key: `run-${Date.now()}-${Math.random()}`, ontology_version: '1.3.0', max_steps: 10, max_tokens: 0, max_cost_micros: 0 });
      const p = await db.insert('proposal', { tenant_id: m.tenantId, run_id: run.id, skill_id: 'test', kind: 'issue', payload_class: 'ek:Exception', title: 'T', why: 'Because the evidence shows it.', confidence: 0.9, materiality: 'trivial', status: 'pending', payload: { a: 1 }, autonomy_level: 'L1', gate_decision: 'await_approval', requested_by: m.userA, idempotency_key: `p-${Date.now()}-${Math.random()}` });
      await expectCode(db.update('proposal', p.id, { status: 'approved', decided_by: m.userA }), /23514|maker_checker/);
      await expectCode(db.update('proposal', p.id, { payload: { a: 2 } }), /EK-PRP-IMMUTABLE/);
      await expectCode(db.update('proposal', p.id, { status: 'rejected', decided_by: m.userB }), /23514|rejection_reason/);
      await db.update('proposal', p.id, { status: 'approved', decided_by: m.userB });
      await expectCode(db.update('proposal', p.id, { status: 'pending' }), /EK-PRP-TRANSITION/);
    });

    it('lets each statement line sit in at most one accepted match', async () => {
      const rec = await db.insert('reconciliation', { tenant_id: m.tenantId, entity_id: m.entityId, period_key: '2026-08', account_id: m.cash, rec_type: 'bank' });
      const m1 = await db.insert('rec_match', { tenant_id: m.tenantId, reconciliation_id: rec.id, match_type: 'exact', confidence: 1, status: 'accepted', rationale: 'x', created_by_type: 'user' });
      const m2 = await db.insert('rec_match', { tenant_id: m.tenantId, reconciliation_id: rec.id, match_type: 'exact', confidence: 1, status: 'accepted', rationale: 'y', created_by_type: 'user' });
      await db.insert('rec_match_item', { tenant_id: m.tenantId, match_id: m1.id, side: 'bank', record_type: 'bank_transaction', record_id: 'bt-1', amount: 100, active: true });
      await expectCode(db.insert('rec_match_item', { tenant_id: m.tenantId, match_id: m2.id, side: 'bank', record_type: 'bank_transaction', record_id: 'bt-1', amount: 100, active: true }), /23505|single_active/);
    });

    it('allocates gap-free entry numbers atomically', async () => {
      const a = await db.nextSequence(m.tenantId, 'je:US:2026-09');
      const b = await db.nextSequence(m.tenantId, 'je:US:2026-09');
      const c = await db.nextSequence(m.tenantId, 'je:UK:2026-09');
      expect(b).toBe(a + 1);
      expect(c).toBe(1);
    });

    it('rolls back a failed transaction completely', async () => {
      const before = await db.count('journal_entry', { tenant_id: m.tenantId });
      await expectCode(
        db.tx(async (tx) => {
          await draftEntry(tx, m, [
            { account: m.expense, debit: 10, credit: 0 },
            { account: m.cash, debit: 0, credit: 10 },
          ]);
          throw new Error('boom');
        }),
        /boom/,
      );
      expect(await db.count('journal_entry', { tenant_id: m.tenantId })).toBe(before);
    });
  });
}
