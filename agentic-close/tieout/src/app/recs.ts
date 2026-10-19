/**
 * Reconciliation sign-off: the preparer certifies (AX-REC-01 ties out, or AX-REC-04 justification
 * for unexplained items) and a different person reviews (AX-SOD-03, also a database CHECK).
 */
import { audit } from '../core/audit/audit';
import { conflict, invariant, notFound, sodViolation, validation } from '../core/util/errors';
import { periodEnd } from '../core/util/time';
import type { ReconciliationRow } from '../schema';
import { AccountingServices } from '../packs/accounting/services';
import type { AppContext, RequestUser } from './context';
import { requirePermission } from './context';

export async function certifyBankRec(ctx: AppContext, u: RequestUser, bankAccountId: string, periodKey: string, note?: string): Promise<ReconciliationRow> {
  requirePermission(u, 'recon.prepare');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const svc = new AccountingServices(tx, u.actor, ctx.clock);
    const rec = await svc.bank.ensureReconciliation(bankAccountId, periodKey);
    const st = await svc.bank.state(bankAccountId, periodKey);
    if (!st.tiesOut) throw invariant('AX-REC-01', `the reconciliation is out by ${(st.unreconciledMinor / 100).toFixed(2)}; match or explain the remaining items first`);
    if (st.unexplainedMinor !== 0 && (!note || note.trim().length < 20)) throw invariant('AX-REC-04', 'an unexplained item is open; add a written justification and follow-up (at least 20 characters)');
    if (st.unmatchedBank > 0 && (!note || note.trim().length < 20)) throw validation(`${st.unmatchedBank} bank lines are still unmatched (decisions pending). Decide them or justify certifying now.`);
    const now = ctx.clock.now().toISOString();
    const updated = await tx.update('reconciliations', rec.id, { status: 'prepared', preparer_id: u.actor.id, prepared_at: now, gl_balance_minor: st.glBalanceMinor, external_balance_minor: st.externalBalanceMinor, unreconciled_minor: st.unreconciledMinor, notes: note?.slice(0, 2000) ?? rec.notes });
    await tx.insert('signoffs', { subject_type: 'reconciliation', subject_id: rec.id, role: 'preparer', user_id: u.actor.id, statement: `Prepared: bank ${(st.externalBalanceMinor / 100).toFixed(2)} reconciles to GL ${(st.glBalanceMinor / 100).toFixed(2)}.`, content_hash: null, signed_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'recon.certify', subjectType: 'reconciliation', subjectId: rec.id, entityId: rec.entity_id, summary: `Bank reconciliation ${periodKey} prepared (unreconciled ${(st.unreconciledMinor / 100).toFixed(2)})`, data: { unexplainedMinor: st.unexplainedMinor } }, u.ip);
    return updated;
  });
}

export async function certifySubledger(ctx: AppContext, u: RequestUser, entityId: string, kind: 'ap' | 'ar', periodKey: string, note?: string): Promise<ReconciliationRow> {
  requirePermission(u, 'recon.prepare');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const svc = new AccountingServices(tx, u.actor, ctx.clock);
    svc.ctx.assertEntityInScope(entityId);
    const t = await svc.subledgers.tieOut(entityId, kind, periodEnd(periodKey));
    if (t.differenceMinor !== 0 && (!note || note.trim().length < 20)) throw invariant('AX-REC-01', `the subledger differs from the GL by ${(t.differenceMinor / 100).toFixed(2)}; explain it (at least 20 characters) or fix it first`);
    const period = await svc.ctx.period(entityId, periodKey);
    const chart = await svc.ctx.chart();
    const recType = kind === 'ap' ? 'subledger_ap' : 'subledger_ar';
    const now = ctx.clock.now().toISOString();
    const existing = await tx.findOne('reconciliations', { entity_id: entityId, period_id: period.id, rec_type: recType });
    const fields = { status: 'prepared' as const, preparer_id: u.actor.id, prepared_at: now, gl_balance_minor: t.glMinor, external_balance_minor: t.subledgerMinor, unreconciled_minor: t.differenceMinor, notes: note?.slice(0, 2000) ?? null };
    const rec = existing
      ? await tx.update('reconciliations', existing.id, fields)
      : await tx.insert('reconciliations', { entity_id: entityId, period_id: period.id, account_id: chart.account(t.accountCode).id, rec_type: recType, bank_account_id: null, external_source: kind === 'ap' ? 'AP aging (bills less payments)' : 'AR aging (invoices less receipts)', risk: 'low', reviewer_id: null, reviewed_at: null, agent_run_id: null, ...fields });
    await tx.insert('signoffs', { subject_type: 'reconciliation', subject_id: rec.id, role: 'preparer', user_id: u.actor.id, statement: `Prepared: ${kind.toUpperCase()} subledger ${(t.subledgerMinor / 100).toFixed(2)} vs GL ${(t.glMinor / 100).toFixed(2)}.`, content_hash: null, signed_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'recon.certify', subjectType: 'reconciliation', subjectId: rec.id, entityId, summary: `${kind.toUpperCase()} tie-out ${periodKey} prepared (difference ${(t.differenceMinor / 100).toFixed(2)})`, data: {} }, u.ip);
    return rec;
  });
}

export async function reviewRec(ctx: AppContext, u: RequestUser, recId: string, note?: string): Promise<ReconciliationRow> {
  requirePermission(u, 'recon.review');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const rec = await tx.get('reconciliations', recId);
    if (!rec) throw notFound('Reconciliation', recId);
    if (rec.status !== 'prepared') throw conflict('Only a prepared reconciliation can be reviewed.');
    if (rec.preparer_id === u.actor.id) throw sodViolation('You prepared this reconciliation, so someone else has to review it (AX-SOD-03).');
    if (rec.agent_run_id) {
      const run = await tx.get('agent_runs', rec.agent_run_id);
      if (run?.requested_by === u.actor.id) throw sodViolation('You ran the agent that prepared this reconciliation, so someone else has to review it (AX-SOD-03).');
    }
    const now = ctx.clock.now().toISOString();
    const updated = await tx.update('reconciliations', rec.id, { status: 'reviewed', reviewer_id: u.actor.id, reviewed_at: now, notes: note ? `${rec.notes ? `${rec.notes}\n` : ''}Review: ${note}`.slice(0, 2000) : rec.notes });
    await tx.insert('signoffs', { subject_type: 'reconciliation', subject_id: rec.id, role: 'reviewer', user_id: u.actor.id, statement: 'Reviewed and approved.', content_hash: null, signed_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'recon.review', subjectType: 'reconciliation', subjectId: rec.id, entityId: rec.entity_id, summary: `Reconciliation reviewed (${rec.rec_type})`, data: {} }, u.ip);
    return updated;
  });
}
