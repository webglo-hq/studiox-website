import { appendAudit } from '../../audit/audit';
import type { Tx } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import type { Permission } from '../../security/permissions';
import { can, type Principal, withinLimit } from '../../security/principal';
import type { DomainContext } from '../../shared/context';
import { DomainError } from '../../shared/errors';
import { formatMoney } from '../../shared/money';
import type { AgentRuntime } from './runtime';

/**
 * Human decisions on proposals: approve (apply the effect), reject (with reason), bulk, adopt a suggestion,
 * and post-hoc review of auto-applied work. Every decision passes the authority checks below and is written
 * to the append-only approvals table and the audit chain.
 */

export interface DecisionBlock {
  code: string;
  message: string;
}

/** Why `principal` may not approve `proposal` (empty = allowed). */
export async function approvalBlocks(tx: Tx, runtime: AgentRuntime<unknown>, principal: Principal, proposal: Row<'proposals'>): Promise<DecisionBlock[]> {
  const blocks: DecisionBlock[] = [];
  if (principal.readOnly) blocks.push({ code: 'READ_ONLY', message: 'Read-only role: auditors can review but not decide.' });
  if (!can(principal, proposal.required_permission as Permission)) {
    blocks.push({ code: 'PERMISSION', message: `Needs permission "${proposal.required_permission}", which your role does not include.` });
  }
  const limitApplies = runtime.handler(proposal.kind).limitApplies !== false;
  if (limitApplies && !withinLimit(principal, proposal.amount_minor)) {
    blocks.push({ code: 'LIMIT', message: `${formatMoney(proposal.amount_minor, { currency: proposal.currency })} is above your approval limit of ${formatMoney(principal.approvalLimitMinor ?? 0, { currency: proposal.currency })}.` });
  }
  const rules = (await tx.find('sod_rules', { tenant_id: principal.tenantId, enabled: true })).filter((r) => r.severity === 'block');
  for (const rule of rules) {
    const params = (rule.params ?? {}) as Record<string, unknown>;
    if (rule.kind === 'maker_checker' && proposal.maker_user_id && proposal.maker_user_id === principal.user.id) {
      blocks.push({ code: rule.code, message: `${rule.name}: you made this proposal, so someone else must approve it.` });
    }
    if (rule.kind === 'requester_limit' && limitApplies && proposal.requested_by === principal.user.id && proposal.amount_minor > Number(params.limit_minor ?? 0)) {
      blocks.push({ code: rule.code, message: `${rule.name}: you started the agent run, and items over ${formatMoney(Number(params.limit_minor ?? 0))} need an independent approver.` });
    }
    if (rule.kind === 'policy_author' && proposal.policy_id) {
      const policy = await tx.get('skill_policies', proposal.policy_id);
      if (policy?.created_by === principal.user.id) blocks.push({ code: rule.code, message: `${rule.name}: you wrote the policy version this proposal was generated under (v${policy.version}).` });
    }
    if (rule.kind === 'vendor_master_payment') {
      const subjects = runtime.handler(proposal.kind).sodSubjects?.(proposal);
      for (const vendorId of subjects?.vendorIds ?? []) {
        const vendor = await tx.get('vendors', vendorId);
        if (vendor && (vendor.created_by === principal.user.id || vendor.updated_by === principal.user.id)) {
          blocks.push({ code: rule.code, message: `${rule.name}: you maintain the vendor record for ${vendor.name}.` });
        }
      }
    }
  }
  return blocks;
}

async function scopeFor(tx: Tx, ctx: DomainContext, runtime: AgentRuntime<unknown>) {
  return { tx, ctx, pack: await runtime.deps.pack.buildScope(tx, ctx) };
}

export async function approveProposal(tx: Tx, ctx: DomainContext, runtime: AgentRuntime<unknown>, principal: Principal, proposalId: string, note?: string): Promise<Row<'proposals'>> {
  const proposal = await tx.get('proposals', proposalId, { forUpdate: true });
  if (!proposal || proposal.tenant_id !== ctx.tenantId) throw new DomainError('NOT_FOUND', 'Proposal not found');
  if (proposal.status !== 'pending') {
    throw new DomainError('CONFLICT', proposal.status === 'blocked' ? 'This proposal failed verification and cannot be approved; reject it or re-run the agent after fixing the cause.' : `This proposal is already ${proposal.status.replace('_', ' ')}.`);
  }
  const blocks = await approvalBlocks(tx, runtime, principal, proposal);
  if (blocks.length) throw new DomainError(blocks.some((b) => b.code.startsWith('SOD')) ? 'SOD_VIOLATION' : 'FORBIDDEN', blocks.map((b) => b.message).join(' '), { blocks });
  const handler = runtime.handler(proposal.kind);
  const scope = await scopeFor(tx, ctx, runtime);
  const result = await handler.apply({ ...scope, proposal, basis: 'human_approval', approvedBy: principal.user.id, runId: proposal.run_id });
  const now = ctx.clock.now();
  const updated = await tx.update('proposals', proposal.id, {
    status: 'approved',
    decided_by: principal.user.id,
    decided_at: now,
    decision_reason: note ?? null,
    effect: result.effect,
    posted_entry_id: result.postedEntryId ?? null,
    updated_at: now,
  });
  await tx.insert('approvals', { tenant_id: ctx.tenantId, proposal_id: proposal.id, decision: 'approve', user_id: principal.user.id, role_key: principal.roleKeys[0] ?? 'unknown', reason: note ?? null });
  await appendAudit(tx, ctx.tenantId, ctx.actor, {
    action: 'proposal.approve',
    objectType: 'proposal',
    objectId: proposal.id,
    summary: `Approved ${handler.label.toLowerCase()}: ${proposal.title}${result.postedEntryId ? ' (posted)' : ''}`,
    details: { effect: result.effect, note: note ?? null, amount_minor: proposal.amount_minor },
  }, now);
  await runtime.deps.pack.onProposalSettled?.(scope, updated);
  return updated;
}

export async function rejectProposal(tx: Tx, ctx: DomainContext, runtime: AgentRuntime<unknown>, principal: Principal, proposalId: string, reason: string): Promise<Row<'proposals'>> {
  if (!reason || reason.trim().length < 3) throw new DomainError('VALIDATION', 'Give a reason for rejecting (it trains the policy and documents the review).');
  const proposal = await tx.get('proposals', proposalId, { forUpdate: true });
  if (!proposal || proposal.tenant_id !== ctx.tenantId) throw new DomainError('NOT_FOUND', 'Proposal not found');
  if (!['pending', 'blocked', 'suggested'].includes(proposal.status)) throw new DomainError('CONFLICT', `This proposal is already ${proposal.status.replace('_', ' ')}.`);
  if (principal.readOnly || !can(principal, proposal.required_permission as Permission)) throw new DomainError('FORBIDDEN', 'Your role cannot decide this proposal.');
  const handler = runtime.handler(proposal.kind);
  const scope = await scopeFor(tx, ctx, runtime);
  await handler.onReject?.(proposal, scope);
  const now = ctx.clock.now();
  const updated = await tx.update('proposals', proposal.id, { status: 'rejected', decided_by: principal.user.id, decided_at: now, decision_reason: reason.trim(), updated_at: now });
  await tx.insert('approvals', { tenant_id: ctx.tenantId, proposal_id: proposal.id, decision: 'reject', user_id: principal.user.id, role_key: principal.roleKeys[0] ?? 'unknown', reason: reason.trim() });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'proposal.reject', objectType: 'proposal', objectId: proposal.id, summary: `Rejected ${handler.label.toLowerCase()}: ${proposal.title} (${reason.trim()})` }, now);
  await runtime.deps.pack.onProposalSettled?.(scope, updated);
  return updated;
}

/** Turn an L0 suggestion into a proposal awaiting someone else's approval (the adopter becomes the maker). */
export async function adoptSuggestion(tx: Tx, ctx: DomainContext, principal: Principal, proposalId: string): Promise<Row<'proposals'>> {
  const proposal = await tx.get('proposals', proposalId);
  if (!proposal || proposal.tenant_id !== ctx.tenantId) throw new DomainError('NOT_FOUND', 'Proposal not found');
  if (proposal.status !== 'suggested') throw new DomainError('CONFLICT', 'Only suggestions can be adopted.');
  if (principal.readOnly) throw new DomainError('FORBIDDEN', 'Read-only role.');
  const now = ctx.clock.now();
  const updated = await tx.update('proposals', proposal.id, { status: 'pending', disposition: 'needs_approval', maker_type: 'user', maker_user_id: principal.user.id, updated_at: now });
  await tx.insert('approvals', { tenant_id: ctx.tenantId, proposal_id: proposal.id, decision: 'adopt', user_id: principal.user.id, role_key: principal.roleKeys[0] ?? 'unknown' });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'proposal.adopt', objectType: 'proposal', objectId: proposal.id, summary: `Adopted suggestion: ${proposal.title}` }, now);
  return updated;
}

/** Post-hoc review of an auto-applied proposal: confirm, or reverse its effect (via the handler / reversal). */
export async function reviewAutoApplied(
  tx: Tx,
  ctx: DomainContext,
  runtime: AgentRuntime<unknown>,
  principal: Principal,
  proposalId: string,
  decision: 'confirm' | 'reverse',
  reason: string | undefined,
  reverse: (proposal: Row<'proposals'>) => Promise<Record<string, unknown>>,
): Promise<Row<'proposals'>> {
  const proposal = await tx.get('proposals', proposalId);
  if (!proposal || proposal.tenant_id !== ctx.tenantId) throw new DomainError('NOT_FOUND', 'Proposal not found');
  if (proposal.status !== 'auto_applied') throw new DomainError('CONFLICT', 'Only auto-applied work is reviewed after the fact.');
  if (proposal.post_hoc_status === 'confirmed' || proposal.post_hoc_status === 'reversed') throw new DomainError('CONFLICT', 'Already reviewed.');
  if (!can(principal, 'proposal.review_posthoc')) throw new DomainError('FORBIDDEN', 'Your role cannot review auto-applied work.');
  if (decision === 'reverse' && (!reason || reason.trim().length < 3)) throw new DomainError('VALIDATION', 'Say why you are reversing it.');
  const now = ctx.clock.now();
  let effect = proposal.effect ?? {};
  if (decision === 'reverse') effect = { ...effect, reversal: await reverse(proposal) };
  const updated = await tx.update('proposals', proposal.id, { post_hoc_status: decision === 'confirm' ? 'confirmed' : 'reversed', post_hoc_reviewed_by: principal.user.id, post_hoc_reviewed_at: now, effect, updated_at: now });
  await tx.insert('approvals', { tenant_id: ctx.tenantId, proposal_id: proposal.id, decision: decision === 'confirm' ? 'post_hoc_confirm' : 'post_hoc_reverse', user_id: principal.user.id, role_key: principal.roleKeys[0] ?? 'unknown', reason: reason ?? null });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: `proposal.post_hoc_${decision}`, objectType: 'proposal', objectId: proposal.id, summary: `${decision === 'confirm' ? 'Confirmed' : 'Reversed'} auto-applied work: ${proposal.title}${reason ? ` (${reason})` : ''}` }, now);
  void runtime;
  return updated;
}
