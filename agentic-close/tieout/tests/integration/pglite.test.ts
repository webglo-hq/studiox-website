/** Embedded PostgreSQL (PGlite, the default local store): migrations, seed, contract, an agent run. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/core/agent/runtime';
import { resolveUserActor } from '../../src/core/auth/actor';
import { DEMO_SCRYPT, nobleScrypt, PasswordHasher } from '../../src/core/auth/password';
import { createPgliteDriver } from '../../src/core/store/drivers/pglite';
import { migrate } from '../../src/core/store/migrate';
import type { SqlDriver } from '../../src/core/store/sql';
import { scenarioClock } from '../../src/core/util/time';
import type { Db } from '../../src/schema';
import { createPgDb } from '../../src/schema/factory';
import { migrations } from '../../src/schema/migrations.generated';
import { accountingPack } from '../../src/packs/accounting/agent/pack';
import { PEOPLE, SCENARIO } from '../../src/packs/accounting/seed/company';
import { DEMO_TENANT_ID, seedScenario } from '../../src/packs/accounting/seed/scenario';
import { accountingSkills, installAccountingSkills } from '../../src/packs/accounting/skills/install';
import { storeContract } from '../support/contract';

describe('PGlite (embedded PostgreSQL)', () => {
  let driver: SqlDriver;
  let db: Db;

  beforeAll(async () => {
    driver = await createPgliteDriver(); // in-memory instance
    const r = await migrate(driver, migrations);
    expect(r.applied.length).toBe(migrations.length);
    db = createPgDb(driver);
    const hasher = new PasswordHasher(nobleScrypt, DEMO_SCRYPT);
    await seedScenario(db, { demoPassword: 'pglite-test-only', hashPassword: (p) => hasher.hash(p), installSkills: installAccountingSkills });
  }, 300_000);

  afterAll(async () => {
    await driver?.close();
  });

  describe('store contract on PGlite', () => storeContract(() => db));

  it('runs a skill against the embedded database', async () => {
    const runtime = new AgentRuntime({ db, clock: scenarioClock(SCENARIO.businessDate), pack: accountingPack, skills: accountingSkills(), llm: null, resolveActor: resolveUserActor });
    const users = await db.tx(DEMO_TENANT_ID, (tx) => tx.find('users', {}));
    const us = await db.tx(DEMO_TENANT_ID, (tx) => tx.findOne('entities', { code: 'BWL-US' }));
    const run = await runtime.start({ tenantId: DEMO_TENANT_ID, skillKey: 'transaction-coding', entityId: us!.id, periodKey: SCENARIO.closeKey, requestedBy: users.find((u) => u.email === PEOPLE.find((p) => p.key === 'sam')!.email)!.id });
    expect(run.status).toBe('succeeded');
    expect(run.summary.proposals).toBeGreaterThan(15);
  }, 120_000);
});
