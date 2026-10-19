import { approvalBlocks } from '../../agents/framework/decisions';
import type { AgentRuntime } from '../../agents/framework/runtime';
import type { Tx } from '../../persistence/db';
import { closeProgress, signOffProblems, taskStates } from '../../packs/accounting/domain/close';
import { closeBlockers } from '../../packs/accounting/services/periods';
import { certificationProblems } from '../../packs/accounting/services/recon';
import { can, canOn, canSeeEntity, entityScope, type Principal } from '../../security/principal';
import { dateToWorkday, formatWorkday, usBusinessCalendar } from '../../shared/dates';
import type { App } from '../app';
import { decisionProblems } from './access';
import { currentClose } from './close';

/** "My close": what this person should do next, ranked, with their tasks and the close at a glance. */

async function closeAgents(tx: Tx, closeId: string, waiting: number): Promise<CloseAgentsView | null> {
  const [latest] = await tx.find('agent_runs', { close_id: closeId, skill_key: 'close-orchestrator', parent_run_id: null }, { orderBy: [['created_at', 'desc']], limit: 1 });
  if (!latest) return null;
  const tree = await tx.find('agent_runs', { close_id: closeId, created_at: { gte: latest.created_at } });
  const proposals = tree.length ? await tx.find('proposals', { run_id: { in: tree.map((r) => r.id) } }) : [];
  return {
    runId: latest.id,
    status: latest.status,
    startedBy: latest.requested_by_label,
    startedAt: latest.started_at ?? latest.created_at,
    finishedAt: latest.finished_at,
    working: tree.filter((r) => r.status === 'queued' || r.status === 'running').length,
    proposals: proposals.length,
    autoApplied: proposals.filter((x) => x.status === 'auto_applied').length,
    waiting,
  };
}

export interface NextStep {
  id: string;
  title: string;
  detail: string;
  href: string;
  count?: number;
  tone: 'primary' | 'attention' | 'info' | 'done';
}

/** The latest "Run close agents" for the close: whether it is still working and what it left for people. */
export interface CloseAgentsView {
  runId: string;
  status: string;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  /** Runs of this close still queued or running. */
  working: number;
  proposals: number;
  autoApplied: number;
  /** Proposals of the close still waiting for a decision. */
  waiting: number;
}

export async function home(app: App, p: Principal) {
  // Someone without close.view (a person whose roles still wait for approval) sees no close data.
  const close = can(p, 'close.view') ? await currentClose(app, p.tenantId) : null;
  return app.read(async (tx) => {
    const tenant = (await tx.get('tenants', p.tenantId))!;
    const cal = usBusinessCalendar();
    const businessDate = app.clock.businessDate();
    const next: NextStep[] = [];
    let closeView = null;
    let agents: CloseAgentsView | null = null;
    let myTasks: Array<Record<string, unknown>> = [];
    let pendingForMe = 0;
    let blockedForMe = 0;
    if (close) {
      const lookups = await app.lookups(tx, p.tenantId);
      // Entity scope: someone limited to some entities sees those entities' tasks, items and numbers only.
      const scope = entityScope(p);
      const states = (await taskStates(tx, close.id)).filter((s) => canSeeEntity(p, s.task.entity_id));
      const progress = closeProgress(states);
      const wd = dateToWorkday(close.period_end, businessDate, cal);
      closeView = { id: close.id, name: close.name, periodEnd: close.period_end, status: close.status, targetWorkday: close.target_workday, currentWorkday: wd, currentWorkdayLabel: formatWorkday(wd), progress };
      const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
      myTasks = states
        .filter((s) => (s.task.owner_id === p.user.id && !['done', 'skipped'].includes(s.task.status)) || (s.task.reviewer_id === p.user.id && s.task.status === 'ready_for_review'))
        .map((s) => ({ id: s.task.id, title: s.task.title, status: s.task.status, dueDate: s.task.due_date, dueWorkday: s.task.due_workday, role: s.task.reviewer_id === p.user.id && s.task.status === 'ready_for_review' ? 'reviewer' : 'owner', skillKey: s.task.skill_key, ready: s.ready, blockedBy: s.blockedBy.map((b) => b.title), blockedReason: s.task.blocked_reason, overdue: s.task.due_date < businessDate, owner: s.task.owner_id ? users.get(s.task.owner_id) : null }));

      if (close.status !== 'closed') {
        const readyAgentTasks = states.filter((s) => s.ready && s.task.skill_key && ['not_started', 'blocked'].includes(s.task.status));
        const running = (await tx.find('agent_runs', { close_id: close.id, status: { in: ['queued', 'running'] } })).filter((r) => canSeeEntity(p, r.entity_id));
        if (running.length) next.push({ id: 'running', title: `${running.length} agent run${running.length === 1 ? ' is' : 's are'} working`, detail: 'Watch the trace live; results land in your inbox.', href: `#/runs/${running[0]!.id}`, tone: 'info' });
        else if (readyAgentTasks.length && canOn(p, 'skill.run', null)) next.push({ id: 'run-agents', title: 'Run the close agents', detail: `${readyAgentTasks.length} task${readyAgentTasks.length === 1 ? ' is' : 's are'} ready: ${readyAgentTasks.slice(0, 3).map((s) => s.task.title).join(', ')}${readyAgentTasks.length > 3 ? '...' : ''}`, href: `#/close/${close.id}`, count: readyAgentTasks.length, tone: 'primary' });

        const pending = await tx.find('proposals', { tenant_id: p.tenantId, status: 'pending', ...(scope ? { entity_id: scope } : {}) });
        for (const x of pending) {
          if ((await approvalBlocks(tx, app.runtime as unknown as AgentRuntime<unknown>, p, x)).length === 0) pendingForMe++;
          else blockedForMe++;
        }
        if (pendingForMe) next.push({ id: 'inbox', title: `Review ${pendingForMe} item${pendingForMe === 1 ? '' : 's'} in your inbox`, detail: 'Agents prepared these and verified them against the ontology; they need your approval.', href: '#/inbox', count: pendingForMe, tone: 'attention' });
        else if (pending.length && can(p, 'proposal.view')) next.push({ id: 'inbox-others', title: `Review ${pending.length} item${pending.length === 1 ? '' : 's'} the agents prepared`, detail: 'Someone else approves them (a higher limit, another role, or independence from whoever started the agents). Open each to check the evidence, and reject anything wrong.', href: '#/inbox', count: pending.length, tone: 'info' });
        agents = p.entityIds === null ? await closeAgents(tx, close.id, pending.length) : null;
        const postHoc = await tx.count('proposals', { tenant_id: p.tenantId, status: 'auto_applied', post_hoc_status: 'pending', ...(scope ? { entity_id: scope } : {}) });
        if (postHoc && can(p, 'proposal.review_posthoc')) next.push({ id: 'posthoc', title: `Spot-check ${postHoc} auto-applied item${postHoc === 1 ? '' : 's'}`, detail: 'A sample of work applied under autonomy policy, for after-the-fact review.', href: '#/inbox?view=review', count: postHoc, tone: 'info' });

        const periods = lookups.operatingEntities().filter((e) => canSeeEntity(p, e.id)).map((e) => lookups.period(e.id, close.fiscal_year, close.period_number)?.id).filter((x): x is string => !!x);
        const recs = periods.length ? await tx.find('reconciliations', { period_id: { in: periods } }) : [];
        let toPrepare = 0;
        let toReview = 0;
        for (const r of recs) {
          if (['in_progress', 'reopened', 'not_started'].includes(r.status) && canOn(p, 'rec.prepare', r.entity_id) && (await certificationProblems(tx, r)).length === 0) toPrepare++;
          if (r.status === 'prepared' && canOn(p, 'rec.review', r.entity_id) && r.prepared_by !== p.user.id) toReview++;
        }
        if (toPrepare) next.push({ id: 'recs-prepare', title: `Certify ${toPrepare} reconciliation${toPrepare === 1 ? '' : 's'} as preparer`, detail: 'Every difference is matched or listed; sign as preparer.', href: '#/recs', count: toPrepare, tone: 'attention' });
        if (toReview) next.push({ id: 'recs-review', title: `Review ${toReview} prepared reconciliation${toReview === 1 ? '' : 's'}`, detail: 'Independent review (you did not prepare them).', href: '#/recs', count: toReview, tone: 'attention' });

        const flux = (await tx.find('flux_analyses', { close_id: close.id })).filter((f) => canSeeEntity(p, f.entity_id));
        for (const f of flux) {
          const lines = (await tx.find('flux_lines', { analysis_id: f.id })).filter((l) => l.is_material);
          const drafted = lines.filter((l) => l.explanation_status === 'drafted' || l.explanation_status === 'missing' || l.explanation_status === 'rejected').length;
          if (drafted && canOn(p, 'flux.explain', f.entity_id)) next.push({ id: `flux-${f.id}`, title: `Explain ${drafted} material variance${drafted === 1 ? '' : 's'}`, detail: 'Agent drafts are ready; accept or rewrite them.', href: '#/flux', count: drafted, tone: 'attention' });
          else if (!drafted && f.status !== 'approved' && canOn(p, 'flux.approve', f.entity_id) && !lines.some((l) => l.explained_by === p.user.id)) next.push({ id: `flux-approve-${f.id}`, title: 'Approve the flux analysis', detail: `${lines.length} material variance${lines.length === 1 ? '' : 's'} explained.`, href: '#/flux', tone: 'attention' });
        }
        const review = [];
        for (const s of states.filter((x) => x.task.status === 'ready_for_review' && canOn(p, 'close.task.review', x.task.entity_id) && x.task.completed_by !== p.user.id)) {
          if (!(await signOffProblems(tx, s.task)).length) review.push(s);
        }
        if (review.length) next.push({ id: 'task-review', title: `Sign off ${review.length} completed task${review.length === 1 ? '' : 's'}`, detail: review.slice(0, 3).map((s) => s.task.title).join(', '), href: `#/close/${close.id}`, count: review.length, tone: 'info' });
        const bsRecs = states.filter((s) => s.task.key === 'bs-recs' && s.ready && !['done', 'ready_for_review', 'skipped'].includes(s.task.status));
        if (bsRecs.length && bsRecs.some((s) => canOn(p, 'close.task.work', s.task.entity_id)) && recs.length && recs.every((r) => r.status === 'reviewed')) next.push({ id: 'bs-recs', title: 'Mark balance-sheet reconciliations certified', detail: 'All required reconciliations are reviewed.', href: `#/close/${close.id}`, tone: 'primary' });
        const pkgProposal = pending.find((x) => x.kind === 'task_update');
        if (pkgProposal && canOn(p, 'package.approve', null)) next.push({ id: 'package', title: 'Approve the close package', detail: pkgProposal.title, href: `#/close/${close.id}/package`, tone: 'attention' });
        const blockers = await closeBlockers(tx, lookups, close.id, { ignoreTaskKeys: ['lock'] });
        if (!blockers.length && canOn(p, 'period.lock', null)) next.push({ id: 'lock', title: `Lock ${close.name.replace(' close', '')}`, detail: 'Everything is signed off. Locking stops all postings to the period.', href: `#/close/${close.id}`, tone: 'primary' });
      } else {
        next.push({ id: 'closed', title: `${close.name} is locked`, detail: 'Postings to the period are blocked; corrections go through a CFO reopen or the next period.', href: `#/close/${close.id}/package`, tone: 'done' });
      }
    }
    // Access changes an administrator asked for (roles with approval authority, SoD rules) wait for someone independent.
    let accessForMe = 0;
    if (can(p, 'access.approve')) {
      for (const r of await tx.find('access_requests', { tenant_id: p.tenantId, status: 'pending' })) if (!(await decisionProblems(tx, p, r)).length) accessForMe++;
      if (accessForMe) next.push({ id: 'access', title: `Decide ${accessForMe} access request${accessForMe === 1 ? '' : 's'}`, detail: 'An administrator asked for a role with approval authority or a control change. It takes effect only if someone independent approves it.', href: '#/admin?tab=access', count: accessForMe, tone: 'attention' });
    }
    if (!p.roles.length) next.push({ id: 'no-roles', title: 'You have no roles yet', detail: 'Your roles take effect when a Controller or CFO approves the request your administrator made. Sign out and in again once they have.', href: '#/', tone: 'info' });
    if (!next.length) next.push({ id: 'nothing', title: 'Nothing needs you right now', detail: 'Check the close cockpit for what others are working on.', href: close ? `#/close/${close.id}` : '#/', tone: 'done' });
    const scope = entityScope(p);
    const runs = can(p, 'skill.view') ? await tx.find('agent_runs', { tenant_id: p.tenantId, parent_run_id: null, ...(scope ? { entity_id: scope } : {}) }, { orderBy: [['created_at', 'desc']], limit: 5 }) : [];
    // The organization's activity feed spans every entity: someone limited to some entities sees only their own actions.
    const activity = !can(p, 'close.view') ? [] : await tx.find('audit_log', { tenant_id: p.tenantId, ...(scope ? { actor_id: p.user.id } : {}) }, { orderBy: [['seq', 'desc']], limit: 8 });
    return {
      user: { name: p.user.display_name, firstName: p.user.display_name.split(' ')[0], title: p.user.title, roles: p.roles.map((r) => r.name) },
      tenant: { name: tenant.name, isDemo: tenant.is_demo, reportingCurrency: tenant.reporting_currency },
      businessDate,
      mode: { live: !!app.liveModel, model: app.liveModel },
      close: closeView,
      agents,
      next,
      myTasks,
      inbox: { pendingForMe, blockedForMe },
      access: { pendingForMe: accessForMe },
      recentRuns: runs.map((r) => ({ id: r.id, skill: r.skill_key, status: r.status, summary: r.summary, at: r.finished_at ?? r.created_at, proposals: r.proposals_count })),
      activity: activity.map((a) => ({ seq: a.seq, at: a.occurred_at, actor: a.actor_label, actorType: a.actor_type, action: a.action, summary: a.summary })),
    };
  });
}
