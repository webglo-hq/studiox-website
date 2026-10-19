import { createPgliteDriver } from '../../src/framework/store/drivers/pglite';
import { SqlStore } from '../../src/framework/store/sql';
import { createMemoryDb, schema } from '../../src/packs/accounting/store';
import { migrate } from '../../src/server/db';
import { defineInvariantSuite } from '../shared/invariant-suite';

defineInvariantSuite('in-memory store (emulated triggers)', async () => createMemoryDb());

defineInvariantSuite('embedded Postgres (PGlite)', async () => {
  const driver = await createPgliteDriver();
  await migrate(driver);
  return new SqlStore(schema, driver);
});
