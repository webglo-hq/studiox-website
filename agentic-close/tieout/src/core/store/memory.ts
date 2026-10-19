/**
 * MemoryStore: an in-process relational store that emulates the Postgres schema closely enough to
 * run the whole product in a browser (static demo) and in fast unit tests.
 *
 * Emulated from the SQL (via generated table metadata): NOT NULL, defaults, enum CHECKs, PK,
 * single + composite UNIQUE (NULLs distinct), FOREIGN KEY existence, ON DELETE CASCADE/RESTRICT.
 * Emulated by hooks (mirroring the plpgsql triggers): see packs/accounting/store-hooks.ts and
 * core/store/core-hooks.ts. Transactions are serialised and rolled back via an undo log.
 */
import { deepClone } from '../util/json';
import { newId } from '../util/random';
import { sealAuditRecord } from '../audit/chain';
import { compareValues, isEquality, matches } from './where';
import {
  StoreError,
  type AuditAppend,
  type AuditRecord,
  type ColumnMeta,
  type DirectoryKind,
  type FindOptions,
  type LineSum,
  type LineSumQuery,
  type Store,
  type TableMeta,
  type TableMetaMap,
  type Tx,
  type Where,
} from './types';

type Row = Record<string, unknown>;

export interface HookReader {
  get(table: string, id: string): Row | undefined;
  find(table: string, where: Record<string, unknown>): Row[];
}

export interface MemoryHooks {
  beforeInsert?: Record<string, (row: Row, db: HookReader) => void>;
  beforeUpdate?: Record<string, (oldRow: Row, newRow: Row, db: HookReader) => void>;
  beforeDelete?: Record<string, (row: Row, db: HookReader) => void>;
}

interface TableState {
  meta: TableMeta;
  colByName: Map<string, ColumnMeta>;
  rows: Map<string, Row>;
  /** column -> value -> ids (for FK/hot columns) */
  indexes: Map<string, Map<unknown, Set<string>>>;
  /** unique constraint key -> tuple -> id */
  uniques: Map<string, Map<string, string>>;
}

type Undo = () => void;

export interface MemoryStoreOptions {
  meta: TableMetaMap;
  idPrefix: Record<string, string>;
  hooks?: MemoryHooks[];
  /** extra columns to index for equality lookups */
  indexHints?: Record<string, string[]>;
  now?: () => string;
}

export class MemoryStore<M, I = M> implements Store<M, I> {
  readonly kind = 'memory' as const;
  private readonly tables = new Map<string, TableState>();
  private readonly hooks: MemoryHooks[];
  private readonly idPrefix: Record<string, string>;
  private readonly referencedBy = new Map<string, { table: string; column: string; onDelete: 'cascade' | 'restrict' }[]>();
  private queue: Promise<unknown> = Promise.resolve();
  private undo: Undo[] | null = null;
  private readonly now: () => string;

  constructor(opts: MemoryStoreOptions) {
    this.hooks = opts.hooks ?? [];
    this.idPrefix = opts.idPrefix;
    this.now = opts.now ?? (() => new Date().toISOString());
    for (const meta of Object.values(opts.meta)) {
      const colByName = new Map(meta.columns.map((c) => [c.name, c] as const));
      const indexCols = new Set<string>(opts.indexHints?.[meta.name] ?? []);
      for (const c of meta.columns) {
        if (c.references) indexCols.add(c.name);
        if (c.references) {
          const list = this.referencedBy.get(c.references.table) ?? [];
          list.push({ table: meta.name, column: c.name, onDelete: c.references.onDelete });
          this.referencedBy.set(c.references.table, list);
        }
      }
      if (meta.tenantScoped) indexCols.add('tenant_id');
      const uniques = new Map<string, Map<string, string>>();
      for (const u of this.uniqueSets(meta)) uniques.set(u.join(','), new Map());
      this.tables.set(meta.name, {
        meta,
        colByName,
        rows: new Map(),
        indexes: new Map([...indexCols].map((c) => [c, new Map()] as const)),
        uniques,
      });
    }
  }

  private uniqueSets(meta: TableMeta): string[][] {
    const sets: string[][] = meta.uniques.map((u) => [...u]);
    for (const c of meta.columns) if (c.unique && !c.primaryKey) sets.push([c.name]);
    return sets;
  }

  private table(name: string): TableState {
    const t = this.tables.get(name);
    if (!t) throw new StoreError('42P01', `relation "${name}" does not exist`);
    return t;
  }

  // ------------------------------------------------------------- tx plumbing
  async tx<R>(tenantId: string, fn: (tx: Tx<M, I>) => Promise<R>): Promise<R> {
    return this.serialise(async () => {
      this.undo = [];
      try {
        const result = await fn(this.makeTx(tenantId));
        this.undo = null;
        return result;
      } catch (e) {
        const undo = this.undo ?? [];
        this.undo = null;
        for (let i = undo.length - 1; i >= 0; i--) undo[i]!();
        throw e;
      }
    });
  }

  async tenantOf(kind: DirectoryKind, key: string): Promise<string | null> {
    // the in-memory store has no row-level security; the lookup reads the keyed table directly
    const [table, column] = kind === 'user_email' ? ['users', 'email'] : kind === 'session' ? ['sessions', 'id'] : ['api_tokens', 'token_hash'];
    const row = this.findRows(table, { [column]: key } as Where<Row>, { limit: 1 }, null)[0];
    return row ? (row.tenant_id as string) : null;
  }

  private serialise<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  private makeTx(tenantId: string): Tx<M, I> {
    return {
      tenantId,
      insert: async (table, row) => this.insertRow(table, row as Row, tenantId) as never,
      insertMany: async (table, rows) => {
        for (const r of rows) this.insertRow(table, r as Row, tenantId);
        return rows.length;
      },
      update: async (table, id, patch) => this.updateRow(table, id, patch as Row, tenantId) as never,
      updateWhere: async (table, where, patch) => {
        const rows = this.findRows(table, where as Where<Row>, undefined, tenantId);
        for (const r of rows) this.updateRow(table, r.id as string, patch as Row, tenantId);
        return rows.length;
      },
      delete: async (table, id) => this.deleteRow(table, id, tenantId),
      get: async (table, id) => {
        const r = this.table(table).rows.get(id);
        if (!r || !this.visible(table, r, tenantId)) return undefined;
        return this.out(table, r) as never;
      },
      find: async (table, where, opts) => this.findRows(table, where as Where<Row>, opts as FindOptions<Row>, tenantId) as never,
      findOne: async (table, where) => this.findRows(table, where as Where<Row>, { limit: 1 }, tenantId)[0] as never,
      count: async (table, where) => this.findRows(table, where as Where<Row>, undefined, tenantId, false).length,
      sumLines: async (q) => this.sumLines(q, tenantId),
      appendAudit: async (e) => this.appendAudit(e, tenantId),
      nextCounter: async (name) => this.nextCounter(name, tenantId),
    };
  }

  private visible(table: string, row: Row, tenantId: string | null): boolean {
    if (tenantId === null) return true;
    const t = this.table(table);
    return !t.meta.tenantScoped || row.tenant_id === tenantId;
  }

  private out(table: string, row: Row): Row {
    const t = this.table(table);
    const copy: Row = { ...row };
    for (const c of t.meta.columns) if (c.type === 'jsonb' && copy[c.name] !== null && typeof copy[c.name] === 'object') copy[c.name] = deepClone(copy[c.name]);
    return copy;
  }

  // ---------------------------------------------------------------- reading
  private reader(tenantId: string | null): HookReader {
    return {
      get: (table, id) => {
        const r = this.table(table).rows.get(id);
        return r && this.visible(table, r, tenantId) ? r : undefined;
      },
      find: (table, where) => this.findRows(table, where as Where<Row>, undefined, tenantId, false),
    };
  }

  private candidateIds(t: TableState, where: Where<Row> | undefined, tenantId: string | null): Iterable<string> {
    let best: Set<string> | undefined;
    if (where)
      for (const [col, cond] of Object.entries(where)) {
        const idx = t.indexes.get(col);
        if (!idx) continue;
        let ids: Set<string> | undefined;
        if (isEquality(cond)) ids = idx.get(cond) ?? new Set();
        else if (cond && typeof cond === 'object' && 'in' in cond) {
          ids = new Set();
          for (const v of cond.in) for (const id of idx.get(v) ?? []) ids.add(id);
        }
        if (ids && (!best || ids.size < best.size)) best = ids;
      }
    if (!best && tenantId !== null && t.meta.tenantScoped) best = t.indexes.get('tenant_id')?.get(tenantId) ?? new Set();
    return best ?? t.rows.keys();
  }

  private findRows(table: string, where: Where<Row> | undefined, opts: FindOptions<Row> | undefined, tenantId: string | null, clone = true): Row[] {
    const t = this.table(table);
    if (where) for (const col of Object.keys(where)) if (!t.colByName.has(col)) throw new StoreError('42703', `column "${col}" of "${table}" does not exist`);
    const out: Row[] = [];
    for (const id of this.candidateIds(t, where, tenantId)) {
      const r = t.rows.get(id);
      if (!r || !this.visible(table, r, tenantId)) continue;
      let ok = true;
      if (where)
        for (const [col, cond] of Object.entries(where))
          if (!matches(r[col], cond as never)) {
            ok = false;
            break;
          }
      if (ok) out.push(r);
    }
    if (opts?.orderBy?.length) {
      const order = opts.orderBy;
      out.sort((a, b) => {
        for (const [col, dir] of order) {
          const c = compareValues(a[col], b[col]);
          if (c !== 0) return dir === 'asc' ? c : -c;
        }
        return 0;
      });
    }
    const sliced = out.slice(opts?.offset ?? 0, opts?.limit !== undefined ? (opts.offset ?? 0) + opts.limit : undefined);
    return clone ? sliced.map((r) => this.out(table, r)) : sliced;
  }

  // ---------------------------------------------------------------- writing
  private coerce(t: TableState, row: Row): void {
    for (const c of t.meta.columns) {
      const v = row[c.name];
      if (v === undefined || v === null) continue;
      switch (c.type) {
        case 'bigint':
        case 'int':
        case 'numeric': {
          const n = typeof v === 'number' ? v : Number(v);
          if (!Number.isFinite(n)) throw new StoreError('22P02', `invalid number for ${t.meta.name}.${c.name}`);
          if (c.type !== 'numeric' && !Number.isInteger(n)) throw new StoreError('22P02', `${t.meta.name}.${c.name} must be an integer`);
          row[c.name] = n;
          break;
        }
        case 'boolean':
          if (typeof v !== 'boolean') throw new StoreError('22P02', `invalid boolean for ${t.meta.name}.${c.name}`);
          break;
        case 'date':
          if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new StoreError('22007', `invalid date for ${t.meta.name}.${c.name}: ${String(v)}`);
          break;
        case 'timestamptz':
          if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new StoreError('22007', `invalid timestamp for ${t.meta.name}.${c.name}`);
          row[c.name] = new Date(v).toISOString();
          break;
        case 'text':
          if (typeof v !== 'string') throw new StoreError('22P02', `${t.meta.name}.${c.name} must be text`);
          break;
        case 'jsonb':
          row[c.name] = deepClone(v);
          break;
      }
    }
  }

  private checkRow(t: TableState, row: Row, changed: Set<string> | null, tenantId: string | null): void {
    for (const c of t.meta.columns) {
      if (changed && !changed.has(c.name)) continue;
      const v = row[c.name];
      if ((v === null || v === undefined) && !c.nullable)
        throw new StoreError('23502', `null value in column "${c.name}" of relation "${t.meta.name}" violates not-null constraint`);
      if (v !== null && v !== undefined && c.enumValues && !c.enumValues.includes(v as string))
        throw new StoreError('23514', `new row for relation "${t.meta.name}" violates check constraint on "${c.name}" (${String(v)})`);
      if (v !== null && v !== undefined && c.references) {
        const target = this.table(c.references.table).rows.get(v as string);
        if (!target || (tenantId !== null && this.table(c.references.table).meta.tenantScoped && target.tenant_id !== row.tenant_id))
          throw new StoreError('23503', `insert or update on table "${t.meta.name}" violates foreign key on "${c.name}" -> ${c.references.table}(${String(v)})`);
      }
    }
  }

  private uniqueKey(row: Row, cols: string[]): string | null {
    const parts: unknown[] = [];
    for (const c of cols) {
      const v = row[c];
      if (v === null || v === undefined) return null; // NULLs are distinct
      parts.push(v);
    }
    return JSON.stringify(parts);
  }

  private indexAdd(t: TableState, row: Row): void {
    for (const [col, idx] of t.indexes) {
      const v = row[col];
      if (v === undefined) continue;
      let set = idx.get(v);
      if (!set) idx.set(v, (set = new Set()));
      set.add(row.id as string);
    }
    for (const [key, map] of t.uniques) {
      const k = this.uniqueKey(row, key.split(','));
      if (k !== null) map.set(k, row.id as string);
    }
  }

  private indexRemove(t: TableState, row: Row): void {
    for (const [col, idx] of t.indexes) idx.get(row[col])?.delete(row.id as string);
    for (const [key, map] of t.uniques) {
      const k = this.uniqueKey(row, key.split(','));
      if (k !== null && map.get(k) === row.id) map.delete(k);
    }
  }

  private checkUnique(t: TableState, row: Row): void {
    if (t.rows.has(row.id as string)) throw new StoreError('23505', `duplicate key value violates unique constraint "${t.meta.name}_pkey"`);
    for (const [key, map] of t.uniques) {
      const k = this.uniqueKey(row, key.split(','));
      if (k !== null) {
        const other = map.get(k);
        if (other !== undefined && other !== row.id)
          throw new StoreError('23505', `duplicate key value violates unique constraint on ${t.meta.name}(${key})`);
      }
    }
  }

  private insertRow(table: string, input: Row, tenantId: string | null): Row {
    const t = this.table(table);
    for (const k of Object.keys(input)) if (!t.colByName.has(k)) throw new StoreError('42703', `column "${k}" of relation "${table}" does not exist`);
    const row: Row = { ...input };
    if (row.id === undefined) row.id = newId(this.idPrefix[table] ?? table.slice(0, 3));
    if (t.meta.tenantScoped && tenantId !== null) {
      if (row.tenant_id !== undefined && row.tenant_id !== tenantId) throw new StoreError('42501', 'cross-tenant write rejected');
      row.tenant_id = tenantId;
    }
    for (const c of t.meta.columns) {
      if (row[c.name] !== undefined) continue;
      if (c.default) row[c.name] = c.default.kind === 'now' ? this.now() : deepClone(c.default.value);
      else row[c.name] = null;
    }
    this.coerce(t, row);
    this.checkRow(t, row, null, tenantId);
    this.checkUnique(t, row);
    for (const h of this.hooks) h.beforeInsert?.[table]?.(row, this.reader(tenantId));
    t.rows.set(row.id as string, row);
    this.indexAdd(t, row);
    this.undo?.push(() => {
      this.indexRemove(t, row);
      t.rows.delete(row.id as string);
    });
    return this.out(table, row);
  }

  private updateRow(table: string, id: string, patch: Row, tenantId: string | null): Row {
    const t = this.table(table);
    const old = t.rows.get(id);
    if (!old || !this.visible(table, old, tenantId)) throw new StoreError('P0002', `${table} ${id} not found`);
    for (const k of Object.keys(patch)) if (!t.colByName.has(k)) throw new StoreError('42703', `column "${k}" of relation "${table}" does not exist`);
    if ('id' in patch && patch.id !== id) throw new StoreError('42501', 'primary key is immutable');
    if ('tenant_id' in patch && patch.tenant_id !== old.tenant_id) throw new StoreError('42501', 'tenant_id is immutable');
    const next: Row = { ...old };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
    this.coerce(t, next);
    this.checkRow(t, next, new Set(Object.keys(patch)), tenantId);
    this.indexRemove(t, old);
    try {
      this.checkUnique({ ...t, rows: new Map() } as TableState, next);
      for (const h of this.hooks) h.beforeUpdate?.[table]?.(old, next, this.reader(tenantId));
    } catch (e) {
      this.indexAdd(t, old);
      throw e;
    }
    t.rows.set(id, next);
    this.indexAdd(t, next);
    this.undo?.push(() => {
      this.indexRemove(t, next);
      t.rows.set(id, old);
      this.indexAdd(t, old);
    });
    return this.out(table, next);
  }

  private deleteRow(table: string, id: string, tenantId: string | null): void {
    const t = this.table(table);
    const row = t.rows.get(id);
    if (!row || !this.visible(table, row, tenantId)) throw new StoreError('P0002', `${table} ${id} not found`);
    for (const h of this.hooks) h.beforeDelete?.[table]?.(row, this.reader(tenantId));
    for (const ref of this.referencedBy.get(table) ?? []) {
      const child = this.table(ref.table);
      const ids = [...(child.indexes.get(ref.column)?.get(id) ?? [])];
      if (!ids.length) continue;
      if (ref.onDelete === 'restrict')
        throw new StoreError('23503', `update or delete on table "${table}" violates foreign key constraint on table "${ref.table}"`);
      for (const cid of ids) this.deleteRow(ref.table, cid, tenantId);
    }
    this.indexRemove(t, row);
    t.rows.delete(id);
    this.undo?.push(() => {
      t.rows.set(id, row);
      this.indexAdd(t, row);
    });
  }

  // ------------------------------------------------------------ specialised
  private sumLines(q: LineSumQuery, tenantId: string): LineSum[] {
    const je = this.table('journal_entries');
    const jl = this.table('journal_lines');
    const statuses = new Set(q.statuses ?? ['posted']);
    const excluded = new Set(q.excludeEntryTypes ?? []);
    const entitySet = q.entityIds ? new Set(q.entityIds) : null;
    const accountSet = q.accountIds ? new Set(q.accountIds) : null;
    const groups = new Map<string, LineSum>();
    const headerIds: Iterable<string> = entitySet
      ? [...entitySet].flatMap((e) => [...(je.indexes.get('entity_id')?.get(e) ?? [])])
      : (je.indexes.get('tenant_id')?.get(tenantId) ?? []);
    for (const hid of headerIds) {
      const h = je.rows.get(hid);
      if (!h || h.tenant_id !== tenantId || !statuses.has(h.status as string) || excluded.has(h.entry_type as string)) continue;
      const date = h.posting_date as string;
      if (q.fromDate && date < q.fromDate) continue;
      if (q.toDate && date > q.toDate) continue;
      for (const lid of jl.indexes.get('journal_entry_id')?.get(hid) ?? []) {
        const l = jl.rows.get(lid)!;
        if (accountSet && !accountSet.has(l.account_id as string)) continue;
        const keyObj: Record<string, unknown> = {};
        for (const g of q.groupBy) {
          if (g === 'entity_id') keyObj.entity_id = h.entity_id;
          else if (g === 'period') keyObj.period = date.slice(0, 7);
          else keyObj[g] = l[g] ?? null;
        }
        const key = JSON.stringify(keyObj);
        let agg = groups.get(key);
        if (!agg) groups.set(key, (agg = { ...(keyObj as object), debit_minor: 0, credit_minor: 0, txn_amount_minor: 0, line_count: 0 }));
        agg.debit_minor += l.debit_minor as number;
        agg.credit_minor += l.credit_minor as number;
        agg.txn_amount_minor += (l.txn_amount_minor as number | null) ?? 0;
        agg.line_count += 1;
      }
    }
    return [...groups.values()];
  }

  private appendAudit(e: AuditAppend, tenantId: string): AuditRecord {
    const t = this.table('audit_log');
    let last: { seq: number; hash: string } | undefined;
    for (const id of t.indexes.get('tenant_id')?.get(tenantId) ?? []) {
      const r = t.rows.get(id)!;
      if (!last || (r.seq as number) > last.seq) last = { seq: r.seq as number, hash: r.hash as string };
    }
    const rec = sealAuditRecord(tenantId, last, e);
    this.insertRow('audit_log', rec as unknown as Row, tenantId);
    return rec;
  }

  private nextCounter(name: string, tenantId: string): number {
    const existing = this.findRows('counters', { name } as Where<Row>, undefined, tenantId, false)[0];
    if (!existing) {
      this.insertRow('counters', { name, value: 1 }, tenantId);
      return 1;
    }
    const value = (existing.value as number) + 1;
    this.updateRow('counters', existing.id as string, { value }, tenantId);
    return value;
  }

  /** Test/ops helper: raw row count across tenants. */
  /** Deep copy of every row (used to fork a seeded demo state cheaply: evals, demo reset). */
  snapshot(): Record<string, Row[]> {
    const out: Record<string, Row[]> = {};
    for (const [name, t] of this.tables) out[name] = [...t.rows.values()].map((r) => structuredClone(r));
    return out;
  }

  /** Replace all data with a snapshot taken from a store with the same schema. */
  async restore(snap: Record<string, Row[]>): Promise<void> {
    await this.serialise(async () => {
      for (const [name, t] of this.tables) {
        t.rows.clear();
        for (const idx of t.indexes.values()) idx.clear();
        for (const u of t.uniques.values()) u.clear();
        for (const r of snap[name] ?? []) {
          const row = structuredClone(r);
          t.rows.set(row.id as string, row);
          this.indexAdd(t, row);
        }
      }
    });
  }

  size(table: string): number {
    return this.table(table).rows.size;
  }

  /** Test-only escape hatch that bypasses hooks, used to simulate tampering. */
  unsafeMutate(table: string, id: string, patch: Row): void {
    const t = this.table(table);
    const r = t.rows.get(id);
    if (r) Object.assign(r, patch);
  }
}
