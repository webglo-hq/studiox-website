import { fileURLToPath } from 'node:url';
import { MemoryDb } from '../../src/persistence/memory';
import { openDatabase } from '../../src/persistence/node';
import { defineConformance } from './conformance';

const migrationsDir = fileURLToPath(new URL('../../db/migrations', import.meta.url));

defineConformance('MemoryDb (TypeScript constraint engine)', async () => new MemoryDb());

defineConformance('PGlite (embedded Postgres)', async () => (await openDatabase({ migrationsDir })).db);

const url = process.env.DATABASE_URL;
if (url) {
  defineConformance(`PostgreSQL server`, async () => (await openDatabase({ migrationsDir, databaseUrl: url })).db);
}
