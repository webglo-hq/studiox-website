import { adoptSuggestion, approvalBlocks, approveProposal, bulkApprovalBlock, rejectProposal, reviewAutoApplied, sodFindings } from '../../agents/framework/decisions';
import type { AgentRuntime } from '../../agents/framework/runtime';
import type { Tx, Where } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import { reverseEntry } from '../../packs/accounting/domain/ledger';
import { canOn, canSeeEntity, entityScope, requirePermission, type Principal } from '../../security/principal';
import { DomainError } from '../../shared/errors';
import type { App, RequestMeta } from '../app';
import { continueClose } from './close';

/** The agent inbox: proposals awaiting decisions, post-hoc review of auto-applied work, decision history. */

export type InboxView = 'pending' | 'review' | 'blocked' | 'suggested' | 'decided' | 'all';

function rt(app: App): AgentRuntime<unknown> {
  return app.runtime as unknown as AgentRuntime<unknown>;
}

/**
 * The number the inbox shows for an item: the amount at stake (reporting currency) for anything with a ledger
 * effect, the variance being explained for a flux explanation, and nothing for the close package.
 */
async function displayAmount(tx: Tx, x: Row<'proposals'>): Promise<{ minor: number | null; kind: 'at_stake' | 'variance' | 'none' }> {
  if (x.kind === 'task_update') return { minor: null, kind: 'none' };
  if (x.kind === 'flux_explanation') {
    const line = await tx.get('flux_lines', String((x.payload as { fluxLineId?: string }).fluxLineId ?? ''));
    return line ? { minor: line.variance_minor, kind: 'variance' } : { minor: null, kind: 'none' };
  }
  return { minor: x.amount_minor, kind: 'at_stake' };
}

export async function proposalSummary(tx: Tx, app: App, p: Principal, x: Row<'proposals'>, ctx: { users: Map<string, Row<'users'>>; entities: Map<string, Row<'entities'>> }) {
  const checks = (x.verification as Array<{ id: string; label: string; passed: boolean; severity: string; message?: string }>) ?? [];
  const blocks = x.status === 'pending' ? await approvalBlocks(tx, rt(app), p, x) : [];
  const sodWarnings = x.status === 'pending' && blocks.length === 0 ? (await sodFindings(tx, rt(app), p, x)).filter((f) => f.severity === 'warn').map((f) => f.message) : [];
  const skill = x.skill_key ? app.runtime.listSkills().find((s) => s.manifest.key === x.skill_key)?.manifest.name ?? x.skill_key : null;
  return {
    id: x.id,
    kind: x.kind,
    title: x.title,
    why: x.why,
    confidence: x.confidence,
    amount: x.amount_minor,
    currency: x.currency,
    display: await displayAmount(tx, x),
    entity: x.entity_id ? ctx.entities.get(x.entity_id)?.code ?? null : null,
    status: x.status,
    disposition: x.disposition,
    autonomy: x.autonomy_level,
    riskFlags: x.risk_flags,
    skill,
    skillKey: x.skill_key,
    runId: x.run_id,
    closeTaskId: x.close_task_id,
    createdAt: x.created_at,
    decidedAt: x.decided_at,
    decidedBy: x.decided_by ? ctx.users.get(x.decided_by)?.display_name ?? null : null,
    decisionReason: x.decision_reason,
    checks: { passed: checks.filter((c) => c.passed && c.id !== 'DISPOSITION').length, failed: checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.message ?? c.label), warnings: checks.filter((c) => !c.passed && c.severity === 'warning').map((c) => c.message ?? c.label), disposition: checks.find((c) => c.id === 'DISPOSITION')?.label ?? null },
    sampledForReview: x.sampled_for_review,
    postHocStatus: x.post_hoc_status,
    /** Functional currency of the proposal's entity: native amounts in the detail (bank lines, entries) are in it. */
    entityCurrency: x.entity_id ? ctx.entities.get(x.entity_id)?.functional_currency ?? null : null,
    /** Why this item must be decided on its own (null = it may be bulk-approved). */
    bulkBlock: x.status === 'pending' ? bulkApprovalBlock(x) : null,
    canApprove: x.status === 'pending' && blocks.length === 0,
    blocks: blocks.map((b) => b.message),
    sodWarnings,
    canReject: ['pending', 'blocked', 'suggested'].includes(x.status) && canOn(p, x.required_permission as never, x.entity_id) && !p.readOnly,
    canReviewPostHoc: x.status === 'auto_applied' && x.post_hoc_status === 'pending' && canOn(p, 'proposal.review_posthoc', x.entity_id),
    // Confirming is independent review: whoever started the run may reverse its work but not confirm it.
    canConfirmPostHoc: x.status === 'auto_applied' && x.post_hoc_status === 'pending' && canOn(p, 'proposal.review_posthoc', x.entity_id) && x.requested_by !== p.user.id,
    canAdopt: x.status === 'suggested' && !p.readOnly && canOn(p, 'proposal.decide', x.entity_id),
    postedEntryId: x.posted_entry_id,
  };
}

export async function listProposals(app: App, p: Principal, filter: { view?: InboxView; kind?: string; skill?: string; entity?: string; closeTaskId?: string; runId?: string; limit?: number; offset?: number }) {
  requirePermission(p, 'proposal.view');
  return app.read(async (tx) => {
    // Entity scope: someone limited to some entities sees their proposals only (never whole-organization ones).
    const scope = entityScope(p);
    const where: Where<'proposals'> = { tenant_id: p.tenantId, ...(scope ? { entity_id: scope } : {}) };
    const view = filter.view ?? 'pending';
    if (view === 'pending') where.status = 'pending';
    else if (view === 'blocked') where.status = 'blocked';
    else if (view === 'suggested') where.status = 'suggested';
    else if (view === 'review') {
      where.status = 'auto_applied';
      where.post_hoc_status = 'pending';
    } else if (view === 'decided') where.status = { in: ['approved', 'rejected', 'auto_applied', 'superseded', 'failed'] };
    if (filter.kind) where.kind = filter.kind as Row<'proposals'>['kind'];
    if (filter.skill) where.skill_key = filter.skill;
    if (filter.closeTaskId) where.close_task_id = filter.closeTaskId;
    if (filter.runId) where.run_id = filter.runId;
    const entities = new Map((await tx.find('entities', { tenant_id: p.tenantId })).map((e) => [e.id, e]));
    if (filter.entity) {
      const e = [...entities.values()].find((x) => x.code === filter.entity || x.id === filter.entity);
      if (e) where.entity_id = canSeeEntity(p, e.id) ? e.id : { in: [] };
    }
    const total = await tx.count('proposals', where);
    const rows = await tx.find('proposals', where, { orderBy: [[view === 'decided' ? 'updated_at' : 'created_at', 'desc']], limit: Math.min(filter.limit ?? 100, 500), offset: filter.offset ?? 0 });
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u]));
    const items = [];
    for (const r of rows) items.push(await proposalSummary(tx, app, p, r, { users, entities }));
    const mine: Where<'proposals'> = { tenant_id: p.tenantId, ...(scope ? { entity_id: scope } : {}) };
    const counts = {
      pending: await tx.count('proposals', { ...mine, status: 'pending' }),
      review: await tx.count('proposals', { ...mine, status: 'auto_applied', post_hoc_status: 'pending' }),
      blocked: await tx.count('proposals', { ...mine, status: 'blocked' }),
      suggested: await tx.count('proposals', { ...mine, status: 'suggested' }),
      autoApplied: await tx.count('proposals', { ...mine, status: 'auto_applied' }),
    };
    return { view, total, counts, items };
  });
}

/** Resolve references in a proposal payload into readable rows for the decision screen. */
async function payloadDetail(tx: Tx, p: Principal, x: Row<'proposals'>) {
  const accounts = new Map((await tx.find('accounts', { tenant_id: p.tenantId })).map((a) => [a.number, a]));
  const acct = (n: string) => (accounts.get(n) ? `${n} ${accounts.get(n)!.name}` : n);
  const entities = await tx.find('entities', { tenant_id: p.tenantId });
  const tenant = await tx.get('tenants', p.tenantId);
  // Debits and credits are in the entity's functional currency (a UK entry is in pounds even when a USD-valued item is shown at stake).
  const functional = (ref: unknown) => entities.find((e) => e.code === ref || e.id === ref)?.functional_currency ?? tenant?.reporting_currency ?? 'USD';
  const pl = x.payload as Record<string, unknown>;
  const entryView = (e: Record<string, unknown> | undefined) =>
    e
      ? {
          entity: e.entity,
          functionalCurrency: functional(e.entity),
          date: e.date,
          type: e.type,
          description: e.description,
          autoReverseDate: e.autoReverseDate ?? null,
          currency: e.currency ?? null,
          lines: ((e.lines as Array<Record<string, unknown>>) ?? []).map((l) => ({ account: acct(String(l.account)), accountNumber: l.account, debit: Number(l.debit ?? 0), credit: Number(l.credit ?? 0), department: l.department ?? null, memo: l.memo ?? null, txnCurrency: l.txnCurrency ?? null, txnAmount: l.txnAmount ?? null, counterparty: l.counterpartyEntity ?? null })),
        }
      : null;
  switch (x.kind) {
    case 'journal_entry':
      if (pl.reversesEntryId) {
        const e = await tx.get('journal_entries', String(pl.reversesEntryId));
        return { type: 'reversal', entry: e ? { id: e.id, number: e.entry_number, description: e.description, total: e.total_minor, currency: functional(e.entity_id), date: e.entry_date } : null, reason: pl.reason };
      }
      return { type: 'entry', entry: entryView(pl.entry as Record<string, unknown>), links: pl.links };
    case 'transaction_coding': {
      const t = await tx.get('card_transactions', String(pl.cardTransactionId));
      return { type: 'coding', transaction: t ? { id: t.id, merchant: t.merchant_name, date: t.transaction_date, amount: t.amount_minor, currency: t.currency, memo: t.memo, mcc: t.mcc, status: t.status } : null, account: acct(String(pl.accountNumber)), department: pl.departmentCode, source: pl.source };
    }
    case 'rec_match': {
      const bank = await tx.find('bank_transactions', { id: { in: (pl.bankTransactionIds as string[]) ?? [] } });
      const lines = await tx.find('journal_lines', { id: { in: (pl.journalLineIds as string[]) ?? [] } });
      const entries = new Map((lines.length ? await tx.find('journal_entries', { id: { in: lines.map((l) => l.journal_entry_id) } }) : []).map((e) => [e.id, e]));
      return {
        type: 'match',
        currency: functional(x.entity_id),
        matchType: pl.matchType,
        rule: pl.rule,
        bank: bank.map((b) => ({ id: b.id, date: b.booking_date, amount: b.amount_minor, description: b.description, reference: b.reference })),
        ledger: lines.map((l) => ({ id: l.id, date: l.entry_date, amount: l.debit_minor - l.credit_minor, entryNumber: entries.get(l.journal_entry_id)?.entry_number, description: entries.get(l.journal_entry_id)?.description, memo: l.memo })),
      };
    }
    case 'reconciling_item':
      return { type: 'reconciling_item', kind: pl.kind, description: pl.description, amount: pl.amountMinor, currency: functional(pl.entityId ?? x.entity_id), itemDate: pl.itemDate, expectedClearDate: pl.expectedClearDate, account: acct(String(pl.accountNumber)) };
    case 'flux_explanation': {
      const line = await tx.get('flux_lines', String(pl.fluxLineId));
      const a = line ? await tx.get('accounts', line.account_id) : null;
      const analysis = line ? await tx.get('flux_analyses', line.analysis_id) : null;
      // A consolidated analysis is in the reporting currency; a budget analysis in its entity's currency.
      const currency = analysis?.entity_id ? functional(analysis.entity_id) : (tenant?.reporting_currency ?? 'USD');
      return { type: 'flux', account: a ? `${a.number} ${a.name}` : null, currency, current: line?.current_minor, comparison: line?.comparison_minor, variance: line?.variance_minor, variancePct: line?.variance_pct, explanation: pl.explanation, drivers: pl.drivers, coverage: pl.coverage };
    }
    case 'anomaly': {
      const res = pl.resolution as Record<string, unknown>;
      let resolution: Record<string, unknown> = { type: res.type };
      if (res.type === 'reverse_entry') {
        const e = await tx.get('journal_entries', String(res.entryId));
        resolution = { type: 'reverse_entry', reason: res.reason, entry: e ? { id: e.id, number: e.entry_number, description: e.description, total: e.total_minor, currency: functional(e.entity_id), date: e.entry_date, externalRef: e.external_ref, preparedBy: e.external_prepared_by, approvedBy: e.external_approved_by } : null };
      } else if (res.type === 'journal_entry') resolution = { type: 'journal_entry', entry: entryView(res.entry as Record<string, unknown>), voidBillIds: res.voidBillIds ?? [] };
      return { type: 'anomaly', category: pl.category, severity: pl.severity, recommendedAction: pl.recommendedAction, resolution };
    }
    case 'schedule':
      if (pl.type === 'prepaid') return { type: 'prepaid_schedule', currency: functional(pl.entity), description: pl.description, total: pl.totalMinor, months: pl.months, startDate: pl.startDate, balanceAccount: acct(String(pl.balanceAccount)), plAccount: acct(String(pl.plAccount)), catchUpThrough: pl.catchUpThrough, catchUpEntry: entryView(pl.catchUpEntry as Record<string, unknown>) };
      return { type: 'capitalize', currency: functional(pl.entity), description: pl.description, cost: pl.costMinor, assetClass: pl.assetClass, usefulLifeMonths: pl.usefulLifeMonths, inServiceDate: pl.inServiceDate, assetAccount: acct(String(pl.assetAccount)), reclass: entryView(pl.reclass as Record<string, unknown>) };
    case 'task_update': {
      const content = pl.content as Record<string, unknown>;
      return { type: 'close_package', closeId: pl.closeId, contentHash: pl.contentHash, openBlockers: content.openBlockers, agentActivity: content.agentActivity, entities: content.entities };
    }
    default:
      return { type: 'raw', payload: pl };
  }
}

export async function proposalDetail(app: App, p: Principal, id: string) {
  requirePermission(p, 'proposal.view');
  return app.read(async (tx) => {
    const x = await tx.get('proposals', id);
    if (!x || x.tenant_id !== p.tenantId || !canSeeEntity(p, x.entity_id)) app.notFound('Proposal');
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u]));
    const entities = new Map((await tx.find('entities', { tenant_id: p.tenantId })).map((e) => [e.id, e]));
    const summary = await proposalSummary(tx, app, p, x, { users, entities });
    const approvals = await tx.find('approvals', { proposal_id: id }, { orderBy: [['created_at', 'asc']] });
    const run = x.run_id ? await tx.get('agent_runs', x.run_id) : null;
    const policy = x.policy_id ? await tx.get('skill_policies', x.policy_id) : null;
    const entry = x.posted_entry_id ? await tx.get('journal_entries', x.posted_entry_id) : null;
    return {
      ...summary,
      evidence: x.evidence,
      verification: x.verification,
      effect: x.effect,
      detail: await payloadDetail(tx, p, x),
      approvals: approvals.map((a) => ({ decision: a.decision, user: users.get(a.user_id)?.display_name ?? a.user_id, role: a.role_key, reason: a.reason, at: a.created_at })),
      run: run ? { id: run.id, skill: run.skill_key, status: run.status, mode: run.mode, model: run.model, requestedBy: run.requested_by_label, startedAt: run.started_at } : null,
      policy: policy ? { id: policy.id, version: policy.version, autonomy: policy.autonomy_level, author: policy.created_by ? users.get(policy.created_by)?.display_name ?? null : 'package default' } : null,
      postedEntry: entry ? { id: entry.id, number: entry.entry_number } : null,
    };
  });
}

async function decideOne(app: App, p: Principal, id: string, decision: 'approve' | 'reject', reason: string | undefined, meta: RequestMeta) {
  requirePermission(p, 'proposal.view');
  return app.tx(async (tx) => {
    const ctx = app.ctx(p, meta);
    return decision === 'approve' ? approveProposal(tx, ctx, rt(app), p, id, reason) : rejectProposal(tx, ctx, rt(app), p, id, reason ?? '');
  });
}

/** Approve or reject one proposal; then let the close orchestrator pick up any tasks this unblocked. */
export async function decide(app: App, p: Principal, id: string, decision: 'approve' | 'reject', reason: string | undefined, meta: RequestMeta = {}) {
  const result = await decideOne(app, p, id, decision, reason, meta);
  await continueClose(app, p.tenantId);
  return result;
}

/**
 * Bulk decisions run one transaction per item: one failure never rolls back the others. A bulk approval must
 * echo the count and total the person confirmed, and never applies a flagged, failed-check or low-confidence
 * item: those are opened and decided one by one.
 */
export async function decideBulk(app: App, p: Principal, ids: string[], decision: 'approve' | 'reject', reason: string | undefined, meta: RequestMeta = {}, confirm?: { count: number; totalMinor: number }) {
  if (ids.length > 200) throw new DomainError('VALIDATION', 'At most 200 items per bulk action.');
  if (decision === 'reject' && (!reason || reason.trim().length < 3)) throw new DomainError('VALIDATION', 'Give a reason for rejecting.');
  const unique = [...new Set(ids)];
  const rows = new Map((await app.read((tx) => tx.find('proposals', { tenant_id: p.tenantId, id: { in: unique } }))).filter((r) => canSeeEntity(p, r.entity_id)).map((r) => [r.id, r]));
  if (decision === 'approve') {
    if (!confirm) throw new DomainError('VALIDATION', 'Confirm the number of items and their total before approving in bulk.');
    const total = unique.reduce((s, id) => s + (rows.get(id)?.amount_minor ?? 0), 0);
    if (confirm.count !== unique.length || confirm.totalMinor !== total) throw new DomainError('CONFLICT', 'The selection changed after you confirmed it; review it again.', { count: unique.length, totalMinor: total });
  }
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of unique) {
    const row = rows.get(id);
    if (!row) {
      results.push({ id, ok: false, error: 'Proposal not found' });
      continue;
    }
    const individually = decision === 'approve' ? bulkApprovalBlock(row) : null;
    if (individually) {
      results.push({ id, ok: false, error: individually });
      continue;
    }
    try {
      await decideOne(app, p, id, decision, reason, meta);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (results.some((r) => r.ok)) await continueClose(app, p.tenantId);
  return { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

export async function adopt(app: App, p: Principal, id: string, meta: RequestMeta = {}) {
  return app.tx((tx) => adoptSuggestion(tx, app.ctx(p, meta), p, id));
}

export async function postHocReview(app: App, p: Principal, id: string, decision: 'confirm' | 'reverse', reason: string | undefined, meta: RequestMeta = {}) {
  return app.tx(async (tx) => {
    const ctx = app.ctx(p, meta);
    return reviewAutoApplied(tx, ctx, rt(app), p, id, decision, reason, async (proposal) => {
      if (!proposal.posted_entry_id) return { note: 'No ledger effect to reverse; marked as reversed for the record.' };
      const reversal = await reverseEntry(tx, ctx, await app.lookups(tx, p.tenantId), proposal.posted_entry_id, { reason: `Post-hoc review: ${reason ?? 'reversed'}`, basis: { basis: 'human_approval', approvedBy: p.user.id }, preparedBy: null, proposalId: proposal.id });
      if (proposal.kind === 'transaction_coding') {
        const cardId = (proposal.payload as { cardTransactionId?: string }).cardTransactionId;
        if (cardId) await tx.update('card_transactions', cardId, { status: 'pending', coded_account_id: null, coded_department_id: null, coding_source: null, coding_confidence: null, journal_entry_id: null });
      }
      return { reversalEntryId: reversal.id, reversalNumber: reversal.entry_number };
    });
  });
}
