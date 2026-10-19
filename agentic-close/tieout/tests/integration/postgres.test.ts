/**
 * Real PostgreSQL 16: migrations, DB-enforced invariants, row-level security for tenant
 * isolation (as an ordinary application role), and a full agent close on the real database.
 * Needs the throwaway cluster from `npx tsx scripts/pgtest.ts start` (or TIEOUT_PG_* env vars);
 * without it this file is reported as skipped, never as passed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/core/agent/runtime';
import { resolveUserActor } from '../../src/core/auth/actor';
import { verifyAuditChain } from '../../src/core/audit/chain';
import { DEMO_SCRYPT, nobleScrypt, PasswordHasher } from '../../src/core/auth/password';
import { createNodePgDriver } from '../../src/core/store/drivers/node-pg';
import { migrate } from '../../src/core/store/migrate';
import type { SqlDriver } from '../../src/core/store/sql';
import type { AuditRecord } from '../../src/core/store/types';
import { scenarioClock } from '../../src/core/util/time';
import type { Db } from '../../src/schema';
import { createPgDb } from '../../src/schema/factory';
import { migrations } from '../../src/schema/migrations.generated';
import { Chart } from '../../src/packs/accounting/ledger/chart';
import { balancesAsOf, trialBalanceRows } from '../../src/packs/accounting/ledger/balances';
import { consolidatedStatements } from '../../src/packs/accounting/ledger/statements';
import { accountingPack } from '../../src/packs/accounting/agent/pack';
import { runCloseAgents } from '../../src/packs/accounting/close/orchestrate';
import { PEOPLE, SCENARIO } from '../../src/packs/accounting/seed/company';
import { DEMO_TENANT_ID, seedScenario } from '../../src/packs/accounting/seed/scenario';
import { accountingSkills, installAccountingSkills } from '../../src/packs/accounting/skills/install';
import { testApp, TEST_PASSWORD } from '../support/app';
import { draft, storeContract } from '../support/contract';
import { closeTheMonth } from '../support/full-close';
import { pgTestEnv } from '../support/pg';

const env = pgTestEnv();
if (!env) console.warn('[postgres.test] no PostgreSQL test cluster: run `npx tsx scripts/pgtest.ts start` (these tests are skipped, not passed)');

describe.skipIf(!env)('PostgreSQL 16 (real database)', () => {
  let admin: SqlDriver;
  let app: SqlDriver;
  let db: Db;

  beforeAll(async () => {
    admin = createNodePgDriver(env!.adminUrl, 2);
    await admin.exec(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO tieout_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE tieout IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tieout_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE tieout IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tieout_app;`);
    app = createNodePgDriver(env!.appUrl, 6);
    db = createPgDb(app);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it('applies the migrations once, and refuses an edited migration (checksum drift)', async () => {
    const first = await migrate(admin, migrations);
    expect(first.applied).toEqual(migrations.map((m) => m.id).sort());
    const again = await migrate(admin, migrations);
    expect(again.applied).toEqual([]);
    const tampered = migrations.map((m, i) => (i === 0 ? { ...m, sql: `${m.sql}\n-- edited` } : m));
    await expect(migrate(admin, tampered)).rejects.toThrow(/checksum drift/);
  });

  it('runs the application as an ordinary role (not a superuser), so row-level security applies', async () => {
    const r = await app.query("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su, (SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation') AS policies, current_setting('TimeZone') AS tz");
    expect(r.rows[0]).toMatchObject({ u: 'tieout_app', su: false, tz: 'UTC' });
    expect(Number(r.rows[0]!.policies)).toBeGreaterThan(50);
  });

  it('seeds the fictional company through the application role with balanced books', async () => {
    const hasher = new PasswordHasher(nobleScrypt, DEMO_SCRYPT);
    const summary = await seedScenario(db, { demoPassword: TEST_PASSWORD, hashPassword: (p) => hasher.hash(p), installSkills: installAccountingSkills });
    expect(summary.counts.journal_entries).toBeGreaterThan(2000);
    await db.tx(DEMO_TENANT_ID, async (tx) => {
      const chart = await Chart.load(tx);
      for (const e of chart.entities) {
        const tb = trialBalanceRows(chart, await balancesAsOf(tx, [e.id], '2026-09-30'));
        expect(tb.totalDebitMinor, e.code).toBe(tb.totalCreditMinor);
      }
      expect((await consolidatedStatements(tx, chart, '2026-08')).checks.balanced).toBe(true);
    });
  }, 300_000);

  describe('store contract on PostgreSQL (triggers, constraints)', () => storeContract(() => db));

  it('isolates tenants in the database itself (row-level security)', async () => {
    const count = (tenant: string | null) =>
      app.transaction(async (q) => {
        if (tenant !== null) await q.query("SELECT set_config('tieout.tenant_id', $1, true)", [tenant]);
        return Number((await q.query('SELECT count(*) AS n FROM journal_entries')).rows[0]!.n);
      });
    expect(await count(null)).toBe(0); // a query that forgets the tenant sees nothing
    expect(await count('ten_someone_else')).toBe(0);
    expect(await count(DEMO_TENANT_ID)).toBeGreaterThan(2000);
    await expect(
      app.transaction(async (q) => {
        await q.query("SELECT set_config('tieout.tenant_id', $1, true)", [DEMO_TENANT_ID]);
        await q.query("INSERT INTO counters (id, tenant_id, name, value) VALUES ('ctr_rls_probe', 'ten_someone_else', 'probe', 1)");
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('TO-DB-RLS: the application role cannot switch tenant isolation off for itself', async () => {
    const seen = await app.transaction(async (q) => {
      await q.query("SELECT set_config('tieout.bypass', 'on', true)"); // honoured before migration 0010
      return Number((await q.query('SELECT count(*) AS n FROM journal_entries')).rows[0]!.n);
    });
    expect(seen).toBe(0);
    const policies = await app.query("SELECT count(*) AS n FROM pg_policies WHERE policyname = 'tenant_isolation' AND (qual LIKE '%bypass%' OR with_check LIKE '%bypass%')");
    expect(Number(policies.rows[0]!.n)).toBe(0);
    // the only table without row-level security names a tenant for a lookup key, nothing more
    const cols = await app.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'tenant_directory' ORDER BY column_name");
    expect(cols.rows.map((r) => r.column_name)).toEqual(['id', 'tenant_id']);
  });

  it('TO-M1: posting holds its period: a period change waits for a posting in flight, and a posting after a lock is refused', async () => {
    const asTenant = <R>(fn: (q: Parameters<Parameters<SqlDriver['transaction']>[0]>[0]) => Promise<R>) =>
      app.transaction(async (q) => {
        await q.query("SELECT set_config('tieout.tenant_id', $1, true)", [DEMO_TENANT_ID]);
        return fn(q);
      });
    const period = (await asTenant((q) => q.query("SELECT p.id FROM periods p JOIN entities e ON e.id = p.entity_id WHERE p.period_key = '2026-09' AND e.code = 'BWL-US'"))).rows[0]!.id as string;
    const riley = (await db.tx(DEMO_TENANT_ID, (tx) => tx.findOne('users', { email: PEOPLE.find((p) => p.key === 'riley')!.email })))!.id;
    const postSql = "UPDATE journal_entries SET status = 'posted', posted_by = $2, posted_at = now() WHERE id = $1";
    const settle = (p: Promise<unknown>) => p.then(() => 'done', (e: Error) => e.message);
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // 1. an entry is being posted: soft-closing its period waits until the posting commits
    const first = await draft(db, { lines: [[2_500, 0], [0, 2_500]], period: 'open' });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const posting = asTenant(async (q) => {
      await q.query(postSql, [first, riley]);
      await held;
    });
    await pause(150);
    let closedAt = 0;
    const closing = asTenant((q) => q.query("UPDATE periods SET status = 'soft_closed' WHERE id = $1", [period])).then(() => (closedAt = Date.now()));
    await pause(400);
    expect(closedAt).toBe(0);
    const releasedAt = Date.now();
    release();
    await posting;
    await closing;
    expect(closedAt).toBeGreaterThanOrEqual(releasedAt);

    // 2. the period is being locked: a posting waits, then sees the lock and is refused
    const second = await draft(db, { lines: [[3_500, 0], [0, 3_500]], period: 'open' });
    let unlock!: () => void;
    const locking = new Promise<void>((r) => (unlock = r));
    const locker = asTenant(async (q) => {
      await q.query("UPDATE periods SET status = 'locked' WHERE id = $1", [period]);
      await locking;
    });
    await pause(150);
    const late = settle(asTenant((q) => q.query(postSql, [second, riley])));
    await pause(400);
    unlock();
    await locker;
    expect(await late).toMatch(/AX-PD-01: cannot post adjusting entry .* into a locked period/);

    // reopen September for the rest of this file
    await asTenant(async (q) => {
      await q.query("UPDATE periods SET status = 'soft_closed', status_reason = 'Reopened after the concurrency probe' WHERE id = $1", [period]);
      await q.query("UPDATE periods SET status = 'open' WHERE id = $1", [period]);
    });
  });

  it('forbids rewriting history even with raw SQL as the application role', async () => {
    const asTenant = <R>(fn: (q: Parameters<Parameters<SqlDriver['transaction']>[0]>[0]) => Promise<R>) =>
      app.transaction(async (q) => {
        await q.query("SELECT set_config('tieout.tenant_id', $1, true)", [DEMO_TENANT_ID]);
        return fn(q);
      });
    await expect(asTenant((q) => q.query("UPDATE journal_entries SET memo = 'edited' WHERE status = 'posted'"))).rejects.toThrow(/AX-IM-01/);
    await expect(asTenant((q) => q.query('DELETE FROM audit_log'))).rejects.toThrow(/AX-AUD-01/);
    await expect(asTenant((q) => q.query('TRUNCATE audit_log'))).rejects.toThrow(/AX-AUD-01|permission denied/);
  });

  it('runs the whole close with agents on PostgreSQL and keeps the audit chain intact', async () => {
    const clock = scenarioClock(SCENARIO.businessDate);
    const runtime = new AgentRuntime({ db, clock, pack: accountingPack, skills: accountingSkills(), llm: null, resolveActor: resolveUserActor });
    const jordanId = (await db.tx(DEMO_TENANT_ID, (tx) => tx.findOne('users', { email: PEOPLE.find((p) => p.key === 'jordan')!.email })))!.id;
    const jordan = await db.tx(DEMO_TENANT_ID, (tx) => resolveUserActor(tx, jordanId));
    const result = await runCloseAgents({ db, runtime, clock }, { tenantId: DEMO_TENANT_ID, periodKey: SCENARIO.closeKey, requester: jordan });
    expect(result.tasks.every((t) => t.outcome === 'succeeded')).toBe(true);
    const counts = await db.tx(DEMO_TENANT_ID, async (tx) => ({ proposals: await tx.count('proposals', {}), applied: await tx.count('proposals', { status: 'applied' }), pending: await tx.count('proposals', { status: 'pending_approval' }) }));
    expect(counts.proposals).toBeGreaterThan(100);
    expect(counts.applied).toBeGreaterThan(0);
    expect(counts.pending).toBeGreaterThan(20);
    const chain = await db.tx(DEMO_TENANT_ID, (tx) => tx.find('audit_log', {}, { orderBy: [['seq', 'asc']] }));
    expect(verifyAuditChain(chain as unknown as AuditRecord[]).ok).toBe(true);
  }, 300_000);

  it('finishes the close through the HTTP API and locks the period, with the database triggers on', async () => {
    const t = await testApp({}, db);
    const out = await closeTheMonth(t, { runAgents: false });
    expect(out.readinessBeforeLock.ready).toBe(true);
    // the database itself now refuses new entries in September (AX-PD-01 trigger), even as raw SQL
    const periods = await admin.query("SELECT status FROM periods WHERE period_key = '2026-09'"); // superuser: sees past row-level security
    expect(periods.rows.length).toBeGreaterThanOrEqual(2);
    expect(periods.rows.every((r) => r.status === 'locked')).toBe(true);
    await expect(
      admin.exec(`INSERT INTO journal_entries (id, tenant_id, entity_id, period_id, je_number, entry_type, source, posting_date, memo, currency, status, total_minor, prepared_by, idempotency_key)
        SELECT 'je_late_probe', p.tenant_id, p.entity_id, p.id, 'JE-LATE-1', 'adjusting', 'manual', '2026-09-30', 'late', 'USD', 'posted', 0, 'probe', 'late-probe'
          FROM periods p JOIN entities e ON e.id = p.entity_id WHERE p.period_key = '2026-09' AND e.code = 'BWL-US'`),
    ).rejects.toThrow(/AX-PD/);
    const chain = await db.tx(DEMO_TENANT_ID, (tx) => tx.find('audit_log', {}, { orderBy: [['seq', 'asc']] }));
    expect(verifyAuditChain(chain as unknown as AuditRecord[]).ok).toBe(true);
  }, 300_000);
});
