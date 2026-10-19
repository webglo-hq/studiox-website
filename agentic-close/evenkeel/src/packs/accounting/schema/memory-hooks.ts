import { auditHash, GENESIS_HASH, normalizeInstant } from '../../../framework/audit/chain';
import { StoreError } from '../../../framework/store/db';
import { nowIso } from '../../../framework/store/defaults';
import type { HookContext, MemoryHooks } from '../../../framework/store/memory';
import type { EkSchema } from './tables';

/**
 * In-memory emulation of db/migrations/0002_invariants.sql. Same rules, same EK-codes, so
 * the browser demo and unit tests enforce exactly what Postgres enforces. A contract test
 * runs one invariant suite against both stores.
 */
type Row = Record<string, unknown>;
type Ctx = HookContext<EkSchema>;

const raise = (msg: string): never => {
  throw new StoreError('P0001', msg);
};

const SOFT_CLOSE_TYPES = new Set(['adjusting', 'accrual', 'reclass', 'elimination', 'fx_revaluation', 'depreciation', 'amortization', 'reversing']);
const JE_MUTABLE_AFTER_POST = new Set(['reversed_by_entry_id']);

function lines(ctx: Ctx, entryId: string): Row[] {
  return ctx.reader.byIndex('journal_line', 'journal_entry_id', entryId) as unknown as Row[];
}

function assertPostable(next: Row, ctx: Ctx): void {
  const p = ctx.reader.byId('fiscal_period', next.period_id as string) as unknown as Row | undefined;
  if (!p || p.entity_id !== next.entity_id || p.period_key !== next.period_key) raise(`EK-PER-02: entry ${String(next.entry_number)} period record does not match its entity/period`);
  if (p!.status === 'hard_close') raise(`EK-PERIOD-LOCKED: ${String(next.period_key)} is hard-closed; post the correction in an open period`);
  if (p!.status === 'soft_close' && !SOFT_CLOSE_TYPES.has(next.entry_type as string)) raise(`EK-PERIOD-SOFT-CLOSE: ${String(next.period_key)} is soft-closed; ${String(next.entry_type)} entries are not allowed`);
  if ((next.entry_date as string) < (p!.start_date as string) || (next.entry_date as string) > (p!.end_date as string)) raise(`EK-PER-02: entry date ${String(next.entry_date)} is outside ${String(next.period_key)}`);

  const ls = lines(ctx, next.id as string);
  if (ls.length < 2) raise(`EK-DE-03: entry ${String(next.entry_number)} needs at least one debit and one credit line`);
  let d = 0;
  let c = 0;
  const bad: string[] = [];
  for (const l of ls) {
    d += l.debit as number;
    c += l.credit as number;
    const a = ctx.reader.byId('account', l.account_id as string) as unknown as Row | undefined;
    if (!a || !a.is_postable || !a.is_active || a.tenant_id !== next.tenant_id) bad.push(String(a?.code ?? l.account_id));
  }
  if (d !== c || d === 0) raise(`EK-DE-01: entry ${String(next.entry_number)} is unbalanced (debits ${d}, credits ${c})`);
  if (bad.length) raise(`EK-ACC-01: entry ${String(next.entry_number)} posts to non-postable, inactive or foreign accounts: ${bad.join(', ')}`);

  const ent = ctx.reader.byId('entity', next.entity_id as string) as unknown as Row | undefined;
  if ((next.entry_type === 'elimination') !== Boolean(ent?.is_elimination)) raise(`EK-JE-04: elimination entries belong only to the elimination entity (entry ${String(next.entry_number)})`);

  if (next.approved_by !== null && (next.approved_by === next.prepared_by || next.approved_by === next.requested_by)) {
    raise(`EK-SOD-01: the preparer or requester of ${String(next.entry_number)} cannot approve it`);
  }

  if (next.reverses_entry_id) {
    const o = ctx.reader.byId('journal_entry', next.reverses_entry_id as string) as unknown as Row | undefined;
    if (!o || o.status !== 'posted' || o.reversed_by_entry_id !== null || o.entity_id !== next.entity_id || (next.entry_date as string) < (o.entry_date as string)) {
      raise(`EK-JE-02: ${String(next.entry_number)} cannot reverse ${String(o?.entry_number)} (must be posted, unreversed, same entity, not earlier)`);
    }
    const key = (l: Row, swap: boolean) => `${String(l.account_id)}|${swap ? String(l.credit) : String(l.debit)}|${swap ? String(l.debit) : String(l.credit)}`;
    const want = lines(ctx, o!.id as string).map((l) => key(l, true)).sort();
    const got = ls.map((l) => key(l, false)).sort();
    if (want.join(',') !== got.join(',')) raise(`EK-JE-02: reversal ${String(next.entry_number)} must mirror ${String(o!.entry_number)} with debits and credits swapped`);
  }
  next.total_debit = d;
  if (next.posted_at === null) next.posted_at = nowIso();
}

function appendOnly(table: string) {
  return {
    beforeUpdate: () => raise(`EK-AUDIT-APPEND-ONLY: ${table} is append-only`),
    beforeDelete: () => raise(`EK-AUDIT-APPEND-ONLY: ${table} is append-only`),
  };
}

const PROPOSAL_TRANSITIONS: Record<string, string[]> = {
  pending: ['approved', 'rejected', 'applied', 'superseded', 'failed'],
  approved: ['applied', 'failed'],
  suggested: ['approved', 'applied', 'rejected', 'superseded'],
  failed: ['superseded', 'pending'],
};

export function accountingMemoryHooks(): MemoryHooks<EkSchema> {
  return {
    journal_entry: {
      beforeInsert(row, ctx) {
        if (row.status === 'posted') raise(`EK-JE-POST-VIA-DRAFT: insert entry ${String(row.entry_number)} as draft, add its lines, then post it`);
        const p = ctx.reader.byId('fiscal_period', row.period_id as string) as unknown as Row | undefined;
        if (p?.status === 'hard_close') raise(`EK-PERIOD-LOCKED: ${String(row.period_key)} is hard-closed; no new entries`);
      },
      beforeUpdate(old, next, ctx) {
        if (old.status === 'posted') {
          for (const k of Object.keys(next)) {
            if (JE_MUTABLE_AFTER_POST.has(k)) continue;
            if (JSON.stringify(next[k]) !== JSON.stringify(old[k])) raise(`EK-JE-IMMUTABLE: posted entry ${String(old.entry_number)} cannot be changed; post a reversing entry instead`);
          }
          if (old.reversed_by_entry_id !== null && next.reversed_by_entry_id !== old.reversed_by_entry_id) raise(`EK-JE-IMMUTABLE: entry ${String(old.entry_number)} is already reversed`);
          return;
        }
        if (next.status === 'posted') assertPostable(next, ctx);
      },
      afterUpdate(old, next, ctx) {
        if (next.status === 'posted' && old.status !== 'posted' && next.reverses_entry_id) {
          const o = ctx.reader.byId('journal_entry', next.reverses_entry_id as string) as unknown as Row | undefined;
          if (!o || o.reversed_by_entry_id !== null) raise(`EK-JE-02: original of ${String(next.entry_number)} is already reversed`);
          ctx.rawUpdate('journal_entry', o!.id as string, { reversed_by_entry_id: next.id });
        }
      },
      beforeDelete(row) {
        if (row.status === 'posted') raise(`EK-JE-IMMUTABLE: posted entry ${String(row.entry_number)} cannot be deleted; post a reversing entry instead`);
      },
    },
    journal_line: {
      beforeInsert(row, ctx) {
        const e = ctx.reader.byId('journal_entry', row.journal_entry_id as string) as unknown as Row | undefined;
        if (e?.status === 'posted') raise('EK-JE-IMMUTABLE: lines cannot be added to a posted entry');
        if (e && e.tenant_id !== row.tenant_id) raise('EK-TENANT: journal line tenant differs from its entry');
      },
      beforeUpdate(old, next, ctx) {
        const e = ctx.reader.byId('journal_entry', old.journal_entry_id as string) as unknown as Row | undefined;
        if (e?.status === 'posted') raise('EK-JE-IMMUTABLE: lines of a posted entry cannot change');
        void next;
      },
      beforeDelete(row, ctx) {
        const e = ctx.reader.byId('journal_entry', row.journal_entry_id as string) as unknown as Row | undefined;
        if (e?.status === 'posted') raise('EK-JE-IMMUTABLE: lines of a posted entry cannot change');
      },
    },
    fiscal_period: {
      beforeUpdate(old, next) {
        if (next.status === old.status) return;
        const from = old.status as string;
        const to = next.status as string;
        if ((from === 'open' && to === 'soft_close') || (from === 'soft_close' && to === 'hard_close')) return;
        if ((from === 'hard_close' && to === 'soft_close') || (from === 'soft_close' && to === 'open')) {
          if (typeof next.reopen_reason !== 'string' || next.reopen_reason.length < 10) raise(`EK-PERIOD-REOPEN: reopening ${String(next.period_key)} requires a documented reason`);
          return;
        }
        raise(`EK-PERIOD-TRANSITION: ${from} → ${to} is not allowed (open → soft_close → hard_close)`);
      },
    },
    audit_log: {
      beforeInsert(row, ctx) {
        const head = ctx.reader.byId('audit_chain_head', row.tenant_id as string) as unknown as Row | undefined;
        const lastSeq = (head?.last_seq as number | undefined) ?? 0;
        const lastHash = (head?.last_hash as string | undefined) ?? GENESIS_HASH;
        row.occurred_at = normalizeInstant(row.occurred_at as string);
        row.seq = lastSeq + 1;
        row.prev_hash = lastHash;
        row.hash = auditHash(lastHash, {
          seq: row.seq as number,
          tenantId: row.tenant_id as string,
          occurredAt: row.occurred_at as string,
          actorType: row.actor_type as string,
          actorId: row.actor_id as string | null,
          action: row.action as string,
          subjectType: row.subject_type as string | null,
          subjectId: row.subject_id as string | null,
          data: row.data,
        });
        ctx.rawUpsert('audit_chain_head', { tenant_id: row.tenant_id, last_seq: row.seq, last_hash: row.hash });
      },
    },
    signoff: appendOnly('signoff'),
    approval: appendOnly('approval'),
    close_task_dependency: {
      beforeInsert(row, ctx) {
        const target = row.task_id as string;
        const stack = [row.depends_on_task_id as string];
        const seen = new Set<string>();
        while (stack.length) {
          const cur = stack.pop()!;
          if (cur === target) raise('EK-CLS-01: dependency would create a cycle');
          if (seen.has(cur)) continue;
          seen.add(cur);
          for (const d of ctx.reader.byIndex('close_task_dependency', 'task_id', cur) as unknown as Row[]) stack.push(d.depends_on_task_id as string);
        }
      },
    },
    close_package: {
      beforeUpdate(old, next) {
        if (old.status === 'final') raise(`EK-PACKAGE-FINAL: the ${String(old.period_key)} close package is final and cannot change`);
        if (JSON.stringify(next.content) !== JSON.stringify(old.content) || next.content_hash !== old.content_hash) raise('EK-PACKAGE: package content is immutable; generate a new version');
      },
      beforeDelete() {
        raise('EK-PACKAGE: close packages are never deleted');
      },
    },
    proposal: {
      beforeUpdate(old, next) {
        for (const k of ['payload', 'why', 'confidence', 'evidence', 'kind', 'run_id']) {
          if (JSON.stringify(next[k]) !== JSON.stringify(old[k])) raise("EK-PRP-IMMUTABLE: a proposal's content cannot change after it is made");
        }
        if (next.status !== old.status && !(PROPOSAL_TRANSITIONS[old.status as string] ?? []).includes(next.status as string)) {
          raise(`EK-PRP-TRANSITION: proposal cannot move from ${String(old.status)} to ${String(next.status)}`);
        }
      },
    },
    rec_match_item: {
      beforeInsert(row, ctx) {
        if (!row.active) return;
        const clash = (ctx.reader.byIndex('rec_match_item', 'record_id', row.record_id) as unknown as Row[]).some((r) => r.active && r.record_type === row.record_type && r.id !== row.id);
        if (clash) throw new StoreError('23505', 'duplicate key value violates unique constraint "rec_match_item_single_active"', 'rec_match_item_single_active');
      },
      beforeUpdate(_old, next, ctx) {
        if (!next.active) return;
        const clash = (ctx.reader.byIndex('rec_match_item', 'record_id', next.record_id) as unknown as Row[]).some((r) => r.active && r.record_type === next.record_type && r.id !== next.id);
        if (clash) throw new StoreError('23505', 'duplicate key value violates unique constraint "rec_match_item_single_active"', 'rec_match_item_single_active');
      },
    },
    skill_policy: {
      beforeInsert(row, ctx) {
        if (!row.is_current) return;
        const clash = (ctx.reader.byIndex('skill_policy', 'skill_id', row.skill_id) as unknown as Row[]).some((r) => r.is_current && r.tenant_id === row.tenant_id && r.id !== row.id);
        if (clash) throw new StoreError('23505', 'duplicate key value violates unique constraint "skill_policy_one_current"', 'skill_policy_one_current');
      },
      beforeUpdate(_old, next, ctx) {
        if (!next.is_current) return;
        const clash = (ctx.reader.byIndex('skill_policy', 'skill_id', next.skill_id) as unknown as Row[]).some((r) => r.is_current && r.tenant_id === next.tenant_id && r.id !== next.id);
        if (clash) throw new StoreError('23505', 'duplicate key value violates unique constraint "skill_policy_one_current"', 'skill_policy_one_current');
      },
    },
  };
}
