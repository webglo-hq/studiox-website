import { sha256Hex } from '../shared/hash';
import type { ColumnSpec, TableSpec } from './dsl';
import { normalizeUnique } from './dsl';
import { schema, TABLE_NAMES, type TableName } from './schema';

/** Quote an identifier; identifiers only ever come from the static schema, never from input. */
export function q(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error(`unsafe identifier: ${identifier}`);
  return `"${identifier}"`;
}

/** Postgres identifiers are limited to 63 bytes; long names get a short hash suffix. */
export function constraintName(name: string): string {
  if (name.length <= 63) return name;
  return `${name.slice(0, 54)}_${sha256Hex(name).slice(0, 8)}`;
}

export function sqlTypeOf(col: ColumnSpec): string {
  switch (col.sqlType) {
    case 'numeric':
      return col.numeric ? `numeric(${col.numeric.precision},${col.numeric.scale})` : 'numeric';
    default:
      return col.sqlType;
  }
}

function literal(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

function defaultClause(col: ColumnSpec): string {
  if (col.defaultGen === 'uuid') return ' DEFAULT gen_random_uuid()';
  if (col.defaultGen === 'now') return col.sqlType === 'date' ? ' DEFAULT CURRENT_DATE' : ' DEFAULT now()';
  if (col.defaultGen === 'today') return ' DEFAULT CURRENT_DATE';
  if (col.hasDefault && col.defaultLiteral !== undefined) return ` DEFAULT ${literal(col.defaultLiteral)}`;
  return '';
}

function tableDdl(spec: TableSpec): string {
  const lines: string[] = [];
  const constraints: string[] = [];
  for (const name of spec.columnNames) {
    const col = spec.columns[name]!.spec as ColumnSpec;
    lines.push(`  ${q(name)} ${sqlTypeOf(col)}${col.nullable ? '' : ' NOT NULL'}${defaultClause(col)}`);
    if (col.enumValues) {
      const values = col.enumValues.map((v) => literal(v)).join(', ');
      constraints.push(`  CONSTRAINT ${q(constraintName(`${spec.name}_${name}_check`))} CHECK (${q(name)} IN (${values}))`);
    } else if (col.checkSql) {
      constraints.push(`  CONSTRAINT ${q(constraintName(`${spec.name}_${name}_check`))} CHECK (${q(name)} ${col.checkSql})`);
    }
  }
  const pk = spec.columnNames.filter((n) => (spec.columns[n]!.spec as ColumnSpec).primaryKey);
  constraints.unshift(`  CONSTRAINT ${q(constraintName(`${spec.name}_pkey`))} PRIMARY KEY (${pk.map(q).join(', ')})`);
  for (const name of spec.columnNames) {
    if ((spec.columns[name]!.spec as ColumnSpec).unique) {
      constraints.push(`  CONSTRAINT ${q(constraintName(`${spec.name}_${name}_key`))} UNIQUE (${q(name)})`);
    }
  }
  for (const u of (spec.uniques ?? []).map(normalizeUnique)) {
    const nn = u.nullsNotDistinct ? ' NULLS NOT DISTINCT' : '';
    constraints.push(`  CONSTRAINT ${q(constraintName(`${spec.name}_${u.columns.join('_')}_key`))} UNIQUE${nn} (${u.columns.map(q).join(', ')})`);
  }
  for (const chk of spec.checks ?? []) {
    constraints.push(`  CONSTRAINT ${q(constraintName(chk.name))} CHECK (${chk.sql})`);
  }
  return `CREATE TABLE ${q(spec.name)} (\n${[...lines, ...constraints].join(',\n')}\n);`;
}

function foreignKeys(spec: TableSpec): string[] {
  const out: string[] = [];
  for (const name of spec.columnNames) {
    const ref = (spec.columns[name]!.spec as ColumnSpec).references;
    if (!ref) continue;
    const action = ref.onDelete === 'cascade' ? 'CASCADE' : ref.onDelete === 'set null' ? 'SET NULL' : 'RESTRICT';
    out.push(
      `ALTER TABLE ${q(spec.name)} ADD CONSTRAINT ${q(constraintName(`${spec.name}_${name}_fkey`))} FOREIGN KEY (${q(name)}) REFERENCES ${q(ref.table)} (${q(ref.column)}) ON DELETE ${action};`,
    );
  }
  return out;
}

function indexes(spec: TableSpec): string[] {
  const covered = new Set<string>();
  covered.add('id');
  for (const name of spec.columnNames) if ((spec.columns[name]!.spec as ColumnSpec).unique) covered.add(name);
  for (const u of (spec.uniques ?? []).map(normalizeUnique)) covered.add(u.columns[0]!);
  const out: string[] = [];
  const emitted = new Set<string>();
  const emit = (cols: string[]) => {
    const key = cols.join(',');
    if (emitted.has(key)) return;
    emitted.add(key);
    out.push(`CREATE INDEX ${q(constraintName(`${spec.name}_${cols.join('_')}_idx`))} ON ${q(spec.name)} (${cols.map(q).join(', ')});`);
  };
  for (const idx of spec.indexes ?? []) {
    emit(idx);
    covered.add(idx[0]!);
  }
  for (const name of spec.columnNames) {
    const col = spec.columns[name]!.spec as ColumnSpec;
    if (col.references && !covered.has(name)) emit([name]);
  }
  return out;
}

function comment(spec: TableSpec): string {
  return `COMMENT ON TABLE ${q(spec.name)} IS ${literal(spec.description)};`;
}

/**
 * Migrations generated from the schema DSL. A table belongs to the migration named by its `migration` option
 * (default 0001); hand-written migrations (triggers, data fixes) sit between them in version order.
 */
export const GENERATED_MIGRATIONS: ReadonlyArray<{ version: string; name: string }> = [
  { version: '0001', name: 'schema' },
  { version: '0004', name: 'access_control' },
];

/** A generated migration (by default the initial schema). Deterministic: same schema -> same bytes. */
export function generateSchemaSql(version = '0001'): string {
  const migration = GENERATED_MIGRATIONS.find((m) => m.version === version);
  if (!migration) throw new Error(`no generated migration ${version}`);
  const specs = TABLE_NAMES.map((n: TableName) => schema[n] as unknown as TableSpec).filter((s) => (s.migration ?? '0001') === version);
  const parts: string[] = [
    `-- ${version}_${migration.name}.sql`,
    '-- GENERATED from src/persistence/schema by `npm run db:generate`. Do not edit by hand:',
    '-- tests/unit/ddl.test.ts fails if this file drifts from the schema.',
    '',
  ];
  for (const s of specs) {
    parts.push(tableDdl(s), '');
  }
  parts.push('-- Foreign keys (added after all tables exist; circular references are allowed)');
  for (const s of specs) parts.push(...foreignKeys(s));
  parts.push('', '-- Indexes');
  for (const s of specs) parts.push(...indexes(s));
  parts.push('', '-- Documentation');
  for (const s of specs) parts.push(comment(s));
  parts.push('');
  return parts.join('\n');
}
