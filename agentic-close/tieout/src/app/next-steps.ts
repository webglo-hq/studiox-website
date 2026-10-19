/**
 * "What's next" on My close: the few things in this close that wait on the person signed in, in
 * the order the close needs them, each with where to do it. When nothing does, it says what the
 * close is waiting on instead, so nobody is left wondering whether it is their move.
 *
 * Everything is derived from the same state the screens and the lock gate read (proposals,
 * reconciliations, flux, the checklist and its sign-off rules); nothing here is stored.
 */
import { periodLabel } from '../core/util/time';
import { roleDef } from '../packs/accounting/controls/permissions';
import type { AccountingServices } from '../packs/accounting/services';
import type { Readiness, TaskView } from '../packs/accounting/services/close';
import { isExplained } from '../packs/accounting/services/flux';
import type { DbTx, ProposalRow } from '../schema';
import { cannotDecide } from './access';
import { signOffBlockers } from './close';
import { inScope, type RequestUser } from './context';

export interface NextStep {
  text: string;
  /** where to do it; `action` names a button on My close itself instead */
  href: string;
  action?: 'run-agents';
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export async function nextSteps(
  svc: AccountingServices,
  tx: DbTx,
  u: RequestUser,
  periodKey: string,
  f: { closed: boolean; agentsRun: boolean; mine: number; open: ProposalRow[]; readiness: Readiness; tasks: TaskView[]; latestPackage: { id: string; status: string; requestedBy: string | null } | null },
): Promise<{ steps: NextStep[]; waitingOn: string[] }> {
  if (f.closed) return { steps: [], waitingOn: [] };
  const can = (p: string) => u.actor.permissions.has(p);
  const steps: NextStep[] = [];
  const waitingOn: string[] = [];
  const month = periodLabel(periodKey);

  // 1. the agents prepare the month
  if (!f.agentsRun) {
    if (can('agent.run')) steps.push({ text: `Run the close agents for ${month}: they reconcile the bank, code card spend, find accruals and draft variance explanations for people to approve.`, href: '#/home', action: 'run-agents' });
    else waitingOn.push('the close agents to run (a Senior Accountant starts them)');
  }

  // 2. decisions on agent work
  if (f.mine) steps.push({ text: `Decide ${n(f.mine, 'item')} waiting for you in the inbox.`, href: '#/inbox' });
  const others = f.open.length - f.mine;
  if (others > 0) {
    const byRole = new Map<string, number>();
    for (const p of f.open) byRole.set(p.assigned_role ?? '', (byRole.get(p.assigned_role ?? '') ?? 0) + 1);
    const parts = [...byRole].filter(([r]) => r).map(([r, c]) => `${c} for the ${roleDef(r)?.name ?? r}`);
    waitingOn.push(`${n(others, 'inbox item')} waiting for someone else${parts.length ? ` (${parts.join(', ')})` : ''}`);
  }

  // access: new approval authority and control changes wait for a second person
  if (can('access.approve') || can('admin.users') || can('admin.sod')) {
    const pending = await tx.find('access_requests', { status: 'pending' });
    const decidable = can('access.approve') ? pending.filter((r) => cannotDecide(u, r).length === 0).length : 0;
    if (decidable) steps.push({ text: `Decide ${n(decidable, 'access request')}: someone asked to give a person approval authority or to change a control.`, href: '#/admin?tab=access' });
    const asked = pending.filter((r) => r.requested_by === u.actor.id).length;
    if (asked) waitingOn.push(`${n(asked, 'access request')} you made, waiting for a second person to approve`);
  }

  // 3. reconciliations: preparers certify, a different person reviews (AX-SOD-03)
  const periods = new Set((await tx.find('periods', { period_key: periodKey })).filter((p) => inScope(u, p.entity_id)).map((p) => p.id));
  const recs = (await tx.find('reconciliations', {})).filter((r) => periods.has(r.period_id) && ['bank', 'subledger_ap', 'subledger_ar'].includes(r.rec_type));
  const expected = (await svc.bank.accounts()).length + (await svc.ctx.legalEntities()).length * 2;
  const certified = recs.filter((r) => r.status === 'prepared' || r.status === 'reviewed').length;
  const toCertify = Math.max(0, expected - certified);
  const toReview = recs.filter((r) => r.status === 'prepared');
  if (f.agentsRun && toCertify) {
    if (can('recon.prepare')) steps.push({ text: `Certify ${n(toCertify, 'reconciliation')} as preparer, noting anything still open.`, href: '#/recs' });
    else waitingOn.push(`${n(toCertify, 'reconciliation')} to certify (Staff Accountant)`);
  }
  const mineToReview = toReview.filter((r) => r.preparer_id !== u.actor.id).length;
  if (can('recon.review') && mineToReview) steps.push({ text: `Review ${n(mineToReview, 'reconciliation')} a preparer certified.`, href: '#/recs' });
  else if (toReview.length && !can('recon.review')) waitingOn.push(`${n(toReview.length, 'reconciliation')} to review (Senior Accountant or Controller)`);

  // 4. significant variances need an explanation (AX-FLX-01); drafts waiting for approval count as in hand
  if (f.agentsRun) {
    let unexplained = 0;
    for (const e of await svc.ctx.legalEntities()) unexplained += (await svc.flux.compute(e.id, periodKey)).lines.filter((l) => l.exceeds && !isExplained(l) && !l.draft?.current).length;
    if (unexplained) {
      if (can('flux.explain')) steps.push({ text: `Explain ${n(unexplained, 'significant variance')} in plain words (or let the agent draft them).`, href: '#/flux' });
      else waitingOn.push(`${n(unexplained, 'significant variance')} to explain (Staff Accountant or FP&A)`);
    }
  }

  // 5. the checklist: sign off what you review (or stand in for a reviewer who ran its agents)
  let signable = 0;
  const unsigned: string[] = [];
  for (const t of f.tasks.filter((x) => x.status === 'ready_for_review')) {
    const b = await signOffBlockers(tx, u, t);
    const reviewerRan = t.agent_run_id && t.reviewer_id ? (await tx.get('agent_runs', t.agent_run_id))?.requested_by === t.reviewer_id : false;
    if (!b.sod.length && !b.other.length && (t.reviewer_id === u.actor.id || reviewerRan)) signable++;
    else if (t.reviewer_id !== u.actor.id) unsigned.push(t.reviewerName ?? t.reviewer_role ?? 'a reviewer');
  }
  if (signable) steps.push({ text: `Sign off ${n(signable, 'checklist task')} you review.`, href: '#/close' });
  if (unsigned.length && !signable) waitingOn.push(`${n(unsigned.length, 'checklist task')} to sign off (${[...new Set(unsigned)].join(', ')})`);

  // 6. the package, then the lock
  const tasksLeft = f.tasks.filter((t) => t.key !== 'lock' && t.key !== 'close-package' && t.status !== 'done' && t.status !== 'skipped').length;
  const packageDrafting = f.open.some((p) => p.kind === 'report');
  if (!f.latestPackage && !packageDrafting && f.agentsRun && !tasksLeft && f.readiness.pendingProposals === 0) {
    if (can('close.package') && !u.actor.entityScope) steps.push({ text: `Draft the close package for ${month}: everything else is done.`, href: '#/close' });
    else waitingOn.push('the close package to be drafted (Controller)');
  }
  if (f.latestPackage?.status === 'draft' && !packageDrafting) {
    if (can('close.package') && f.latestPackage.requestedBy !== u.actor.id) steps.push({ text: 'Approve and sign the close package: your sign-off is bound to its content.', href: `#/package/${f.latestPackage.id}` });
    else waitingOn.push('the close package to be approved and signed (CFO)');
  }
  if (f.readiness.ready) {
    if (can('close.lock')) steps.push({ text: `Lock ${month}: every condition holds.`, href: '#/close' });
    else waitingOn.push(`${month} to be locked (Controller or CFO)`);
  }
  return { steps, waitingOn };
}
