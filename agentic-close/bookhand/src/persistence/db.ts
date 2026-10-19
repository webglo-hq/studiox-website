import type { Insert, Row, TableName } from './schema';

/**
 * Persistence port. Domain services depend only on this interface; two adapters implement it:
 *   - MemoryDb: in-process, enforces the same constraints/invariants in TypeScript (static demo, unit tests)
 *   - SqlDb:    Postgres (PGlite embedded or a real server via node-postgres), invariants enforced by the database
 * The model never sees SQL: agents act through typed tools that call domain services that call this port.
 */

export type Cond<V> =
  | V
  | null
  | { in: readonly V[] }
  | { notIn: readonly V[] }
  | { ne: V | null }
  | { gt: V }
  | { gte: V }
  | { lt: V }
  | { lte: V }
  | { between: readonly [V, V] }
  | { contains: string };

export type Where<T extends TableName> = { [K in keyof Row<T>]?: Cond<NonNullable<Row<T>[K]>> };

export interface FindOptions<T extends TableName> {
  orderBy?: Array<[keyof Row<T> & string, 'asc' | 'desc']>;
  limit?: number;
  offset?: number;
  forUpdate?: boolean;
}

export type LineGroupKey =
  | 'entity_id'
  | 'period_id'
  | 'account_id'
  | 'department_id'
  | 'location_id'
  | 'class_id'
  | 'project_id'
  | 'counterparty_entity_id'
  | 'vendor_id';

export const LINE_GROUP_KEYS: readonly LineGroupKey[] = [
  'entity_id',
  'period_id',
  'account_id',
  'department_id',
  'location_id',
  'class_id',
  'project_id',
  'counterparty_entity_id',
  'vendor_id',
];

export interface LineSumsQuery {
  tenantId: string;
  entityIds?: readonly string[];
  periodIds?: readonly string[];
  accountIds?: readonly string[];
  dateFrom?: string;
  dateTo?: string;
  groupBy: readonly LineGroupKey[];
  /** Journal entry statuses included (default: posted only). */
  statuses?: ReadonlyArray<'posted' | 'pending_approval' | 'draft'>;
}

export interface LineSum {
  key: Partial<Record<LineGroupKey, string | null>>;
  debit_minor: number;
  credit_minor: number;
  line_count: number;
}

export interface Tx {
  readonly kind: 'memory' | 'postgres';
  insert<T extends TableName>(table: T, row: Insert<T>): Promise<Row<T>>;
  insertMany<T extends TableName>(table: T, rows: ReadonlyArray<Insert<T>>): Promise<Row<T>[]>;
  update<T extends TableName>(table: T, id: string, patch: Partial<Row<T>>): Promise<Row<T>>;
  delete<T extends TableName>(table: T, id: string): Promise<void>;
  get<T extends TableName>(table: T, id: string, opts?: { forUpdate?: boolean }): Promise<Row<T> | null>;
  find<T extends TableName>(table: T, where?: Where<T>, opts?: FindOptions<T>): Promise<Row<T>[]>;
  findOne<T extends TableName>(table: T, where: Where<T>): Promise<Row<T> | null>;
  count<T extends TableName>(table: T, where?: Where<T>): Promise<number>;
  /** The one aggregate the ledger needs: sums of posted lines grouped by whitelisted keys. */
  sumLines(query: LineSumsQuery): Promise<LineSum[]>;
  /** Serialize writers of a tenant's audit hash chain (advisory lock in Postgres; no-op in memory). */
  lockAuditChain(tenantId: string): Promise<void>;
}

export interface Db {
  readonly kind: 'memory' | 'postgres';
  readonly label: string;
  /** Run fn in one atomic transaction. Never nest. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Read-only unit of work. */
  read<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DbErrorKind =
  | 'unique_violation'
  | 'foreign_key_violation'
  | 'check_violation'
  | 'not_null_violation'
  | 'invariant_violation'
  | 'period_locked'
  | 'immutable_row'
  | 'audit_chain'
  | 'invalid_input';

/** Constraint failure raised identically by both adapters (Postgres SQLSTATEs are mapped onto these kinds). */
export class DbConstraintError extends Error {
  readonly kind: DbErrorKind;
  readonly constraint: string | undefined;
  readonly table: string | undefined;

  constructor(kind: DbErrorKind, message: string, opts: { constraint?: string; table?: string } = {}) {
    super(message);
    this.name = 'DbConstraintError';
    this.kind = kind;
    this.constraint = opts.constraint;
    this.table = opts.table;
  }
}

export function isDbConstraintError(e: unknown): e is DbConstraintError {
  return e instanceof DbConstraintError;
}

/** Find all, failing loudly if the caller expected exactly one. */
export async function getOrThrow<T extends TableName>(tx: Tx, table: T, id: string): Promise<Row<T>> {
  const row = await tx.get(table, id);
  if (!row) throw new DbConstraintError('invalid_input', `${table} ${id} does not exist`, { table });
  return row;
}
