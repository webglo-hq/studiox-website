import type { ColumnSpec, TableSpec } from './dsl';
import { normalizeUnique } from './dsl';
import {
  type Cond,
  type Db,
  DbConstraintError,
  type FindOptions,
  LINE_GROUP_KEYS,
  type LineSum,
  type LineSumsQuery,
  type Tx,
  type Where,
} from './db';
import { memoryGuards, MSG, type GuardContext, type TableGuard } from './invariants';
import { applyDefaults, validateColumns } from './rows';
import { schema, type Insert, type Row, type TableName, TABLE_NAMES } from './schema';

type AnyRow = Record<string, unknown>;

interface UniqueIndex {
  columns: string[];
  nullsNotDistinct: boolean;
  name: string;
  map: Map<string, string>;
}

interface ChildRef {
  table: TableName;
  column: string;
  onDelete: 'restrict' | 'cascade' | 'set null';
}

type UndoOp =
  | { op: 'insert'; table: TableName; id: string }
  | { op: 'update'; table: TableName; id: string; before: AnyRow }
  | { op: 'delete'; table: TableName; id: string; before: AnyRow };

function spec(table: TableName): TableSpec {
  return schema[table] as unknown as TableSpec;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !Object.isFrozen(value)) {
    for (const v of Object.values(value as object)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * In-memory implementation of the persistence port with Postgres-grade integrity: primary keys, unique
 * constraints (incl. NULLS NOT DISTINCT), foreign keys with restrict/cascade/set-null, enum and CHECK
 * constraints, append-only tables and the procedural invariants in invariants.ts. Transactions are atomic via
 * an undo log and serialized by a mutex. Stored rows are deep-frozen, so reads are zero-copy and cannot be
 * mutated by callers.
 */
export class MemoryStore {
  private readonly rows = new Map<TableName, Map<string, AnyRow>>();
  private readonly uniques = new Map<TableName, UniqueIndex[]>();
  private readonly secondary = new Map<TableName, Map<string, Map<string, Set<string>>>>();
  private readonly children = new Map<TableName, ChildRef[]>();
  private readonly guards: Partial<Record<TableName, TableGuard>>;
  private undo: UndoOp[] | null = null;
  readonly clock: () => string;

  constructor(opts: { clock?: () => string; guards?: Partial<Record<TableName, TableGuard>> } = {}) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.guards = opts.guards ?? memoryGuards;
    for (const name of TABLE_NAMES) {
      const s = spec(name);
      this.rows.set(name, new Map());
      const uniqueSpecs = [
        ...s.columnNames
          .filter((col) => (s.columns[col]!.spec as ColumnSpec).unique)
          .map((col) => ({ columns: [col], nullsNotDistinct: false })),
        ...(s.uniques ?? []).map(normalizeUnique).map((u) => ({ columns: u.columns, nullsNotDistinct: !!u.nullsNotDistinct })),
      ];
      this.uniques.set(
        name,
        uniqueSpecs.map((u) => ({ ...u, name: `${name}_${u.columns.join('_')}_key`, map: new Map() })),
      );
      const indexed = new Set<string>(['tenant_id']);
      for (const col of s.columnNames) if ((s.columns[col]!.spec as ColumnSpec).references) indexed.add(col);
      for (const idx of s.indexes ?? []) indexed.add(idx[0]!);
      const sec = new Map<string, Map<string, Set<string>>>();
      for (const col of indexed) if (col in s.columns) sec.set(col, new Map());
      this.secondary.set(name, sec);
    }
    for (const name of TABLE_NAMES) {
      const s = spec(name);
      for (const col of s.columnNames) {
        const ref = (s.columns[col]!.spec as ColumnSpec).references;
        if (ref) {
          const list = this.children.get(ref.table as TableName) ?? [];
          list.push({ table: name, column: col, onDelete: ref.onDelete });
          this.children.set(ref.table as TableName, list);
        }
      }
    }
  }

  // ------------------------------------------------------------------ transactions

  begin(): void {
    if (this.undo) throw new Error('MemoryStore: nested transaction');
    this.undo = [];
  }

  commit(): void {
    this.undo = null;
  }

  rollback(): void {
    const ops = this.undo ?? [];
    this.undo = null;
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i]!;
      const table = this.rows.get(op.table)!;
      if (op.op === 'insert') {
        const row = table.get(op.id);
        if (row) {
          this.unindex(op.table, row);
          table.delete(op.id);
        }
      } else if (op.op === 'update') {
        const current = table.get(op.id);
        if (current) this.unindex(op.table, current);
        table.set(op.id, op.before);
        this.index(op.table, op.before);
      } else {
        table.set(op.id, op.before);
        this.index(op.table, op.before);
      }
    }
  }

  // ------------------------------------------------------------------ indexes

  private uniqueKey(u: UniqueIndex, row: AnyRow): string | null {
    const values = u.columns.map((c) => row[c]);
    if (!u.nullsNotDistinct && values.some((v) => v === null || v === undefined)) return null;
    return JSON.stringify(values);
  }

  private index(table: TableName, row: AnyRow): void {
    for (const u of this.uniques.get(table)!) {
      const key = this.uniqueKey(u, row);
      if (key !== null) u.map.set(key, String(row.id));
    }
    for (const [col, map] of this.secondary.get(table)!) {
      const v = row[col];
      if (v === null || v === undefined) continue;
      const k = String(v);
      let set = map.get(k);
      if (!set) map.set(k, (set = new Set()));
      set.add(String(row.id));
    }
  }

  private unindex(table: TableName, row: AnyRow): void {
    for (const u of this.uniques.get(table)!) {
      const key = this.uniqueKey(u, row);
      if (key !== null && u.map.get(key) === row.id) u.map.delete(key);
    }
    for (const [col, map] of this.secondary.get(table)!) {
      const v = row[col];
      if (v === null || v === undefined) continue;
      map.get(String(v))?.delete(String(row.id));
    }
  }

  // ------------------------------------------------------------------ guard context

  readonly ctx: GuardContext = {
    get: <T extends TableName>(table: T, id: string) => (this.rows.get(table)!.get(id) as Row<T> | undefined) ?? null,
    where: <T extends TableName>(table: T, column: keyof Row<T> & string, value: string) => {
      const sec = this.secondary.get(table)!.get(column);
      const tableRows = this.rows.get(table)!;
      if (sec) {
        const ids = sec.get(value);
        if (!ids) return [];
        return Array.from(ids, (id) => tableRows.get(id)!) as Row<T>[];
      }
      return Array.from(tableRows.values()).filter((r) => String(r[column]) === value) as Row<T>[];
    },
  };

  // ------------------------------------------------------------------ writes

  private requireTx(): UndoOp[] {
    if (!this.undo) throw new Error('MemoryStore: writes require a transaction');
    return this.undo;
  }

  private checkUniques(table: TableName, row: AnyRow, selfId?: string): void {
    for (const u of this.uniques.get(table)!) {
      const key = this.uniqueKey(u, row);
      if (key === null) continue;
      const existing = u.map.get(key);
      if (existing && existing !== selfId) {
        throw new DbConstraintError('unique_violation', `duplicate value for ${table} (${u.columns.join(', ')})`, {
          table,
          constraint: u.name,
        });
      }
    }
  }

  private checkForeignKeys(table: TableName, row: AnyRow): void {
    const s = spec(table);
    for (const col of s.columnNames) {
      const ref = (s.columns[col]!.spec as ColumnSpec).references;
      const v = row[col];
      if (!ref || v === null || v === undefined) continue;
      if (!this.rows.get(ref.table as TableName)!.has(String(v))) {
        throw new DbConstraintError('foreign_key_violation', `${table}.${col} references missing ${ref.table} ${String(v)}`, {
          table,
          constraint: `${table}_${col}_fkey`,
        });
      }
    }
  }

  insert(table: TableName, input: AnyRow): AnyRow {
    const undo = this.requireTx();
    const s = spec(table);
    const row = applyDefaults(s, input, this.clock());
    validateColumns(s, row);
    if (this.rows.get(table)!.has(String(row.id))) {
      throw new DbConstraintError('unique_violation', `duplicate primary key for ${table}`, { table, constraint: `${table}_pkey` });
    }
    this.checkUniques(table, row);
    this.checkForeignKeys(table, row);
    this.guards[table]?.beforeInsert?.(row, this.ctx);
    const frozen = deepFreeze(row);
    this.rows.get(table)!.set(String(row.id), frozen);
    this.index(table, frozen);
    undo.push({ op: 'insert', table, id: String(row.id) });
    return frozen;
  }

  update(table: TableName, id: string, patch: AnyRow): AnyRow {
    const undo = this.requireTx();
    const s = spec(table);
    const before = this.rows.get(table)!.get(id);
    if (!before) throw new DbConstraintError('invalid_input', `${table} ${id} does not exist`, { table });
    if (s.appendOnly) throw new DbConstraintError('immutable_row', MSG.appendOnly, { table, constraint: `${table}_append_only` });
    for (const key of Object.keys(patch)) {
      if (!(key in s.columns)) throw new DbConstraintError('invalid_input', `${table} has no column "${key}"`, { table });
    }
    const next: AnyRow = { ...before, ...patch, id };
    if ('updated_at' in s.columns && patch.updated_at === undefined) next.updated_at = this.clock();
    validateColumns(s, next);
    this.checkUniques(table, next, id);
    this.checkForeignKeys(table, next);
    this.guards[table]?.beforeUpdate?.(before, next, this.ctx);
    this.unindex(table, before);
    const frozen = deepFreeze(next);
    this.rows.get(table)!.set(id, frozen);
    this.index(table, frozen);
    undo.push({ op: 'update', table, id, before });
    return frozen;
  }

  delete(table: TableName, id: string): void {
    const undo = this.requireTx();
    const s = spec(table);
    const row = this.rows.get(table)!.get(id);
    if (!row) return;
    if (s.appendOnly) throw new DbConstraintError('immutable_row', MSG.appendOnly, { table, constraint: `${table}_append_only` });
    this.guards[table]?.beforeDelete?.(row, this.ctx);
    for (const child of this.children.get(table) ?? []) {
      const dependents = this.ctx.where(child.table, child.column as never, id);
      if (dependents.length === 0) continue;
      if (child.onDelete === 'restrict') {
        throw new DbConstraintError('foreign_key_violation', `${table} ${id} is still referenced by ${child.table}.${child.column}`, {
          table: child.table,
          constraint: `${child.table}_${child.column}_fkey`,
        });
      }
      for (const dep of dependents) {
        if (child.onDelete === 'cascade') this.delete(child.table, String((dep as AnyRow).id));
        else this.update(child.table, String((dep as AnyRow).id), { [child.column]: null });
      }
    }
    this.unindex(table, row);
    this.rows.get(table)!.delete(id);
    undo.push({ op: 'delete', table, id, before: row });
  }

  // ------------------------------------------------------------------ reads

  get(table: TableName, id: string): AnyRow | null {
    const row = this.rows.get(table)!.get(id) ?? null;
    return row ? this.out(table, row) : null;
  }

  private out(table: TableName, row: AnyRow): AnyRow {
    if (table === 'source_documents' && row.content instanceof Uint8Array) return { ...row, content: new Uint8Array(row.content) };
    return row;
  }

  find(table: TableName, where: AnyRow = {}, opts: FindOptions<TableName> = {}): AnyRow[] {
    const s = spec(table);
    for (const key of Object.keys(where)) {
      if (!(key in s.columns)) throw new DbConstraintError('invalid_input', `${table} has no column "${key}"`, { table });
    }
    const candidates = this.candidates(table, where);
    let result: AnyRow[] = [];
    for (const row of candidates) if (matches(row, where)) result.push(row);
    if (opts.orderBy?.length) {
      for (const [col] of opts.orderBy) {
        if (!(col in s.columns)) throw new DbConstraintError('invalid_input', `${table} has no column "${col}"`, { table });
      }
      result.sort((a, b) => {
        for (const [col, dir] of opts.orderBy!) {
          const c = compareSql(a[col], b[col], dir);
          if (c !== 0) return c;
        }
        return 0;
      });
    }
    if (opts.offset) result = result.slice(opts.offset);
    if (opts.limit !== undefined) result = result.slice(0, opts.limit);
    return result.map((r) => this.out(table, r));
  }

  private candidates(table: TableName, where: AnyRow): Iterable<AnyRow> {
    const tableRows = this.rows.get(table)!;
    const sec = this.secondary.get(table)!;
    let best: Set<string> | null = null;
    for (const [col, cond] of Object.entries(where)) {
      const index = sec.get(col);
      if (!index || cond === null || cond === undefined) continue;
      let ids: Set<string> | null = null;
      if (typeof cond !== 'object') ids = index.get(String(cond)) ?? new Set();
      else if ('in' in (cond as object)) {
        ids = new Set();
        for (const v of (cond as { in: unknown[] }).in) for (const id of index.get(String(v)) ?? []) ids.add(id);
      }
      if (ids && (!best || ids.size < best.size)) best = ids;
    }
    if (!best) return tableRows.values();
    const out: AnyRow[] = [];
    for (const id of best) {
      const r = tableRows.get(id);
      if (r) out.push(r);
    }
    return out;
  }

  sumLines(q: LineSumsQuery): LineSum[] {
    for (const k of q.groupBy) if (!LINE_GROUP_KEYS.includes(k)) throw new DbConstraintError('invalid_input', `cannot group by ${k}`);
    const statuses = new Set(q.statuses ?? ['posted']);
    const where: AnyRow = { tenant_id: q.tenantId };
    if (q.periodIds) where.period_id = { in: q.periodIds };
    if (q.entityIds) where.entity_id = { in: q.entityIds };
    if (q.accountIds) where.account_id = { in: q.accountIds };
    if (q.dateFrom && q.dateTo) where.entry_date = { between: [q.dateFrom, q.dateTo] };
    else if (q.dateFrom) where.entry_date = { gte: q.dateFrom };
    else if (q.dateTo) where.entry_date = { lte: q.dateTo };
    const groups = new Map<string, LineSum>();
    const entries = this.rows.get('journal_entries')!;
    for (const line of this.candidates('journal_lines', where)) {
      if (!matches(line, where)) continue;
      const je = entries.get(String(line.journal_entry_id));
      if (!je || !statuses.has(je.status as 'posted')) continue;
      const keyObj: Partial<Record<string, string | null>> = {};
      for (const k of q.groupBy) keyObj[k] = (line[k] as string | null) ?? null;
      const key = JSON.stringify(q.groupBy.map((k) => keyObj[k]));
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key: keyObj, debit_minor: 0, credit_minor: 0, line_count: 0 }));
      g.debit_minor += Number(line.debit_minor);
      g.credit_minor += Number(line.credit_minor);
      g.line_count += 1;
    }
    return Array.from(groups.values());
  }

  /** Row counts per table (diagnostics, seed stats). */
  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, map] of this.rows) out[name] = map.size;
    return out;
  }
}

function isCondObject(v: unknown): v is Exclude<Cond<unknown>, string | number | boolean | null> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

function matches(row: AnyRow, where: AnyRow): boolean {
  for (const [col, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const v = row[col];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
      continue;
    }
    if (!isCondObject(cond)) {
      if (v !== cond) return false;
      continue;
    }
    const c = cond as Record<string, unknown>;
    if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
    if ('notIn' in c && (v === null || (c.notIn as unknown[]).includes(v))) return false;
    // IS DISTINCT FROM semantics: null equals null.
    if ('ne' in c && (v ?? null) === (c.ne ?? null)) return false;
    if ('gt' in c && !(v !== null && (v as number) > (c.gt as number))) return false;
    if ('gte' in c && !(v !== null && (v as number) >= (c.gte as number))) return false;
    if ('lt' in c && !(v !== null && (v as number) < (c.lt as number))) return false;
    if ('lte' in c && !(v !== null && (v as number) <= (c.lte as number))) return false;
    if ('between' in c) {
      const [lo, hi] = c.between as [number, number];
      if (v === null || (v as number) < lo || (v as number) > hi) return false;
    }
    if ('contains' in c) {
      if (typeof v !== 'string' || !v.toLowerCase().includes(String(c.contains).toLowerCase())) return false;
    }
  }
  return true;
}

/** Postgres ordering: NULLS LAST for ASC, NULLS FIRST for DESC. */
function compareSql(a: unknown, b: unknown, dir: 'asc' | 'desc'): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) {
    if (an && bn) return 0;
    const nullsLast = an ? 1 : -1;
    return dir === 'asc' ? nullsLast : -nullsLast;
  }
  const c = (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  return dir === 'asc' ? c : -c;
}

class MemoryTx implements Tx {
  readonly kind = 'memory' as const;
  constructor(
    private readonly store: MemoryStore,
    private readonly readOnly: boolean,
  ) {}

  private writable(): void {
    if (this.readOnly) throw new DbConstraintError('invalid_input', 'write attempted in a read-only unit of work');
  }

  async insert<T extends TableName>(table: T, row: Insert<T>): Promise<Row<T>> {
    this.writable();
    return this.store.insert(table, row as AnyRow) as Row<T>;
  }

  async insertMany<T extends TableName>(table: T, rows: ReadonlyArray<Insert<T>>): Promise<Row<T>[]> {
    this.writable();
    return rows.map((r) => this.store.insert(table, r as AnyRow) as Row<T>);
  }

  async update<T extends TableName>(table: T, id: string, patch: Partial<Row<T>>): Promise<Row<T>> {
    this.writable();
    return this.store.update(table, id, patch as AnyRow) as Row<T>;
  }

  async delete<T extends TableName>(table: T, id: string): Promise<void> {
    this.writable();
    this.store.delete(table, id);
  }

  async get<T extends TableName>(table: T, id: string): Promise<Row<T> | null> {
    return this.store.get(table, id) as Row<T> | null;
  }

  async find<T extends TableName>(table: T, where?: Where<T>, opts?: FindOptions<T>): Promise<Row<T>[]> {
    return this.store.find(table, (where ?? {}) as AnyRow, (opts ?? {}) as FindOptions<TableName>) as Row<T>[];
  }

  async findOne<T extends TableName>(table: T, where: Where<T>): Promise<Row<T> | null> {
    return (this.store.find(table, where as AnyRow, { limit: 1 })[0] as Row<T> | undefined) ?? null;
  }

  async count<T extends TableName>(table: T, where?: Where<T>): Promise<number> {
    return this.store.find(table, (where ?? {}) as AnyRow).length;
  }

  async sumLines(query: LineSumsQuery): Promise<LineSum[]> {
    return this.store.sumLines(query);
  }

  async lockAuditChain(): Promise<void> {
    // Transactions are already serialized by the MemoryDb mutex.
  }
}

export class MemoryDb implements Db {
  readonly kind = 'memory' as const;
  readonly label = 'in-memory (TypeScript constraint engine)';
  readonly store: MemoryStore;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: { clock?: () => string } = {}) {
    this.store = new MemoryStore(opts);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.store.begin();
      try {
        const result = await fn(new MemoryTx(this.store, false));
        this.store.commit();
        return result;
      } catch (error) {
        this.store.rollback();
        throw error;
      }
    });
  }

  read<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.exclusive(() => fn(new MemoryTx(this.store, true)));
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
