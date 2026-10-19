import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderErd } from '../../scripts/gen-erd';
import { renderOntologyExports } from '../../scripts/export-ontology';
import { GENERATED_MIGRATIONS, generateSchemaSql } from '../../src/persistence/ddl';

/** Generated artifacts that are committed must match the code that generates them. */
describe('generated documentation', () => {
  it('docs/erd.md matches the schema (npm run db:erd)', () => {
    expect(readFileSync(join(process.cwd(), 'docs', 'erd.md'), 'utf8')).toBe(renderErd());
  });

  it('docs/ontology exports match the ontology (npm run ontology:export)', () => {
    for (const [name, text] of Object.entries(renderOntologyExports())) {
      expect(readFileSync(join(process.cwd(), 'docs', 'ontology', name), 'utf8'), name).toBe(text);
    }
  });

  it('the generated migrations match the schema DSL (npm run db:generate)', () => {
    for (const m of GENERATED_MIGRATIONS) expect(readFileSync(join(process.cwd(), 'db', 'migrations', `${m.version}_${m.name}.sql`), 'utf8'), m.name).toBe(generateSchemaSql(m.version));
  });
});
