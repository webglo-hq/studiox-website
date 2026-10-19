import type { Assessment, DelegatedActor, DomainAdapter, ProposalDraft, ProposalRecord, RunRecord, SkillPolicy, VerificationReport } from '../../../framework/runtime/types';
import type { SkillPackage } from '../../../framework/skills/manifest';
import type { Clock } from '../../../framework/util/clock';
import { AppError } from '../../../framework/util/errors';
import { audit } from '../domain/audit';
import { hasPermission, makeContext, requireEntity } from '../domain/context';
import { assertSod, loadActor } from '../domain/rbac';
import { ONTOLOGY_VERSION, PROPOSAL_CLASS, type ProposalKind } from '../ontology';
import { syncTaskFromRuns } from '../services/close';
import { currentPeriodKey, materialityBand, toReporting } from '../services/common';
import { refreshRec } from '../services/recs';
import { currentPolicy } from '../services/skills';
import type { EkDb } from '../store';
import { agentServiceContext, type AgentCtx } from './context';
import { applyProposal } from './effectors';
import { entityCurrencyOf, verifyProposal } from './verify';

/** Proposal kinds that move money or balances (gated by amount); the rest gate on confidence only. */
const MONETARY: ReadonlySet<string> = new Set(['journal_entry', 'coding', 'rec_match', 'reconciling_item', 'prepaid_schedule', 'fixed_asset']);

/** Permission a person needs (in addition to proposal.approve) to approve each kind. */
const APPROVE_PERMISSION: Record<ProposalKind, string> = {
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

export interface AdapterDeps {
  db: EkDb;
  tenantId: string;
  clock: Clock;
  skills: Map<string, SkillPackage>;
  dispatch: (parentRun: RunRecord) => Promise<unknown>;
}

export function createAdapter(deps: AdapterDeps): DomainAdapter<AgentCtx> {
  const { db, tenantId, clock } = deps;

  const toolContext = async (run: RunRecord, actor: DelegatedActor): Promise<AgentCtx> => {
    const skill = deps.skills.get(run.skillId);
    if (!skill) throw new Error(`Unknown skill ${run.skillId}`);
    const requester = run.requestedBy ? await loadActor(db, tenantId, run.requestedBy).catch(() => null) : null;
    let svc;
    let decider = null;
    if (actor.kind === 'user' && actor.userId) {
      // Keep the delegate's label, which may name the channel (e.g. "via API token").
      decider = { ...(await loadActor(db, tenantId, actor.userId)), label: actor.label };
      svc = makeContext(db, tenantId, decider, clock);
    } else {
      svc = agentServiceContext(db, tenantId, clock, run, actor, requester);
    }
    const policy = await currentPolicy(svc, skill);
    const periodKey = run.periodKey ?? (await currentPeriodKey(svc));
    return { svc, run, skill, policy, periodKey, requester, decider, dispatch: deps.dispatch };
  };

  const assess = async (draft: ProposalDraft, ctx: AgentCtx): Promise<Assessment> => {
    const currency = draft.currency ?? (await entityCurrencyOf(ctx, draft.entityId ?? ctx.run.entityId));
    const amount = Math.abs(draft.amount ?? 0);
    const reporting = await toReporting(ctx.svc, amount, currency, draft.periodKey ?? ctx.periodKey);
    const { band, performance } = await materialityBand(ctx.svc, reporting);
    const gating = MONETARY.has(draft.kind) ? reporting : 0;
    const materiality = MONETARY.has(draft.kind) ? band : 'trivial';
    return { amountReporting: gating, materiality, performanceMateriality: performance, requiresRole: materiality === 'material' ? 'controller' : null };
  };

  const authorize = async (p: ProposalRecord, ctx: AgentCtx, decision: 'approve' | 'reject' | 'review'): Promise<void> => {
    const actor = ctx.decider ?? ctx.svc.actor;
    if (!actor.userId) throw new AppError('FORBIDDEN', 'Only a signed-in person can decide on proposals.');
    if (p.entityId) requireEntity(ctx.svc, p.entityId);
    if (decision === 'review') {
      if (!hasPermission(actor, 'proposal.review')) throw new AppError('FORBIDDEN', 'Your role cannot complete post-hoc reviews.');
      if (ctx.run.requestedBy === actor.userId) throw new AppError('SOD_VIOLATION', 'SOD-02: you started the run that posted this; someone else must review it.');
      return;
    }
    if (!hasPermission(actor, 'proposal.approve')) throw new AppError('FORBIDDEN', 'Your role cannot approve or reject agent proposals.');
    if (decision === 'reject') return; // discarding a draft never needs segregation of duties
    if (p.materiality === 'material' && !hasPermission(actor, 'proposal.approve.material')) throw new AppError('FORBIDDEN', 'This item is at or above performance materiality and needs a controller or CFO.');
    const extra = APPROVE_PERMISSION[p.kind as ProposalKind];
    if (extra && !hasPermission(actor, extra)) throw new AppError('FORBIDDEN', `Approving this kind of item needs the ${extra} permission.`);
    const task = ctx.run.taskId ? await db.get('close_task', ctx.run.taskId) : null;
    const vendorIds = [p.payload.vendorId, (p.payload.lines as { vendorId?: string }[] | undefined)?.map((l) => l.vendorId)].flat().filter((x): x is string => typeof x === 'string');
    await assertSod(ctx.svc, { kind: 'approve_proposal', preparedBy: task?.owner_id ?? null, requestedBy: ctx.run.requestedBy, vendorIds });
  };

  const afterDecision = async (p: ProposalRecord, ctx: AgentCtx): Promise<void> => {
    // Supersede pending proposals made obsolete by this one (e.g. a statement line now matched).
    if (p.status === 'applied' || p.status === 'auto_applied') {
      const bankIds = new Set<string>([...(((p.payload.links ?? {}) as { bankTransactionIds?: string[] }).bankTransactionIds ?? []), ...((p.payload.bankItems as { id: string }[] | undefined) ?? []).map((b) => b.id)]);
      if (bankIds.size) {
        const pend = await db.find('proposal', { run_id: p.runId, status: { in: ['pending', 'suggested'] } });
        for (const q of pend) {
          if (q.id === p.id) continue;
          const refs = ((q.payload.sourceRefs ?? []) as { type: string; id: string }[]).filter((r) => r.type === 'bank_transaction');
          const qb = [...refs.map((r) => r.id), ...((q.payload.bankItems as { id: string }[] | undefined) ?? []).map((b) => b.id)];
          if (qb.length && qb.every((id) => bankIds.has(id))) {
            await db.update('proposal', q.id, { status: 'superseded', decision_reason: `Superseded: ${p.title}`, decided_at: clock.nowIso() });
          }
        }
      }
    }
    const recId = (p.payload.reconciliationId as string | undefined) ?? ((p.payload.links ?? {}) as { recId?: string }).recId;
    if (recId) await refreshRec(ctx.svc, recId);
    if (ctx.run.taskId) await syncTaskFromRuns(ctx.svc, ctx.run.taskId);
  };

  return {
    ontologyVersion: ONTOLOGY_VERSION,
    toolContext,
    payloadClass: (kind) => PROPOSAL_CLASS[kind as ProposalKind] ?? 'ek:Proposal',
    verify: (draft, ctx): Promise<VerificationReport> => verifyProposal(ctx, draft),
    assess,
    apply: (p, ctx, decision) => applyProposal(ctx, p, decision),
    audit: (ctx, event) => audit(ctx.svc, event),
    policy: async (skillId): Promise<SkillPolicy> => {
      const skill = deps.skills.get(skillId);
      if (!skill) throw new Error(`Unknown skill ${skillId}`);
      return currentPolicy(makeContext(db, tenantId, { type: 'system', userId: null, label: 'policy', roles: [], permissions: new Set(['*']), entityScope: 'all' }, clock), skill);
    },
    afterDecision,
    authorize,
  };
}
