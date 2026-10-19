import { describe, expect, it } from 'vitest';
import type { Insert, Row } from './schema';
import { TABLE_NAMES } from './schema';

describe('schema type inference', () => {
  it('infers row and insert types from the DSL', () => {
    const r = { status: 'posted', approval_basis: null } as unknown as Row<'journal_entries'>;
    const s: 'draft' | 'pending_approval' | 'posted' | 'rejected' = r.status;
    const n: string | null = r.approval_basis;
    const i: Insert<'journal_lines'> = {
      tenant_id: 'x',
      journal_entry_id: 'x',
      line_number: 1,
      entity_id: 'x',
      period_id: 'x',
      entry_date: '2026-01-01',
      account_id: 'a',
      txn_currency: 'USD',
      txn_amount_minor: 1,
    };
    // @ts-expect-error missing required fields
    const bad: Insert<'journal_lines'> = { tenant_id: 'x' };
    expect([s, n, i.line_number, bad.tenant_id]).toEqual(['posted', null, 1, 'x']);
    expect(TABLE_NAMES.length).toBeGreaterThan(60);
  });
});
