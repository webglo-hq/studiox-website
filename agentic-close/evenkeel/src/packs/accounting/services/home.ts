import { formatPeriod } from '../../../framework/util/dates';
import { canSeeEntity, entityFilter, hasPermission, requirePermission, type ServiceContext } from '../domain/context';
import { loadActor } from '../domain/rbac';
import { entityByCode } from '../domain/refdata';
import { closeCalendar, completionReadiness, type TaskView } from './close';
import { currentPeriodKey, type PersonRef } from './common';
import { fluxView } from './flux';
import { approversFor, listProposals } from './inbox';
import { listIssues } from './issues';
import { getPackage, listPackages } from './package';
import { lockReadiness, type LockReadiness } from './periods';
import { listRecs, type RecSummary } from './recs';
import { headline } from './reports';

/**
 * "My close": everything the signed-in person should do next, in plain language, with one
 * primary action. Built for staff who do not live in accounting software. Counts are the
 * person's own work, and when nothing is theirs to do while the month cannot lock yet, the page
 * says who the close is waiting on instead of "all set".
 */

export interface NextAction {
  title: string;
  detail: string;
  href: string;
  action?: 'orchestrate' | 'approve' | 'certify' | 'review' | 'lock' | 'package' | 'none';
  /** Label of the primary button (null: only the calendar link). */
  cta: string | null;
  /** The line above the title: "What to do next", "Waiting on others" or "All set". */
  kicker: string;
  tone: 'primary' | 'calm' | 'done';
}

const WAITING = 'Waiting on others';
const NEXT = 'What to do next';

const names = (people: (PersonRef | null | undefined)[]) => {
  const list = [...new Map(people.filter((p): p is PersonRef => !!p).map((p) => [p.id, p.name])).values()];
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
};
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Who the open lock checks wait on, in a sentence or two (only the first few items). */
async function waitingOn(ctx: ServiceContext, input: { ready: LockReadiness; tasks: TaskView[]; recs: RecSummary[]; periodKey: string }): Promise<string> {
  const parts: string[] = [];
  const failing = new Set(input.ready.checks.filter((c) => !c.ok).map((c) => c.id));
  if (failing.has('proposals')) {
    const rows = await ctx.db.find('proposal', { tenant_id: ctx.tenantId, period_key: input.periodKey, status: { in: ['pending', 'suggested'] } });
    const visible = rows.filter((r) => canSeeEntity(ctx, r.entity_id));
    const who = await approversFor(ctx, visible);
    const approvers = visible.flatMap((r) => who.get(r.id) ?? []);
    const first = visible[0];
    if (first) parts.push(`${count(visible.length, 'agent proposal')}${visible.length === 1 ? ` (${first.title})` : ''} ${verb(visible.length, 'waits', 'wait')} for ${names(approvers) || 'an eligible approver'}.`);
  }
  // Only work someone can do now: items still waiting on agent proposals are covered above.
  const unreviewed = input.recs.filter((r) => r.status !== 'reviewed');
  if (failing.has('recs') && unreviewed.length) {
    const prepared = (code: string | null) => !input.tasks.some((t) => t.code === code && t.skillId && t.runs === 0);
    const toCertify = unreviewed.filter((r) => r.status !== 'prepared' && r.unexplained === 0 && r.pendingProposals === 0 && prepared(r.taskCode));
    const toReview = unreviewed.filter((r) => r.status === 'prepared');
    if (toCertify.length) parts.push(`${count(toCertify.length, 'reconciliation')} ${verb(toCertify.length, 'waits', 'wait')} for certification by ${names(toCertify.map((r) => r.owner))}.`);
    if (toReview.length) parts.push(`${count(toReview.length, 'reconciliation')} ${verb(toReview.length, 'waits', 'wait')} for review by ${names(toReview.map((r) => r.reviewer))}.`);
  }
  const reviews = input.tasks.filter((t) => t.status === 'ready_for_review' && t.pendingProposals === 0 && t.recs.every((r) => r.status === 'reviewed'));
  if (failing.has('tasks') && reviews.length) parts.push(`${count(reviews.length, 'task')} ${verb(reviews.length, 'waits', 'wait')} for review by ${names(reviews.map((t) => t.reviewer))}.`);
  for (const c of input.ready.checks.filter((x) => !x.ok && !['proposals', 'recs', 'tasks'].includes(x.id))) parts.push(`${c.label}: ${c.detail.charAt(0).toLowerCase()}${c.detail.slice(1)}.`);
  return parts.slice(0, 3).join(' ') || 'Nothing needs you right now.';
}

export async function myClose(ctx: ServiceContext) {
  requirePermission(ctx, 'close.view');
  const periodKey = await currentPeriodKey(ctx);
  const me = ctx.actor.userId;
  const can = (p: string) => hasPermission(ctx.actor, p);
  // Consolidated views (packages, headline figures) span every entity.
  const allEntities = entityFilter(ctx) === null;
  const cal = await closeCalendar(ctx, periodKey);
  const recs = await listRecs(ctx, periodKey);
  const inbox = await listProposals(ctx, { tab: 'mine', periodKey, limit: 5 });
  const issues = await listIssues(ctx, { periodKey, status: ['open', 'acknowledged'] });
  const packages = can('report.view') && allEntities ? await listPackages(ctx, periodKey) : [];
  const ready = await lockReadiness(ctx, periodKey);
  const taskByCode = new Map(cal.tasks.map((t) => [t.code, t]));
  // A reconciliation is ready for its preparer once the agent for its task has prepared it.
  const agentPrepared = (code: string | null) => {
    const t = code ? taskByCode.get(code) : undefined;
    return !t || !t.skillId || t.runs > 0;
  };
  // The assigned reviewer reviews, unless they prepared the item themselves.
  const reviewerIs = (assigned: PersonRef | null, preparer: string | null | undefined) => !assigned || assigned.id === preparer || assigned.id === me;
  const myTasks = cal.tasks.filter((t) => t.owner?.id === me && t.status !== 'complete');
  const workable = myTasks.filter((t) => !t.blockedBy.length);
  const toReview: TaskView[] = [];
  if (can('close.task.review')) {
    for (const t of cal.tasks.filter((x) => x.status === 'ready_for_review' && (x.preparedBy?.id ?? x.owner?.id) !== me && reviewerIs(x.reviewer, x.preparedBy?.id ?? x.owner?.id))) {
      if ((await completionReadiness(ctx, t.id)).ok) toReview.push(t);
    }
  }
  const recsToCertify = can('rec.prepare') ? recs.filter((r) => (r.status === 'in_progress' || r.status === 'not_started') && r.unexplained === 0 && r.pendingProposals === 0 && r.hasStatement && r.owner?.id === me && agentPrepared(r.taskCode)) : [];
  const recsBlocked = recs.filter((r) => r.status !== 'reviewed' && r.status !== 'prepared' && (r.unexplained !== 0 || r.pendingProposals > 0));
  const recsToReview = can('rec.review') ? recs.filter((r) => r.status === 'prepared' && r.preparedBy?.id !== me && reviewerIs(r.reviewer, r.preparedBy?.id)) : [];
  let fluxToApprove = 0;
  if (can('flux.approve')) {
    for (const code of ['US', 'UK']) {
      if (!canSeeEntity(ctx, (await entityByCode(ctx, code)).id)) continue;
      for (const comparison of ['prior_month', 'budget'] as const) {
        const v = await fluxView(ctx, { entityCode: code, periodKey, comparison });
        fluxToApprove += v.lines.filter((l) => l.explanation?.status === 'submitted' && l.explanation.author?.id !== me).length;
      }
    }
  }
  // Only the newest version can be signed; older drafts were superseded by a refresh.
  const draftPkg = packages[0]?.status === 'draft' ? packages[0] : undefined;
  const finalPkg = packages.find((p) => p.status === 'final');
  const neverRan = cal.tasks.filter((t) => t.skillId).every((t) => t.runs === 0);
  const readyToRun = cal.tasks.filter((t) => t.skillId && t.runs === 0 && t.blockedBy.length === 0 && t.status !== 'complete');
  const locked = cal.periodStatus.every((p) => p.status === 'hard_close');
  const label = formatPeriod(periodKey);
  const people = async (permission: string) => {
    const users = await ctx.db.find('app_user', { tenant_id: ctx.tenantId, status: 'active' }, { orderBy: [['display_name', 'asc']] });
    const out: PersonRef[] = [];
    for (const u of users) if (hasPermission(await loadActor(ctx.db, ctx.tenantId, u.id), permission)) out.push({ id: u.id, name: u.display_name, title: u.title });
    return out;
  };
  const step = (n: Omit<NextAction, 'kicker' | 'tone'> & Partial<Pick<NextAction, 'kicker' | 'tone'>>): NextAction => ({ kicker: NEXT, tone: 'primary', ...n });
  const packageDraft = inbox.items.find((p) => p.kind === 'close_package');

  let next: NextAction;
  if (locked) next = { title: `${label} is locked`, detail: 'The close is complete. Every number is signed off and the period is protected.', href: '#/package', action: 'none', cta: 'Open the package', kicker: 'All set', tone: 'done' };
  else if (neverRan && can('agent.orchestrate')) next = step({ title: 'Run the close agents', detail: `Agents will prepare ${cal.tasks.filter((t) => t.skillId).length} tasks in dependency order. Nothing posts above your policy thresholds without a person.`, href: '#/cockpit', action: 'orchestrate', cta: 'Run the close agents' });
  // Approvals that only a CFO may give do not restart the agents; a close lead continues the close,
  // which comes first because the agents' next proposals are other people's work.
  else if (readyToRun.length && can('agent.orchestrate')) next = step({ title: 'Continue the close', detail: `${count(readyToRun.length, 'task')} ${verb(readyToRun.length, 'is', 'are')} ready for ${verb(readyToRun.length, 'its agent', 'their agents')} now that upstream work is approved.`, href: '#/cockpit', action: 'orchestrate', cta: 'Continue the close' });
  else if (neverRan) next = step({ title: 'Waiting for the close agents', detail: `${names(await people('agent.orchestrate'))} starts them from My close. Your reconciliations and approvals appear here once the agents have prepared them.`, href: '#/cockpit', action: 'none', cta: null, kicker: WAITING, tone: 'calm' });
  else if (packageDraft && inbox.counts.mine === 1) next = step({ title: 'Approve the close package draft', detail: 'The close-package agent assembled the statements, reconciliations, variance commentary and exceptions. Approving it creates the version you sign next.', href: `#/inbox/${packageDraft.id}`, action: 'approve', cta: 'Open the draft' });
  else if (inbox.counts.mine > 0) next = step({ title: `Review ${count(inbox.counts.mine, 'agent proposal')}`, detail: `${inbox.counts.material ? `${inbox.counts.material} at or above materiality. ` : ''}Each shows why the agent proposed it, the evidence and how confident it is.`, href: '#/inbox', action: 'approve', cta: 'Open the inbox' });
  else if (recsToCertify.length) next = step({ title: `Certify ${count(recsToCertify.length, 'reconciliation')}`, detail: 'They tie out with every difference explained. Certifying is your sign-off as preparer.', href: '#/recs', action: 'certify', cta: 'Open reconciliations' });
  else if (recsToReview.length) next = step({ title: `Review ${count(recsToReview.length, 'reconciliation')}`, detail: 'Someone else prepared them; your review completes maker-checker.', href: '#/recs', action: 'review', cta: 'Open reconciliations' });
  else if (fluxToApprove) next = step({ title: `Approve ${count(fluxToApprove, 'variance explanation')}`, detail: 'Material movements against prior month and budget, explained by driver.', href: '#/flux', action: 'approve', cta: 'Open flux review' });
  else if (toReview.length) next = step({ title: `Complete ${count(toReview.length, 'task review')}`, detail: `${toReview.map((t) => t.code).join(', ')} ${verb(toReview.length, 'is', 'are')} prepared and ${verb(toReview.length, 'waits', 'wait')} for you before the period can lock.`, href: '#/cockpit', action: 'review', cta: 'Open the cockpit' });
  else if (draftPkg && can('package.approve') && draftPkg.generatedBy?.id !== me) {
    const stale = (await getPackage(ctx, draftPkg.id)).stale;
    next = step({ title: stale ? 'Refresh and sign the close package' : 'Approve the close package', detail: stale ? `The close moved on since version ${draftPkg.version} was generated. Refresh it to the current figures and status, review it, then sign.` : `Version ${draftPkg.version} is ready for your signature.`, href: '#/package', action: 'package', cta: 'Open the package' });
  } else if (ready.ok && can('period.lock')) next = step({ title: `Lock ${label}`, detail: 'Every check passes. Locking prevents any further posting to the month.', href: '#/cockpit', action: 'lock', cta: 'Go to lock' });
  // Owned tasks still waiting on upstream work are not something to work on yet: say who the close waits on.
  else if (workable.length) next = step({ title: `Work on ${count(workable.length, 'task')} you own`, detail: `${workable[0]!.title} is due ${workable[0]!.dueLabel}.`, href: '#/cockpit', action: 'none', cta: null, tone: 'calm' });
  else if (ready.ok) next = step({ title: `${label} is ready to lock`, detail: `Every check passes. ${names(await people('period.lock'))} can lock the month.`, href: '#/cockpit', action: 'none', cta: null, kicker: WAITING, tone: 'calm' });
  else next = step({ title: 'Nothing for you right now', detail: await waitingOn(ctx, { ready, tasks: cal.tasks, recs, periodKey }), href: '#/cockpit', action: 'none', cta: null, kicker: WAITING, tone: 'calm' });

  return {
    periodKey,
    periodLabel: label,
    today: cal.today,
    todayWorkday: cal.todayWorkday,
    target: { workday: `WD+${cal.cycle.targetWorkday}`, date: cal.cycle.targetDate },
    progress: cal.progress,
    locked,
    next,
    myTasks: myTasks.map((t) => ({ id: t.id, code: t.code, title: t.title, status: t.status, dueLabel: t.dueLabel, workdayLabel: t.workdayLabel, overdue: t.overdue, blockedBy: t.blockedBy, pending: t.pendingProposals })),
    toReview: toReview.map((t) => ({ id: t.id, code: t.code, title: t.title, preparedBy: t.preparedBy?.name ?? t.owner?.name ?? null })),
    approvals: { count: inbox.counts.mine, waiting: inbox.counts.waiting, material: inbox.counts.material, top: inbox.items.slice(0, 3).map((p) => ({ id: p.id, title: p.title, kindLabel: p.kindLabel, confidence: p.confidence, amount: p.amount, currency: p.currency, materiality: p.materiality })) },
    recs: { toCertify: recsToCertify.length, toReview: recsToReview.length, blocked: recsBlocked.length, total: recs.length, reviewed: recs.filter((r) => r.status === 'reviewed').length },
    flux: { toApprove: fluxToApprove },
    issues: { open: issues.length, high: issues.filter((i) => i.severity === 'high' || i.severity === 'critical').length, top: issues.slice(0, 3).map((i) => ({ id: i.id, title: i.title, severity: i.severity, status: i.status })) },
    package: draftPkg ? { id: draftPkg.id, status: 'draft', version: draftPkg.version } : finalPkg ? { id: finalPkg.id, status: 'final', version: finalPkg.version } : null,
    lock: { ok: ready.ok, failing: ready.checks.filter((c) => !c.ok).map((c) => ({ label: c.label, detail: c.detail })) },
    headline: can('report.view') && allEntities ? await headline(ctx, periodKey).catch(() => null) : null,
    agentsRan: !neverRan,
  };
}
