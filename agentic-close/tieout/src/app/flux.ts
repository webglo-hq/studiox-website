/**
 * Variance explanations written by a person. They travel the same road as an agent's draft: a
 * flux_explanation proposal with the drivers as evidence and the same checks (AX-FLX-01/02), and a
 * different person approves it (maker-checker, SOD-01) before it counts toward the lock.
 */
import type { VerificationResult } from '../core/agent/types';
import { audit } from '../core/audit/audit';
import { conflict, notFound, validation } from '../core/util/errors';
import type { ProposalRow } from '../schema';
import { FluxPayloadSchema } from '../packs/accounting/agent/payloads';
import { closeOntology } from '../packs/accounting/ontology';
import { asUser, requirePermission, type AppContext, type RequestUser } from './context';

export async function writeFluxExplanation(ctx: AppContext, u: RequestUser, input: { entityId: string; periodKey: string; accountCode: string; text: string }): Promise<ProposalRow> {
  requirePermission(u, 'flux.explain');
  const text = String(input.text ?? '').trim();
  if (text.length < 20 || text.length > 4000) throw validation('Write at least 20 characters: what changed, why, and whether it will happen again.');
  return asUser(ctx, u, async (svc, tx) => {
    svc.ctx.assertEntityInScope(input.entityId);
    const f = await svc.flux.compute(input.entityId, input.periodKey);
    const line = f.lines.find((l) => l.code === input.accountCode);
    if (!line) throw notFound('Variance line', input.accountCode);
    if (line.explanation?.status === 'approved') throw conflict('This variance already has an approved explanation.');
    const open = await tx.find('proposals', { entity_id: input.entityId, period_key: input.periodKey, kind: 'flux_explanation', status: { in: ['pending_approval', 'suggested'] } });
    const now = ctx.clock.now().toISOString();
    // a newer explanation replaces any draft still waiting for this account
    for (const p of open.filter((x) => (x.payload as { accountCode?: string }).accountCode === line.code)) await tx.update('proposals', p.id, { status: 'superseded', decided_by: u.actor.id, decided_at: now, decision_reason: 'Replaced by an explanation written by a person', updated_at: now });
    const payload = FluxPayloadSchema.parse({
      entityId: input.entityId,
      periodKey: input.periodKey,
      comparison: f.comparison,
      accountCode: line.code,
      currentMinor: line.currentMinor,
      comparativeMinor: line.comparativeMinor,
      budgetMinor: line.budgetMinor,
      varianceMinor: line.varianceMinor,
      variancePct: line.variancePct,
      thresholdAbsMinor: f.thresholds.absMinor,
      thresholdPct: f.thresholds.pct,
      materiality: line.materiality,
      text,
      drivers: line.drivers.slice(0, 12),
      pending: line.pending,
    });
    const onto = closeOntology();
    const drivers = onto.check('AX-FLX-02', { varianceMinor: line.varianceMinor, driverMinors: payload.drivers.map((d) => d.amountMinor) });
    const verification: VerificationResult[] = [
      { check: 'Variance arithmetic', passed: line.currentMinor - line.comparativeMinor === line.varianceMinor, severity: 'error', message: 'current − comparative = variance' },
      { check: 'Drivers reconcile to the variance', axiomId: 'AX-FLX-02', passed: drivers.passed, severity: 'warning', message: drivers.passed ? 'The drivers add up to the change.' : drivers.messages.join('; ') },
      { check: 'Explanation is substantive', axiomId: 'AX-FLX-01', passed: true, severity: 'error', message: `${text.length} characters` },
    ];
    const n = await tx.nextCounter('proposal');
    const p = await tx.insert('proposals', {
      ref: `P-${String(n).padStart(4, '0')}`,
      run_id: null,
      skill_key: 'flux-analysis',
      kind: 'flux_explanation',
      ontology_type: 'tie:FluxExplanationProposal',
      entity_id: input.entityId,
      period_key: input.periodKey,
      title: `Explain ${line.code} ${line.name} (${f.entityCode})`,
      why: `Written by ${u.actor.label}; a different person approves it before it counts toward the lock.`,
      confidence: 1,
      amount_minor: Math.abs(line.varianceMinor),
      currency: f.currency,
      materiality: line.materiality,
      payload: payload as unknown as ProposalRow['payload'],
      evidence: [{ kind: 'computation', label: `Variance ${line.code}: drivers from the ledger`, detail: payload.drivers.map((d) => d.label).join('; ').slice(0, 500) }],
      verification,
      flags: [],
      status: 'pending_approval',
      autonomy_level: 'L1',
      route: 'human_approval',
      review_status: 'none',
      assigned_role: 'controller',
      assigned_to: null,
      prepared_by: u.actor.id,
      requested_by: u.actor.id,
      idempotency_key: `flux-explanation:${input.entityId}:${input.periodKey}:${line.code}:${now}`,
      created_at: now,
      updated_at: now,
    });
    await audit(tx, u.actor, ctx.clock, { action: 'proposal.create', subjectType: 'proposal', subjectId: p.id, entityId: input.entityId, summary: `${p.ref} explanation written for ${line.code} ${line.name}`, data: { kind: 'flux_explanation', accountCode: line.code } }, u.ip);
    return p;
  });
}
