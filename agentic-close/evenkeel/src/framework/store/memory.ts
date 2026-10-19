import { isCondObject, matchesWhere, StoreError, type Db, type FindOptions, type MemoryReader, type NamedQuery, type Where } from './db';
import { materializeInsert, primaryKey, type Insert, type Row, type Schema, type TableName, type TableSpec } from './schema';

type AnyRow = Record<string, unknown>;

export interface HookContext<S extends Schema> {
  reader: MemoryReader<S>;
  /** Raw write used by emulated triggers (no hooks, but constraints still apply). */
  rawUpsert(table: TableName<S>, row: AnyRow): void;
  rawUpdate(table: TableName<S>, id: string, patch: AnyRow): void;
}

export interface TableHooks<S extends Schema> {
  beforeInsert?(row: AnyRow, ctx: HookContext<S>): void;
  beforeUpdate?(oldRow: AnyRow, newRow: AnyRow, ctx: HookContext<S>): void;
  afterUpdate?(oldRow: AnyRow, newRow: AnyRow, ctx: HookContext<S>): void;
  beforeDelete?(row: AnyRow, ctx: HookContext<S>): void;
}

/** Emulated triggers, keyed by table; supplied by the domain pack (mirrors its SQL triggers). */
export type MemoryHooks<S extends Schema> = { [T in TableName<S>]?: TableHooks<S> };

/** Commit-time checks (emulating DEFERRABLE INITIALLY DEFERRED constraint triggers). */
export type DeferredCheck<S extends Schema> = (reader: MemoryReader<S>, touched: ReadonlyMap<string, ReadonlySet<string>>) => void;

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    return prev.then(() => release);
  }
}

interface UndoEntry {
  table: string;
  id: string;
  before: AnyRow | undefined; // undefined = row did not exist
}

/**
 * In-memory implementation of the store port with Postgres-like semantics: NOT NULL, enum,
 * integer, primary/unique keys, foreign keys (incl. tenant consistency), CHECKs, append-only
 * tables, row hooks (triggers), deferred commit checks and atomic transactions with savepoints.
 */
export class MemoryStore<S extends Schema> implements Db<S> {
  readonly kind = 'memory' as const;
  private readonly data = new Map<string, Map<string, AnyRow>>();
  private readonly indexes = new Map<string, Map<string, Map<unknown, Set<string>>>>();
  private readonly uniques = new Map<string, { cols: string[]; map: Map<string, string> }[]>();
  private readonly mutex = new Mutex();
  private undo: UndoEntry[] | null = null;
  private touched = new Map<string, Set<string>>();
  private readonly reader: MemoryReader<S>;
  private readonly hookCtx: HookContext<S>;

  constructor(
    private readonly schema: S,
    private readonly hooks: MemoryHooks<S> = {},
    private readonly deferred: DeferredCheck<S>[] = [],
    private readonly sequenceTable = 'je_sequence',
  ) {
    for (const [name, spec] of Object.entries(schema) as [string, TableSpec][]) {
      this.data.set(name, new Map());
      const idx = new Map<string, Map<unknown, Set<string>>>();
      const cols = new Set<string>();
      for (const i of spec.indexes ?? []) if (i.length === 1) cols.add(i[0]!);
      for (const [c, col] of Object.entries(spec.columns)) if (col.spec.references) cols.add(c);
      if ('tenant_id' in spec.columns) cols.add('tenant_id');
      for (const c of cols) idx.set(c, new Map());
      this.indexes.set(name, idx);
      this.uniques.set(name, (spec.unique ?? []).map((u) => ({ cols: u, map: new Map() })));
    }
    this.reader = {
      all: (table) => [...this.tableData(table).values()] as never,
      byId: (table, id) => this.tableData(table).get(id) as never,
      byIndex: (table, column, value) => this.lookupIndex(table, column, value) as never,
    };
    this.hookCtx = {
      reader: this.reader,
      rawUpsert: (table, row) => this.rawUpsert(table, row),
      rawUpdate: (table, id, patch) => {
        const old = this.tableData(table).get(id);
        if (!old) throw new StoreError('P0002', `${table} ${id} not found`);
        this.writeRow(table, { ...old, ...patch }, old);
      },
    };
  }

  // ------------------------------------------------------------------ internals

  private spec(table: string): TableSpec {
    const s = this.schema[table];
    if (!s) throw new StoreError('42P01', `unknown table ${table}`);
    return s;
  }

  private tableData(table: string): Map<string, AnyRow> {
    const t = this.data.get(table);
    if (!t) throw new StoreError('42P01', `unknown table ${table}`);
    return t;
  }

  private lookupIndex(table: string, column: string, value: unknown): AnyRow[] {
    const idx = this.indexes.get(table)?.get(column);
    const rows = this.tableData(table);
    if (!idx) return [...rows.values()].filter((r) => r[column] === value);
    const ids = idx.get(value);
    if (!ids) return [];
    return [...ids].map((id) => rows.get(id)!).filter(Boolean);
  }

  private uniqueKey(row: AnyRow, cols: string[]): string | null {
    const parts: unknown[] = [];
    for (const c of cols) {
      if (row[c] === null || row[c] === undefined) return null; // NULLs are distinct
      parts.push(row[c]);
    }
    return JSON.stringify(parts);
  }

  private validate(table: string, row: AnyRow, old: AnyRow | undefined): void {
    const spec = this.spec(table);
    for (const [name, col] of Object.entries(spec.columns)) {
      const v = row[name];
      if (v === null || v === undefined) {
        if (!col.spec.nullable) throw new StoreError('23502', `null value in column "${name}" of relation "${table}" violates not-null constraint`, `${table}_${name}_not_null`);
        continue;
      }
      switch (col.spec.kind) {
        case 'int':
        case 'bigint':
          if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new StoreError('22P02', `invalid integer for ${table}.${name}: ${String(v)}`);
          break;
        case 'numeric':
          if (typeof v !== 'number' || !Number.isFinite(v)) throw new StoreError('22P02', `invalid numeric for ${table}.${name}`);
          break;
        case 'bool':
          if (typeof v !== 'boolean') throw new StoreError('22P02', `invalid boolean for ${table}.${name}`);
          break;
        case 'date':
          if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new StoreError('22007', `invalid date for ${table}.${name}: ${String(v)}`);
          break;
        case 'timestamptz':
          if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new StoreError('22007', `invalid timestamp for ${table}.${name}`);
          break;
        case 'uuid':
        case 'text':
          if (typeof v !== 'string') throw new StoreError('22P02', `invalid text for ${table}.${name}`);
          break;
        case 'json':
          break;
      }
      if (col.spec.enumValues && !col.spec.enumValues.includes(v as string)) {
        throw new StoreError('23514', `new row for relation "${table}" violates check constraint "${table}_${name}_check" (${String(v)})`, `${table}_${name}_check`);
      }
      const ref = col.spec.references;
      if (ref) {
        const target = this.tableData(ref.table).get(v as string);
        if (!target) throw new StoreError('23503', `insert or update on table "${table}" violates foreign key constraint "${table}_${name}_fkey"`, `${table}_${name}_fkey`);
        if ('tenant_id' in row && 'tenant_id' in target && row.tenant_id !== null && target.tenant_id !== null && row.tenant_id !== target.tenant_id) {
          throw new StoreError('23503', `cross-tenant reference ${table}.${name} → ${ref.table}`, `${table}_${name}_tenant_fkey`);
        }
      }
    }
    for (const chk of spec.checks ?? []) {
      if (!chk.test(row as never)) throw new StoreError('23514', `new row for relation "${table}" violates check constraint "${chk.name}": ${chk.message}`, chk.name);
    }
    const pk = primaryKey(spec);
    for (const u of this.uniques.get(table) ?? []) {
      const key = this.uniqueKey(row, u.cols);
      if (key === null) continue;
      const holder = u.map.get(key);
      if (holder !== undefined && holder !== (row[pk] as string)) {
        throw new StoreError('23505', `duplicate key value violates unique constraint "${table}_${u.cols.join('_')}_key"`, `${table}_${u.cols.join('_')}_key`);
      }
    }
    void old;
  }

  private indexRemove(table: string, row: AnyRow, id: string): void {
    for (const [col, map] of this.indexes.get(table) ?? []) map.get(row[col])?.delete(id);
    for (const u of this.uniques.get(table) ?? []) {
      const key = this.uniqueKey(row, u.cols);
      if (key !== null && u.map.get(key) === id) u.map.delete(key);
    }
  }

  private indexAdd(table: string, row: AnyRow, id: string): void {
    for (const [col, map] of this.indexes.get(table) ?? []) {
      let set = map.get(row[col]);
      if (!set) map.set(row[col], (set = new Set()));
      set.add(id);
    }
    for (const u of this.uniques.get(table) ?? []) {
      const key = this.uniqueKey(row, u.cols);
      if (key !== null) u.map.set(key, id);
    }
  }

  private writeRow(table: string, row: AnyRow, old: AnyRow | undefined): void {
    const pk = primaryKey(this.spec(table));
    const id = row[pk] as string;
    this.validate(table, row, old);
    const rows = this.tableData(table);
    if (this.undo) this.undo.push({ table, id, before: old ? { ...old } : undefined });
    if (old) this.indexRemove(table, old, id);
    rows.set(id, row);
    this.indexAdd(table, row, id);
    let set = this.touched.get(table);
    if (!set) this.touched.set(table, (set = new Set()));
    set.add(id);
  }

  private removeRow(table: string, id: string): void {
    const rows = this.tableData(table);
    const old = rows.get(id);
    if (!old) return;
    if (this.undo) this.undo.push({ table, id, before: { ...old } });
    this.indexRemove(table, old, id);
    rows.delete(id);
  }

  private rawUpsert(table: string, row: AnyRow): void {
    const pk = primaryKey(this.spec(table));
    const old = this.tableData(table).get(row[pk] as string);
    this.writeRow(table, old ? { ...old, ...row } : materializeInsert(this.spec(table), row), old);
  }

  private rollbackTo(mark: number): void {
    const undo = this.undo!;
    while (undo.length > mark) {
      const e = undo.pop()!;
      const rows = this.tableData(e.table);
      const cur = rows.get(e.id);
      if (cur) this.indexRemove(e.table, cur, e.id);
      if (e.before) {
        rows.set(e.id, e.before);
        this.indexAdd(e.table, e.before, e.id);
      } else {
        rows.delete(e.id);
      }
    }
  }

  private doInsert(table: string, input: AnyRow): AnyRow {
    const spec = this.spec(table);
    const row = materializeInsert(spec, input);
    const pk = primaryKey(spec);
    if (row[pk] === null) throw new StoreError('23502', `${table}.${pk} is required`);
    if (this.tableData(table).has(row[pk] as string)) throw new StoreError('23505', `duplicate key value violates unique constraint "${table}_pkey"`, `${table}_pkey`);
    this.hooks[table as TableName<S>]?.beforeInsert?.(row, this.hookCtx);
    this.writeRow(table, row, undefined);
    return { ...row };
  }

  private doUpdate(table: string, id: string, patch: AnyRow): AnyRow {
    const spec = this.spec(table);
    if (spec.appendOnly) throw new StoreError('P0001', `EK-AUDIT-APPEND-ONLY: ${table} is append-only`);
    const old = this.tableData(table).get(id);
    if (!old) throw new StoreError('P0002', `${table} ${id} not found`);
    for (const k of Object.keys(patch)) if (!(k in spec.columns)) throw new StoreError('42703', `unknown column ${table}.${k}`);
    const next = { ...old, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) next[k] = old[k];
    this.hooks[table as TableName<S>]?.beforeUpdate?.(old, next, this.hookCtx);
    this.writeRow(table, next, old);
    this.hooks[table as TableName<S>]?.afterUpdate?.(old, next, this.hookCtx);
    return { ...next };
  }

  private doFind(table: string, where?: AnyRow, opts?: FindOptions<AnyRow>): AnyRow[] {
    let candidates: Iterable<AnyRow> | undefined;
    if (where) {
      const idx = this.indexes.get(table)!;
      for (const [col, cond] of Object.entries(where)) {
        if (cond === undefined || !idx.has(col)) continue;
        if (!isCondObject(cond)) {
          candidates = this.lookupIndex(table, col, cond);
          break;
        }
        const c = cond as Record<string, unknown>;
        if (Array.isArray(c.in) && Object.keys(c).length === 1) {
          const out: AnyRow[] = [];
          for (const v of new Set(c.in)) out.push(...this.lookupIndex(table, col, v));
          candidates = out;
          break;
        }
      }
    }
    const rows = [...(candidates ?? this.tableData(table).values())].filter((r) => matchesWhere(r, where));
    if (opts?.orderBy?.length) {
      const order = opts.orderBy;
      rows.sort((a, b) => {
        for (const [col, dir] of order) {
          const av = a[col];
          const bv = b[col];
          if (av === bv) continue;
          if (av === null || av === undefined) return dir === 'asc' ? 1 : -1;
          if (bv === null || bv === undefined) return dir === 'asc' ? -1 : 1;
          const cmp = (av as number | string) < (bv as number | string) ? -1 : 1;
          return dir === 'asc' ? cmp : -cmp;
        }
        return 0;
      });
    }
    const off = opts?.offset ?? 0;
    const lim = opts?.limit;
    return (lim !== undefined ? rows.slice(off, off + lim) : rows.slice(off)).map((r) => ({ ...r }));
  }

  private runDeferred(): void {
    if (!this.deferred.length || this.touched.size === 0) return;
    for (const check of this.deferred) check(this.reader, this.touched);
  }

  // -------------------------------------------------------------- public API

  /** Root-level operations are serialised against transactions (statement-level atomicity). */
  private async atomic<R>(fn: () => R | Promise<R>): Promise<R> {
    const release = await this.lockWithTimeout();
    this.undo = [];
    this.touched = new Map();
    try {
      const out = await fn();
      this.runDeferred();
      return out;
    } catch (e) {
      this.rollbackTo(0);
      throw e;
    } finally {
      this.undo = null;
      this.touched = new Map();
      release();
    }
  }

  private async lockWithTimeout(): Promise<() => void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreError('40P01', 'memory store lock wait exceeded 15s — is the root store being used inside a transaction? Use the transaction handle.')), 15_000);
    });
    try {
      return await Promise.race([this.mutex.lock(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** @internal operations used by transaction handles (caller holds the lock). */
  _insert(table: string, row: AnyRow): AnyRow {
    return this.doInsert(table, row);
  }
  _update(table: string, id: string, patch: AnyRow): AnyRow {
    return this.doUpdate(table, id, patch);
  }
  _updateWhere(table: string, where: AnyRow, patch: AnyRow): number {
    const pk = primaryKey(this.spec(table));
    const rows = this.doFind(table, where);
    for (const r of rows) this.doUpdate(table, r[pk] as string, patch);
    return rows.length;
  }
  _delete(table: string, id: string): void {
    const spec = this.spec(table);
    if (spec.appendOnly) throw new StoreError('P0001', `EK-AUDIT-APPEND-ONLY: ${table} is append-only`);
    if (!spec.deletable) throw new StoreError('P0001', `EK-NO-DELETE: rows in ${table} cannot be deleted`);
    const row = this.tableData(table).get(id);
    if (!row) return;
    this.hooks[table as TableName<S>]?.beforeDelete?.(row, this.hookCtx);
    for (const [otherName, other] of Object.entries(this.schema) as [string, TableSpec][]) {
      for (const [col, c] of Object.entries(other.columns)) {
        if (c.spec.references?.table !== table) continue;
        const refs = this.lookupIndex(otherName, col, id);
        if (!refs.length) continue;
        if (c.spec.references.onDelete === 'cascade') for (const r of refs) this.removeRow(otherName, r[primaryKey(other)] as string);
        else if (c.spec.references.onDelete === 'set null') for (const r of refs) this.writeRow(otherName, { ...r, [col]: null }, r);
        else throw new StoreError('23503', `update or delete on table "${table}" violates foreign key constraint on "${otherName}"`, `${otherName}_${col}_fkey`);
      }
    }
    this.removeRow(table, id);
  }
  _find(table: string, where?: AnyRow, opts?: FindOptions<AnyRow>): AnyRow[] {
    return this.doFind(table, where, opts);
  }
  _savepoint(): number {
    return this.undo?.length ?? 0;
  }
  _rollbackTo(mark: number): void {
    this.rollbackTo(mark);
  }

  insert<T extends TableName<S>>(table: T, row: Insert<S, T>): Promise<Row<S, T>> {
    return this.atomic(() => this.doInsert(table, row as AnyRow) as Row<S, T>);
  }

  insertMany<T extends TableName<S>>(table: T, rows: Insert<S, T>[]): Promise<number> {
    return this.atomic(() => {
      for (const r of rows) this.doInsert(table, r as AnyRow);
      return rows.length;
    });
  }

  update<T extends TableName<S>>(table: T, id: string, patch: Partial<Row<S, T>>): Promise<Row<S, T>> {
    return this.atomic(() => this.doUpdate(table, id, patch as AnyRow) as Row<S, T>);
  }

  updateWhere<T extends TableName<S>>(table: T, where: Where<Row<S, T>>, patch: Partial<Row<S, T>>): Promise<number> {
    return this.atomic(() => this._updateWhere(table, where as AnyRow, patch as AnyRow));
  }

  async get<T extends TableName<S>>(table: T, id: string): Promise<Row<S, T> | null> {
    const r = this.tableData(table).get(id);
    return r ? ({ ...r } as Row<S, T>) : null;
  }

  async find<T extends TableName<S>>(table: T, where?: Where<Row<S, T>>, opts?: FindOptions<Row<S, T>>): Promise<Row<S, T>[]> {
    return this.doFind(table, where as AnyRow, opts as FindOptions<AnyRow>) as Row<S, T>[];
  }

  async findOne<T extends TableName<S>>(table: T, where: Where<Row<S, T>>, opts?: FindOptions<Row<S, T>>): Promise<Row<S, T> | null> {
    const rows = this.doFind(table, where as AnyRow, { ...(opts as FindOptions<AnyRow>), limit: 1 });
    return (rows[0] as Row<S, T>) ?? null;
  }

  async count<T extends TableName<S>>(table: T, where?: Where<Row<S, T>>): Promise<number> {
    if (!where) return this.tableData(table).size;
    return this.doFind(table, where as AnyRow).length;
  }

  delete<T extends TableName<S>>(table: T, id: string): Promise<void> {
    return this.atomic(() => this._delete(table, id));
  }

  async query<P, R>(q: NamedQuery<S, P, R>, params: P): Promise<R[]> {
    return q.memory(this.reader, params);
  }

  /** @internal */
  _nextSequence(tenantId: string, key: string): number {
    const table = this.sequenceTable;
    const id = `${tenantId}:${key}`;
    const cur = this.tableData(table).get(id);
    const value = cur ? (cur.next_value as number) : 1;
    this.rawUpsert(table, { id, tenant_id: tenantId, next_value: value + 1 });
    return value;
  }

  nextSequence(tenantId: string, key: string): Promise<number> {
    return this.atomic(() => this._nextSequence(tenantId, key));
  }

  tx<R>(fn: (db: Db<S>) => Promise<R>): Promise<R> {
    return this.atomic(() => fn(new MemoryTx<S>(this)));
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  /** Test/demo helper: number of rows per table. */
  stats(): Record<string, number> {
    return Object.fromEntries([...this.data.entries()].map(([k, v]) => [k, v.size]));
  }

  readerForTests(): MemoryReader<S> {
    return this.reader;
  }
}

/** Transaction-bound handle: operations join the open transaction; nested tx() = savepoint. */
class MemoryTx<S extends Schema> implements Db<S> {
  readonly kind = 'memory' as const;
  constructor(private readonly store: MemoryStore<S>) {}
  async insert<T extends TableName<S>>(table: T, row: Insert<S, T>): Promise<Row<S, T>> {
    return this.store._insert(table, row as AnyRow) as Row<S, T>;
  }
  async insertMany<T extends TableName<S>>(table: T, rows: Insert<S, T>[]): Promise<number> {
    for (const r of rows) this.store._insert(table, r as AnyRow);
    return rows.length;
  }
  async update<T extends TableName<S>>(table: T, id: string, patch: Partial<Row<S, T>>): Promise<Row<S, T>> {
    return this.store._update(table, id, patch as AnyRow) as Row<S, T>;
  }
  async updateWhere<T extends TableName<S>>(table: T, where: Where<Row<S, T>>, patch: Partial<Row<S, T>>): Promise<number> {
    return this.store._updateWhere(table, where as AnyRow, patch as AnyRow);
  }
  get<T extends TableName<S>>(table: T, id: string): Promise<Row<S, T> | null> {
    return this.store.get(table, id);
  }
  find<T extends TableName<S>>(table: T, where?: Where<Row<S, T>>, opts?: FindOptions<Row<S, T>>): Promise<Row<S, T>[]> {
    return this.store.find(table, where, opts);
  }
  findOne<T extends TableName<S>>(table: T, where: Where<Row<S, T>>, opts?: FindOptions<Row<S, T>>): Promise<Row<S, T> | null> {
    return this.store.findOne(table, where, opts);
  }
  count<T extends TableName<S>>(table: T, where?: Where<Row<S, T>>): Promise<number> {
    return this.store.count(table, where);
  }
  async delete<T extends TableName<S>>(table: T, id: string): Promise<void> {
    this.store._delete(table, id);
  }
  query<P, R>(q: NamedQuery<S, P, R>, params: P): Promise<R[]> {
    return this.store.query(q, params);
  }
  async nextSequence(tenantId: string, key: string): Promise<number> {
    return this.store._nextSequence(tenantId, key);
  }
  async tx<R>(fn: (db: Db<S>) => Promise<R>): Promise<R> {
    const mark = this.store._savepoint();
    try {
      return await fn(this);
    } catch (e) {
      this.store._rollbackTo(mark);
      throw e;
    }
  }
  async close(): Promise<void> {
    /* handle only */
  }
}
