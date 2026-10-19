import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, verifyAuditChain } from '../../src/audit/audit';
import type { Db } from '../../src/persistence/db';
import { openDatabase } from '../../src/persistence/node';
import type { SqlDriver } from '../../src/persistence/sql';
import { migrationsDir } from './helpers';

/**
 * The reviewer's attack: a database owner disables the audit triggers and edits the columns the audit log
 * shows (time, actor type, object type, IP), leaving the hashed record alone. Both verifiers must catch it.
 */
describe('audit chain tampering (embedded Postgres)', () => {
  let db: Db;
  let driver: SqlDriver;
  let tenantId = '';

  beforeAll(async () => {
    ({ db, driver } = await openDatabase({ migrationsDir }));
    tenantId = (await db.tx((tx) => tx.insert('tenants', { name: 'Tamper Co', slug: 'tamper', reporting_currency: 'USD' }))).id;
    for (let i = 1; i <= 6; i++) {
      await db.tx((tx) => appendAudit(tx, tenantId, { type: 'user', userId: null, label: 'Maya Chen', ip: '10.0.0.7', requestId: `req-${i}` }, { action: 'journal_entry.approve', objectType: 'journal_entry', objectId: `je-${i}`, summary: `Approved entry ${i}` }, `2026-10-0${i}T09:00:00.000Z`));
    }
  }, 120_000);
  afterAll(async () => driver?.close());

  const sqlVerify = async () => Number((await driver.query<{ r: string | null }>('SELECT bh_verify_audit_chain($1) AS r', [tenantId])).rows[0]!.r ?? 0);

  it('SEC-2: edits to the time, actor type, object type or IP of an event are caught by both verifiers', async () => {
    expect((await db.read((tx) => verifyAuditChain(tx, tenantId))).ok).toBe(true);
    expect(await sqlVerify()).toBe(0);
    const edits: Array<[number, string, string]> = [
      [2, 'occurred_at', "occurred_at = occurred_at - interval '30 days'"],
      [3, 'actor_type', "actor_type = 'system'"],
      [4, 'object_type', "object_type = 'tampered'"],
      [5, 'ip', "ip = '203.0.113.9'"],
    ];
    for (const [seq, column, set] of edits) {
      await driver.exec('ALTER TABLE audit_log DISABLE TRIGGER USER');
      const before = (await driver.query<Record<string, unknown>>(`SELECT ${column}::text AS v FROM audit_log WHERE tenant_id = $1 AND seq = $2`, [tenantId, seq])).rows[0]!.v;
      await driver.query(`UPDATE audit_log SET ${set} WHERE tenant_id = $1 AND seq = $2`, [tenantId, seq]);
      await driver.exec('ALTER TABLE audit_log ENABLE TRIGGER USER');

      const app = await db.read((tx) => verifyAuditChain(tx, tenantId));
      expect(app.ok, column).toBe(false);
      expect(app.firstBadSeq).toBe(seq);
      expect(app.reason).toContain(column);
      expect(await sqlVerify(), column).toBe(seq);

      // Put it back (as the owner) before trying the next column.
      await driver.exec('ALTER TABLE audit_log DISABLE TRIGGER USER');
      await driver.query(`UPDATE audit_log SET ${column} = $3 WHERE tenant_id = $1 AND seq = $2`, [tenantId, seq, before]);
      await driver.exec('ALTER TABLE audit_log ENABLE TRIGGER USER');
      expect((await db.read((tx) => verifyAuditChain(tx, tenantId))).ok).toBe(true);
    }
  });
});
