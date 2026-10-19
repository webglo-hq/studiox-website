import type { Insert, Row, Schema, TableName } from './schema';

/**
 * Store port used by every domain service. Two adapters implement it: SqlStore (Postgres via
 * node-postgres or embedded PGlite) and MemoryStore (browser demo and fast unit tests).
 * Domain code never builds SQL; identifiers are whitelisted from the schema registry and all
 * values are bound parameters.
 */
export type Cond<V> =
  | V
  | {
      eq?: V;
      ne?: V;
      in?: readonly V[];
      notIn?: readonly V[];
      gt?: V;
      gte?: V;
      lt?: V;
      lte?: V;
      isNull?: boolean;
      /** case-insensitive substring match (strings only) */
      contains?: string;
    };

export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  offset?: number;
}

/** A query with an SQL implementation and an in-memory implementation that must agree. */
export interface NamedQuery<S extends Schema, P, R> {
  name: string;
  sql(params: P): { text: string; values: unknown[] };
  /** Convert a raw SQL row (strings for numerics etc.) to R. */
  mapRow(row: Record<string, unknown>): R;
  memory(reader: MemoryReader<S>, params: P): R[];
}

export interface MemoryReader<S extends Schema> {
  all<T extends TableName<S>>(table: T): readonly Row<S, T>[];
  byId<T extends TableName<S>>(table: T, id: string): Row<S, T> | undefined;
  byIndex<T extends TableName<S>>(table: T, column: keyof Row<S, T> & string, value: unknown): readonly Row<S, T>[];
}

export interface Db<S extends Schema> {
  readonly kind: 'memory' | 'pglite' | 'postgres';
  insert<T extends TableName<S>>(table: T, row: Insert<S, T>): Promise<Row<S, T>>;
  insertMany<T extends TableName<S>>(table: T, rows: Insert<S, T>[]): Promise<number>;
  update<T extends TableName<S>>(table: T, id: string, patch: Partial<Row<S, T>>): Promise<Row<S, T>>;
  updateWhere<T extends TableName<S>>(table: T, where: Where<Row<S, T>>, patch: Partial<Row<S, T>>): Promise<number>;
  get<T extends TableName<S>>(table: T, id: string): Promise<Row<S, T> | null>;
  find<T extends TableName<S>>(table: T, where?: Where<Row<S, T>>, opts?: FindOptions<Row<S, T>>): Promise<Row<S, T>[]>;
  findOne<T extends TableName<S>>(table: T, where: Where<Row<S, T>>, opts?: FindOptions<Row<S, T>>): Promise<Row<S, T> | null>;
  count<T extends TableName<S>>(table: T, where?: Where<Row<S, T>>): Promise<number>;
  delete<T extends TableName<S>>(table: T, id: string): Promise<void>;
  query<P, R>(q: NamedQuery<S, P, R>, params: P): Promise<R[]>;
  /** Atomically allocate the next value of a gap-free sequence (e.g. journal entry numbers). */
  nextSequence(tenantId: string, key: string): Promise<number>;
  /** Run fn atomically. Nested calls use savepoints. */
  tx<R>(fn: (db: Db<S>) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export function isCondObject(v: unknown): v is Exclude<Cond<unknown>, unknown[]> & Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => ['eq', 'ne', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'isNull', 'contains'].includes(k));
}

/** Evaluate a Where clause against a plain row (used by the memory adapter). */
export function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [col, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const v = row[col];
    if (isCondObject(cond)) {
      const c = cond as Record<string, unknown>;
      if ('eq' in c && v !== c.eq) return false;
      if ('ne' in c && v === c.ne) return false;
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
      if ('notIn' in c && (c.notIn as unknown[]).includes(v)) return false;
      if ('gt' in c && !(v !== null && (v as number | string) > (c.gt as number | string))) return false;
      if ('gte' in c && !(v !== null && (v as number | string) >= (c.gte as number | string))) return false;
      if ('lt' in c && !(v !== null && (v as number | string) < (c.lt as number | string))) return false;
      if ('lte' in c && !(v !== null && (v as number | string) <= (c.lte as number | string))) return false;
      if ('isNull' in c && (v === null) !== c.isNull) return false;
      if ('contains' in c && !(typeof v === 'string' && v.toLowerCase().includes(String(c.contains).toLowerCase()))) return false;
    } else if (cond === null) {
      if (v !== null) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly constraint?: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}
