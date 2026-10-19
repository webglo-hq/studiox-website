import type { GateExplanation } from '../../../framework/runtime/types';
import type { Row } from '../../../framework/store/schema';
import { AppError } from '../../../framework/util/errors';
import { audit } from '../domain/audit';
import { hasPermission, requirePermission, withDb, type ServiceContext } from '../domain/context';
import { reverseEntry } from '../domain/ledger';
import { loadActor } from '../domain/rbac';
import { accounts, dimensionById, entities } from '../domain/refdata';
import { formatMoney } from '../../../framework/util/money';
import { closeOntology } from '../ontology';
import type { EkSchema } from '../store';
import { peopleMap, type PersonRef } from './common';

/** Ontology ids (ek:Existence) shown as their plain labels (Existence). */
function termLabel(id: string): string {
  return closeOntology().explain(id)?.label ?? id.replace(/^ek:/, '');
}

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
  // The agent's draft package goes to the people who sign packages (the CFO, or a controller
  // who neither owns the task nor started the run).
  close_package: 'package.approve',
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
  if (a.userId && requestedBy === a.userId) reasons.push('SOD-02: you started the agent run that prepared this, so someone else must approve it.');
  else if (a.userId && taskOwner === a.userId) reasons.push('SOD-01: you own the task this was prepared for, so someone else must approve it.');
  if (p.entity_id && a.entityScope !== 'all' && !a.entityScope.includes(p.entity_id)) reasons.push('Outside your entities.');
  return { ok: reasons.length === 0, reasons };
}

/** Holds that mean "open this one and decide it on its own, with the evidence in view". */
const INDIVIDUAL_REVIEW: Record<string, string> = {
  untrusted_text: 'Flagged: its sources contain instruction-like text.',
  low_confidence: 'Its confidence is below the policy floor.',
  policy_rule: 'A policy rule asks for a person to look at it.',
  review_requested: 'The agent or a policy rule asked for a person to look at it.',
  amount_unknown: 'Its amount could not be computed.',
};

/**
 * Whether an item may be approved in bulk. Items flagged for instruction-like text, below the
 * policy's confidence floor, or held by a policy rule or at the agent's request are approved
 * one at a time, never swept up by "select all".
 */
export function bulkGuard(p: ProposalRow): Guard {
  const gate = (p.verification as { gate?: GateExplanation }).gate;
  const codes = new Set(gate?.codes ?? []);
  if (p.injection_flag) codes.add('untrusted_text');
  if (gate && p.confidence < gate.minConfidence) codes.add('low_confidence');
  const reasons = [...codes].filter((c) => c in INDIVIDUAL_REVIEW).map((c) => INDIVIDUAL_REVIEW[c]!);
  if (reasons.length) reasons.push('Open it and approve it on its own.');
  return { ok: reasons.length === 0, reasons };
}

/** Everyone who could approve each open proposal: role, materiality, segregation of duties, scope. */
export async function approversFor(ctx: ServiceContext, rows: ProposalRow[]): Promise<Map<string, PersonRef[]>> {
  const users = await ctx.db.find('app_user', { tenant_id: ctx.tenantId, status: 'active' }, { orderBy: [['display_name', 'asc']] });
  const actors = await Promise.all(users.map((u) => loadActor(ctx.db, ctx.tenantId, u.id)));
  const runs = new Map((rows.length ? await ctx.db.find('agent_run', { id: { in: [...new Set(rows.map((r) => r.run_id))] } }) : []).map((r) => [r.id, r]));
  const taskIds = [...new Set([...runs.values()].map((r) => r.close_task_id).filter((x): x is string => !!x))];
  const owners = new Map((taskIds.length ? await ctx.db.find('close_task', { id: { in: taskIds } }) : []).map((t) => [t.id, t.owner_id]));
  const out = new Map<string, PersonRef[]>();
  for (const r of rows) {
    const run = runs.get(r.run_id);
    const owner = run?.close_task_id ? (owners.get(run.close_task_id) ?? null) : null;
    out.set(r.id, actors.filter((a) => approveGuard({ ...ctx, actor: a }, r, run?.requested_by ?? null, owner).ok).map((a) => ({ id: a.userId!, name: a.label, title: users.find((u) => u.id === a.userId)?.title ?? null })));
  }
  return out;
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
  run: { id: string; taskCode: string | null; taskTitle: string | null; requestedBy: PersonRef | null; owner: PersonRef | null; engine: string; model: string | null };
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionReason: string | null;
  reviewedBy: PersonRef | null;
  appliedRef: Record<string, unknown> | null;
  createdAt: string;
  canApprove: Guard;
  /** May be approved with others ("select all"); otherwise it must be opened and approved alone. */
  canBulkApprove: Guard;
  canReject: Guard;
  canReview: Guard;
  canUndo: Guard;
  payload: Record<string, unknown>;
  preview: ProposalPreview;
}

/** The payload in words: account codes and names instead of ids, for people to review. */
export interface ProposalPreview {
  fields: { label: string; value: string }[];
  lines: { account: string; debit: number; credit: number; memo: string | null; dimension: string | null }[] | null;
  drivers: { label: string; kind: string; amount: number }[] | null;
}

type Lookups = { accs: Awaited<ReturnType<typeof accounts>>; dims: Awaited<ReturnType<typeof dimensionById>>; ents: Awaited<ReturnType<typeof entities>> };

function previewOf(kind: string, payload: Record<string, unknown>, currency: string | null, L: Lookups): ProposalPreview {
  const acct = (id: unknown) => {
    const a = typeof id === 'string' ? L.accs.get(id) : undefined;
    return a ? `${a.code} ${a.name}` : '—';
  };
  const dim = (id: unknown) => (typeof id === 'string' ? (L.dims.get(id)?.name ?? null) : null);
  const ent = (id: unknown) => (typeof id === 'string' ? (L.ents.get(id)?.code ?? '—') : '—');
  const cur = currency ?? 'USD';
  const m = (v: unknown) => (typeof v === 'number' ? formatMoney(v, cur) : '—');
  const str = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
  const f = (label: string, value: string) => ({ label, value });
  const P = payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (kind) {
    case 'journal_entry':
      return {
        fields: [f('Entity', ent(P.entityId)), f('Date', str(P.entryDate)), f('Entry type', str(P.entryType).replace(/_/g, ' ')), f('Memo', str(P.memo)), ...(P.autoReverseDate ? [f('Reverses automatically on', str(P.autoReverseDate))] : [])],
        lines: ((P.lines ?? []) as Record<string, unknown>[]).map((l) => ({ account: acct(l.accountId), debit: Number(l.debit ?? 0), credit: Number(l.credit ?? 0), memo: (l.memo as string | undefined) ?? null, dimension: dim(l.departmentId) ?? (typeof l.counterpartyEntityId === 'string' ? `IC ${ent(l.counterpartyEntityId)}` : null) })),
        drivers: null,
      };
    case 'coding':
      return {
        fields: [
          f('Code to', acct(P.accountId)),
          f('Treatment', str(P.treatment)),
          ...(P.departmentId ? [f('Department', dim(P.departmentId) ?? '—')] : []),
          f('Based on', ((P.basis ?? []) as string[]).map((b) => b.replace(/_/g, ' ')).join(', ') || '—'),
          ...(P.previousAccountId ? [f('Previously', acct(P.previousAccountId))] : []),
          ...(((P.alternatives ?? []) as { accountId: string; score: number }[]).length ? [f('Alternatives', ((P.alternatives ?? []) as { accountId: string; score: number }[]).map((a) => `${acct(a.accountId)} (${Math.round(a.score * 100)}%)`).join('; '))] : []),
        ],
        lines: null,
        drivers: null,
      };
    case 'rec_match': {
      const bank = (P.bankItems ?? []) as { amount: number; label?: string }[];
      const led = (P.ledgerItems ?? []) as { amount: number; label?: string }[];
      return {
        fields: [
          f('Match type', str(P.matchType).replace(/_/g, ' ')),
          f('Bank side', `${bank.length} line${bank.length === 1 ? '' : 's'} · ${m(bank.reduce((x, b) => x + b.amount, 0))}`),
          f('Ledger side', `${led.length} line${led.length === 1 ? '' : 's'} · ${m(led.reduce((x, b) => x + b.amount, 0))}`),
          f('Days apart', str(P.dateDeltaDays)),
          ...(typeof P.nameScore === 'number' ? [f('Name similarity', `${Math.round(P.nameScore * 100)}%`)] : []),
          ...bank.slice(0, 3).map((b, i) => f(`Bank ${i + 1}`, `${b.label ?? ''} ${m(b.amount)}`.trim())),
          ...led.slice(0, 3).map((b, i) => f(`Ledger ${i + 1}`, `${b.label ?? ''} ${m(b.amount)}`.trim())),
        ],
        lines: null,
        drivers: null,
      };
    }
    case 'reconciling_item':
      return { fields: [f('Item type', str(P.itemType).replace(/_/g, ' ')), f('Side', P.side === 'bank' ? 'On the statement, not in the books' : 'In the books, not on the statement'), f('Amount', m(P.amount)), f('Description', str(P.description)), f('Origin date', str(P.originDate)), f('Expected to clear', str(P.expectedClearDate))], lines: null, drivers: null };
    case 'flux_explanation':
      return {
        fields: [f('Account', acct(P.accountId)), f('Entity', ent(P.entityId)), f('Compared with', str(P.comparison).replace(/_/g, ' ')), f('Variance', m(P.variance)), f('Explained by drivers', `${Math.round(Number(P.coverage ?? 0) * 100)}%`), f('Narrative', str(P.narrative))],
        lines: null,
        drivers: ((P.drivers ?? []) as { label: string; kind: string; amount: number }[]).map((d) => ({ label: d.label, kind: d.kind, amount: d.amount })),
      };
    case 'issue':
      return { fields: [f('Category', str(P.category).replace(/_/g, ' ')), f('Severity', str(P.severity)), f('Description', str(P.description)), f('Recommended action', str(P.recommendedAction)), ...(P.assertions?.length ? [f('Assertions at risk', (P.assertions as string[]).map(termLabel).join(', '))] : [])], lines: null, drivers: null };
    case 'prepaid_schedule':
      return { fields: [f('Entity', ent(P.entityId)), f('Description', str(P.description)), f('Total', m(P.total)), f('Starts', str(P.startPeriod)), f('Months', str(P.months)), f('Prepaid account', acct(P.prepaidAccountId)), f('Expense account', acct(P.expenseAccountId))], lines: null, drivers: null };
    case 'fixed_asset':
      return { fields: [f('Entity', ent(P.entityId)), f('Asset', `${str(P.name)}${P.quantity > 1 ? ` × ${P.quantity}` : ''}`), f('Class', str(P.assetClass).replace(/_/g, ' ')), f('Cost', m(P.cost)), f('In service', str(P.inServiceDate)), f('Useful life', `${str(P.usefulLifeMonths)} months`), f('Asset account', acct(P.assetAccountId)), f('Depreciation expense', acct(P.deprExpenseAccountId))], lines: null, drivers: null };
    case 'close_package':
      return { fields: [f('Period', str(P.periodKey)), f('Commentary', str(P.commentary).slice(0, 600))], lines: null, drivers: null };
    default:
      return { fields: Object.entries(P).slice(0, 8).map(([k, v]) => f(k, typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : str(v))), lines: null, drivers: null };
  }
}

async function toViews(ctx: ServiceContext, rows: ProposalRow[]): Promise<ProposalView[]> {
  const runs = new Map((rows.length ? await ctx.db.find('agent_run', { id: { in: [...new Set(rows.map((r) => r.run_id))] } }) : []).map((r) => [r.id, r]));
  const taskIds = [...new Set([...runs.values()].map((r) => r.close_task_id).filter((x): x is string => !!x))];
  const tasks = new Map((taskIds.length ? await ctx.db.find('close_task', { id: { in: taskIds } }) : []).map((t) => [t.id, t]));
  const people = await peopleMap(ctx);
  const ents = await entities(ctx);
  const lookups: Lookups = { accs: await accounts(ctx), dims: await dimensionById(ctx), ents };
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
      run: { id: r.run_id, taskCode: task?.code ?? null, taskTitle: task?.title ?? null, requestedBy: p(run?.requested_by ?? null), owner: p(task?.owner_id ?? null), engine: run?.engine ?? 'offline', model: run?.model ?? null },
      decidedBy: p(r.decided_by),
      decidedAt: r.decided_at,
      decisionReason: r.decision_reason,
      reviewedBy: p(r.reviewed_by),
      appliedRef: r.applied_ref,
      createdAt: r.created_at,
      canApprove: approve,
      canBulkApprove: approve.ok ? bulkGuard(r) : approve,
      canReject: reject,
      canReview: { ok: reviewReasons.length === 0, reasons: reviewReasons },
      canUndo: { ok: undoReasons.length === 0, reasons: undoReasons },
      payload: r.payload,
      preview: previewOf(r.kind, r.payload, r.currency, lookups),
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
