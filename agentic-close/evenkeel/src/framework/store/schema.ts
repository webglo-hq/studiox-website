/**
 * Typed table registry. Each domain pack declares its tables once here; the declaration
 * gives (1) TypeScript row/insert types, (2) the identifier whitelist and value codecs for
 * the SQL adapter, and (3) the constraint metadata the in-memory adapter enforces.
 * The SQL migrations are written by hand (they also carry triggers); a contract test checks
 * the registry against information_schema so the two can never drift.
 */
export type ColKind = 'uuid' | 'text' | 'int' | 'bigint' | 'numeric' | 'bool' | 'date' | 'timestamptz' | 'json';

export interface ColSpec {
  kind: ColKind;
  nullable: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  enumValues?: readonly string[];
  references?: { table: string; onDelete?: 'cascade' | 'restrict' | 'set null' };
}

export class Col<T, N extends boolean = false, D extends boolean = false> {
  declare readonly __type: T;
  declare readonly __nullable: N;
  declare readonly __default: D;
  constructor(readonly spec: ColSpec) {}

  nullable(): Col<T, true, D> {
    return new Col<T, true, D>({ ...this.spec, nullable: true });
  }

  /** App-side default applied on insert by both adapters (functions are evaluated per row). */
  default(value: T | (() => T)): Col<T, N, true> {
    return new Col<T, N, true>({ ...this.spec, hasDefault: true, defaultValue: value });
  }

  references(table: string, onDelete: 'cascade' | 'restrict' | 'set null' = 'restrict'): Col<T, N, D> {
    return new Col<T, N, D>({ ...this.spec, references: { table, onDelete } });
  }
}

const base = (kind: ColKind, extra: Partial<ColSpec> = {}): ColSpec => ({ kind, nullable: false, hasDefault: false, ...extra });

export const t = {
  uuid: () => new Col<string>(base('uuid')),
  text: () => new Col<string>(base('text')),
  enum: <const V extends readonly string[]>(values: V) => new Col<V[number]>(base('text', { enumValues: values })),
  int: () => new Col<number>(base('int')),
  /** int8 — used for money in minor units */
  bigint: () => new Col<number>(base('bigint')),
  numeric: () => new Col<number>(base('numeric')),
  bool: () => new Col<boolean>(base('bool')),
  date: () => new Col<string>(base('date')),
  timestamptz: () => new Col<string>(base('timestamptz')),
  json: <T>() => new Col<T>(base('json')),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCol = Col<any, boolean, boolean>;
export type Columns = Record<string, AnyCol>;

export interface CheckSpec<R> {
  name: string;
  message: string;
  /** Method syntax keeps the check bivariant so typed tables fit the generic Schema. */
  test(row: R): boolean;
}

export interface TableSpec<C extends Columns = Columns> {
  name: string;
  columns: C;
  /** Defaults to "id". */
  primaryKey?: keyof C & string;
  unique?: (keyof C & string)[][];
  /** Equality indexes the in-memory adapter maintains (SQL indexes live in migrations). */
  indexes?: (keyof C & string)[][];
  /** Rows can never be updated or deleted (audit log). */
  appendOnly?: boolean;
  /** Rows may be deleted (default: false — most business tables are never deleted). */
  deletable?: boolean;
  checks?: CheckSpec<RowOf<C>>[];
  /** Tenant-scoped tables carry tenant_id (enforced for cross-row FK consistency). */
  tenantScoped?: boolean;
}

export type RowOf<C extends Columns> = {
  [K in keyof C]: C[K] extends Col<infer T, infer N, boolean> ? (N extends true ? T | null : T) : never;
};

type RequiredKeys<C extends Columns> = {
  [K in keyof C]: C[K] extends Col<unknown, infer N, infer D> ? (N extends true ? never : D extends true ? never : K) : never;
}[keyof C];

export type InsertOf<C extends Columns> = { [K in RequiredKeys<C>]: RowOf<C>[K] } & {
  [K in Exclude<keyof C, RequiredKeys<C>>]?: RowOf<C>[K];
};

export function table<C extends Columns>(spec: TableSpec<C>): TableSpec<C> {
  return spec;
}

// `any` here: table specs are invariant in their column map (keyof in key positions), so the
// generic registry type must accept every concrete TableSpec<C>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Schema = Record<string, TableSpec<any>>;

export type TableName<S extends Schema> = keyof S & string;
export type Row<S extends Schema, T extends TableName<S>> = RowOf<S[T]['columns']>;
export type Insert<S extends Schema, T extends TableName<S>> = InsertOf<S[T]['columns']>;

export function primaryKey(spec: TableSpec): string {
  return spec.primaryKey ?? 'id';
}

/** Apply app-side defaults and fill nullable columns with null. */
export function materializeInsert(spec: TableSpec, input: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(spec.columns)) {
    let v = input[name];
    if (v === undefined && col.spec.hasDefault) {
      const d = col.spec.defaultValue;
      v = typeof d === 'function' ? (d as () => unknown)() : d;
      if (v !== null && typeof v === 'object') v = structuredClone(v);
    }
    if (v === undefined) v = null;
    row[name] = v;
  }
  for (const k of Object.keys(input)) {
    if (!(k in spec.columns)) throw new Error(`unknown column ${spec.name}.${k}`);
  }
  return row;
}
