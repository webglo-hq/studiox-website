import { beforeAll, describe } from 'vitest';
import type { Db } from '../../src/schema';
import { bramblewoodFixture } from '../../src/packs/accounting/evals/harness';
import { storeContract } from '../support/contract';

let db: Db;
beforeAll(async () => {
  db = (await bramblewoodFixture()).db;
}, 120_000);

describe('store contract: in-memory store (trigger emulation)', () => storeContract(() => db));
