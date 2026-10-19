import { appendAudit } from '../../audit/audit';
import type { Tx } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import type { Permission } from '../../security/permissions';
import { approvalLimitOn, can, canOn, canSeeEntity, type Principal, withinLimit } from '../../security/principal';
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

/** Below this confidence a proposal is opened and decided on its own, never swept up by a bulk approval. */
export const BULK_MIN_CONFIDENCE = 0.7;

/**
 * Why a proposal must be opened and decided individually rather than bulk-approved (null = bulk is fine):
 * anything risk-flagged (instruction-like text, unexplained cash), any deterministic check that did not pass,
 * and anything the agent is not confident about.
 */
export function bulkApprovalBlock(proposal: Pick<Row<'proposals'>, 'risk_flags' | 'verification' | 'confidence'>): string | null {
  const flags = (proposal.risk_flags as string[] | null) ?? [];
  if (flags.length) return `Flagged (${flags.map((f) => f.replace(/_/g, ' ')).join(', ')}): open it and decide on its own.`;
  const checks = (proposal.verification as Array<{ id?: string; passed?: boolean }> | null) ?? [];
  if (checks.some((c) => c.id !== 'DISPOSITION' && c.passed === false)) return 'A deterministic check did not pass: open it and decide on its own.';
  if (proposal.confidence < BULK_MIN_CONFIDENCE) return `Confidence ${Math.round(proposal.confidence * 100)}% is below the ${Math.round(BULK_MIN_CONFIDENCE * 100)}% floor for bulk approval: open it and decide on its own.`;
  return null;
}

/** Segregation-of-duties findings for `principal` approving `proposal`, with each rule's configured severity. */
export async function sodFindings(tx: Tx, runtime: AgentRuntime<unknown>, principal: Principal, proposal: Row<'proposals'>): Promise<Array<DecisionBlock & { severity: 'block' | 'warn' }>> {
  const out: Array<DecisionBlock & { severity: 'block' | 'warn' }> = [];
  const rules = await tx.find('sod_rules', { tenant_id: principal.tenantId, enabled: true });
  for (const rule of rules) {
    const add = (message: string) => out.push({ code: rule.code, message, severity: rule.severity });
    if (rule.kind === 'maker_checker' && proposal.maker_user_id && proposal.maker_user_id === principal.user.id) {
      add(`${rule.name}: you made this proposal, so someone else must approve it.`);
    }
    // Whoever started the agent run is its maker: none of its output, of any kind or amount, is theirs to approve.
    if (rule.kind === 'requester_limit' && proposal.requested_by && proposal.requested_by === principal.user.id) {
      add(`${rule.name}: you started the agent run that made this proposal, so someone independent must approve it.`);
    }
    if (rule.kind === 'policy_author' && proposal.policy_id) {
      const policy = await tx.get('skill_policies', proposal.policy_id);
      if (policy?.created_by === principal.user.id) add(`${rule.name}: you wrote the policy version this proposal was generated under (v${policy.version}).`);
    }
    if (rule.kind === 'vendor_master_payment') {
      const subjects = runtime.handler(proposal.kind).sodSubjects?.(proposal);
      for (const vendorId of subjects?.vendorIds ?? []) {
        const vendor = await tx.get('vendors', vendorId);
        if (vendor && (vendor.created_by === principal.user.id || vendor.updated_by === principal.user.id)) {
          add(`${rule.name}: you maintain the vendor record for ${vendor.name}.`);
        }
      }
    }
  }
  return out;
}

/**
 * Why `principal` may not approve `proposal` (empty = allowed). SoD rules set to "block" stop the approval;
 * rules set to "warn" let it through but are recorded on the approval and in the audit chain.
 */
export async function approvalBlocks(tx: Tx, runtime: AgentRuntime<unknown>, principal: Principal, proposal: Row<'proposals'>): Promise<DecisionBlock[]> {
  const blocks: DecisionBlock[] = [];
  if (principal.readOnly) blocks.push({ code: 'READ_ONLY', message: 'Read-only role: auditors can review but not decide.' });
  if (!can(principal, proposal.required_permission as Permission)) {
    blocks.push({ code: 'PERMISSION', message: `Needs permission "${proposal.required_permission}", which your role does not include.` });
  } else if (!canOn(principal, proposal.required_permission as Permission, proposal.entity_id)) {
    // Entity scope: a grant limited to one entity decides that entity's items only.
    blocks.push({ code: 'ENTITY', message: proposal.entity_id ? 'Your approval rights cover other entities, not this one.' : 'This covers the whole organization; your approval rights cover only some entities.' });
  }
  const limitApplies = runtime.handler(proposal.kind).limitApplies !== false;
  if (limitApplies && !withinLimit(principal, proposal.amount_minor, proposal.entity_id)) {
    blocks.push({ code: 'LIMIT', message: `${formatMoney(proposal.amount_minor, { currency: proposal.currency })} is above your approval limit of ${formatMoney(approvalLimitOn(principal, proposal.entity_id) ?? 0, { currency: proposal.currency })}.` });
  }
  for (const f of await sodFindings(tx, runtime, principal, proposal)) if (f.severity === 'block') blocks.push({ code: f.code, message: f.message });
  return blocks;
}

async function scopeFor(tx: Tx, ctx: DomainContext, runtime: AgentRuntime<unknown>) {
  return { tx, ctx, pack: await runtime.deps.pack.buildScope(tx, ctx) };
}

export async function approveProposal(tx: Tx, ctx: DomainContext, runtime: AgentRuntime<unknown>, principal: Principal, proposalId: string, note?: string): Promise<Row<'proposals'>> {
  const proposal = await tx.get('proposals', proposalId, { forUpdate: true });
  if (!proposal || proposal.tenant_id !== ctx.tenantId || !canSeeEntity(principal, proposal.entity_id)) throw new DomainError('NOT_FOUND', 'Proposal not found');
  if (proposal.status !== 'pending') {
    throw new DomainError('CONFLICT', proposal.status === 'blocked' ? 'This proposal failed verification and cannot be approved; reject it or re-run the agent after fixing the cause.' : `This proposal is already ${proposal.status.replace('_', ' ')}.`);
  }
  const blocks = await approvalBlocks(tx, runtime, principal, proposal);
  if (blocks.length) throw new DomainError(blocks.some((b) => b.code.startsWith('SOD')) ? 'SOD_VIOLATION' : 'FORBIDDEN', blocks.map((b) => b.message).join(' '), { blocks });
  const warnings = (await sodFindings(tx, runtime, principal, proposal)).filter((f) => f.severity === 'warn');
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
  const warningText = warnings.length ? `[SoD warning] ${warnings.map((w) => w.message).join(' ')}` : '';
  const reason = [note?.trim(), warningText].filter(Boolean).join(' ');
  await tx.insert('approvals', { tenant_id: ctx.tenantId, proposal_id: proposal.id, decision: 'approve', user_id: principal.user.id, role_key: principal.roleKeys[0] ?? 'unknown', reason: reason || null });
  await appendAudit(tx, ctx.tenantId, ctx.actor, {
    action: 'proposal.approve',
    objectType: 'proposal',
    objectId: proposal.id,
    summary: `Approved ${handler.label.toLowerCase()}: ${proposal.title}${result.postedEntryId ? ' (posted)' : ''}${warnings.length ? ` despite SoD warning ${warnings.map((w) => w.code).join(', ')}` : ''}`,
    details: { effect: result.effect, note: note ?? null, amount_minor: proposal.amount_minor, ...(warnings.length ? { sodWarnings: warnings } : {}) },
  }, now);
  await runtime.deps.pack.onProposalSettled?.(scope, updated);
  return updated;
}

export async function rejectProposal(tx: Tx, ctx: DomainContext, runtime: AgentRuntime<unknown>, principal: Principal, proposalId: string, reason: string): Promise<Row<'proposals'>> {
  if (!reason || reason.trim().length < 3) throw new DomainError('VALIDATION', 'Give a reason for rejecting (it trains the policy and documents the review).');
  const proposal = await tx.get('proposals', proposalId, { forUpdate: true });
  if (!proposal || proposal.tenant_id !== ctx.tenantId || !canSeeEntity(principal, proposal.entity_id)) throw new DomainError('NOT_FOUND', 'Proposal not found');
  if (!['pending', 'blocked', 'suggested'].includes(proposal.status)) throw new DomainError('CONFLICT', `This proposal is already ${proposal.status.replace('_', ' ')}.`);
  if (principal.readOnly || !canOn(principal, proposal.required_permission as Permission, proposal.entity_id)) throw new DomainError('FORBIDDEN', 'Your role cannot decide this proposal.');
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
  if (!proposal || proposal.tenant_id !== ctx.tenantId || !canSeeEntity(principal, proposal.entity_id)) throw new DomainError('NOT_FOUND', 'Proposal not found');
  if (proposal.status !== 'suggested') throw new DomainError('CONFLICT', 'Only suggestions can be adopted.');
  if (principal.readOnly) throw new DomainError('FORBIDDEN', 'Read-only role.');
  if (!canOn(principal, 'proposal.decide', proposal.entity_id)) throw new DomainError('FORBIDDEN', 'Your role cannot adopt suggestions for this entity.');
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
  if (!proposal || proposal.tenant_id !== ctx.tenantId || !canSeeEntity(principal, proposal.entity_id)) throw new DomainError('NOT_FOUND', 'Proposal not found');
  if (proposal.status !== 'auto_applied') throw new DomainError('CONFLICT', 'Only auto-applied work is reviewed after the fact.');
  if (proposal.post_hoc_status === 'confirmed' || proposal.post_hoc_status === 'reversed') throw new DomainError('CONFLICT', 'Already reviewed.');
  if (!canOn(principal, 'proposal.review_posthoc', proposal.entity_id)) throw new DomainError('FORBIDDEN', 'Your role cannot review auto-applied work for this entity.');
  // Confirming is an independent review; the person who started the run may still reverse its work.
  if (decision === 'confirm' && proposal.requested_by && proposal.requested_by === principal.user.id) throw new DomainError('SOD_VIOLATION', 'You started the agent run that applied this, so someone independent must confirm it.');
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
