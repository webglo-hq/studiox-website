import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GENERATED_MIGRATIONS, generateSchemaSql } from '../src/persistence/ddl';

for (const m of GENERATED_MIGRATIONS) {
  const target = fileURLToPath(new URL(`../db/migrations/${m.version}_${m.name}.sql`, import.meta.url));
  writeFileSync(target, generateSchemaSql(m.version));
  console.log(`wrote ${target}`);
}
