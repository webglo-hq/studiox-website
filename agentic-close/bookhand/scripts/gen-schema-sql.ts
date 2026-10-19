import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSchemaSql } from '../src/persistence/ddl';

const target = fileURLToPath(new URL('../db/migrations/0001_schema.sql', import.meta.url));
writeFileSync(target, generateSchemaSql());
console.log(`wrote ${target}`);
