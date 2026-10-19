/**
 * Renders docs/erd.md (Mermaid ER diagrams, one per area, plus a table index) from the schema DSL, so the
 * diagram can never drift from the code. Usage: npm run db:erd   (--check exits 1 when docs/erd.md is stale;
 * tests/unit/docs.test.ts runs the same comparison in CI).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ColumnSpec, TableSpec } from '../src/persistence/dsl';
import { schema } from '../src/persistence/schema';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'docs', 'erd.md');

const TYPE: Record<string, string> = { uuid: 'uuid', text: 'text', integer: 'int', bigint: 'bigint', numeric: 'numeric', boolean: 'bool', date: 'date', timestamptz: 'timestamptz', jsonb: 'jsonb' };

function columns(t: TableSpec): string[] {
  return t.columnNames.map((name) => {
    const spec = t.columns[name]!.spec as ColumnSpec;
    const key = spec.primaryKey ? ' PK' : spec.references ? ' FK' : spec.unique ? ' UK' : '';
    const type = spec.enumValues ? 'enum' : (TYPE[spec.sqlType] ?? spec.sqlType.replace(/[^a-z0-9_]/gi, '_'));
    return `    ${type} ${name}${key}`;
  });
}

export function renderErd(): string {
  const tables = Object.values(schema) as unknown as TableSpec[];
  const areas = [...new Set(tables.map((t) => t.area))];
  const parts: string[] = [];
  parts.push('# Bookhand data model (ERD)');
  parts.push('');
  parts.push(`Generated from \`src/persistence/schema\` by \`scripts/gen-erd.ts\`; do not edit by hand. ${tables.length} tables in ${areas.length} areas. Every business table is scoped by \`tenant_id\`; the tenant edges are omitted from the diagrams for readability.`);
  parts.push('');
  parts.push('Invariants enforced by the database itself (`db/migrations/0002_invariants.sql`, mirrored by the in-memory adapter): balanced, immutable posted journals; posting only into open periods; reversal-only corrections; append-only audit, approvals, sign-offs, skill versions and agent traces; a hash-chained audit log; maker-checker on human approvals.');
  parts.push('');
  for (const area of areas) {
    const inArea = tables.filter((t) => t.area === area);
    const names = new Set(inArea.map((t) => t.name));
    parts.push(`## ${area}`);
    parts.push('');
    parts.push('```mermaid');
    parts.push('erDiagram');
    const rels: string[] = [];
    const external = new Set<string>();
    for (const t of inArea) {
      for (const name of t.columnNames) {
        const ref = (t.columns[name]!.spec as ColumnSpec).references;
        if (!ref || name === 'tenant_id') continue;
        const nullable = (t.columns[name]!.spec as ColumnSpec).nullable;
        rels.push(`  ${ref.table} ${nullable ? '|o' : '||'}--o{ ${t.name} : "${name}"`);
        if (!names.has(ref.table)) external.add(ref.table);
      }
    }
    for (const t of inArea) {
      parts.push(`  ${t.name} {`);
      parts.push(...columns(t));
      parts.push('  }');
    }
    for (const e of [...external].sort()) parts.push(`  ${e} {`, '    uuid id PK', '  }');
    parts.push(...rels);
    parts.push('```');
    parts.push('');
    parts.push('| Table | Ontology class | Notes |');
    parts.push('|---|---|---|');
    for (const t of inArea) parts.push(`| \`${t.name}\` | ${t.ontologyClass ? `\`${t.ontologyClass}\`` : ''} | ${t.description.replace(/\|/g, '/')}${t.appendOnly ? ' **Append-only.**' : ''} |`);
    parts.push('');
  }
  return `${parts.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = renderErd();
  if (process.argv.includes('--check')) {
    const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    if (current !== text) {
      console.error('docs/erd.md is stale: run npm run db:erd');
      process.exit(1);
    }
    console.log('docs/erd.md is current');
  } else {
    writeFileSync(outFile, text);
    console.log('wrote docs/erd.md');
  }
}
