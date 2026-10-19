import { appendAudit } from '../../../audit/audit';
import type { Tx } from '../../../persistence/db';
import type { Row } from '../../../persistence/schema';
import type { DomainContext } from '../../../shared/context';
import { type BusinessCalendar, monthEnd, usBusinessCalendar, workdayToDate } from '../../../shared/dates';
import { DomainError } from '../../../shared/errors';
import { newId } from '../../../shared/ids';
import type { LedgerLookups } from './lookups';

export type TaskCategory = Row<'close_tasks'>['category'];

export interface TemplateTask {
  key: string;
  title: string;
  description: string;
  category: TaskCategory;
  workday: number;
  scope: 'each_entity' | 'parent' | 'consolidated';
  ownerRole: string;
  reviewerRole: string | null;
  skillKey: string | null;
  dependsOn: string[];
  evidenceRequired: boolean;
}

/** The monthly close SOP as data (the checklist template). */
export const MONTHLY_CLOSE_TEMPLATE: TemplateTask[] = [
  { key: 'import-bank', title: 'Import bank statements', description: 'Bring in month-end statements from every bank feed (BAI2, camt.053, OFX).', category: 'cash', workday: 1, scope: 'each_entity', ownerRole: 'staff_accountant', reviewerRole: null, skillKey: null, dependsOn: [], evidenceRequired: true },
  { key: 'ap-cutoff', title: 'AP cutoff and invoice capture', description: 'Enter every vendor invoice received through period end; hold later invoices for accrual review.', category: 'ap', workday: 1, scope: 'each_entity', ownerRole: 'ap_clerk', reviewerRole: null, skillKey: null, dependsOn: [], evidenceRequired: false },
  { key: 'card-coding', title: 'Code card transactions', description: 'Code every card transaction to an account and department; fix misclassified spend.', category: 'cards', workday: 1, scope: 'each_entity', ownerRole: 'staff_accountant', reviewerRole: 'senior_accountant', skillKey: 'transaction-coding', dependsOn: [], evidenceRequired: false },
  { key: 'bank-rec', title: 'Reconcile bank accounts', description: 'Match statement lines to the ledger, explain timing differences, investigate anything unexplained.', category: 'cash', workday: 2, scope: 'each_entity', ownerRole: 'staff_accountant', reviewerRole: 'senior_accountant', skillKey: 'bank-reconciliation', dependsOn: ['import-bank'], evidenceRequired: true },
  { key: 'accruals', title: 'Record accruals', description: 'Find unrecorded liabilities (recurring vendors, received-not-invoiced POs, late invoices) and accrue them with auto-reversal.', category: 'accruals', workday: 2, scope: 'each_entity', ownerRole: 'senior_accountant', reviewerRole: 'controller', skillKey: 'accrual-detection', dependsOn: ['ap-cutoff'], evidenceRequired: true },
  { key: 'prepaids', title: 'Amortize prepaid expenses', description: 'Post this month\'s amortization for every prepaid schedule; catch missed months.', category: 'prepaids', workday: 2, scope: 'each_entity', ownerRole: 'staff_accountant', reviewerRole: 'senior_accountant', skillKey: 'prepaid-amortization', dependsOn: ['ap-cutoff'], evidenceRequired: false },
  { key: 'depreciation', title: 'Record depreciation', description: 'Post depreciation from the fixed-asset register, including newly capitalized assets.', category: 'fixed_assets', workday: 2, scope: 'each_entity', ownerRole: 'staff_accountant', reviewerRole: 'senior_accountant', skillKey: 'fixed-asset-depreciation', dependsOn: ['card-coding'], evidenceRequired: false },
  { key: 'ap-tieout', title: 'Tie out AP to the GL', description: 'AP subledger total must equal the Accounts payable control account.', category: 'ap', workday: 3, scope: 'each_entity', ownerRole: 'staff_accountant', reviewerRole: 'senior_accountant', skillKey: 'subledger-tieout', dependsOn: ['accruals', 'bank-rec'], evidenceRequired: true },
  { key: 'ar-tieout', title: 'Tie out AR to the GL', description: 'AR subledger total must equal the Accounts receivable control account.', category: 'ar', workday: 3, scope: 'each_entity', ownerRole: 'staff_accountant', reviewerRole: 'senior_accountant', skillKey: 'subledger-tieout', dependsOn: ['bank-rec'], evidenceRequired: true },
  { key: 'je-review', title: 'Review journal entries', description: 'Scan the month\'s entries for duplicates, SoD breaks, weekend and round-amount postings.', category: 'review', workday: 3, scope: 'consolidated', ownerRole: 'senior_accountant', reviewerRole: 'controller', skillKey: 'je-review', dependsOn: ['card-coding', 'accruals'], evidenceRequired: false },
  { key: 'ic-rec', title: 'Reconcile intercompany balances', description: 'Agree intercompany charges and balances between entities; resolve mismatches before eliminating.', category: 'intercompany', workday: 3, scope: 'consolidated', ownerRole: 'senior_accountant', reviewerRole: 'controller', skillKey: 'intercompany', dependsOn: ['accruals'], evidenceRequired: true },
  { key: 'fx-reval', title: 'Revalue foreign-currency balances', description: 'Remeasure foreign-currency monetary balances at the closing rate.', category: 'fx', workday: 3, scope: 'consolidated', ownerRole: 'senior_accountant', reviewerRole: 'controller', skillKey: 'fx-revaluation', dependsOn: ['ic-rec'], evidenceRequired: false },
  { key: 'eliminations', title: 'Post consolidation eliminations', description: 'Eliminate intercompany revenue, expense and balances in the elimination entity (translated per ASC 830).', category: 'intercompany', workday: 4, scope: 'consolidated', ownerRole: 'senior_accountant', reviewerRole: 'controller', skillKey: 'intercompany-eliminations', dependsOn: ['ic-rec', 'fx-reval'], evidenceRequired: true },
  { key: 'bs-recs', title: 'Certify balance-sheet reconciliations', description: 'Every balance-sheet reconciliation prepared and independently reviewed.', category: 'review', workday: 4, scope: 'each_entity', ownerRole: 'senior_accountant', reviewerRole: 'controller', skillKey: null, dependsOn: ['bank-rec', 'ap-tieout', 'ar-tieout', 'prepaids', 'depreciation'], evidenceRequired: true },
  { key: 'flux', title: 'Flux analysis and commentary', description: 'Explain material variances against prior month and budget with driver-based commentary.', category: 'review', workday: 4, scope: 'consolidated', ownerRole: 'fpa_analyst', reviewerRole: 'controller', skillKey: 'flux-analysis', dependsOn: ['ap-tieout', 'ar-tieout', 'prepaids', 'depreciation', 'je-review', 'eliminations'], evidenceRequired: true },
  { key: 'close-package', title: 'Prepare the close package', description: 'Trial balance, statements, commentary, reconciliation status and exceptions.', category: 'reporting', workday: 5, scope: 'consolidated', ownerRole: 'senior_accountant', reviewerRole: 'controller', skillKey: 'close-package', dependsOn: ['flux', 'bs-recs'], evidenceRequired: true },
  { key: 'lock', title: 'Lock the period', description: 'Soft-close, final review and hard-lock the period for every entity.', category: 'lock', workday: 5, scope: 'consolidated', ownerRole: 'controller', reviewerRole: 'cfo', skillKey: null, dependsOn: ['close-package'], evidenceRequired: false },
];

export async function businessCalendar(tx: Tx, tenantId: string): Promise<BusinessCalendar> {
  const extra = (await tx.find('holidays', { tenant_id: tenantId })).map((h) => h.holiday_date);
  return usBusinessCalendar(extra);
}

export async function createClose(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  args: { fiscalYear: number; periodNumber: number; template?: TemplateTask[]; assignees: Record<string, string>; targetWorkday?: number },
): Promise<Row<'closes'>> {
  const template = args.template ?? MONTHLY_CLOSE_TEMPLATE;
  const calendar = await businessCalendar(tx, ctx.tenantId);
  const periodEnd = monthEnd(args.fiscalYear, args.periodNumber);
  const close = await tx.insert('closes', {
    tenant_id: ctx.tenantId,
    fiscal_year: args.fiscalYear,
    period_number: args.periodNumber,
    name: `${new Date(`${periodEnd}T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${args.fiscalYear} close`,
    period_end: periodEnd,
    target_workday: args.targetWorkday ?? 5,
    status: 'in_progress',
    started_at: ctx.clock.now(),
  });
  const entities = lookups.operatingEntities().sort((a, b) => (a.parent_entity_id ? 1 : 0) - (b.parent_entity_id ? 1 : 0) || a.code.localeCompare(b.code));
  const parent = entities.find((e) => !e.parent_entity_id) ?? entities[0]!;
  const created = new Map<string, Row<'close_tasks'>[]>();
  let order = 0;
  for (const t of template) {
    const scoped = t.scope === 'each_entity' ? entities : [t.scope === 'parent' ? parent : null];
    for (const entity of scoped) {
      const task = await tx.insert('close_tasks', {
        id: newId(),
        tenant_id: ctx.tenantId,
        close_id: close.id,
        key: t.key,
        entity_id: entity?.id ?? null,
        title: entity ? `${t.title} (${entity.code})` : t.title,
        description: t.description,
        category: t.category,
        due_workday: t.workday,
        due_date: workdayToDate(periodEnd, t.workday, calendar),
        owner_id: args.assignees[t.ownerRole] ?? null,
        reviewer_id: t.reviewerRole ? (args.assignees[t.reviewerRole] ?? null) : null,
        skill_key: t.skillKey,
        evidence_required: t.evidenceRequired,
        sort_order: order++,
      });
      const list = created.get(t.key) ?? [];
      list.push(task);
      created.set(t.key, list);
    }
  }
  for (const t of template) {
    for (const task of created.get(t.key) ?? []) {
      for (const depKey of t.dependsOn) {
        const deps = created.get(depKey) ?? [];
        // Same-entity dependency when both are per entity; otherwise depend on every instance.
        const targets = task.entity_id ? deps.filter((d) => d.entity_id === task.entity_id || d.entity_id === null) : deps;
        for (const d of targets.length ? targets : deps) {
          await tx.insert('close_task_dependencies', { tenant_id: ctx.tenantId, task_id: task.id, depends_on_task_id: d.id });
        }
      }
    }
  }
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'close.create', objectType: 'close', objectId: close.id, summary: `Created ${close.name} with ${order} tasks`, details: { tasks: order } }, ctx.clock.now());
  return close;
}

export interface TaskState {
  task: Row<'close_tasks'>;
  dependsOn: string[];
  ready: boolean;
  blockedBy: Row<'close_tasks'>[];
}

const DONE = new Set(['done', 'skipped']);

export async function taskStates(tx: Tx, closeId: string): Promise<TaskState[]> {
  const tasks = await tx.find('close_tasks', { close_id: closeId }, { orderBy: [['sort_order', 'asc']] });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const deps = await tx.find('close_task_dependencies', { task_id: { in: tasks.map((t) => t.id) } });
  return tasks.map((task) => {
    const mine = deps.filter((d) => d.task_id === task.id).map((d) => d.depends_on_task_id);
    const blockedBy = mine.map((id) => byId.get(id)!).filter((d) => d && !DONE.has(d.status));
    return { task, dependsOn: mine, ready: blockedBy.length === 0, blockedBy };
  });
}

/** Detect dependency cycles (should never happen with the template, but closes can be edited). */
export function findCycle(edges: Array<{ task_id: string; depends_on_task_id: string }>): string[] | null {
  const graph = new Map<string, string[]>();
  for (const e of edges) graph.set(e.task_id, [...(graph.get(e.task_id) ?? []), e.depends_on_task_id]);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    stack.push(n);
    for (const m of graph.get(n) ?? []) {
      const c = visit(m);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of graph.keys()) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

export async function startTask(tx: Tx, ctx: DomainContext, taskId: string): Promise<Row<'close_tasks'>> {
  const task = await tx.get('close_tasks', taskId);
  if (!task) throw new DomainError('NOT_FOUND', 'task not found');
  if (task.status !== 'not_started' && task.status !== 'blocked') return task;
  const states = await taskStates(tx, task.close_id);
  const st = states.find((s) => s.task.id === taskId)!;
  if (!st.ready) {
    return tx.update('close_tasks', taskId, { status: 'blocked', blocked_reason: `Waiting on: ${st.blockedBy.map((b) => b.title).join(', ')}` });
  }
  return tx.update('close_tasks', taskId, { status: 'in_progress', started_at: ctx.clock.now(), blocked_reason: null });
}

export async function completeTask(tx: Tx, ctx: DomainContext, taskId: string, opts: { runId?: string | null; note?: string } = {}): Promise<Row<'close_tasks'>> {
  const task = await tx.get('close_tasks', taskId);
  if (!task) throw new DomainError('NOT_FOUND', 'task not found');
  if (DONE.has(task.status)) return task;
  const states = await taskStates(tx, task.close_id);
  const st = states.find((s) => s.task.id === taskId)!;
  if (!st.ready) throw new DomainError('CONFLICT', `"${task.title}" is waiting on: ${st.blockedBy.map((b) => b.title).join(', ')}`);
  const next = task.reviewer_id ? 'ready_for_review' : 'done';
  const updated = await tx.update('close_tasks', taskId, {
    status: next,
    started_at: task.started_at ?? ctx.clock.now(),
    completed_at: ctx.clock.now(),
    completed_by: opts.runId ? null : ctx.actor.userId,
    completed_by_run_id: opts.runId ?? null,
    blocked_reason: null,
  });
  await tx.insert('signoffs', { tenant_id: ctx.tenantId, object_type: 'close_task', object_id: taskId, role: 'preparer', user_id: ctx.actor.userId ?? task.owner_id!, comment: opts.note ?? (opts.runId ? 'Completed by agent run' : null) });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'close_task.complete', objectType: 'close_task', objectId: taskId, summary: `${task.title}: ${next === 'done' ? 'done' : 'ready for review'}`, details: { run_id: opts.runId ?? null } }, ctx.clock.now());
  return updated;
}

export async function reviewTask(tx: Tx, ctx: DomainContext, taskId: string, decision: 'approve' | 'send_back', note?: string): Promise<Row<'close_tasks'>> {
  const task = await tx.get('close_tasks', taskId);
  if (!task) throw new DomainError('NOT_FOUND', 'task not found');
  if (task.status !== 'ready_for_review') throw new DomainError('CONFLICT', 'task is not waiting for review');
  if (ctx.actor.userId && ctx.actor.userId === task.completed_by) throw new DomainError('SOD_VIOLATION', 'You completed this task; another person must review it.');
  if (decision === 'send_back') {
    const t = await tx.update('close_tasks', taskId, { status: 'in_progress', completed_at: null, completed_by: null, completed_by_run_id: null, blocked_reason: note ? `Sent back: ${note}` : 'Sent back by reviewer' });
    await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'close_task.send_back', objectType: 'close_task', objectId: taskId, summary: `${task.title} sent back${note ? `: ${note}` : ''}` }, ctx.clock.now());
    return t;
  }
  const t = await tx.update('close_tasks', taskId, { status: 'done', reviewed_at: ctx.clock.now(), reviewed_by: ctx.actor.userId });
  await tx.insert('signoffs', { tenant_id: ctx.tenantId, object_type: 'close_task', object_id: taskId, role: 'reviewer', user_id: ctx.actor.userId!, comment: note ?? null });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'close_task.review', objectType: 'close_task', objectId: taskId, summary: `${task.title} reviewed and done` }, ctx.clock.now());
  return t;
}

/** Close progress for dashboards. */
export function closeProgress(states: TaskState[]) {
  const total = states.length;
  const done = states.filter((s) => DONE.has(s.task.status)).length;
  const review = states.filter((s) => s.task.status === 'ready_for_review').length;
  const inProgress = states.filter((s) => s.task.status === 'in_progress').length;
  const blocked = states.filter((s) => !s.ready && !DONE.has(s.task.status)).length;
  return { total, done, review, inProgress, blocked, pct: total ? done / total : 0 };
}
