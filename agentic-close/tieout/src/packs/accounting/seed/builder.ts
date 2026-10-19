/**
 * In-memory builder for seed rows. Accumulates rows per table with deterministic ids, keeps the
 * ledger balanced by construction (every JE is asserted balanced before it is accepted), and
 * inserts everything in dependency order at the end.
 */
import { SeededRandom } from '../../../core/util/random';
import { periodKeyOf } from '../../../core/util/time';
import type { Db, DbInsertRow, DbInserts, TableName } from '../../../schema';

export interface LineSpec {
  account: string;
  debit?: number;
  credit?: number;
  department?: string | null;
  location?: string | null;
  product_class?: string | null;
  project?: string | null;
  memo?: string | null;
  txn_currency?: string | null;
  txn_amount_minor?: number | null;
  fx_rate?: number | null;
  counterparty_entity_id?: string | null;
  source_line_ref?: string | null;
}

export interface JeSpec {
  entity: string;
  date: string;
  type: DbInsertRow<'journal_entries'>['entry_type'];
  memo: string;
  source: DbInsertRow<'journal_entries'>['source'];
  sourceRef?: string;
  preparedBy: string;
  approvedBy: string;
  route: 'human' | 'policy' | 'system';
  lines: LineSpec[];
  autoReverseOn?: string | null;
  reversesJeId?: string | null;
  counterpartyEntityId?: string | null;
  sourceDocumentId?: string | null;
}

export const INSERT_ORDER: TableName[] = [
  'tenants', 'currencies', 'permissions', 'roles', 'role_permissions', 'users', 'user_roles', 'sod_rules',
  'entities', 'fs_line_items', 'accounts', 'dimensions', 'dimension_values', 'periods', 'fx_rates',
  'connectors', 'source_documents', 'import_batches',
  'vendors', 'customers', 'bank_accounts', 'cards', 'bank_statements',
  'journal_entries', 'journal_lines',
  'purchase_orders', 'goods_receipts', 'bills', 'bill_lines', 'payments', 'payment_applications',
  'invoices', 'invoice_lines', 'receipts', 'receipt_applications', 'bank_transactions', 'card_transactions',
  'fixed_assets', 'depreciation_lines', 'prepaid_schedules', 'prepaid_lines', 'payroll_runs',
  'budgets', 'budget_lines',
  'skills', 'skill_versions', 'skill_policies',
  'close_templates', 'close_template_tasks', 'close_periods', 'close_tasks', 'close_task_dependencies',
  'counters',
];

export class SeedBuilder {
  readonly rng: SeededRandom;
  readonly tenantId: string;
  readonly rows = new Map<TableName, Record<string, unknown>[]>();
  readonly accountId = new Map<string, string>();
  readonly entityId = new Map<string, string>();
  readonly entityCurrency = new Map<string, string>();
  readonly periodId = new Map<string, string>();
  readonly userId = new Map<string, string>();
  private readonly jeCounters = new Map<string, number>();
  readonly postedJeIds: string[] = [];
  readonly jeNumbers = new Map<string, string>();

  constructor(seed: number, tenantId: string) {
    this.rng = new SeededRandom(seed);
    this.tenantId = tenantId;
  }

  id(prefix: string): string {
    return this.rng.id(prefix);
  }

  add<T extends TableName>(table: T, row: DbInserts[T]): DbInserts[T] & { id: string } {
    const r = row as Record<string, unknown>;
    if (!r.id) r.id = this.id(prefixOf(table));
    let list = this.rows.get(table);
    if (!list) this.rows.set(table, (list = []));
    list.push(r);
    return r as DbInserts[T] & { id: string };
  }

  list<T extends TableName>(table: T): (DbInserts[T] & { id: string })[] {
    return (this.rows.get(table) ?? []) as (DbInserts[T] & { id: string })[];
  }

  acct(code: string): string {
    const id = this.accountId.get(code);
    if (!id) throw new Error(`seed: unknown account ${code}`);
    return id;
  }

  ent(code: string): string {
    const id = this.entityId.get(code);
    if (!id) throw new Error(`seed: unknown entity ${code}`);
    return id;
  }

  period(entityCode: string, key: string): string {
    const id = this.periodId.get(`${entityCode}:${key}`);
    if (!id) throw new Error(`seed: no period ${key} for ${entityCode}`);
    return id;
  }

  user(key: string): string {
    const id = this.userId.get(key);
    if (!id) throw new Error(`seed: unknown user ${key}`);
    return id;
  }

  /** Add a posted journal entry. Asserts double-entry balance at build time. */
  je(spec: JeSpec): string {
    const lines = spec.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
    const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    if (dr !== cr) throw new Error(`seed: unbalanced JE "${spec.memo}" on ${spec.date}: ${dr} vs ${cr}`);
    if (lines.length < 2) throw new Error(`seed: JE "${spec.memo}" needs two lines`);
    for (const l of lines) {
      if ((l.debit ?? 0) > 0 && (l.credit ?? 0) > 0) throw new Error(`seed: two-sided line in "${spec.memo}"`);
      if (!Number.isInteger(l.debit ?? 0) || !Number.isInteger(l.credit ?? 0)) throw new Error(`seed: non-integer amount in "${spec.memo}"`);
    }
    const pk = periodKeyOf(spec.date);
    const short = spec.entity.replace(/^[A-Z]+-/, '');
    const ck = `je:${short}:${pk}`;
    const n = (this.jeCounters.get(ck) ?? 0) + 1;
    this.jeCounters.set(ck, n);
    const at = `${spec.date}T17:00:00.000Z`;
    const je = this.add('journal_entries', {
      entity_id: this.ent(spec.entity),
      period_id: this.period(spec.entity, pk),
      je_number: `JE-${pk}-${short}-${String(n).padStart(4, '0')}`,
      entry_type: spec.type,
      // inserted awaiting approval so lines can be attached (trigger AX-IM-01), then flipped to posted in flush()
      status: 'pending_approval',
      posting_date: spec.date,
      memo: spec.memo,
      source: spec.source,
      source_ref: spec.sourceRef ?? null,
      source_document_id: spec.sourceDocumentId ?? null,
      currency: this.entityCurrency.get(spec.entity)!,
      total_minor: dr,
      prepared_by: spec.preparedBy,
      approved_by: spec.approvedBy,
      approval_route: spec.route,
      posted_by: spec.route === 'human' ? spec.approvedBy : 'system',
      posted_at: at,
      reverses_je_id: spec.reversesJeId ?? null,
      auto_reverse_on: spec.autoReverseOn ?? null,
      counterparty_entity_id: spec.counterpartyEntityId ?? null,
      created_at: at,
      updated_at: at,
    });
    lines.forEach((l, i) =>
      this.add('journal_lines', {
        journal_entry_id: je.id,
        line_no: i + 1,
        account_id: this.acct(l.account),
        debit_minor: l.debit ?? 0,
        credit_minor: l.credit ?? 0,
        memo: l.memo ?? null,
        department: l.department ?? null,
        location: l.location ?? null,
        product_class: l.product_class ?? null,
        project: l.project ?? null,
        txn_currency: l.txn_currency ?? null,
        txn_amount_minor: l.txn_amount_minor ?? null,
        fx_rate: l.fx_rate ?? null,
        counterparty_entity_id: l.counterparty_entity_id ?? null,
        source_line_ref: l.source_line_ref ?? null,
      }),
    );
    this.postedJeIds.push(je.id);
    this.jeNumbers.set(je.id, je.je_number as string);
    return je.id;
  }

  counterRows(): DbInserts['counters'][] {
    return [...this.jeCounters.entries()].map(([name, value]) => ({ name, value }));
  }

  /** Insert every table in dependency order, then flip pending entries to posted (triggers verify each). */
  /** Updates applied after posting, inside the same transaction (e.g. locking history periods). */
  readonly afterPost: ((tx: Parameters<Parameters<Db['tx']>[1]>[0]) => Promise<void>)[] = [];

  async flush(db: Db, onProgress?: (msg: string) => void): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const postedIds = this.postedJeIds;
    await db.tx(this.tenantId, async (tx) => {
      for (const t of INSERT_ORDER) {
        const rows = this.rows.get(t);
        if (!rows?.length) continue;
        onProgress?.(`inserting ${rows.length} ${t}`);
        await tx.insertMany(t, rows as never);
        counts[t] = rows.length;
      }
      onProgress?.(`posting ${postedIds.length} journal entries`);
      for (let i = 0; i < postedIds.length; i += 500) {
        await tx.updateWhere('journal_entries', { id: { in: postedIds.slice(i, i + 500) } }, { status: 'posted' });
      }
      for (const f of this.afterPost) await f(tx);
    });
    return counts;
  }
}

function prefixOf(table: TableName): string {
  const map: Partial<Record<TableName, string>> = {
    journal_entries: 'je', journal_lines: 'jl', bank_transactions: 'btx', card_transactions: 'ctx', invoices: 'inv', invoice_lines: 'il', bills: 'bill', bill_lines: 'bl',
    payments: 'pay', receipts: 'rcp', accounts: 'acct', entities: 'ent', periods: 'per', users: 'usr', vendors: 'ven', customers: 'cus', fx_rates: 'fx',
    budget_lines: 'bdl', budgets: 'bud', close_tasks: 'tsk', roles: 'role', role_permissions: 'rp', user_roles: 'ur',
  };
  return map[table] ?? table.split('_').map((w) => w[0]).join('');
}
