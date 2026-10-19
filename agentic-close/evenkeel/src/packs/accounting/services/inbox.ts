import type { Row } from '../../../framework/store/schema';
import { AppError } from '../../../framework/util/errors';
import { audit } from '../domain/audit';
import { hasPermission, requirePermission, withDb, type ServiceContext } from '../domain/context';
import { reverseEntry } from '../domain/ledger';
import { entities } from '../domain/refdata';
import type { EkSchema } from '../store';
import { peopleMap, type PersonRef } from './common';

/**
 * The agent inbox: proposals waiting for people, post-hoc review queues and decided history,
 * each with the evidence, the "why", the confidence, what verification checked and whether
 * the current user may decide (permissions and segregation of duties, explained).
 */

type ProposalRow = Row<EkSchema, 'proposal'>;

const KIND_PERMISSION: Record<string, string> = {
  journal_entry: 'je.approve',
  coding: 'je.approve',
  prepaid_schedule: 'je.approve',
  fixed_asset: 'je.approve',
  rec_match: 'rec.review',
  reconciling_item: 'rec.review',
  flux_explanation: 'flux.approve',
  issue: 'issue.resolve',
  task_update: 'close.task.review',
  close_package: 'package.generate',
};

export const KIND_LABEL: Record<string, string> = {
  journal_entry: 'Journal entry',
  coding: 'Transaction coding',
  rec_match: 'Reconciliation match',
  reconciling_item: 'Reconciling item',
  flux_explanation: 'Variance explanation',
  issue: 'Exception',
  prepaid_schedule: 'Prepaid schedule',
  fixed_asset: 'Fixed asset',
  task_update: 'Task update',
  close_package: 'Close package',
};

export interface Guard {
  ok: boolean;
  reasons: string[];
}

export function approveGuard(ctx: ServiceContext, p: ProposalRow, requestedBy: string | null, taskOwner: string | null): Guard {
  const a = ctx.actor;
  const reasons: string[] = [];
  if (!['pending', 'suggested'].includes(p.status)) reasons.push(`Already ${p.status.replace('_', ' ')}.`);
  if (!hasPermission(a, 'proposal.approve')) reasons.push('Your role cannot approve agent proposals.');
  if (p.materiality === 'material' && !hasPermission(a, 'proposal.approve.material')) reasons.push('At or above performance materiality — needs a controller or CFO.');
  const extra = KIND_PERMISSION[p.kind];
  if (extra && !hasPermission(a, extra)) reasons.push(`Needs the ${extra} permission.`);
  if (a.userId && requestedBy === a.userId) reasons.push('SOD-02: the agent prepared this on your behalf, so someone else must approve it.');
  else if (a.userId && taskOwner === a.userId) reasons.push('SOD-01: you own the task this was prepared for, so someone else must approve it.');
  if (p.entity_id && a.entityScope !== 'all' && !a.entityScope.includes(p.entity_id)) reasons.push('Outside your entities.');
  return { ok: reasons.length === 0, reasons };
}

export interface ProposalView {
  id: string;
  kind: string;
  kindLabel: string;
  skillId: string;
  title: string;
  why: string;
  confidence: number;
  amount: number | null;
  currency: string | null;
  materiality: string;
  entityCode: string | null;
  periodKey: string | null;
  status: ProposalRow['status'];
  reviewStatus: ProposalRow['review_status'];
  gate: { decision: string; reasons: string[]; level: string; threshold: number; minConfidence: number } | null;
  checks: { id: string; label: string; ok: boolean; severity: string; detail?: string }[];
  evidence: { kind: string; label: string; detail?: string; ref?: { type: string; id: string; label?: string }; untrusted?: boolean }[];
  injectionFlag: boolean;
  run: { id: string; taskCode: string | null; taskTitle: string | null; requestedBy: PersonRef | null; engine: string; model: string | null };
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionReason: string | null;
  reviewedBy: PersonRef | null;
  appliedRef: Record<string, unknown> | null;
  createdAt: string;
  canApprove: Guard;
  canReject: Guard;
  canReview: Guard;
  canUndo: Guard;
  payload: Record<string, unknown>;
}

async function toViews(ctx: ServiceContext, rows: ProposalRow[]): Promise<ProposalView[]> {
  const runs = new Map((rows.length ? await ctx.db.find('agent_run', { id: { in: [...new Set(rows.map((r) => r.run_id))] } }) : []).map((r) => [r.id, r]));
  const taskIds = [...new Set([...runs.values()].map((r) => r.close_task_id).filter((x): x is string => !!x))];
  const tasks = new Map((taskIds.length ? await ctx.db.find('close_task', { id: { in: taskIds } }) : []).map((t) => [t.id, t]));
  const people = await peopleMap(ctx);
  const ents = await entities(ctx);
  const p = (id: string | null) => (id ? (people.get(id) ?? null) : null);
  return rows.map((r) => {
    const run = runs.get(r.run_id);
    const task = run?.close_task_id ? tasks.get(run.close_task_id) : undefined;
    const v = r.verification as { checks?: ProposalView['checks']; gate?: ProposalView['gate'] };
    const approve = approveGuard(ctx, r, run?.requested_by ?? null, task?.owner_id ?? null);
    const reject: Guard = { ok: ['pending', 'suggested'].includes(r.status) && hasPermission(ctx.actor, 'proposal.approve'), reasons: [] };
    if (!reject.ok) reject.reasons.push(['pending', 'suggested'].includes(r.status) ? 'Your role cannot reject agent proposals.' : `Already ${r.status.replace('_', ' ')}.`);
    const reviewReasons: string[] = [];
    if (!(r.status === 'auto_applied' && ['sampled', 'pending_review'].includes(r.review_status))) reviewReasons.push('Not waiting for a post-hoc review.');
    if (!hasPermission(ctx.actor, 'proposal.review')) reviewReasons.push('Your role cannot complete reviews.');
    if (run?.requested_by && run.requested_by === ctx.actor.userId) reviewReasons.push('SOD-02: you started this run.');
    const undoReasons: string[] = [];
    if (!['auto_applied', 'applied'].includes(r.status)) undoReasons.push('Only posted items can be undone.');
    if (!['coding', 'journal_entry'].includes(r.kind)) undoReasons.push('Undo is available for entries and coding; use the reconciliation or schedule screens for other items.');
    if ((r.payload as { entryType?: string }).entryType === 'accrual') undoReasons.push('Accruals reverse automatically; reverse the accrual from the journal instead.');
    if (!hasPermission(ctx.actor, 'je.reverse')) undoReasons.push('Your role cannot reverse entries.');
    if ((r.applied_ref as { undone?: boolean } | null)?.undone) undoReasons.push('Already undone.');
    return {
      id: r.id,
      kind: r.kind,
      kindLabel: KIND_LABEL[r.kind] ?? r.kind,
      skillId: r.skill_id,
      title: r.title,
      why: r.why,
      confidence: r.confidence,
      amount: r.amount,
      currency: r.currency,
      materiality: r.materiality,
      entityCode: r.entity_id ? (ents.get(r.entity_id)?.code ?? null) : null,
      periodKey: r.period_key,
      status: r.status,
      reviewStatus: r.review_status,
      gate: v.gate ?? null,
      checks: v.checks ?? [],
      evidence: r.evidence as ProposalView['evidence'],
      injectionFlag: r.injection_flag,
      run: { id: r.run_id, taskCode: task?.code ?? null, taskTitle: task?.title ?? null, requestedBy: p(run?.requested_by ?? null), engine: run?.engine ?? 'offline', model: run?.model ?? null },
      decidedBy: p(r.decided_by),
      decidedAt: r.decided_at,
      decisionReason: r.decision_reason,
      reviewedBy: p(r.reviewed_by),
      appliedRef: r.applied_ref,
      createdAt: r.created_at,
      canApprove: approve,
      canReject: reject,
      canReview: { ok: reviewReasons.length === 0, reasons: reviewReasons },
      canUndo: { ok: undoReasons.length === 0, reasons: undoReasons },
      payload: r.payload,
    };
  });
}

export type InboxTab = 'waiting' | 'mine' | 'review' | 'auto' | 'decided' | 'all';

export async function listProposals(ctx: ServiceContext, f: { tab?: InboxTab; kind?: string; skillId?: string; periodKey?: string; q?: string; limit?: number; offset?: number }) {
  requirePermission(ctx, 'close.view');
  const base: Record<string, unknown> = { tenant_id: ctx.tenantId };
  if (f.periodKey) base.period_key = f.periodKey;
  if (f.kind) base.kind = f.kind;
  if (f.skillId) base.skill_id = f.skillId;
  const all = await ctx.db.find('proposal', base as never, { orderBy: [['created_at', 'desc']] });
  const waiting = all.filter((p) => p.status === 'pending' || p.status === 'suggested');
  const review = all.filter((p) => p.status === 'auto_applied' && (p.review_status === 'sampled' || p.review_status === 'pending_review'));
  const auto = all.filter((p) => p.status === 'auto_applied');
  const decided = all.filter((p) => ['applied', 'approved', 'rejected', 'superseded', 'failed'].includes(p.status));
  const views = await toViews(ctx, waiting);
  const mine = views.filter((v) => v.canApprove.ok);
  const tab = f.tab ?? 'waiting';
  let rows: ProposalView[];
  if (tab === 'waiting') rows = views;
  else if (tab === 'mine') rows = mine;
  else rows = await toViews(ctx, tab === 'review' ? review : tab === 'auto' ? auto : tab === 'decided' ? decided : all);
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((r) => r.title.toLowerCase().includes(q) || r.why.toLowerCase().includes(q));
  }
  // Waiting items: material and low-confidence first, then by amount.
  if (tab === 'waiting' || tab === 'mine') rows.sort((a, b) => Number(b.materiality === 'material') - Number(a.materiality === 'material') || Number(b.injectionFlag) - Number(a.injectionFlag) || (b.amount ?? 0) - (a.amount ?? 0));
  const limit = Math.min(500, f.limit ?? 100);
  const offset = f.offset ?? 0;
  return {
    counts: { waiting: waiting.length, mine: mine.length, review: review.length, auto: auto.length, decided: decided.length, all: all.length, material: waiting.filter((w) => w.materiality === 'material').length },
    byKind: Object.entries(waiting.reduce<Record<string, number>>((m, w) => ({ ...m, [w.kind]: (m[w.kind] ?? 0) + 1 }), {})).map(([kind, n]) => ({ kind, label: KIND_LABEL[kind] ?? kind, n })),
    total: rows.length,
    items: rows.slice(offset, offset + limit),
  };
}

export async function getProposal(ctx: ServiceContext, id: string): Promise<ProposalView> {
  requirePermission(ctx, 'close.view');
  const p = await ctx.db.get('proposal', id);
  if (!p || p.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Proposal not found');
  return (await toViews(ctx, [p]))[0]!;
}

/**
 * Undo an applied entry or coding by posting its reversal (the ledger is never edited). Coded
 * card transactions return to the coding queue.
 */
export async function undoProposal(ctx: ServiceContext, id: string, reason: string) {
  const view = await getProposal(ctx, id);
  if (!view.canUndo.ok) throw new AppError('CONFLICT', view.canUndo.reasons.join(' '));
  if (!reason || reason.trim().length < 5) throw new AppError('VALIDATION', 'Give a reason for undoing (at least 5 characters).');
  const p = (await ctx.db.get('proposal', id))!;
  const ref = (p.applied_ref ?? {}) as Record<string, unknown>;
  const jeId = typeof ref.journalEntryId === 'string' ? ref.journalEntryId : null;
  if (!jeId) throw new AppError('CONFLICT', 'Nothing to undo: no entry was posted for this item.');
  const je = (await ctx.db.get('journal_entry', jeId))!;
  return ctx.db.tx(async (db) => {
    const t = withDb(ctx, db);
    const rev = await reverseEntry(t, jeId, { entryDate: je.entry_date, periodKey: je.period_key, reason: `Undo agent ${KIND_LABEL[p.kind]?.toLowerCase() ?? p.kind}: ${reason.trim()}` });
    if (p.kind === 'coding') {
      const txnId = (p.payload as { subjectId?: string }).subjectId;
      if (txnId) await db.update('card_transaction', txnId, { status: 'uncoded', account_id: null, department_id: null, coding_source: null, coding_confidence: null, journal_entry_id: null });
    }
    await db.update('proposal', p.id, { applied_ref: { ...ref, undone: true, undoEntryId: rev.id, undoEntryNumber: rev.entry_number } });
    await audit(t, { action: 'agent.proposal.undone', subjectType: 'proposal', subjectId: p.id, data: { reversal: rev.entry_number, reason: reason.trim() } });
    return { reversalEntryId: rev.id, reversalEntryNumber: rev.entry_number };
  });
}
