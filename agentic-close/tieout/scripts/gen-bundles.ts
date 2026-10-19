/**
 * Code generation (schema-first). Run `npm run gen`; CI runs `npm run gen:check`.
 *
 *  1. migrations/*.sql          -> src/schema/tables.generated.ts      (row types + table metadata)
 *  2. migrations/*.sql          -> src/schema/migrations.generated.ts  (SQL bundled for runtime)
 *  3. skills/<key>/**           -> src/packs/accounting/skills/bundle.generated.ts
 *
 * The SQL is the single source of truth for the data model; TypeScript row types, the memory
 * store's constraint emulation and the Postgres adapter's column whitelist all derive from it.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const CHECK = process.argv.includes('--check');

type SqlType = 'text' | 'bigint' | 'int' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'jsonb';
interface Col {
  name: string;
  type: SqlType;
  nullable: boolean;
  default?: { kind: 'now' } | { kind: 'literal'; value: unknown };
  enumValues?: string[];
  references?: { table: string; onDelete: 'cascade' | 'restrict' };
  unique?: boolean;
  primaryKey?: boolean;
  jsonType?: string;
}
interface Table {
  name: string;
  columns: Col[];
  uniques: string[][];
}

function parseSql(sql: string): Table[] {
  const tables: Table[] = [];
  const re = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*) \(\n([\s\S]*?)\n\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const name = m[1]!;
    const body = m[2]!;
    const t: Table = { name, columns: [], uniques: [] };
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('--')) continue;
      const uq = /^UNIQUE \(([^)]+)\)/.exec(line);
      if (uq) {
        t.uniques.push(uq[1]!.split(',').map((s) => s.trim()));
        continue;
      }
      if (/^(CHECK|PRIMARY KEY|FOREIGN KEY|CONSTRAINT|OR|AND)\b/.test(line) || /^[()]/.test(line)) continue;
      t.columns.push(parseColumn(name, line));
    }
    tables.push(t);
  }
  return tables;
}

/** `ALTER TABLE t ADD COLUMN …;` statements of a migration, applied after every CREATE TABLE. */
function parseAlters(sql: string): { table: string; line: string }[] {
  const out: { table: string; line: string }[] = [];
  for (const m of sql.matchAll(/ALTER TABLE ([a-z_][a-z0-9_]*) ADD COLUMN ([^;]+);/g)) out.push({ table: m[1]!, line: m[2]!.trim() });
  return out;
}

function parseColumn(name: string, line: string): Col {
  const cm = /^([a-z_][a-z0-9_]*) (TEXT|BIGINT|INT|NUMERIC(?:\(\d+,\d+\))?|BOOLEAN|DATE|TIMESTAMPTZ|JSONB)\b(.*)$/.exec(line);
  if (!cm) throw new Error(`gen: cannot parse column line in ${name}: ${line}`);
  const [, colName, rawType, rest0] = cm as unknown as [string, string, string, string];
  const [rest, comment] = rest0.split('--').map((s) => s?.trim() ?? '') as [string, string | undefined];
  const type = (rawType.startsWith('NUMERIC') ? 'numeric' : rawType.toLowerCase()) as SqlType;
  const col: Col = {
    name: colName,
    type,
    nullable: !/NOT NULL/.test(rest) && !/PRIMARY KEY/.test(rest),
  };
  if (/PRIMARY KEY/.test(rest)) col.primaryKey = true;
  if (/\bUNIQUE\b/.test(rest)) col.unique = true;
  const ref = /REFERENCES ([a-z_]+)\(id\)( ON DELETE CASCADE)?/.exec(rest);
  if (ref) col.references = { table: ref[1]!, onDelete: ref[2] ? 'cascade' : 'restrict' };
  const def = /DEFAULT ('(?:[^']*)'(?:::jsonb)?|now\(\)|true|false|-?\d+(?:\.\d+)?)/.exec(rest);
  if (def) {
    const d = def[1]!;
    if (d === 'now()') col.default = { kind: 'now' };
    else if (d === 'true' || d === 'false') col.default = { kind: 'literal', value: d === 'true' };
    else if (/^-?\d/.test(d)) col.default = { kind: 'literal', value: Number(d) };
    else if (d.endsWith('::jsonb')) col.default = { kind: 'literal', value: JSON.parse(d.slice(1, -8)) };
    else col.default = { kind: 'literal', value: d.slice(1, -1) };
  }
  const en = /CHECK \(\w+ IN \(([^)]*)\)\)/.exec(rest);
  if (en) col.enumValues = en[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  if (comment) {
    const jt = /@json (.+)$/.exec(comment);
    if (jt) col.jsonType = jt[1]!.trim();
  }
  return col;
}

function singular(word: string): string {
  if (word.endsWith('analyses')) return word.slice(0, -2) + 'is';
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (/(ch|sh|x)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function rowTypeName(table: string): string {
  const parts = table.split('_');
  parts[parts.length - 1] = singular(parts[parts.length - 1]!);
  return parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join('') + 'Row';
}

function tsType(c: Col): string {
  let t: string;
  if (c.enumValues) t = c.enumValues.map((v) => `'${v}'`).join(' | ');
  else
    switch (c.type) {
      case 'text':
      case 'date':
      case 'timestamptz':
        t = 'string';
        break;
      case 'bigint':
      case 'int':
      case 'numeric':
        t = 'number';
        break;
      case 'boolean':
        t = 'boolean';
        break;
      case 'jsonb':
        t = c.jsonType ?? 'JsonValue';
        break;
    }
  return c.nullable ? `${t} | null` : t;
}

const JSON_TYPE_IMPORTS = new Set<string>();

function collectJsonTypes(tables: Table[]) {
  const builtin = new Set(['JsonValue', 'unknown', 'string', 'number', 'Record', 'string[]']);
  for (const t of tables)
    for (const c of t.columns) {
      if (!c.jsonType) continue;
      for (const ident of c.jsonType.match(/[A-Z][A-Za-z0-9]+/g) ?? []) {
        if (!builtin.has(ident)) JSON_TYPE_IMPORTS.add(ident);
      }
    }
}

function genTables(tables: Table[]): string {
  collectJsonTypes(tables);
  const lines: string[] = [];
  lines.push('// GENERATED by scripts/gen-bundles.ts from migrations/*.sql. Do not edit by hand.');
  lines.push('/* eslint-disable */');
  lines.push("import type { TableMeta } from '../core/store/types';");
  const usesJsonValue = tables.some((t) => t.columns.some((c) => c.type === 'jsonb' && !c.jsonType));
  if (usesJsonValue) lines.push("import type { JsonValue } from '../core/util/json';");
  if (JSON_TYPE_IMPORTS.size)
    lines.push(`import type { ${[...JSON_TYPE_IMPORTS].sort().join(', ')} } from './json-types';`);
  lines.push('');
  for (const t of tables) {
    lines.push(`export interface ${rowTypeName(t.name)} {`);
    for (const c of t.columns) lines.push(`  ${c.name}: ${tsType(c)};`);
    lines.push('}');
    lines.push('');
  }
  lines.push('export interface DbTables {');
  for (const t of tables) lines.push(`  ${t.name}: ${rowTypeName(t.name)};`);
  lines.push('}');
  lines.push('');
  lines.push('/** Columns that may be omitted on insert (defaulted, nullable, or set by the store). */');
  lines.push('export interface DbOptionalOnInsert {');
  for (const t of tables) {
    const opt = t.columns
      .filter((c) => c.nullable || c.default || c.name === 'id' || c.name === 'tenant_id')
      .map((c) => `'${c.name}'`);
    lines.push(`  ${t.name}: ${opt.length ? opt.join(' | ') : 'never'};`);
  }
  lines.push('}');
  lines.push('');
  lines.push('export const tableMeta = {');
  for (const t of tables) {
    const tenantScoped = t.columns.some((c) => c.name === 'tenant_id');
    const cols = t.columns.map((c) => {
      const o: Record<string, unknown> = { name: c.name, type: c.type, nullable: c.nullable };
      if (c.default) o.default = c.default;
      if (c.enumValues) o.enumValues = c.enumValues;
      if (c.references) o.references = c.references;
      if (c.unique) o.unique = true;
      if (c.primaryKey) o.primaryKey = true;
      return JSON.stringify(o);
    });
    lines.push(`  ${t.name}: {`);
    lines.push(`    name: '${t.name}',`);
    lines.push(`    tenantScoped: ${tenantScoped},`);
    lines.push(`    uniques: ${JSON.stringify(t.uniques)},`);
    lines.push('    columns: [');
    for (const c of cols) lines.push(`      ${c},`);
    lines.push('    ],');
    lines.push('  },');
  }
  lines.push('} satisfies Record<keyof DbTables, TableMeta>;');
  lines.push('');
  lines.push('export type TableName = keyof DbTables;');
  lines.push('');
  return lines.join('\n');
}

function genMigrations(files: { id: string; sql: string }[]): string {
  const lines = ['// GENERATED by scripts/gen-bundles.ts from migrations/*.sql. Do not edit by hand.', '/* eslint-disable */', ''];
  lines.push('export interface MigrationFile { id: string; sql: string }');
  lines.push('export const migrations: MigrationFile[] = [');
  for (const f of files) lines.push(`  { id: ${JSON.stringify(f.id)}, sql: ${JSON.stringify(f.sql)} },`);
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function genSkills(): string {
  const dir = join(ROOT, 'skills');
  const lines = ['// GENERATED by scripts/gen-bundles.ts from skills/**. Do not edit by hand.', '/* eslint-disable */', ''];
  lines.push('export interface SkillBundleFile { path: string; content: string }');
  lines.push('export interface SkillBundle { key: string; files: SkillBundleFile[] }');
  lines.push('export const skillBundles: SkillBundle[] = [');
  if (existsSync(dir)) {
    for (const key of readdirSync(dir).sort()) {
      const skillDir = join(dir, key);
      if (!statSync(skillDir).isDirectory()) continue;
      const files = walk(skillDir).map((p) => ({
        path: relative(skillDir, p).split('\\').join('/'),
        content: readFileSync(p, 'utf8'),
      }));
      lines.push(`  { key: ${JSON.stringify(key)}, files: ${JSON.stringify(files)} },`);
    }
  }
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

function emit(path: string, content: string, stale: string[]) {
  const full = join(ROOT, path);
  const current = existsSync(full) ? readFileSync(full, 'utf8') : '';
  if (current === content) return;
  if (CHECK) stale.push(path);
  else {
    writeFileSync(full, content);
    console.log(`gen: wrote ${path}`);
  }
}

const migFiles = readdirSync(join(ROOT, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ id: f.replace(/\.sql$/, ''), sql: readFileSync(join(ROOT, 'migrations', f), 'utf8') }));
const tables = migFiles.flatMap((f) => parseSql(f.sql));
for (const a of migFiles.flatMap((f) => parseAlters(f.sql))) {
  const t = tables.find((x) => x.name === a.table);
  if (!t) throw new Error(`gen: ALTER TABLE for unknown table ${a.table}`);
  t.columns.push(parseColumn(a.table, a.line));
}
const stale: string[] = [];
emit('src/schema/tables.generated.ts', genTables(tables), stale);
emit('src/schema/migrations.generated.ts', genMigrations(migFiles), stale);
emit('src/packs/accounting/skills/bundle.generated.ts', genSkills(), stale);
if (CHECK && stale.length) {
  console.error(`gen:check failed; regenerate with npm run gen:\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
if (CHECK) console.log(`gen:check ok (${tables.length} tables)`);
