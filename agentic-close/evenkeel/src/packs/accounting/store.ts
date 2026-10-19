import type { Db } from '../../framework/store/db';
import { MemoryStore } from '../../framework/store/memory';
import { accountingMemoryHooks } from './schema/memory-hooks';
import { schema, type EkSchema } from './schema/tables';

export type EkDb = Db<EkSchema>;
export type { EkSchema };
export { schema };

/** In-memory store with the accounting pack's emulated triggers (browser demo, unit tests). */
export function createMemoryDb(): EkDb {
  return new MemoryStore(schema, accountingMemoryHooks());
}
