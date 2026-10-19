/**
 * Human-in-the-loop decisions on agent proposals: approve (apply), reject, bulk approve, post-hoc
 * review, and edit-before-approve for codings. Every decision enforces, in order:
 *   permission for the proposal kind → entity scope → segregation of duties (maker-checker,
 *   requester ≠ approver) → approval limit (journal entries) → prerequisites → apply → audit.
 */
import { audit } from '../core/audit/audit';
import { DomainError, conflict, forbidden, notFound, precondition, sodViolation, validation } from '../core/util/errors';
import type { DbTx, ProposalRow } from '../schema';
import { applyProposal } from '../packs/accounting/agent/apply';
import { usdEquivalent } from '../packs/accounting/agent/assess';
import { CodingPayloadSchema } from '../packs/accounting/agent/payloads';
import { evaluateApproval } from '../packs/accounting/controls/sod';
import { closeOntology } from '../packs/accounting/ontology';
import { AccountingServices } from '../packs/accounting/services';
import type { AppContext, RequestUser } from './context';

export const DECISION_PERMISSION: Record<ProposalRow['kind'], string> = {
  journal_entry: 'je.approve',
  coding: 'coding.approve',
  rec_match: 'recon.prepare',
  reconciling_item: 'recon.prepare',
  flux_explanation: 'flux.approve',
  finding: 'close.signoff',
  report: 'close.package',
  schedule_update: 'je.approve',
};

export interface Eligibility {
  canDecide: boolean;
  reasons: string[];
  sod: { code: string; message: string }[];
}

/** Can this user approve this proposal? Used by the UI (disabled buttons with reasons) and by approve(). */
export async function eligibility(ctx: AppContext, tx: DbTx, u: RequestUser, p: ProposalRow): Promise<Eligibility> {
  const reasons: string[] = [];
  const sod: Eligibility['sod'] = [];
  const perm = DECISION_PERMISSION[p.kind];
  if (!u.actor.permissions.has(perm)) reasons.push(`Needs the ${perm} permission.`);
  if (p.entity_id && u.actor.entityScope && !u.actor.entityScope.includes(p.entity_id)) reasons.push('This entity is outside your access scope.');
  if (!['pending_approval', 'suggested'].includes(p.status)) reasons.push(`It is already ${p.status.replace('_', ' ')}.`);
  const rules = await tx.find('sod_rules', { enabled: true });
  const skill = ctx.skills.has(p.skill_key) ? ctx.skills.get(p.skill_key) : null;
  const relevant = skill?.manifest.controls.requesterMayApprove ? rules.filter((r) => r.kind !== 'requester_checker') : rules;
  const decision = evaluateApproval(relevant, u.actor.id, { subjectType: 'proposal', preparedBy: p.prepared_by, editedBy: p.edited_by, requestedBy: p.requested_by, agentPrepared: true });
  for (const v of decision.violations) {
    sod.push({ code: v.code, message: v.message });
    if (v.severity === 'block') reasons.push(`${v.code}: ${v.message}`);
  }
  if (p.kind === 'journal_entry' && p.period_key) {
    const usd = await usdEquivalent(new AccountingServices(tx, u.actor, ctx.clock), p.amount_minor, p.currency ?? 'USD', p.period_key);
    const lim = closeOntology().check('AX-SOD-04', { amountMinor: usd, limitMinor: u.actor.approvalLimitMinor });
    if (!lim.passed) reasons.push(`AX-SOD-04: ${lim.messages.join('; ')}; it needs the ${p.assigned_role?.replace('_', ' ') ?? 'next approver'}.`);
  }
  for (const id of (p.payload.dependsOnProposalIds as string[] | undefined) ?? []) {
    const dep = await tx.get('proposals', id);
    if (!dep || dep.status !== 'applied') reasons.push(`Approve ${dep?.ref ?? 'its prerequisite'} first (this entry assumes it is posted).`);
  }
  return { canDecide: reasons.length === 0, reasons, sod };
}

async function load(tx: DbTx, id: string): Promise<ProposalRow> {
  const p = await tx.get('proposals', id);
  if (!p) throw notFound('Proposal', id);
  return p;
}

export async function approveProposal(ctx: AppContext, u: RequestUser, id: string, note?: string): Promise<ProposalRow> {
  const out = await ctx.db.tx(u.tenantId, async (tx) => {
    const p = await load(tx, id);
    const el = await eligibility(ctx, tx, u, p);
    if (!el.canDecide) {
      if (el.sod.length && el.reasons.some((r) => r.startsWith('SOD-'))) throw sodViolation(el.reasons.join(' '), { reasons: el.reasons });
      if (el.reasons.some((r) => r.startsWith('AX-SOD-04'))) throw new DomainError('forbidden', el.reasons.join(' '), { reasons: el.reasons });
      throw precondition(el.reasons.join(' '), { reasons: el.reasons });
    }
    const svc = new AccountingServices(tx, u.actor, ctx.clock);
    const res = await applyProposal(svc, p, { id: u.actor.id, route: 'human' });
    const now = ctx.clock.now().toISOString();
    const updated = await tx.update('proposals', p.id, { status: 'applied', decided_by: u.actor.id, decided_at: now, decision_reason: note?.slice(0, 500) || null, applied_ref_type: res?.refType ?? null, applied_ref_id: res?.refId ?? null, updated_at: now });
    await tx.insert('approvals', { subject_type: 'proposal', subject_id: p.id, decision: 'approved', actor_type: 'user', actor_id: u.actor.id, policy_ref: null, reason: note?.slice(0, 500) || null, at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'proposal.approve', subjectType: 'proposal', subjectId: p.id, entityId: p.entity_id, summary: `${p.ref} approved and applied: ${p.title}`, data: { kind: p.kind, amountMinor: p.amount_minor, refType: res?.refType ?? null, refId: res?.refId ?? null } }, u.ip);
    await refreshCloseTask(tx, p.period_key, p.skill_key);
    return updated;
  });
  return out;
}

export async function rejectProposal(ctx: AppContext, u: RequestUser, id: string, reason: string): Promise<ProposalRow> {
  if (!reason || reason.trim().length < 5) throw validation('Say briefly why you are rejecting it (at least 5 characters); the agent and auditors will see it.');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const p = await load(tx, id);
    if (!u.actor.permissions.has(DECISION_PERMISSION[p.kind])) throw forbidden(`Needs the ${DECISION_PERMISSION[p.kind]} permission.`);
    if (!['pending_approval', 'suggested'].includes(p.status)) throw conflict(`It is already ${p.status.replace('_', ' ')}.`);
    const now = ctx.clock.now().toISOString();
    const updated = await tx.update('proposals', p.id, { status: 'rejected', decided_by: u.actor.id, decided_at: now, decision_reason: reason.trim().slice(0, 500), updated_at: now });
    await tx.insert('approvals', { subject_type: 'proposal', subject_id: p.id, decision: 'rejected', actor_type: 'user', actor_id: u.actor.id, policy_ref: null, reason: reason.trim().slice(0, 500), at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'proposal.reject', subjectType: 'proposal', subjectId: p.id, entityId: p.entity_id, summary: `${p.ref} rejected: ${reason.trim().slice(0, 140)}`, data: { kind: p.kind } }, u.ip);
    await refreshCloseTask(tx, p.period_key, p.skill_key);
    return updated;
  });
}

export async function bulkApprove(ctx: AppContext, u: RequestUser, ids: string[], note?: string): Promise<{ id: string; ok: boolean; ref?: string; error?: string }[]> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw validation('Select between 1 and 200 items.');
  const out: { id: string; ok: boolean; ref?: string; error?: string }[] = [];
  for (const id of ids) {
    try {
      const p = await approveProposal(ctx, u, id, note);
      out.push({ id, ok: true, ref: p.ref });
    } catch (e) {
      out.push({ id, ok: false, error: (e as Error).message });
    }
  }
  return out;
}

/** Post-hoc review of an item the policy applied (L2 sample / L3). */
export async function reviewProposal(ctx: AppContext, u: RequestUser, id: string, note?: string): Promise<ProposalRow> {
  return ctx.db.tx(u.tenantId, async (tx) => {
    const p = await load(tx, id);
    if (!u.actor.permissions.has(DECISION_PERMISSION[p.kind])) throw forbidden(`Needs the ${DECISION_PERMISSION[p.kind]} permission.`);
    if (p.review_status !== 'pending') throw conflict('This item is not waiting for review.');
    if (p.requested_by === u.actor.id && !ctx.skills.get(p.skill_key).manifest.controls.requesterMayApprove) throw sodViolation('You ran the agent that produced this, so someone else has to review it.');
    const now = ctx.clock.now().toISOString();
    const updated = await tx.update('proposals', p.id, { review_status: 'reviewed', updated_at: now });
    await tx.insert('approvals', { subject_type: 'proposal', subject_id: p.id, decision: 'reviewed', actor_type: 'user', actor_id: u.actor.id, policy_ref: null, reason: note?.slice(0, 500) || null, at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'proposal.review', subjectType: 'proposal', subjectId: p.id, entityId: p.entity_id, summary: `${p.ref} reviewed after auto-apply`, data: {} }, u.ip);
    return updated;
  });
}

/** Change a coding suggestion before approving it; the editor becomes a preparer (SoD). */
export async function editCoding(ctx: AppContext, u: RequestUser, id: string, change: { accountCode: string; department: string | null }): Promise<ProposalRow> {
  return ctx.db.tx(u.tenantId, async (tx) => {
    const p = await load(tx, id);
    if (p.kind !== 'coding') throw validation('Only coding suggestions can be edited.');
    if (!u.actor.permissions.has('coding.approve')) throw forbidden('Needs the coding.approve permission.');
    if (!['pending_approval', 'suggested'].includes(p.status)) throw conflict(`It is already ${p.status.replace('_', ' ')}.`);
    const svc = new AccountingServices(tx, u.actor, ctx.clock);
    const acct = (await svc.ctx.chart()).tryAccount(change.accountCode);
    if (!acct || !acct.is_postable || acct.status !== 'active' || acct.control_subledger) throw validation(`${change.accountCode} is not an account you can code spend to.`);
    if (acct.required_dimensions.includes('department') && !change.department) throw validation(`${acct.code} needs a department (AX-AC-02).`);
    const payload = CodingPayloadSchema.parse({ ...p.payload, accountCode: acct.code, department: acct.required_dimensions.includes('department') ? change.department : null });
    const now = ctx.clock.now().toISOString();
    const updated = await tx.update('proposals', p.id, { payload: payload as unknown as ProposalRow['payload'], edited_by: u.actor.id, title: `${p.title.split('→')[0]!.trim()} → ${acct.code} ${acct.name}${payload.department ? ` · ${payload.department}` : ''} (edited)`.slice(0, 300), updated_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'proposal.edit', subjectType: 'proposal', subjectId: p.id, entityId: p.entity_id, summary: `${p.ref} coding changed to ${acct.code}${payload.department ? `/${payload.department}` : ''}`, data: { from: (p.payload as { accountCode?: string }).accountCode ?? null, to: acct.code } }, u.ip);
    return updated;
  });
}

/** When nothing from a skill is left waiting in a period, its close task becomes ready for review. */
export async function refreshCloseTask(tx: DbTx, periodKey: string | null, skillKey: string) {
  if (!periodKey) return;
  const cp = await tx.findOne('close_periods', { period_key: periodKey });
  if (!cp) return;
  const task = await tx.findOne('close_tasks', { close_period_id: cp.id, skill_key: skillKey });
  if (!task || task.status !== 'in_progress') return;
  const waiting = await tx.count('proposals', { skill_key: skillKey, period_key: periodKey, status: { in: ['pending_approval', 'suggested'] } });
  if (waiting === 0) await tx.update('close_tasks', task.id, { status: 'ready_for_review', notes: `${task.notes ? `${task.notes} · ` : ''}All agent items decided.`.slice(0, 2000) });
}
