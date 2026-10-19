import { formatPeriod } from '../../../framework/util/dates';
import { hasPermission, requirePermission, type ServiceContext } from '../domain/context';
import { closeCalendar, type TaskView } from './close';
import { currentPeriodKey } from './common';
import { fluxView } from './flux';
import { listProposals } from './inbox';
import { listIssues } from './issues';
import { listPackages } from './package';
import { lockReadiness } from './periods';
import { listRecs } from './recs';
import { headline } from './reports';

/**
 * "My close": everything the signed-in person should do next, in plain language, with one
 * primary action. Built for staff who do not live in accounting software.
 */

export interface NextAction {
  title: string;
  detail: string;
  href: string;
  action?: 'orchestrate' | 'approve' | 'certify' | 'review' | 'lock' | 'package' | 'none';
  tone: 'primary' | 'calm' | 'done';
}

export async function myClose(ctx: ServiceContext) {
  requirePermission(ctx, 'close.view');
  const periodKey = await currentPeriodKey(ctx);
  const me = ctx.actor.userId;
  const can = (p: string) => hasPermission(ctx.actor, p);
  const cal = await closeCalendar(ctx, periodKey);
  const recs = await listRecs(ctx, periodKey);
  const inbox = await listProposals(ctx, { tab: 'mine', periodKey, limit: 5 });
  const issues = await listIssues(ctx, { periodKey, status: ['open', 'acknowledged'] });
  const packages = can('report.view') ? await listPackages(ctx, periodKey) : [];
  const ready = await lockReadiness(ctx, periodKey);
  const myTasks = cal.tasks.filter((t) => t.owner?.id === me && t.status !== 'complete');
  const toReview = cal.tasks.filter((t: TaskView) => t.status === 'ready_for_review' && can('close.task.review') && (t.preparedBy?.id ?? t.owner?.id) !== me);
  const recsToCertify = can('rec.prepare') ? recs.filter((r) => (r.status === 'in_progress' || r.status === 'not_started') && r.unexplained === 0 && r.pendingProposals === 0 && r.hasStatement) : [];
  const recsBlocked = recs.filter((r) => r.status !== 'reviewed' && r.status !== 'prepared' && (r.unexplained !== 0 || r.pendingProposals > 0));
  const recsToReview = can('rec.review') ? recs.filter((r) => r.status === 'prepared' && r.preparedBy?.id !== me) : [];
  let fluxToApprove = 0;
  if (can('flux.approve')) {
    for (const code of ['US', 'UK']) {
      for (const comparison of ['prior_month', 'budget'] as const) {
        const v = await fluxView(ctx, { entityCode: code, periodKey, comparison });
        fluxToApprove += v.lines.filter((l) => l.explanation?.status === 'submitted' && l.explanation.author?.id !== me).length;
      }
    }
  }
  const draftPkg = packages.find((p) => p.status === 'draft');
  const finalPkg = packages.find((p) => p.status === 'final');
  const neverRan = cal.tasks.filter((t) => t.skillId).every((t) => t.runs === 0);
  const readyToRun = cal.tasks.filter((t) => t.skillId && t.runs === 0 && t.blockedBy.length === 0 && t.status !== 'complete');
  const locked = cal.periodStatus.every((p) => p.status === 'hard_close');
  const label = formatPeriod(periodKey);

  let next: NextAction;
  if (locked) next = { title: `${label} is locked`, detail: 'The close is complete. Every number is signed off and the period is protected.', href: '#/package', action: 'none', tone: 'done' };
  else if (neverRan && can('agent.orchestrate')) next = { title: 'Run the close agents', detail: `Agents will prepare ${cal.tasks.filter((t) => t.skillId).length} tasks in dependency order. Nothing posts above your policy thresholds without a person.`, href: '#/cockpit', action: 'orchestrate', tone: 'primary' };
  else if (inbox.counts.mine > 0) next = { title: `Review ${inbox.counts.mine} agent proposal${inbox.counts.mine === 1 ? '' : 's'}`, detail: `${inbox.counts.material ? `${inbox.counts.material} at or above materiality. ` : ''}Each shows why the agent proposed it, the evidence and how confident it is.`, href: '#/inbox', action: 'approve', tone: 'primary' };
  else if (recsToCertify.length) next = { title: `Certify ${recsToCertify.length} reconciliation${recsToCertify.length === 1 ? '' : 's'}`, detail: 'They tie out with every difference explained. Certifying is your sign-off as preparer.', href: '#/recs', action: 'certify', tone: 'primary' };
  else if (recsToReview.length) next = { title: `Review ${recsToReview.length} reconciliation${recsToReview.length === 1 ? '' : 's'}`, detail: 'Someone else prepared them; your review completes maker-checker.', href: '#/recs', action: 'review', tone: 'primary' };
  else if (fluxToApprove) next = { title: `Approve ${fluxToApprove} variance explanation${fluxToApprove === 1 ? '' : 's'}`, detail: 'Material movements against prior month and budget, explained by driver.', href: '#/flux', action: 'approve', tone: 'primary' };
  else if (toReview.length) next = { title: `Complete ${toReview.length} task review${toReview.length === 1 ? '' : 's'}`, detail: 'Prepared tasks wait for a reviewer before the period can lock.', href: '#/cockpit', action: 'review', tone: 'primary' };
  else if (draftPkg && can('package.approve') && draftPkg.generatedBy?.id !== me) next = { title: 'Approve the close package', detail: `Version ${draftPkg.version} is ready for your signature.`, href: '#/package', action: 'package', tone: 'primary' };
  else if (ready.ok && can('period.lock')) next = { title: `Lock ${label}`, detail: 'Every check passes. Locking prevents any further posting to the month.', href: '#/cockpit', action: 'lock', tone: 'primary' };
  else if (readyToRun.length && can('agent.orchestrate')) next = { title: 'Continue the close', detail: `${readyToRun.length} task${readyToRun.length === 1 ? ' is' : 's are'} ready for its agent now that upstream work is approved.`, href: '#/cockpit', action: 'orchestrate', tone: 'primary' };
  else if (myTasks.length) next = { title: `Work on ${myTasks.length} task${myTasks.length === 1 ? '' : 's'} you own`, detail: myTasks[0]!.blockedBy.length ? `${myTasks[0]!.title} is waiting on ${myTasks[0]!.blockedBy.map((b) => b.title).join(', ')}.` : `${myTasks[0]!.title} is due ${myTasks[0]!.dueLabel}.`, href: '#/cockpit', action: 'none', tone: 'calm' };
  else next = { title: 'You are all caught up', detail: ready.checks.filter((c) => !c.ok).map((c) => c.label).slice(0, 2).join('; ') || 'Nothing needs you right now.', href: '#/cockpit', action: 'none', tone: 'done' };

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
    headline: can('report.view') ? await headline(ctx, periodKey).catch(() => null) : null,
    agentsRan: !neverRan,
  };
}
