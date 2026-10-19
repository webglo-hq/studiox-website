/**
 * Store contract: the same ledger and audit invariants must hold on every store (in-memory
 * emulation, embedded PGlite, PostgreSQL 16). Runs against the seeded demo tenant.
 */
import { expect, it } from 'vitest';
import { audit, SYSTEM_ACTOR } from '../../src/core/audit/audit';
import { computeAuditHash } from '../../src/core/audit/chain';
import type { AuditAppend } from '../../src/core/store/types';
import { DomainError, forbidden } from '../../src/core/util/errors';
import { systemClock } from '../../src/core/util/time';
import type { Db, DbTx, JournalEntryRow } from '../../src/schema';
import { PEOPLE } from '../../src/packs/accounting/seed/company';
import { DEMO_TENANT_ID } from '../../src/packs/accounting/seed/scenario';

const T = DEMO_TENANT_ID;
let seq = 0;

async function fixtureIds(tx: DbTx) {
  const us = (await tx.findOne('entities', { code: 'BWL-US' }))!;
  const open = (await tx.findOne('periods', { entity_id: us.id, period_key: '2026-09' }))!;
  const locked = (await tx.findOne('periods', { entity_id: us.id, period_key: '2026-08' }))!;
  const users = await tx.find('users', {});
  const id = (key: string) => users.find((u) => u.email === PEOPLE.find((p) => p.key === key)!.email)!.id;
  const cash = (await tx.findOne('accounts', { code: '1010' }))!;
  const expense = (await tx.findOne('accounts', { code: '6650' }))!;
  return { us, open, locked, casey: id('casey'), riley: id('riley'), cash, expense };
}

/** Insert a draft entry with the given lines (committed), returning its id. */
export async function draft(db: Db, opts: { lines: [number, number][]; period: 'open' | 'locked'; approvedBySelf?: boolean }): Promise<string> {
  return db.tx(T, async (tx) => {
    const f = await fixtureIds(tx);
    const period = opts.period === 'open' ? f.open : f.locked;
    const n = ++seq;
    const now = '2026-10-02T09:00:00.000Z';
    const total = opts.lines.reduce((s, [d]) => s + d, 0);
    const je = await tx.insert('journal_entries', {
      entity_id: f.us.id,
      period_id: period.id,
      je_number: `JE-CONTRACT-${Date.now()}-${n}`,
      entry_type: 'adjusting',
      status: 'draft',
      posting_date: period.end_date,
      memo: 'Store contract test entry',
      source: 'manual',
      source_ref: null,
      source_document_id: null,
      proposal_id: null,
      agent_run_id: null,
      currency: 'USD',
      total_minor: total,
      prepared_by: f.casey,
      approved_by: opts.approvedBySelf ? f.casey : f.riley,
      approval_route: 'human',
      posted_by: null,
      posted_at: null,
      reverses_je_id: null,
      auto_reverse_on: null,
      counterparty_entity_id: null,
      idempotency_key: null,
      created_at: now,
      updated_at: now,
    } as Omit<JournalEntryRow, 'id' | 'tenant_id'>);
    let lineNo = 0;
    for (const [d, c] of opts.lines)
      await tx.insert('journal_lines', { journal_entry_id: je.id, line_no: ++lineNo, account_id: d ? f.expense.id : f.cash.id, debit_minor: d, credit_minor: c, memo: null, department: 'GA', location: null, product_class: null, project: null, txn_currency: null, txn_amount_minor: null, fx_rate: null, counterparty_entity_id: null, source_line_ref: null });
    return je.id;
  });
}

const post = (db: Db, id: string, poster: 'riley' | 'casey' = 'riley') =>
  db.tx(T, async (tx) => {
    const f = await fixtureIds(tx);
    return tx.update('journal_entries', id, { status: 'posted', posted_by: poster === 'riley' ? f.riley : f.casey, posted_at: '2026-10-02T09:05:00.000Z' });
  });

export function storeContract(getDb: () => Db) {
  it('posts a balanced, approved entry into an open period', async () => {
    const db = getDb();
    const id = await draft(db, { lines: [[12_345, 0], [0, 12_345]], period: 'open' });
    const posted = await post(db, id);
    expect(posted.status).toBe('posted');
  });

  it('refuses entries that do not balance or have fewer than two lines (AX-DE-01, AX-DE-03)', async () => {
    const db = getDb();
    await expect(post(db, await draft(db, { lines: [[10_000, 0]], period: 'open' }))).rejects.toThrow(/AX-DE-03/);
    await expect(post(db, await draft(db, { lines: [[10_000, 0], [0, 9_000]], period: 'open' }))).rejects.toThrow(/AX-DE-01/);
  });

  it('keeps posted entries and their lines immutable (AX-IM-01)', async () => {
    const db = getDb();
    const id = await draft(db, { lines: [[5_000, 0], [0, 5_000]], period: 'open' });
    await post(db, id);
    await expect(db.tx(T, (tx) => tx.update('journal_entries', id, { memo: 'rewritten history' }))).rejects.toThrow(/AX-IM-01/);
    await expect(db.tx(T, (tx) => tx.delete('journal_entries', id))).rejects.toThrow(/AX-IM-01/);
    const line = (await db.tx(T, (tx) => tx.findOne('journal_lines', { journal_entry_id: id })))!;
    await expect(db.tx(T, (tx) => tx.update('journal_lines', line.id, { debit_minor: 1 }))).rejects.toThrow(/AX-IM-01/);
  });

  it('TO-M1: a line moves neither out of a posted entry nor into one (AX-IM-01)', async () => {
    const db = getDb();
    const posted = await draft(db, { lines: [[4_000, 0], [0, 4_000]], period: 'open' });
    await post(db, posted);
    const other = await draft(db, { lines: [[1_000, 0], [0, 1_000]], period: 'open' });
    const leaving = (await db.tx(T, (tx) => tx.findOne('journal_lines', { journal_entry_id: posted })))!;
    await expect(db.tx(T, (tx) => tx.update('journal_lines', leaving.id, { journal_entry_id: other, line_no: 9 }))).rejects.toThrow(/AX-IM-01/);
    const joining = (await db.tx(T, (tx) => tx.findOne('journal_lines', { journal_entry_id: other })))!;
    await expect(db.tx(T, (tx) => tx.update('journal_lines', joining.id, { journal_entry_id: posted, line_no: 9 }))).rejects.toThrow(/AX-IM-01/);
    // the posted entry is exactly as it was posted
    const lines = await db.tx(T, (tx) => tx.find('journal_lines', { journal_entry_id: posted }, { orderBy: [['line_no', 'asc']] }));
    expect(lines.map((l) => [l.debit_minor, l.credit_minor])).toEqual([[4_000, 0], [0, 4_000]]);
  });

  it('refuses postings into a locked period (AX-PD-01)', async () => {
    const db = getDb();
    await expect(post(db, await draft(db, { lines: [[7_000, 0], [0, 7_000]], period: 'locked' }))).rejects.toThrow(/AX-PD-01/);
  });

  it('refuses self-approved manual entries (maker-checker, AX-SOD-01)', async () => {
    const db = getDb();
    await expect(post(db, await draft(db, { lines: [[3_000, 0], [0, 3_000]], period: 'open', approvedBySelf: true }))).rejects.toThrow(/AX-SOD-01/);
  });

  it('keeps the audit log append-only and chained (AX-AUD-01)', async () => {
    const db = getDb();
    await db.tx(T, (tx) => audit(tx, SYSTEM_ACTOR, systemClock, { action: 'test.event', subjectType: 'test', subjectId: 'contract', summary: 'Contract test event', data: {} }));
    const last = (await db.tx(T, (tx) => tx.find('audit_log', {}, { orderBy: [['seq', 'desc']], limit: 1 })))[0]!;
    expect(last.summary).toBe('Contract test event');
    await expect(db.tx(T, (tx) => tx.update('audit_log', last.id, { summary: 'nothing happened' }))).rejects.toThrow(/AX-AUD-01/);
    await expect(db.tx(T, (tx) => tx.delete('audit_log', last.id))).rejects.toThrow(/AX-AUD-01/);
  });

  it('TO-DB-AUDIT: refuses an event that continues the chain with a hash that does not match it (AX-AUD-01)', async () => {
    const db = getDb();
    await db.tx(T, (tx) => audit(tx, SYSTEM_ACTOR, systemClock, { action: 'test.event', subjectType: 'test', subjectId: 'contract', summary: 'Before the forgery', data: {} }));
    const last = (await db.tx(T, (tx) => tx.find('audit_log', {}, { orderBy: [['seq', 'desc']], limit: 1 })))[0]!;
    const event: AuditAppend = { id: `aud_forged_${++seq}`, at: '2026-10-02T09:10:00.000Z', actor_type: 'user', actor_id: 'usr_cfo', actor_label: 'Chief Financial Officer', on_behalf_of: null, action: 'period.lock', subject_type: 'period', subject_id: 'x', entity_id: null, summary: 'The CFO approved everything', data: { amountMinor: 45_909_400, rate: 1.25, tiny: 1e-9, flags: ['a', 'b'], nested: { b: 1, a: null } }, ip: null };
    const link = { tenant_id: T, seq: last.seq + 1, prev_hash: last.hash };
    // a made-up hash, and a real hash of different content
    await expect(db.tx(T, (tx) => tx.insert('audit_log', { ...event, ...link, hash: 'b'.repeat(64) }))).rejects.toThrow(/AX-AUD-01/);
    await expect(db.tx(T, (tx) => tx.insert('audit_log', { ...event, ...link, summary: 'Nothing to see here', hash: computeAuditHash(last.hash, T, last.seq + 1, event) }))).rejects.toThrow(/AX-AUD-01/);
    // the honest event, hashed as the application hashes it, is accepted by the database's own recomputation
    const ok = await db.tx(T, (tx) => tx.insert('audit_log', { ...event, ...link, hash: computeAuditHash(last.hash, T, last.seq + 1, event) }));
    expect(ok.seq).toBe(last.seq + 1);
  });

  it('TO-DB-RLS: finds the tenant of a sign-in email, a session and an API token without reading across tenants', async () => {
    const db = getDb();
    const casey = PEOPLE.find((p) => p.key === 'casey')!.email;
    expect(await db.tenantOf('user_email', casey)).toBe(T);
    expect(await db.tenantOf('user_email', 'nobody@example.com')).toBeNull();
    const session = await db.tx(T, async (tx) => {
      const u = (await tx.findOne('users', { email: casey }))!;
      return tx.insert('sessions', { id: 'c'.repeat(64), user_id: u.id, csrf_hash: 'd'.repeat(64), idle_expires_at: '2026-10-02T10:00:00.000Z', absolute_expires_at: '2026-10-02T21:00:00.000Z', created_at: '2026-10-02T09:00:00.000Z', last_seen_at: '2026-10-02T09:00:00.000Z' });
    });
    expect(await db.tenantOf('session', session.id)).toBe(T);
    expect(await db.tenantOf('session', 'e'.repeat(64))).toBeNull();
    expect(await db.tenantOf('api_token', 'f'.repeat(64))).toBeNull();
  });

  it('scopes every read and write to one tenant', async () => {
    const db = getDb();
    expect(await db.tx('ten_someone_else', (tx) => tx.count('journal_entries', {}))).toBe(0);
    expect(await db.tx(T, (tx) => tx.count('journal_entries', {}))).toBeGreaterThan(2000);
    await expect(db.tx(T, (tx) => tx.insert('vendors', { tenant_id: 'ten_someone_else' } as never))).rejects.toThrow(/cross-tenant/);
  });

  it('rolls back and passes application errors through unchanged (a 403 stays a 403)', async () => {
    const db = getDb();
    const before = await db.tx(T, (tx) => tx.count('counters', {}));
    const err = forbidden('You prepared this item, so someone else has to approve it.');
    const thrown = await db
      .tx(T, async (tx) => {
        await tx.nextCounter('contract-rollback-probe');
        throw err;
      })
      .catch((e: unknown) => e);
    expect(thrown).toBe(err);
    expect(thrown).toBeInstanceOf(DomainError);
    expect(await db.tx(T, (tx) => tx.count('counters', {}))).toBe(before);
  });
}
