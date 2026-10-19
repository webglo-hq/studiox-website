import type { NamedQuery } from '../../../framework/store/db';
import type { EkSchema } from '../store';

/**
 * Named ledger queries with matching SQL and in-memory implementations. The SQL text is
 * static apart from optional, whitelisted clauses; every value is a bound parameter.
 */

export interface BalanceParams {
  tenantId: string;
  entityIds?: string[];
  periodFrom?: string;
  periodTo?: string;
  accountIds?: string[];
  byDepartment?: boolean;
  byPeriod?: boolean;
}

export interface BalanceRow {
  entityId: string;
  accountId: string;
  departmentId: string | null;
  periodKey: string | null;
  debit: number;
  credit: number;
}

export const ledgerBalances: NamedQuery<EkSchema, BalanceParams, BalanceRow> = {
  name: 'ledgerBalances',
  sql(p) {
    const values: unknown[] = [p.tenantId];
    const where = [`e.tenant_id = $1`, `e.status = 'posted'`];
    if (p.entityIds) {
      values.push(p.entityIds);
      where.push(`e.entity_id = ANY($${values.length}::uuid[])`);
    }
    if (p.periodFrom) {
      values.push(p.periodFrom);
      where.push(`e.period_key >= $${values.length}`);
    }
    if (p.periodTo) {
      values.push(p.periodTo);
      where.push(`e.period_key <= $${values.length}`);
    }
    if (p.accountIds) {
      values.push(p.accountIds);
      where.push(`l.account_id = ANY($${values.length}::uuid[])`);
    }
    const dept = p.byDepartment ? 'l.department_id' : 'NULL::uuid';
    const period = p.byPeriod ? 'e.period_key' : 'NULL::text';
    const groupExtra = [p.byDepartment ? ', l.department_id' : '', p.byPeriod ? ', e.period_key' : ''].join('');
    return {
      text: `SELECT e.entity_id, l.account_id, ${dept} AS department_id, ${period} AS period_key,
                    coalesce(sum(l.debit), 0)::bigint AS debit, coalesce(sum(l.credit), 0)::bigint AS credit
               FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id
              WHERE ${where.join(' AND ')}
              GROUP BY e.entity_id, l.account_id${groupExtra}`,
      values,
    };
  },
  mapRow: (r) => ({
    entityId: String(r.entity_id),
    accountId: String(r.account_id),
    departmentId: (r.department_id as string | null) ?? null,
    periodKey: (r.period_key as string | null) ?? null,
    debit: Number(r.debit),
    credit: Number(r.credit),
  }),
  memory(reader, p) {
    const entitySet = p.entityIds ? new Set(p.entityIds) : null;
    const accountSet = p.accountIds ? new Set(p.accountIds) : null;
    const out = new Map<string, BalanceRow>();
    for (const e of reader.all('journal_entry')) {
      if (e.tenant_id !== p.tenantId || e.status !== 'posted') continue;
      if (entitySet && !entitySet.has(e.entity_id)) continue;
      if (p.periodFrom && e.period_key < p.periodFrom) continue;
      if (p.periodTo && e.period_key > p.periodTo) continue;
      for (const l of reader.byIndex('journal_line', 'journal_entry_id', e.id)) {
        if (accountSet && !accountSet.has(l.account_id)) continue;
        const dept = p.byDepartment ? l.department_id : null;
        const per = p.byPeriod ? e.period_key : null;
        const key = `${e.entity_id}|${l.account_id}|${dept}|${per}`;
        let row = out.get(key);
        if (!row) out.set(key, (row = { entityId: e.entity_id, accountId: l.account_id, departmentId: dept, periodKey: per, debit: 0, credit: 0 }));
        row.debit += l.debit;
        row.credit += l.credit;
      }
    }
    return [...out.values()];
  },
};

export interface LineParams {
  tenantId: string;
  entityIds?: string[];
  periodFrom?: string;
  periodTo?: string;
  accountIds?: string[];
  entryIds?: string[];
  limit?: number;
}

export interface LedgerLineRow {
  lineId: string;
  entryId: string;
  entryNumber: string;
  entryDate: string;
  entryType: string;
  periodKey: string;
  entityId: string;
  memo: string;
  source: string;
  lineMemo: string | null;
  accountId: string;
  departmentId: string | null;
  counterpartyEntityId: string | null;
  debit: number;
  credit: number;
  sourceType: string | null;
  sourceId: string | null;
  preparedBy: string | null;
  approvedBy: string | null;
  externalPreparer: string | null;
  externalApprover: string | null;
  externalPostedAt: string | null;
  postedAt: string | null;
  txnCurrency: string | null;
  txnAmount: number | null;
}

export const ledgerLines: NamedQuery<EkSchema, LineParams, LedgerLineRow> = {
  name: 'ledgerLines',
  sql(p) {
    const values: unknown[] = [p.tenantId];
    const where = [`e.tenant_id = $1`, `e.status = 'posted'`];
    if (p.entityIds) {
      values.push(p.entityIds);
      where.push(`e.entity_id = ANY($${values.length}::uuid[])`);
    }
    if (p.periodFrom) {
      values.push(p.periodFrom);
      where.push(`e.period_key >= $${values.length}`);
    }
    if (p.periodTo) {
      values.push(p.periodTo);
      where.push(`e.period_key <= $${values.length}`);
    }
    if (p.accountIds) {
      values.push(p.accountIds);
      where.push(`l.account_id = ANY($${values.length}::uuid[])`);
    }
    if (p.entryIds) {
      values.push(p.entryIds);
      where.push(`e.id = ANY($${values.length}::uuid[])`);
    }
    let limit = '';
    if (p.limit !== undefined) {
      values.push(Math.max(1, Math.floor(p.limit)));
      limit = ` LIMIT $${values.length}`;
    }
    return {
      text: `SELECT l.id AS line_id, e.id AS entry_id, e.entry_number, e.entry_date, e.entry_type, e.period_key, e.entity_id, e.memo, e.source,
                    l.memo AS line_memo, l.account_id, l.department_id, l.counterparty_entity_id, l.debit, l.credit, l.source_type, l.source_id,
                    e.prepared_by, e.approved_by, e.external_preparer, e.external_approver, e.external_posted_at, e.posted_at, l.txn_currency, l.txn_amount
               FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id
              WHERE ${where.join(' AND ')}
              ORDER BY e.entry_date, e.entry_number, l.line_no${limit}`,
      values,
    };
  },
  mapRow: (r) => ({
    lineId: String(r.line_id),
    entryId: String(r.entry_id),
    entryNumber: String(r.entry_number),
    entryDate: String(r.entry_date).slice(0, 10),
    entryType: String(r.entry_type),
    periodKey: String(r.period_key),
    entityId: String(r.entity_id),
    memo: String(r.memo),
    source: String(r.source),
    lineMemo: (r.line_memo as string | null) ?? null,
    accountId: String(r.account_id),
    departmentId: (r.department_id as string | null) ?? null,
    counterpartyEntityId: (r.counterparty_entity_id as string | null) ?? null,
    debit: Number(r.debit),
    credit: Number(r.credit),
    sourceType: (r.source_type as string | null) ?? null,
    sourceId: (r.source_id as string | null) ?? null,
    preparedBy: (r.prepared_by as string | null) ?? null,
    approvedBy: (r.approved_by as string | null) ?? null,
    externalPreparer: (r.external_preparer as string | null) ?? null,
    externalApprover: (r.external_approver as string | null) ?? null,
    externalPostedAt: r.external_posted_at ? new Date(String(r.external_posted_at)).toISOString() : null,
    postedAt: r.posted_at ? new Date(String(r.posted_at)).toISOString() : null,
    txnCurrency: (r.txn_currency as string | null) ?? null,
    txnAmount: r.txn_amount === null || r.txn_amount === undefined ? null : Number(r.txn_amount),
  }),
  memory(reader, p) {
    const entitySet = p.entityIds ? new Set(p.entityIds) : null;
    const accountSet = p.accountIds ? new Set(p.accountIds) : null;
    const entrySet = p.entryIds ? new Set(p.entryIds) : null;
    const out: (LedgerLineRow & { lineNo: number })[] = [];
    const entries = entrySet ? [...entrySet].map((id) => reader.byId('journal_entry', id)).filter((e): e is NonNullable<typeof e> => !!e) : reader.all('journal_entry');
    for (const e of entries) {
      if (e.tenant_id !== p.tenantId || e.status !== 'posted') continue;
      if (entitySet && !entitySet.has(e.entity_id)) continue;
      if (p.periodFrom && e.period_key < p.periodFrom) continue;
      if (p.periodTo && e.period_key > p.periodTo) continue;
      for (const l of reader.byIndex('journal_line', 'journal_entry_id', e.id)) {
        if (accountSet && !accountSet.has(l.account_id)) continue;
        out.push({
          lineId: l.id,
          entryId: e.id,
          entryNumber: e.entry_number,
          entryDate: e.entry_date,
          entryType: e.entry_type,
          periodKey: e.period_key,
          entityId: e.entity_id,
          memo: e.memo,
          source: e.source,
          lineMemo: l.memo,
          accountId: l.account_id,
          departmentId: l.department_id,
          counterpartyEntityId: l.counterparty_entity_id,
          debit: l.debit,
          credit: l.credit,
          sourceType: l.source_type,
          sourceId: l.source_id,
          preparedBy: e.prepared_by,
          approvedBy: e.approved_by,
          externalPreparer: e.external_preparer,
          externalApprover: e.external_approver,
          externalPostedAt: e.external_posted_at,
          postedAt: e.posted_at,
          txnCurrency: l.txn_currency,
          txnAmount: l.txn_amount,
          lineNo: l.line_no,
        });
      }
    }
    out.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : a.entryNumber < b.entryNumber ? -1 : a.entryNumber > b.entryNumber ? 1 : a.lineNo - b.lineNo));
    const sliced = p.limit !== undefined ? out.slice(0, p.limit) : out;
    return sliced.map(({ lineNo: _lineNo, ...rest }) => rest);
  },
};
