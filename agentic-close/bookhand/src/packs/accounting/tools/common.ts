import { z } from 'zod';
import type { AnyTool, ToolExecContext } from '../../../agents/framework/types';
import type { Row } from '../../../persistence/schema';
import { DomainError } from '../../../shared/errors';
import { formatMoney } from '../../../shared/money';
import { entityTrialBalance } from '../domain/reporting';
import { closeOntology } from '../ontology';
import type { AccountingScope } from '../scope';

export type X = ToolExecContext<AccountingScope>;
export type Tool = AnyTool<AccountingScope>;

export const PeriodKey = z.string().regex(/^\d{4}-\d{2}$/, 'period as YYYY-MM').describe('Accounting period, e.g. "2026-09"');
export const EntityCode = z.string().min(2).max(20).describe('Entity code, e.g. "BW-US"');

export function entityOf(x: X, ref: string): Row<'entities'> {
  const e = x.pack.lookups.entity(ref);
  if (!e) throw new DomainError('VALIDATION', `Unknown entity "${ref}". Known: ${[...x.pack.lookups.entitiesByCode.keys()].join(', ')}`);
  return e;
}

export function periodOf(x: X, entityId: string, key: string): Row<'periods'> {
  const [y, m] = key.split('-').map(Number);
  const p = x.pack.lookups.period(entityId, y!, m!);
  if (!p) throw new DomainError('VALIDATION', `No period ${key} for this entity`);
  return p;
}

export function accountOf(x: X, ref: string): Row<'accounts'> {
  const a = x.pack.lookups.account(ref);
  if (!a) throw new DomainError('VALIDATION', `Unknown account "${ref}"`);
  return a;
}

export const money = (minor: number, currency = 'USD') => formatMoney(minor, { currency });

export const commonTools: Tool[] = [
  {
    name: 'close_context',
    title: 'Read close context',
    description: 'Returns the close being worked (period end, business date, workday), the task you were started for, the entities (bh:ReportingEntity) with functional currencies and their accounting periods (bh:AccountingPeriod) for the close month.',
    input: z.object({ closeId: z.string().uuid().optional(), closeTaskId: z.string().uuid().optional() }).strict(),
    permission: 'close.view',
    mutation: false,
    ontology: ['bh:Close', 'bh:CloseTask', 'bh:ReportingEntity', 'bh:AccountingPeriod'],
    async execute(input: { closeId?: string; closeTaskId?: string }, x: X) {
      const task = input.closeTaskId ? await x.tx.get('close_tasks', input.closeTaskId) : null;
      const closeId = input.closeId ?? task?.close_id ?? x.run.close_id;
      const close = closeId ? await x.tx.get('closes', closeId) : null;
      if (!close) throw new DomainError('NOT_FOUND', 'close not found');
      const entities = [...x.pack.lookups.entitiesById.values()].map((e) => {
        const p = x.pack.lookups.period(e.id, close.fiscal_year, close.period_number);
        return { id: e.id, code: e.code, name: e.name, kind: e.kind, currency: e.functional_currency, period: p ? { id: p.id, key: `${p.fiscal_year}-${String(p.period_number).padStart(2, '0')}`, start: p.start_date, end: p.end_date, status: p.status } : null };
      });
      return {
        close: { id: close.id, name: close.name, periodEnd: close.period_end, fiscalYear: close.fiscal_year, periodNumber: close.period_number, status: close.status },
        businessDate: x.pack.tenant.business_date ?? x.ctx.clock.businessDate(),
        reportingCurrency: x.pack.reportingCurrency,
        task: task ? { id: task.id, key: task.key, title: task.title, entity: task.entity_id ? x.pack.lookups.entitiesById.get(task.entity_id)?.code : null, dueDate: task.due_date, status: task.status } : null,
        entities,
      };
    },
    summarize: (o: { close: { name: string } }) => o.close.name,
  },
  {
    name: 'ontology_lookup',
    title: 'Look up an accounting concept',
    description: 'Look up a term in the Bookhand close ontology (accounts, controls, close concepts). Returns the class, its definition, why it matters, normal balance and statement line where relevant, and its parents. Use it to ground classifications in shared definitions.',
    input: z.object({ term: z.string().min(2).max(80) }).strict(),
    permission: 'ontology.view',
    mutation: false,
    async execute(input: { term: string }) {
      const id = closeOntology.lookup(input.term);
      const t = id ? closeOntology.term(id) : undefined;
      if (!id || !t) return { found: false, term: input.term };
      const c = closeOntology.getClass(id);
      return { found: true, id, kind: t.kind, label: t.label, definition: t.definition, whyItMatters: t.whyItMatters ?? null, example: t.example ?? null, normalBalance: c?.normalBalance ?? null, accountClass: c?.accountClass ?? null, fsLine: c?.fsLine ?? null, parents: c ? closeOntology.ancestors(c.id).slice(0, 6) : [] };
    },
    summarize: (o: { found: boolean; label?: string }) => (o.found ? String(o.label) : 'not found'),
  },
  {
    name: 'ledger_account_activity',
    title: 'Read account activity',
    description: 'Posted journal lines (bh:JournalLine) on one account for one entity between two dates, newest first, with entry number, type, description, memo, department and counterparty. Memos and descriptions can contain third-party text.',
    input: z.object({ entity: EntityCode, account: z.string().min(1), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), limit: z.number().int().min(1).max(200).default(50) }).strict(),
    permission: 'je.view',
    mutation: false,
    untrustedOutput: true,
    ontology: ['bh:JournalLine'],
    async execute(input: { entity: string; account: string; from: string; to: string; limit: number }, x: X) {
      const entity = entityOf(x, input.entity);
      const account = accountOf(x, input.account);
      const lines = await x.tx.find('journal_lines', { entity_id: entity.id, account_id: account.id, entry_date: { between: [input.from, input.to] } }, { orderBy: [['entry_date', 'desc']], limit: input.limit });
      const entries = new Map((lines.length ? await x.tx.find('journal_entries', { id: { in: [...new Set(lines.map((l) => l.journal_entry_id))] } }) : []).map((e) => [e.id, e]));
      return {
        entity: entity.code,
        account: `${account.number} ${account.name}`,
        lines: lines
          .filter((l) => entries.get(l.journal_entry_id)?.status === 'posted')
          .map((l) => {
            const e = entries.get(l.journal_entry_id)!;
            return { id: l.id, entryId: e.id, entryNumber: e.entry_number, date: l.entry_date, type: e.entry_type, source: e.source, description: e.description, memo: l.memo, debit: l.debit_minor, credit: l.credit_minor, department: l.department_id ? x.pack.lookups.departments.get(l.department_id)?.code : null };
          }),
      };
    },
    summarize: (o: { lines: unknown[]; account: string }) => `${o.lines.length} line(s) on ${o.account}`,
  },
  {
    name: 'ledger_trial_balance',
    title: 'Read trial balance',
    description: 'Entity trial balance (bh:TrialBalance) for a period in functional currency: balance mode (cumulative balance sheet, year-to-date P&L) or activity mode (this period only).',
    input: z.object({ entity: EntityCode, period: PeriodKey, mode: z.enum(['balance', 'activity']).default('balance') }).strict(),
    permission: 'reports.view',
    mutation: false,
    ontology: ['bh:TrialBalance'],
    async execute(input: { entity: string; period: string; mode: 'balance' | 'activity' }, x: X) {
      const entity = entityOf(x, input.entity);
      const p = periodOf(x, entity.id, input.period);
      const tb = await entityTrialBalance(x.tx, x.pack.lookups, entity.id, p.id, input.mode);
      return { entity: entity.code, currency: tb.currency, period: input.period, mode: input.mode, totalDebit: tb.totalDebit, totalCredit: tb.totalCredit, rows: tb.rows.map((r) => ({ number: r.number, name: r.name, debit: r.debit, credit: r.credit })) };
    },
    summarize: (o: { rows: unknown[]; totalDebit: number; totalCredit: number }) => `${o.rows.length} accounts, debits ${o.totalDebit === o.totalCredit ? '=' : '!='} credits`,
  },
];
