/**
 * Store port: the only way domain code touches persistence.
 *
 * Deep-module contract: a small, typed CRUD + aggregate surface. Two adapters implement it:
 *   - PgStore      (real Postgres or embedded PGlite; invariants enforced by constraints/triggers)
 *   - MemoryStore  (browser demo + fast tests; emulates the same constraints and triggers)
 * A shared contract test suite (tests/integration/store-contract.test.ts) proves parity.
 *
 * The model never runs SQL: agents call typed tools -> domain services -> this port.
 */

export type SqlType = 'text' | 'bigint' | 'int' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'jsonb';

export type ColumnDefault =
  | { kind: 'now' }
  | { kind: 'literal'; value: unknown };

export interface ColumnMeta {
  name: string;
  type: SqlType;
  nullable: boolean;
  default?: ColumnDefault;
  enumValues?: readonly string[];
  references?: { table: string; onDelete: 'cascade' | 'restrict' };
  unique?: boolean;
  primaryKey?: boolean;
}

export interface TableMeta {
  name: string;
  columns: readonly ColumnMeta[];
  uniques: readonly (readonly string[])[];
  tenantScoped: boolean;
}

export type TableMetaMap = Record<string, TableMeta>;

/** Filter operators. Values are always bound as parameters, never interpolated. */
export type Scalar = string | number | boolean | null;
export type Condition =
  | Scalar
  | { in: readonly Scalar[] }
  | { notIn: readonly Scalar[] }
  | { ne: Scalar }
  | { gt?: Scalar; gte?: Scalar; lt?: Scalar; lte?: Scalar }
  | { isNull: boolean }
  | { ilike: string };

export type Where<R> = { [K in keyof R]?: Condition };

export interface FindOptions<R> {
  orderBy?: readonly (readonly [keyof R & string, 'asc' | 'desc'])[];
  limit?: number;
  offset?: number;
}

/** Aggregate over posted journal lines (the hot path for TB, statements, flux, recs). */
export interface LineSumQuery {
  entityIds?: readonly string[];
  accountIds?: readonly string[];
  fromDate?: string;
  toDate?: string;
  /** Include only entries with these statuses; default ['posted']. */
  statuses?: readonly string[];
  /** Leave out entries of these types (period activity excludes year-end closing entries). */
  excludeEntryTypes?: readonly string[];
  groupBy: readonly ('account_id' | 'entity_id' | 'department' | 'period' | 'counterparty_entity_id' | 'txn_currency')[];
}

export interface LineSum {
  account_id?: string;
  entity_id?: string;
  department?: string | null;
  period?: string;
  counterparty_entity_id?: string | null;
  txn_currency?: string | null;
  debit_minor: number;
  credit_minor: number;
  txn_amount_minor: number;
  line_count: number;
}

export interface AuditAppend {
  id: string;
  at: string;
  actor_type: 'user' | 'agent' | 'system' | 'policy';
  actor_id: string;
  actor_label: string;
  on_behalf_of: string | null;
  action: string;
  subject_type: string;
  subject_id: string;
  entity_id: string | null;
  summary: string;
  data: Record<string, unknown>;
  ip: string | null;
}

export interface AuditRecord extends AuditAppend {
  tenant_id: string;
  seq: number;
  prev_hash: string;
  hash: string;
}

/** Generic, table-typed transaction handle. `M` maps table names to row types. */
export interface Tx<M, I = M> {
  readonly tenantId: string;
  insert<T extends keyof M & keyof I & string>(table: T, row: I[T]): Promise<M[T]>;
  insertMany<T extends keyof M & keyof I & string>(table: T, rows: readonly I[T][]): Promise<number>;
  update<T extends keyof M & string>(table: T, id: string, patch: Partial<M[T]>): Promise<M[T]>;
  updateWhere<T extends keyof M & string>(table: T, where: Where<M[T]>, patch: Partial<M[T]>): Promise<number>;
  delete<T extends keyof M & string>(table: T, id: string): Promise<void>;
  get<T extends keyof M & string>(table: T, id: string): Promise<M[T] | undefined>;
  find<T extends keyof M & string>(table: T, where?: Where<M[T]>, opts?: FindOptions<M[T]>): Promise<M[T][]>;
  findOne<T extends keyof M & string>(table: T, where: Where<M[T]>): Promise<M[T] | undefined>;
  count<T extends keyof M & string>(table: T, where?: Where<M[T]>): Promise<number>;
  /** Posted-line aggregation joined to journal headers. */
  sumLines(q: LineSumQuery): Promise<LineSum[]>;
  /** Hash-chained append to the tenant audit log (serialised per tenant). */
  appendAudit(event: AuditAppend): Promise<AuditRecord>;
  /** Monotonic per-tenant counter, e.g. for JE numbers. */
  nextCounter(name: string): Promise<number>;
}

export interface Store<M, I = M> {
  readonly kind: 'postgres' | 'memory';
  /** Run `fn` in a serialisable unit of work scoped to one tenant. Rolls back on throw. */
  tx<R>(tenantId: string, fn: (tx: Tx<M, I>) => Promise<R>): Promise<R>;
  /** Cross-tenant system operations (login lookup, migrations bookkeeping). Use sparingly. */
  system<R>(fn: (sys: SystemTx<M>) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export interface SystemTx<M> {
  findGlobal<T extends keyof M & string>(table: T, where: Where<M[T]>, opts?: FindOptions<M[T]>): Promise<M[T][]>;
  insertGlobal<T extends keyof M & string>(table: T, row: Partial<M[T]>): Promise<M[T]>;
  updateGlobal<T extends keyof M & string>(table: T, id: string, patch: Partial<M[T]>): Promise<M[T]>;
}

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}
