import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { constraintName, GENERATED_MIGRATIONS, generateSchemaSql, q } from './ddl';
import { schema, TABLE_NAMES } from './schema';
import type { ColumnSpec } from './dsl';

describe('DDL generator', () => {
  it('matches the committed generated migrations (no drift between DSL and migrations)', () => {
    for (const m of GENERATED_MIGRATIONS) {
      const file = readFileSync(fileURLToPath(new URL(`../../db/migrations/${m.version}_${m.name}.sql`, import.meta.url)), 'utf8');
      expect(file, m.name).toBe(generateSchemaSql(m.version));
    }
  });

  it('generates every table into exactly one migration', () => {
    const generated = GENERATED_MIGRATIONS.flatMap((m) => [...generateSchemaSql(m.version).matchAll(/^CREATE TABLE "([a-z_]+)"/gm)].map((x) => x[1]));
    expect(generated.sort()).toEqual([...TABLE_NAMES].sort());
  });

  it('is deterministic', () => {
    expect(generateSchemaSql()).toBe(generateSchemaSql());
  });

  it('only quotes safe identifiers', () => {
    expect(q('journal_entries')).toBe('"journal_entries"');
    expect(() => q('x"; DROP TABLE users; --')).toThrow(/unsafe identifier/);
  });

  it('keeps constraint names within the Postgres 63-byte limit', () => {
    const long = 'a'.repeat(80);
    expect(constraintName(long).length).toBeLessThanOrEqual(63);
    expect(constraintName('short')).toBe('short');
  });

  it('every table is tenant-scoped or explicitly global, and every reference points at a real table', () => {
    const globals = new Set(['tenants', 'roles', 'skills', 'skill_versions', 'ontology_versions']);
    for (const name of TABLE_NAMES) {
      const spec = schema[name];
      const cols = spec.columns as Record<string, { spec: ColumnSpec }>;
      if (!globals.has(name)) expect(cols.tenant_id, `${name}.tenant_id`).toBeDefined();
      for (const [col, def] of Object.entries(cols)) {
        const ref = def.spec.references;
        if (ref) expect(TABLE_NAMES, `${name}.${col} -> ${ref.table}`).toContain(ref.table);
      }
      expect(spec.description.length, `${name} has a description`).toBeGreaterThan(10);
    }
  });
});
