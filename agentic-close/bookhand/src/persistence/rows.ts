import { newId } from '../shared/ids';
import type { ColumnSpec, TableSpec } from './dsl';
import { DbConstraintError } from './db';

/** Fill defaults for omitted columns exactly the way the DDL defaults would. */
export function applyDefaults(spec: TableSpec, input: Record<string, unknown>, nowIso: string): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const name of spec.columnNames) {
    const col = spec.columns[name]!.spec as ColumnSpec;
    let value = input[name];
    if (value === undefined) {
      if (col.defaultGen === 'uuid') value = newId();
      else if (col.defaultGen === 'now') value = col.sqlType === 'date' ? nowIso.slice(0, 10) : nowIso;
      else if (col.defaultGen === 'today') value = nowIso.slice(0, 10);
      else if (col.hasDefault && col.defaultLiteral !== undefined) value = cloneLiteral(col.defaultLiteral);
      else if (col.nullable) value = null;
    }
    row[name] = value;
  }
  for (const key of Object.keys(input)) {
    if (!(key in spec.columns)) {
      throw new DbConstraintError('invalid_input', `${spec.name} has no column "${key}"`, { table: spec.name });
    }
  }
  return row;
}

function cloneLiteral(v: unknown): unknown {
  return v !== null && typeof v === 'object' ? structuredClone(v) : v;
}

/** Validate column-level rules shared by both adapters before a write (types, enums, not-null, checks). */
export function validateColumns(spec: TableSpec, row: Record<string, unknown>): void {
  for (const name of spec.columnNames) {
    const col = spec.columns[name]!.spec as ColumnSpec;
    const value = row[name];
    if (value === null || value === undefined) {
      if (!col.nullable) {
        throw new DbConstraintError('not_null_violation', `${spec.name}.${name} is required`, {
          table: spec.name,
          constraint: `${spec.name}_${name}_not_null`,
        });
      }
      continue;
    }
    const typeError = checkType(col, value);
    if (typeError) {
      throw new DbConstraintError('invalid_input', `${spec.name}.${name}: ${typeError}`, { table: spec.name });
    }
    if (col.enumValues && !col.enumValues.includes(value as string)) {
      throw new DbConstraintError('check_violation', `${spec.name}.${name} must be one of ${col.enumValues.join(', ')} (got "${String(value)}")`, {
        table: spec.name,
        constraint: `${spec.name}_${name}_check`,
      });
    }
    if (col.checkFn && !col.checkFn(value)) {
      throw new DbConstraintError('check_violation', `${spec.name}.${name} violates CHECK (${name} ${col.checkSql})`, {
        table: spec.name,
        constraint: `${spec.name}_${name}_check`,
      });
    }
  }
  for (const chk of spec.checks ?? []) {
    if (!chk.test(row)) {
      throw new DbConstraintError('check_violation', chk.message, { table: spec.name, constraint: chk.name });
    }
  }
}

function checkType(col: ColumnSpec, value: unknown): string | null {
  switch (col.sqlType) {
    case 'uuid':
      return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? null
        : `expected a UUID, got ${JSON.stringify(value)}`;
    case 'text':
      return typeof value === 'string' ? null : 'expected text';
    case 'integer':
      return Number.isInteger(value) && Math.abs(value as number) <= 2_147_483_647 ? null : 'expected a 32-bit integer';
    case 'bigint':
      return Number.isSafeInteger(value) ? null : 'expected a safe integer';
    case 'numeric':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'expected a finite number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected a boolean';
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : 'expected YYYY-MM-DD';
    case 'timestamptz':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : 'expected an ISO timestamp';
    case 'jsonb':
      return null;
    case 'bytea':
      return value instanceof Uint8Array ? null : 'expected bytes';
    default:
      return null;
  }
}

/** Normalize a row read from Postgres into the same JS shapes the memory adapter returns. */
export function coerceRow(spec: TableSpec, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of spec.columnNames) {
    const col = spec.columns[name]!.spec as ColumnSpec;
    out[name] = coerceValue(col, raw[name]);
  }
  return out;
}

export function coerceValue(col: ColumnSpec, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (col.sqlType) {
    case 'bigint':
    case 'numeric':
    case 'integer':
      return typeof v === 'number' ? v : Number(v);
    case 'boolean':
      return typeof v === 'boolean' ? v : v === 't' || v === 'true';
    case 'date':
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v).slice(0, 10);
    case 'timestamptz':
      return toIsoTimestamp(v);
    case 'jsonb':
      return typeof v === 'string' ? JSON.parse(v) : v;
    case 'bytea':
      return v instanceof Uint8Array ? new Uint8Array(v) : v;
    default:
      return v;
  }
}

export function toIsoTimestamp(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  // Postgres text format: "2026-10-19 04:26:17.123+00" -> ISO
  const normalized = s.includes('T') ? s : s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}
