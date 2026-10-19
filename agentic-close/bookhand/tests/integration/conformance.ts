import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Db, Tx } from '../../src/persistence/db';
import { DbConstraintError } from '../../src/persistence/db';
import { canonicalJson } from '../../src/shared/canonical-json';
import { newId } from '../../src/shared/ids';
import { GENESIS_HASH, sha256Hex } from '../../src/shared/hash';

/**
 * Adapter conformance + invariant parity. The same cases run against MemoryDb, PGlite and a real Postgres
 * server; each violation must surface as the same DbConstraintError kind on every adapter.
 */

interface Fx {
  tenantId: string;
  entityId: string;
  otherEntityId: string;
  periodOpen: string;
  periodLocked: string;
  periodSoft: string;
  periodFuture: string;
  cash: string;
  revenue: string;
  expense: string;
  header: string;
  userA: string;
  userB: string;
}

async function setup(db: Db): Promise<Fx> {
  const fx = {} as Fx;
  await db.tx(async (tx) => {
    const tenant = await tx.insert('tenants', { name: 'Conformance Co', slug: `conf-${newId().slice(0, 8)}`, reporting_currency: 'USD' });
    fx.tenantId = tenant.id;
    const e1 = await tx.insert('entities', { tenant_id: tenant.id, code: 'US', name: 'US', legal_name: 'US Inc', functional_currency: 'USD', country: 'US' });
    const e2 = await tx.insert('entities', { tenant_id: tenant.id, code: 'UK', name: 'UK', legal_name: 'UK Ltd', functional_currency: 'GBP', country: 'GB' });
    fx.entityId = e1.id;
    fx.otherEntityId = e2.id;
    const mk = (n: number, status: 'open' | 'locked' | 'soft_closed' | 'future') =>
      tx.insert('periods', {
        tenant_id: tenant.id,
        entity_id: e1.id,
        fiscal_year: 2026,
        period_number: n,
        name: `P${n}`,
        start_date: `2026-${String(n).padStart(2, '0')}-01`,
        end_date: `2026-${String(n).padStart(2, '0')}-28`,
        status,
        locked_at: status === 'locked' ? '2026-01-31T00:00:00.000Z' : null,
      });
    fx.periodLocked = (await mk(1, 'locked')).id;
    fx.periodSoft = (await mk(2, 'soft_closed')).id;
    fx.periodOpen = (await mk(3, 'open')).id;
    fx.periodFuture = (await mk(4, 'future')).id;
    const acct = (number: string, name: string, cls: 'asset' | 'revenue' | 'expense', postable = true) =>
      tx.insert('accounts', {
        tenant_id: tenant.id,
        number,
        name,
        account_class: cls,
        subtype: 'bh:Test',
        normal_balance: cls === 'revenue' ? 'credit' : 'debit',
        fs_line: 'TEST',
        is_postable: postable,
      });
    fx.cash = (await acct('1000', 'Cash', 'asset')).id;
    fx.revenue = (await acct('4000', 'Revenue', 'revenue')).id;
    fx.expense = (await acct('6000', 'Expense', 'expense')).id;
    fx.header = (await acct('6999', 'Header', 'expense', false)).id;
    fx.userA = (await tx.insert('users', { tenant_id: tenant.id, email: `a-${newId().slice(0, 6)}@example.test`, display_name: 'A' })).id;
    fx.userB = (await tx.insert('users', { tenant_id: tenant.id, email: `b-${newId().slice(0, 6)}@example.test`, display_name: 'B' })).id;
  });
  return fx;
}

let counter = 0;

async function draft(
  tx: Tx,
  fx: Fx,
  opts: { period?: string; date?: string; lines?: Array<[string, number, number]>; type?: 'standard' | 'adjusting' } = {},
) {
  const period = opts.period ?? fx.periodOpen;
  const date = opts.date ?? (period === fx.periodLocked ? '2026-01-15' : period === fx.periodSoft ? '2026-02-15' : period === fx.periodFuture ? '2026-04-15' : '2026-03-15');
  const lines = opts.lines ?? [
    [fx.cash, 1000, 0],
    [fx.revenue, 0, 1000],
  ];
  const je = await tx.insert('journal_entries', {
    tenant_id: fx.tenantId,
    entity_id: fx.entityId,
    period_id: period,
    entry_number: `JE-${++counter}-${newId().slice(0, 6)}`,
    entry_date: date,
    entry_type: opts.type ?? 'standard',
    description: 'test',
    currency: 'USD',
  });
  let n = 0;
  for (const [account, debit, credit] of lines) {
    await tx.insert('journal_lines', {
      tenant_id: fx.tenantId,
      journal_entry_id: je.id,
      line_number: ++n,
      entity_id: fx.entityId,
      period_id: period,
      entry_date: date,
      account_id: account,
      debit_minor: debit,
      credit_minor: credit,
      txn_currency: 'USD',
      txn_amount_minor: debit - credit,
    });
  }
  const total = lines.reduce((s, [, d]) => s + d, 0);
  return { je, total, count: lines.length };
}

async function post(tx: Tx, id: string, total: number, count: number, extra: Record<string, unknown> = {}) {
  return tx.update('journal_entries', id, {
    status: 'posted',
    total_minor: total,
    line_count: count,
    posted_at: '2026-03-20T10:00:00.000Z',
    approval_basis: 'system',
    ...extra,
  });
}

/** An audit row exactly as appendAudit writes it: the columns are the hashed record. */
function auditRow(fx: Fx, seq: number, prevHash: string, event: { occurred_at: string; action: string; summary: string }, columns: Record<string, unknown> = {}) {
  const record = canonicalJson({ seq, tenant_id: fx.tenantId, actor_type: 'system', actor_id: null, actor_label: 'test', object_type: 'test', object_id: null, details: null, request_id: null, ip: null, ...event });
  return {
    tenant_id: fx.tenantId,
    seq,
    occurred_at: event.occurred_at,
    actor_type: 'system' as const,
    actor_label: 'test',
    action: event.action,
    object_type: 'test',
    summary: event.summary,
    record,
    prev_hash: prevHash,
    hash: sha256Hex(`${prevHash}\n${record}`),
    ...columns,
  };
}

async function expectKind(p: Promise<unknown>, kind: string) {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(DbConstraintError);
    expect((error as DbConstraintError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected a ${kind} error`);
}

export function defineConformance(label: string, open: () => Promise<Db>): void {
  describe(`persistence conformance: ${label}`, () => {
    let db: Db;
    let fx: Fx;

    beforeAll(async () => {
      db = await open();
      fx = await setup(db);
    });

    afterAll(async () => {
      await db?.close();
    });

    it('posts a balanced entry and aggregates it', async () => {
      const id = await db.tx(async (tx) => {
        const d = await draft(tx, fx);
        await post(tx, d.je.id, d.total, d.count);
        return d.je.id;
      });
      const sums = await db.read((tx) => tx.sumLines({ tenantId: fx.tenantId, periodIds: [fx.periodOpen], groupBy: ['account_id'] }));
      const cash = sums.find((s) => s.key.account_id === fx.cash);
      expect(cash?.debit_minor).toBeGreaterThanOrEqual(1000);
      const je = await db.read((tx) => tx.get('journal_entries', id));
      expect(je?.status).toBe('posted');
      expect(je?.total_minor).toBe(1000);
    });

    it('rejects unbalanced posting', async () => {
      await expectKind(
        db.tx(async (tx) => {
          const d = await draft(tx, fx, { lines: [[fx.cash, 1000, 0], [fx.revenue, 0, 900]] });
          await post(tx, d.je.id, 1000, 2);
        }),
        'invariant_violation',
      );
    });

    it('rejects a single-line entry', async () => {
      await expectKind(
        db.tx(async (tx) => {
          const d = await draft(tx, fx, { lines: [[fx.cash, 1000, 0]] });
          await post(tx, d.je.id, 1000, 1);
        }),
        'invariant_violation',
      );
    });

    it('rejects inserting an entry directly as posted', async () => {
      await expectKind(
        db.tx((tx) =>
          tx.insert('journal_entries', {
            tenant_id: fx.tenantId,
            entity_id: fx.entityId,
            period_id: fx.periodOpen,
            entry_number: `X-${newId()}`,
            entry_date: '2026-03-10',
            description: 'x',
            currency: 'USD',
            status: 'posted',
            posted_at: '2026-03-10T00:00:00.000Z',
            approval_basis: 'system',
          }),
        ),
        'invariant_violation',
      );
    });

    it('freezes posted entries and their lines', async () => {
      const { jeId, lineId } = await db.tx(async (tx) => {
        const d = await draft(tx, fx);
        await post(tx, d.je.id, d.total, d.count);
        const lines = await tx.find('journal_lines', { journal_entry_id: d.je.id });
        return { jeId: d.je.id, lineId: lines[0]!.id };
      });
      await expectKind(db.tx((tx) => tx.update('journal_entries', jeId, { description: 'tampered' })), 'immutable_row');
      await expectKind(db.tx((tx) => tx.delete('journal_entries', jeId)), 'immutable_row');
      await expectKind(db.tx((tx) => tx.update('journal_lines', lineId, { memo: 'tampered' })), 'immutable_row');
      await expectKind(db.tx((tx) => tx.delete('journal_lines', lineId)), 'immutable_row');
      await expectKind(
        db.tx((tx) =>
          tx.insert('journal_lines', {
            tenant_id: fx.tenantId,
            journal_entry_id: jeId,
            line_number: 99,
            entity_id: fx.entityId,
            period_id: fx.periodOpen,
            entry_date: '2026-03-15',
            account_id: fx.cash,
            debit_minor: 1,
            txn_currency: 'USD',
            txn_amount_minor: 1,
          }),
        ),
        'immutable_row',
      );
    });

    it('blocks postings into locked and future periods', async () => {
      for (const period of [fx.periodLocked, fx.periodFuture]) {
        await expectKind(
          db.tx(async (tx) => {
            const d = await draft(tx, fx, { period });
            await post(tx, d.je.id, d.total, d.count);
          }),
          'period_locked',
        );
      }
    });

    it('allows only adjusting-type entries in a soft-closed period', async () => {
      await expectKind(
        db.tx(async (tx) => {
          const d = await draft(tx, fx, { period: fx.periodSoft });
          await post(tx, d.je.id, d.total, d.count);
        }),
        'period_locked',
      );
      await db.tx(async (tx) => {
        const d = await draft(tx, fx, { period: fx.periodSoft, type: 'adjusting' });
        await post(tx, d.je.id, d.total, d.count);
      });
    });

    it('rejects posting to header accounts and dates outside the period', async () => {
      await expectKind(
        db.tx(async (tx) => {
          const d = await draft(tx, fx, { lines: [[fx.header, 50, 0], [fx.cash, 0, 50]] });
          await post(tx, d.je.id, d.total, d.count);
        }),
        'invariant_violation',
      );
      await expectKind(
        db.tx(async (tx) => {
          const d = await draft(tx, fx, { date: '2026-03-30' });
          await post(tx, d.je.id, d.total, d.count);
        }),
        'invariant_violation',
      );
    });

    it('enforces maker-checker on human approvals', async () => {
      await expectKind(
        db.tx(async (tx) => {
          const d = await draft(tx, fx);
          await tx.update('journal_entries', d.je.id, { prepared_by: fx.userA, approved_by: fx.userA, approval_basis: 'human_approval' });
        }),
        'check_violation',
      );
      await db.tx(async (tx) => {
        const d = await draft(tx, fx);
        await tx.update('journal_entries', d.je.id, { prepared_by: fx.userA });
        await post(tx, d.je.id, d.total, d.count, { approved_by: fx.userB, approval_basis: 'human_approval', approved_at: '2026-03-20T10:00:00.000Z' });
      });
    });

    it('validates reversals', async () => {
      const original = await db.tx(async (tx) => {
        const d = await draft(tx, fx);
        await post(tx, d.je.id, d.total, d.count);
        return d.je.id;
      });
      await expectKind(
        db.tx(async (tx) => {
          const d = await draft(tx, fx, { lines: [[fx.revenue, 500, 0], [fx.cash, 0, 500]] });
          await tx.update('journal_entries', d.je.id, { reverses_entry_id: original, entry_type: 'standard' });
          await post(tx, d.je.id, d.total, d.count);
        }),
        'invariant_violation',
      );
      await db.tx(async (tx) => {
        const d = await draft(tx, fx, { lines: [[fx.revenue, 1000, 0], [fx.cash, 0, 1000]] });
        await tx.update('journal_entries', d.je.id, { reverses_entry_id: original });
        await post(tx, d.je.id, d.total, d.count);
      });
    });

    it('enforces line shape checks, foreign keys, enums, not-null and uniqueness', async () => {
      await expectKind(
        db.tx(async (tx) => {
          await draft(tx, fx, { lines: [[fx.cash, 10, 10], [fx.revenue, 0, 0]] });
        }),
        'check_violation',
      );
      await expectKind(db.tx(async (tx) => draft(tx, fx, { lines: [[newId(), 10, 0], [fx.revenue, 0, 10]] })), 'foreign_key_violation');
      await expectKind(
        db.tx((tx) => tx.insert('accounts', { tenant_id: fx.tenantId, number: '9', name: 'x', account_class: 'bogus' as never, subtype: 'x', normal_balance: 'debit', fs_line: 'x' })),
        'check_violation',
      );
      await expectKind(db.tx((tx) => tx.insert('accounts', { tenant_id: fx.tenantId, number: '9', name: null as never, account_class: 'asset', subtype: 'x', normal_balance: 'debit', fs_line: 'x' })), 'not_null_violation');
      await expectKind(
        db.tx((tx) => tx.insert('accounts', { tenant_id: fx.tenantId, number: '1000', name: 'dup', account_class: 'asset', subtype: 'x', normal_balance: 'debit', fs_line: 'x' })),
        'unique_violation',
      );
    });

    it('enforces the period state machine', async () => {
      await expectKind(db.tx((tx) => tx.update('periods', fx.periodFuture, { status: 'locked', locked_at: '2026-05-01T00:00:00.000Z' })), 'invariant_violation');
      await expectKind(db.tx((tx) => tx.update('periods', fx.periodLocked, { status: 'soft_closed' })), 'invariant_violation');
    });

    it('rolls back the whole transaction on failure', async () => {
      const before = await db.read((tx) => tx.count('journal_entries', { tenant_id: fx.tenantId }));
      await expectKind(
        db.tx(async (tx) => {
          await draft(tx, fx);
          await draft(tx, fx, { lines: [[fx.cash, 5, 5], [fx.revenue, 0, 5]] });
        }),
        'check_violation',
      );
      const after = await db.read((tx) => tx.count('journal_entries', { tenant_id: fx.tenantId }));
      expect(after).toBe(before);
    });

    it('keeps the audit log append-only and chained', async () => {
      const first = auditRow(fx, 1, GENESIS_HASH, { occurred_at: '2026-03-01T00:00:00.000Z', action: 'test.one', summary: 'one' });
      const row = await db.tx(async (tx) => {
        await tx.lockAuditChain(fx.tenantId);
        return tx.insert('audit_log', first);
      });
      // Seq 2 that does not continue the chain (wrong previous hash).
      await expectKind(db.tx((tx) => tx.insert('audit_log', auditRow(fx, 2, GENESIS_HASH, { occurred_at: '2026-03-01T00:00:01.000Z', action: 'test.two', summary: 'two' }))), 'audit_chain');
      await expectKind(db.tx((tx) => tx.update('audit_log', row.id, { summary: 'edited' })), 'immutable_row');
      await expectKind(db.tx((tx) => tx.delete('audit_log', row.id)), 'immutable_row');
      await db.tx((tx) => tx.insert('audit_log', auditRow(fx, 2, first.hash, { occurred_at: '2026-03-01T00:00:01.000Z', action: 'test.two', summary: 'two' })));
    });

    it('SEC-2: refuses an audit row whose shown time, actor type, object type or IP differ from the hashed record', async () => {
      const [last] = await db.read((tx) => tx.find('audit_log', { tenant_id: fx.tenantId }, { orderBy: [['seq', 'desc']], limit: 1 }));
      const seq = (last?.seq ?? 0) + 1;
      const prev = last?.hash ?? GENESIS_HASH;
      const event = { occurred_at: '2026-03-02T09:00:00.000Z', action: 'test.three', summary: 'three' };
      for (const tampered of [{ occurred_at: '2026-02-01T09:00:00.000Z' }, { actor_type: 'user' }, { object_type: 'journal_entry' }, { ip: '203.0.113.9' }, { record: 'not json' }]) {
        await expectKind(db.tx((tx) => tx.insert('audit_log', auditRow(fx, seq, prev, event, tampered))), 'audit_chain');
      }
      await db.tx((tx) => tx.insert('audit_log', auditRow(fx, seq, prev, event)));
    });

    it('supports the query surface identically', async () => {
      const result = await db.read(async (tx) => {
        const byIn = await tx.find('accounts', { tenant_id: fx.tenantId, number: { in: ['1000', '4000'] } }, { orderBy: [['number', 'desc']] });
        const contains = await tx.find('accounts', { tenant_id: fx.tenantId, name: { contains: 'reve' } });
        const between = await tx.find('periods', { entity_id: fx.entityId, period_number: { between: [2, 3] } }, { orderBy: [['period_number', 'asc']] });
        const nullCheck = await tx.find('accounts', { tenant_id: fx.tenantId, parent_id: null }, { limit: 2, offset: 1, orderBy: [['number', 'asc']] });
        const ne = await tx.count('periods', { entity_id: fx.entityId, status: { ne: 'open' } });
        return { byIn: byIn.map((a) => a.number), contains: contains.map((a) => a.number), between: between.map((p) => p.period_number), nullCheck: nullCheck.map((a) => a.number), ne };
      });
      expect(result).toEqual({ byIn: ['4000', '1000'], contains: ['4000'], between: [2, 3], nullCheck: ['4000', '6000'], ne: 3 });
    });

    it('freezes amounts of posted subledger documents', async () => {
      const billId = await db.tx(async (tx) => {
        const vendor = await tx.insert('vendors', { tenant_id: fx.tenantId, code: `V${newId().slice(0, 5)}`, name: 'Vendor', currency: 'USD' });
        const d = await draft(tx, fx, { lines: [[fx.expense, 700, 0], [fx.cash, 0, 700]] });
        await post(tx, d.je.id, d.total, d.count);
        const bill = await tx.insert('bills', {
          tenant_id: fx.tenantId,
          entity_id: fx.entityId,
          vendor_id: vendor.id,
          bill_number: 'B-1',
          bill_date: '2026-03-01',
          received_date: '2026-03-02',
          due_date: '2026-03-31',
          currency: 'USD',
          amount_minor: 700,
          description: 'x',
          journal_entry_id: d.je.id,
        });
        return bill.id;
      });
      await expectKind(db.tx((tx) => tx.update('bills', billId, { amount_minor: 900 })), 'immutable_row');
      await db.tx((tx) => tx.update('bills', billId, { status: 'paid' }));
    });

    it('round-trips every column type', async () => {
      const doc = await db.tx((tx) =>
        tx.insert('source_documents', {
          tenant_id: fx.tenantId,
          kind: 'evidence',
          filename: 'note.txt',
          media_type: 'text/plain',
          sha256: sha256Hex(newId()),
          size_bytes: 3,
          content: new Uint8Array([1, 2, 255]),
          metadata: { nested: { list: [1, 'two'] } },
        }),
      );
      const back = await db.read((tx) => tx.get('source_documents', doc.id));
      expect(Array.from(back!.content!)).toEqual([1, 2, 255]);
      expect(back!.metadata).toEqual({ nested: { list: [1, 'two'] } });
      expect(back!.uploaded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const rate = await db.tx((tx) =>
        tx.insert('fx_rates', { tenant_id: fx.tenantId, base_currency: 'GBP', quote_currency: 'USD', rate_date: '2026-03-31', rate_type: 'closing', rate: 1.27345678 }),
      );
      expect(rate.rate).toBeCloseTo(1.27345678, 8);
      expect(rate.rate_date).toBe('2026-03-31');
    });

    it('BH-M4: refuses to move a draft line into a posted entry, or a posted line out of one', async () => {
      const { posted, draftLine, postedLine, draftId } = await db.tx(async (tx) => {
        const p = await draft(tx, fx);
        await post(tx, p.je.id, p.total, p.count);
        const d = await draft(tx, fx, { lines: [[fx.cash, 777, 0], [fx.revenue, 0, 777]] });
        const dl = (await tx.find('journal_lines', { journal_entry_id: d.je.id }))[0]!;
        const pl = (await tx.find('journal_lines', { journal_entry_id: p.je.id }))[0]!;
        return { posted: p.je.id, draftLine: dl.id, postedLine: pl.id, draftId: d.je.id };
      });
      await expectKind(db.tx((tx) => tx.update('journal_lines', draftLine, { journal_entry_id: posted, line_number: 99 })), 'immutable_row');
      await expectKind(db.tx((tx) => tx.update('journal_lines', postedLine, { journal_entry_id: draftId, line_number: 99 })), 'immutable_row');
      const lines = await db.read((tx) => tx.find('journal_lines', { journal_entry_id: posted }));
      expect(lines.reduce((s, l) => s + l.debit_minor, 0)).toBe(lines.reduce((s, l) => s + l.credit_minor, 0));
    });

    it('BH-M4: a posting that races a period lock never lands in the locked period', async () => {
      const period = (
        await db.tx((tx) =>
          tx.insert('periods', { tenant_id: fx.tenantId, entity_id: fx.entityId, fiscal_year: 2026, period_number: 6, name: 'P6', start_date: '2026-06-01', end_date: '2026-06-28', status: 'open' }),
        )
      ).id;
      const d = await db.tx((tx) => draft(tx, fx, { period, date: '2026-06-15' }));
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      // One person locks the period and keeps the transaction open; someone posts into it meanwhile.
      const locking = db.tx(async (tx) => {
        await tx.update('periods', period, { status: 'soft_closed' });
        await tx.update('periods', period, { status: 'locked', locked_at: '2026-07-01T00:00:00.000Z' });
        await held;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const posting = db.tx((tx) => post(tx, d.je.id, d.total, d.count)).then(
        () => 'posted',
        (e: unknown) => e,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      release();
      await locking;
      const outcome = await posting;
      expect(outcome).toBeInstanceOf(DbConstraintError);
      expect((outcome as DbConstraintError).kind).toBe('period_locked');
      expect((await db.read((tx) => tx.get('journal_entries', d.je.id)))?.status).not.toBe('posted');
    });

    it('BH-M2: a proposal is never approved by whoever started the agent run that made it', async () => {
      const proposal = await db.tx((tx) =>
        tx.insert('proposals', { tenant_id: fx.tenantId, kind: 'journal_entry', disposition: 'needs_approval', title: 'Accrue a bill', why: 'The bill arrived after period end.', confidence: 0.9, currency: 'USD', payload: {}, autonomy_level: 'L1', required_permission: 'proposal.decide', maker_type: 'agent', requested_by: fx.userA, idempotency_key: `p-${newId()}` }),
      );
      await expectKind(db.tx((tx) => tx.update('proposals', proposal.id, { status: 'approved', decided_by: fx.userA, decided_at: '2026-03-20T10:00:00.000Z' })), 'invariant_violation');
      await db.tx((tx) => tx.update('proposals', proposal.id, { status: 'approved', decided_by: fx.userB, decided_at: '2026-03-20T10:00:00.000Z' }));
    });
  });
}
