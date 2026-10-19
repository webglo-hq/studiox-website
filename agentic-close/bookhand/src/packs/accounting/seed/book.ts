import type { Insert } from '../../../persistence/schema';
import { idFromRandom } from '../../../shared/ids';
import type { Prng } from '../../../shared/prng';

/**
 * In-memory journal builder used by the seed generator. It assigns deterministic ids and entry numbers,
 * checks balance as entries are built, and records every cash movement so bank statements can be derived from
 * exactly the same events that hit the ledger.
 */

export interface SeedLine {
  account: string;
  debit?: number;
  credit?: number;
  dept?: string | null;
  location?: string | null;
  klass?: string | null;
  counterparty?: string | null;
  vendorId?: string | null;
  customerId?: string | null;
  memo?: string | null;
  txnCurrency?: string;
  txnAmount?: number;
}

export interface CashEvent {
  entity: string;
  glAccount: string;
  bookDate: string;
  bankDate: string;
  amount: number;
  bankText: string;
  reference: string;
  bankRef: string;
  typeCode: string;
  ledgerLineId: string;
  counterparty: string | null;
  /** Grouping key: events sharing a key clear the bank as ONE line (batched deposit). */
  batchKey?: string;
  /** Split one book line into several bank lines (e.g. payroll funded in two pulls). */
  splits?: number[];
}

export interface SeedJournal {
  header: Insert<'journal_entries'>;
  lines: Insert<'journal_lines'>[];
  basis: 'system' | 'import' | 'human_approval' | 'autonomy_policy';
  approvedBy: string | null;
  postedAt: string;
}

export interface BookContext {
  tenantId: string;
  accountId: (number: string) => string;
  entity: (code: string) => { id: string; currency: string; code: string };
  periodFor: (entityId: string, date: string) => { id: string; key: string } | undefined;
  dept: (code: string | null | undefined) => string | null;
  location: (code: string | null | undefined) => string | null;
  klass: (code: string | null | undefined) => string | null;
}

export class Book {
  readonly journals: SeedJournal[] = [];
  readonly cash: CashEvent[] = [];
  private readonly seq = new Map<string, number>();

  constructor(
    private readonly ctx: BookContext,
    private readonly rng: Prng,
    private readonly cashAccounts: Set<string>,
  ) {}

  id(): string {
    return idFromRandom(() => this.rng.next());
  }

  /** Create a balanced, to-be-posted journal entry. Returns the header id and line ids. */
  entry(args: {
    entity: string;
    date: string;
    description: string;
    type?: Insert<'journal_entries'>['entry_type'];
    source?: Insert<'journal_entries'>['source'];
    module?: Insert<'journal_entries'>['source_module'];
    lines: SeedLine[];
    currency?: string;
    fxRate?: number;
    preparedBy?: string | null;
    approvedBy?: string | null;
    basis?: SeedJournal['basis'];
    autoReverseDate?: string | null;
    reversesEntryId?: string | null;
    icReference?: string | null;
    counterparty?: string | null;
    externalRef?: string | null;
    postedAt?: string;
    cash?: Partial<Omit<CashEvent, 'entity' | 'glAccount' | 'bookDate' | 'amount' | 'ledgerLineId'>> & { lag?: number };
    id?: string;
  }): { id: string; lineIds: string[]; number: string } {
    const entity = this.ctx.entity(args.entity);
    const period = this.ctx.periodFor(entity.id, args.date);
    if (!period) throw new Error(`seed: no period for ${args.entity} on ${args.date}`);
    const debit = args.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const credit = args.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    if (debit !== credit || debit <= 0) throw new Error(`seed: unbalanced entry "${args.description}" ${debit} != ${credit}`);
    for (const l of args.lines) {
      if ((l.debit ?? 0) < 0 || (l.credit ?? 0) < 0 || (l.debit ?? 0) > 0 === (l.credit ?? 0) > 0) throw new Error(`seed: bad line in "${args.description}"`);
    }
    const key = `${entity.code}|${period.key}`;
    const n = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, n);
    const number = `${entity.code}-${period.key.slice(2, 4)}${period.key.slice(5, 7)}-${String(n).padStart(4, '0')}`;
    const id = args.id ?? this.id();
    const currency = args.currency ?? entity.currency;
    const lineIds: string[] = [];
    const lines: Insert<'journal_lines'>[] = args.lines.map((l, i) => {
      const lineId = this.id();
      lineIds.push(lineId);
      const net = (l.debit ?? 0) - (l.credit ?? 0);
      return {
        id: lineId,
        tenant_id: this.ctx.tenantId,
        journal_entry_id: id,
        line_number: i + 1,
        entity_id: entity.id,
        period_id: period.id,
        entry_date: args.date,
        account_id: this.ctx.accountId(l.account),
        debit_minor: l.debit ?? 0,
        credit_minor: l.credit ?? 0,
        txn_currency: l.txnCurrency ?? entity.currency,
        txn_amount_minor: l.txnAmount ?? net,
        department_id: this.ctx.dept(l.dept),
        location_id: this.ctx.location(l.location),
        class_id: this.ctx.klass(l.klass),
        counterparty_entity_id: l.counterparty ? this.ctx.entity(l.counterparty).id : null,
        vendor_id: l.vendorId ?? null,
        customer_id: l.customerId ?? null,
        memo: l.memo ?? null,
      };
    });
    const postedAt = args.postedAt ?? `${args.date}T18:00:00.000Z`;
    this.journals.push({
      header: {
        id,
        tenant_id: this.ctx.tenantId,
        entity_id: entity.id,
        period_id: period.id,
        entry_number: number,
        entry_date: args.date,
        entry_type: args.type ?? 'standard',
        status: 'pending_approval',
        description: args.description,
        source: args.source ?? 'subledger',
        source_module: args.module ?? 'gl',
        currency,
        fx_rate: args.fxRate ?? 1,
        prepared_by: args.preparedBy ?? null,
        reverses_entry_id: args.reversesEntryId ?? null,
        auto_reverse_date: args.autoReverseDate ?? null,
        ic_reference: args.icReference ?? null,
        counterparty_entity_id: args.counterparty ? this.ctx.entity(args.counterparty).id : null,
        external_ref: args.externalRef ?? null,
        total_minor: debit,
        line_count: lines.length,
        created_at: postedAt,
        updated_at: postedAt,
      },
      lines,
      basis: args.basis ?? 'system',
      approvedBy: args.approvedBy ?? null,
      postedAt,
    });
    // Record cash movements for bank statement generation.
    args.lines.forEach((l, i) => {
      if (!this.cashAccounts.has(l.account) || !args.cash) return;
      const amount = (l.debit ?? 0) - (l.credit ?? 0);
      const lag = args.cash.lag ?? 0;
      const bankDate = args.cash.bankDate ?? addBusinessDays(args.date, lag);
      this.cash.push({
        entity: args.entity,
        glAccount: l.account,
        bookDate: args.date,
        bankDate,
        amount,
        bankText: args.cash.bankText ?? args.description.toUpperCase(),
        reference: args.cash.reference ?? '',
        bankRef: args.cash.bankRef ?? `BR${this.rng.int(100000, 999999)}`,
        typeCode: args.cash.typeCode ?? (amount < 0 ? '455' : '165'),
        ledgerLineId: lineIds[i]!,
        counterparty: args.cash.counterparty ?? null,
        batchKey: args.cash.batchKey,
        splits: args.cash.splits,
      });
    });
    return { id, lineIds, number };
  }
}

export function addBusinessDays(date: string, days: number): string {
  let d = new Date(`${date}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    d = new Date(d.getTime() + 86_400_000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
