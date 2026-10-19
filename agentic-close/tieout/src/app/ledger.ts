/** Manual journal entries: prepare, approve (maker-checker + approval limit), reject, reverse. */
import { z } from 'zod';
import { audit } from '../core/audit/audit';
import { forbidden, notFound, sodViolation, validation } from '../core/util/errors';
import { periodKeyOf } from '../core/util/time';
import type { JournalEntryRow } from '../schema';
import { usdEquivalent } from '../packs/accounting/agent/assess';
import { JeLineSchema } from '../packs/accounting/agent/payloads';
import { evaluateApproval } from '../packs/accounting/controls/sod';
import { approveAndPost, createJournalEntry, rejectJournalEntry, reverseJournalEntry } from '../packs/accounting/ledger/journal';
import { closeOntology } from '../packs/accounting/ontology';
import { AccountingServices } from '../packs/accounting/services';
import type { AppContext, RequestUser } from './context';
import { assertInScope, requirePermission } from './context';

export const ManualJeInput = z
  .object({
    entityId: z.string(),
    postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    entryType: z.enum(['standard', 'adjusting', 'accrual', 'reclass']),
    memo: z.string().min(3).max(300),
    lines: z.array(JeLineSchema).min(2).max(100),
    autoReverseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();

export async function prepareJournal(ctx: AppContext, u: RequestUser, raw: unknown): Promise<JournalEntryRow> {
  requirePermission(u, 'je.create');
  const input = ManualJeInput.safeParse(raw);
  if (!input.success) throw validation(input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return ctx.db.tx(u.tenantId, async (tx) => {
    const svc = new AccountingServices(tx, u.actor, ctx.clock);
    svc.ctx.assertEntityInScope(input.data.entityId);
    return createJournalEntry(await svc.ctx.ledger(), { ...input.data, source: 'manual', preparedBy: u.actor.id, autoReverseOn: input.data.autoReverseOn ?? null }, 'pending_approval');
  });
}

export async function approveJournal(ctx: AppContext, u: RequestUser, jeId: string, reason?: string): Promise<JournalEntryRow> {
  requirePermission(u, 'je.approve');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const je = await tx.get('journal_entries', jeId);
    if (!je) throw notFound('Journal entry', jeId);
    const svc = new AccountingServices(tx, u.actor, ctx.clock);
    svc.ctx.assertEntityInScope(je.entity_id);
    if (je.proposal_id) throw validation('This entry came from an agent proposal; approve the proposal instead.');
    const rules = await tx.find('sod_rules', { enabled: true });
    const sod = evaluateApproval(rules, u.actor.id, { subjectType: 'journal_entry', preparedBy: je.prepared_by });
    if (!sod.allowed) throw sodViolation(sod.violations.map((v) => `${v.code}: ${v.message}`).join(' '));
    const usd = await usdEquivalent(svc, je.total_minor, je.currency, je.posting_date.slice(0, 7));
    const lim = closeOntology().check('AX-SOD-04', { amountMinor: usd, limitMinor: u.actor.approvalLimitMinor });
    if (!lim.passed) throw forbidden(`AX-SOD-04: ${lim.messages.join('; ')}`);
    const posted = await approveAndPost(await svc.ctx.ledger(), je.id, { route: 'human', approverId: u.actor.id, reason });
    // explanation drafts written for the figures before this entry no longer explain the variance
    await svc.flux.retireOutdatedDrafts(posted.entity_id, periodKeyOf(posted.posting_date), `${posted.je_number} posted`);
    return posted;
  });
}

export async function rejectJournal(ctx: AppContext, u: RequestUser, jeId: string, reason: string) {
  requirePermission(u, 'je.approve');
  return ctx.db.tx(u.tenantId, async (tx) => {
    assertInScope(u, (await tx.get('journal_entries', jeId))?.entity_id);
    return rejectJournalEntry(await new AccountingServices(tx, u.actor, ctx.clock).ctx.ledger(), jeId, reason);
  });
}

/** Request a reversal of a posted entry; the reversal itself needs a second person to approve. */
export async function requestReversal(ctx: AppContext, u: RequestUser, jeId: string, reason: string, postingDate: string) {
  requirePermission(u, 'je.reverse');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(postingDate)) throw validation('Choose a posting date for the reversal.');
  return ctx.db.tx(u.tenantId, async (tx) => {
    assertInScope(u, (await tx.get('journal_entries', jeId))?.entity_id);
    const svc = new AccountingServices(tx, u.actor, ctx.clock);
    const out = await reverseJournalEntry(await svc.ctx.ledger(), jeId, { postingDate, reason, preparedBy: u.actor.id, post: 'approval' });
    await audit(tx, u.actor, ctx.clock, { action: 'je.reverse.request', subjectType: 'journal_entry', subjectId: jeId, entityId: out.entity_id, summary: `Reversal ${out.je_number} requested: ${reason}`, data: { reversalId: out.id } }, u.ip);
    return out;
  });
}
