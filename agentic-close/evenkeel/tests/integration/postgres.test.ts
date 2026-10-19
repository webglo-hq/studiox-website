import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ColKind, Schema, TableSpec } from '../../src/framework/store/schema';
import { createPgDriver } from '../../src/framework/store/drivers/pg';
import { SqlStore, type SqlDriver } from '../../src/framework/store/sql';
import { runFullClose } from '../../src/packs/accounting/evals/close-run';
import { schema, type EkSchema } from '../../src/packs/accounting/store';
import { migrate } from '../../src/server/db';
import { loadSkillsFromDisk } from '../../src/server/skills-fs';
import { expectSingleApplication } from '../shared/decisions';
import { buildMiniTenant, defineInvariantSuite, draftEntry } from '../shared/invariant-suite';
import { loadTestScenario } from '../shared/scenario';

/**
 * The same rules, against a real PostgreSQL 16 server: `npm run test:integration` starts a
 * throwaway cluster on a free port and sets DATABASE_URL. Each suite gets its own database,
 * dropped at the end.
 */
const BASE_URL = process.env.DATABASE_URL;
if (!BASE_URL) throw new Error('DATABASE_URL is not set. Run `npm run test:integration`, which starts a throwaway PostgreSQL 16 cluster for these tests.');

interface Fresh {
  name: string;
  url: string;
  db: SqlStore<EkSchema>;
}
const created: Fresh[] = [];

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: BASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A new, migrated database on the test server. */
async function freshDatabase(label: string): Promise<Fresh> {
  const name = `ek_it_${label}_${randomBytes(4).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE ${c.escapeIdentifier(name)}`));
  const url = new URL(BASE_URL!);
  url.pathname = `/${name}`;
  const driver = createPgDriver(url.toString());
  await migrate(driver);
  const fresh = { name, url: url.toString(), db: new SqlStore<EkSchema>(schema, driver) };
  created.push(fresh);
  return fresh;
}

afterAll(async () => {
  for (const f of created) await f.db.close().catch(() => undefined);
  await admin(async (c) => {
    for (const f of created) await c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(f.name)} WITH (FORCE)`);
  });
});

describe('PostgreSQL server', () => {
  it('is version 16', async () => {
    const v = await admin((c) => c.query<{ server_version_num: string }>('SHOW server_version_num'));
    expect(Math.floor(Number(v.rows[0]!.server_version_num) / 10_000)).toBe(16);
  });
});

defineInvariantSuite('PostgreSQL 16 server', async () => (await freshDatabase('inv')).db);

// ------------------------------------------------------------------------------------------
// Schema contract: the TypeScript registry (which drives the SQL adapter, the in-memory store
// and every row type) and the hand-written migrations must describe the same database.
// ------------------------------------------------------------------------------------------

const PG_TYPES: Record<ColKind, string[]> = {
  uuid: ['uuid'],
  text: ['text', 'character varying'],
  int: ['integer', 'smallint'],
  bigint: ['bigint'],
  numeric: ['numeric'],
  bool: ['boolean'],
  date: ['date'],
  timestamptz: ['timestamp with time zone'],
  json: ['jsonb'],
};

const ON_DELETE: Record<string, string[]> = { restrict: ['r', 'a'], cascade: ['c'], 'set null': ['n'] };

describe('schema contract — registry vs PostgreSQL catalog', () => {
  let driver: SqlDriver;
  const tables: TableSpec[] = Object.values(schema as Schema);

  beforeAll(async () => {
    driver = (await freshDatabase('contract')).db.raw();
  });

  it('applies each migration once, records checksums, and re-running is a no-op', async () => {
    const again = await migrate(driver);
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBeGreaterThanOrEqual(3);
    const rows = (await driver.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows;
    expect(rows.map((r) => r.version)).toEqual(again.skipped);
    for (const r of rows) expect(String(r.checksum)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('has exactly the registered tables and columns, with matching types and nullability', async () => {
    const cols = (await driver.query(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`)).rows as { table_name: string; column_name: string; data_type: string; is_nullable: 'YES' | 'NO' }[];
    const byTable = new Map<string, Map<string, (typeof cols)[number]>>();
    for (const c of cols) {
      if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Map());
      byTable.get(c.table_name)!.set(c.column_name, c);
    }
    const problems: string[] = [];
    for (const spec of tables) {
      const dbCols = byTable.get(spec.name);
      if (!dbCols) {
        problems.push(`table ${spec.name} is missing from the database`);
        continue;
      }
      for (const [name, col] of Object.entries(spec.columns)) {
        const c = dbCols.get(name);
        if (!c) {
          problems.push(`${spec.name}.${name} is missing from the database`);
          continue;
        }
        if (!PG_TYPES[col.spec.kind].includes(c.data_type)) problems.push(`${spec.name}.${name}: registry ${col.spec.kind}, database ${c.data_type}`);
        if (col.spec.nullable !== (c.is_nullable === 'YES')) problems.push(`${spec.name}.${name}: registry ${col.spec.nullable ? 'nullable' : 'NOT NULL'}, database ${c.is_nullable === 'YES' ? 'nullable' : 'NOT NULL'}`);
      }
      for (const name of dbCols.keys()) if (!(name in spec.columns)) problems.push(`${spec.name}.${name} exists in the database but not in the registry`);
    }
    const known = new Set([...tables.map((t) => t.name), 'schema_migrations']);
    for (const t of byTable.keys()) if (!known.has(t)) problems.push(`table ${t} exists in the database but not in the registry`);
    expect(problems).toEqual([]);
    expect(tables.length).toBeGreaterThan(60);
  });

  it('spells every enumeration the same way in the registry and in its CHECK constraint', async () => {
    const checks = (await driver.query(`SELECT cl.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public' WHERE c.contype = 'c'`)).rows as { table_name: string; conname: string; def: string }[];
    const problems: string[] = [];
    let compared = 0;
    for (const spec of tables) {
      for (const [name, col] of Object.entries(spec.columns)) {
        const values = col.spec.enumValues;
        if (!values) continue;
        const check = checks.find((c) => c.table_name === spec.name && c.conname === `${spec.name}_${name}_check`);
        if (!check) {
          problems.push(`${spec.name}.${name}: no CHECK constraint named ${spec.name}_${name}_check`);
          continue;
        }
        const inDb = [...check.def.matchAll(/'((?:[^']|'')*)'::text/g)].map((m) => m[1]!.replace(/''/g, "'"));
        compared++;
        if ([...inDb].sort().join('|') !== [...values].sort().join('|')) problems.push(`${spec.name}.${name}: registry [${values.join(', ')}] vs database [${inDb.join(', ')}]`);
      }
      for (const chk of spec.checks ?? []) {
        if (!checks.some((c) => c.table_name === spec.name && c.conname === chk.name)) problems.push(`${spec.name}: registry check ${chk.name} has no database constraint`);
      }
    }
    expect(problems).toEqual([]);
    expect(compared).toBeGreaterThan(50);
  });

  it('declares every registered foreign key and unique key in the database', async () => {
    const fks = (await driver.query(`SELECT cl.relname AS table_name, a.attname AS column_name, rcl.relname AS ref_table, c.confdeltype AS on_delete
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
      JOIN pg_class rcl ON rcl.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND cardinality(c.conkey) = 1`)).rows as { table_name: string; column_name: string; ref_table: string; on_delete: string }[];
    const uniques = (await driver.query(`SELECT t.relname AS table_name, array_agg(a.attname::text ORDER BY a.attname) AS cols, bool_or(i.indpred IS NOT NULL) AS partial
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisunique
      GROUP BY t.relname, i.indexrelid`)).rows as { table_name: string; cols: string[]; partial: boolean }[];
    const problems: string[] = [];
    for (const spec of tables) {
      for (const [name, col] of Object.entries(spec.columns)) {
        const ref = col.spec.references;
        if (!ref) continue;
        const fk = fks.find((f) => f.table_name === spec.name && f.column_name === name);
        if (!fk) problems.push(`${spec.name}.${name}: no foreign key to ${ref.table}`);
        else if (fk.ref_table !== ref.table) problems.push(`${spec.name}.${name}: references ${fk.ref_table}, registry says ${ref.table}`);
        else if (!ON_DELETE[ref.onDelete ?? 'restrict']!.includes(fk.on_delete)) problems.push(`${spec.name}.${name}: ON DELETE ${fk.on_delete}, registry says ${ref.onDelete}`);
      }
      for (const key of spec.unique ?? []) {
        const want = [...key].sort().join(',');
        if (!uniques.some((u) => u.table_name === spec.name && !u.partial && [...u.cols].sort().join(',') === want)) problems.push(`${spec.name}: no unique index on (${key.join(', ')})`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('guards the ledger, the audit trail and approvals with triggers', async () => {
    const triggers = (await driver.query(`SELECT c.relname AS table_name, t.tgname AS name, p.proname AS fn
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE NOT t.tgisinternal`)).rows as { table_name: string; name: string; fn: string }[];
    const names = triggers.map((t) => `${t.table_name}.${t.name}`);
    for (const expected of [
      'journal_entry.journal_entry_guard',
      'journal_entry.journal_entry_link_reversal',
      'journal_line.journal_line_guard',
      'fiscal_period.fiscal_period_guard',
      'audit_log.audit_log_chain',
      'audit_log.audit_log_append_only',
      'audit_log.audit_log_no_truncate',
      'close_task_dependency.close_task_dependency_acyclic',
      'close_package.close_package_guard',
      'proposal.proposal_guard',
    ]) {
      expect(names).toContain(expected);
    }
    for (const spec of tables.filter((t) => t.appendOnly)) {
      expect(triggers.some((t) => t.table_name === spec.name && t.fn === 'ek_append_only'), `${spec.name} is append-only in the registry`).toBe(true);
    }
  });
});

// ------------------------------------------------------------------------------------------
// Concurrency: things only a multi-connection server can show.
// ------------------------------------------------------------------------------------------

describe('concurrency on a real server', () => {
  it('hands out unique, gap-free entry numbers to 40 concurrent callers', async () => {
    const { db } = await freshDatabase('seq');
    const m = await buildMiniTenant(db);
    const values = await Promise.all(Array.from({ length: 40 }, () => db.nextSequence(m.tenantId, 'je:US:2026-09')));
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('makes a period lock wait for an in-flight posting, and a posting wait for an in-flight lock', async () => {
    const { db, url } = await freshDatabase('race');
    const m = await buildMiniTenant(db);
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      await other.query("SET lock_timeout = '400ms'");
      // 1. A posting is in flight: closing the period must wait for it.
      await db.tx(async (tx) => {
        const je = await draftEntry(tx, m, [
          { account: m.expense, debit: 4_200, credit: 0 },
          { account: m.cash, debit: 0, credit: 4_200 },
        ]);
        await tx.update('journal_entry', je.id, { status: 'posted', approved_by: m.userB });
        await expect(other.query("UPDATE fiscal_period SET status = 'soft_close' WHERE id = $1", [m.periodOpen])).rejects.toMatchObject({ code: '55P03' });
      });
      // 2. A lock is in flight: posting into that period must wait for it, then see it closed.
      const je = await draftEntry(db, m, [
        { account: m.expense, debit: 900, credit: 0 },
        { account: m.cash, debit: 0, credit: 900 },
      ]);
      await other.query('BEGIN');
      await other.query("UPDATE fiscal_period SET status = 'soft_close' WHERE id = $1", [m.periodOpen]);
      await other.query("UPDATE fiscal_period SET status = 'hard_close' WHERE id = $1", [m.periodOpen]);
      const posting = db.update('journal_entry', je.id, { status: 'posted', approved_by: m.userB });
      await new Promise((r) => setTimeout(r, 300));
      await other.query('COMMIT');
      await expect(posting).rejects.toThrow(/EK-PERIOD-LOCKED/);
    } finally {
      await other.end();
    }
  });

  it('applies a proposal exactly once when two people approve it in parallel transactions', async () => {
    const { db } = await freshDatabase('decide');
    const s = await loadTestScenario({ db });
    await s.engine.orchestrate(null, s.user('casey'));
    await expectSingleApplication(s);
  }, 300_000);
});

// ------------------------------------------------------------------------------------------
// The whole September close of the fictional Kitewell Labs, end to end, on PostgreSQL.
// ------------------------------------------------------------------------------------------

describe('full close on PostgreSQL 16', () => {
  it('runs the agents, takes every approval, certifies, signs the package and locks the month', async () => {
    const { db } = await freshDatabase('close');
    const t0 = Date.now();
    const r = await runFullClose({ db, skills: loadSkillsFromDisk(), through: 'lock' });
    expect(r.lockFailures).toEqual([]);
    expect(r.locked).toBe(true);
    expect(r.auditOk).toBe(true);
    expect(r.auditChecked).toBeGreaterThan(500);

    const sql = db.raw();
    // Every posted entry balances, checked by the database itself.
    const unbalanced = await sql.query(`SELECT je.entry_number FROM journal_entry je JOIN journal_line l ON l.journal_entry_id = je.id
      WHERE je.status = 'posted' GROUP BY je.id, je.entry_number HAVING sum(l.debit) <> sum(l.credit)`);
    expect(unbalanced.rows).toEqual([]);
    // The month is hard-closed for every entity, and nothing is left in draft for it.
    const periods = await sql.query(`SELECT DISTINCT status FROM fiscal_period WHERE tenant_id = $1 AND period_key = '2026-09'`, [r.info.tenantId]);
    expect(periods.rows.map((p) => p.status)).toEqual(['hard_close']);
    // The audit chain head matches the last event.
    const head = await sql.query(`SELECT h.last_seq, h.last_hash = a.hash AS matches FROM audit_chain_head h JOIN audit_log a ON a.tenant_id = h.tenant_id AND a.seq = h.last_seq WHERE h.tenant_id = $1`, [r.info.tenantId]);
    expect(head.rows[0]).toMatchObject({ matches: true });
    expect(Number(head.rows[0]!.last_seq)).toBe(r.auditChecked);
    console.log(`[integration] full close on PostgreSQL: ${r.proposals.length} proposals, ${r.rounds} approval rounds, ${r.auditChecked} audit events, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }, 600_000);
});
