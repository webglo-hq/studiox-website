import { appendAudit } from '../../audit/audit';
import type { Where } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import { reviewTask, signOffProblems } from '../../packs/accounting/domain/close';
import { createEntry, type EntryDraft, errorsOf, postEntry, reverseEntry, verifyDraft } from '../../packs/accounting/domain/ledger';
import { balanceSheet, checkTrialBalance, consolidatedTrialBalance, entityTrialBalance, incomeStatement } from '../../packs/accounting/domain/reporting';
import { approveFlux, explainLine } from '../../packs/accounting/services/flux';
import { closeOntology } from '../../packs/accounting/ontology';
import { can, canOn, canSeeEntity, entityScope, requireAllEntities, requirePermission, requirePermissionOn, withinLimit, type Principal } from '../../security/principal';
import { DomainError } from '../../shared/errors';
import { formatMoney } from '../../shared/money';
import type { App, RequestMeta } from '../app';
import { continueClose, currentClose } from './close';

/** Journal entries, trial balance, statements with drill-down, flux workpaper. */

export async function listEntries(app: App, p: Principal, f: { entity?: string; period?: string; status?: string; type?: string; source?: string; q?: string; account?: string; limit?: number; offset?: number }) {
  requirePermission(p, 'je.view');
  return app.read(async (tx) => {
    const lookups = await app.lookups(tx, p.tenantId);
    const scope = entityScope(p);
    const where: Where<'journal_entries'> = { tenant_id: p.tenantId, ...(scope ? { entity_id: scope } : {}) };
    const entity = f.entity ? lookups.entity(f.entity) : undefined;
    if (entity) where.entity_id = canSeeEntity(p, entity.id) ? entity.id : { in: [] };
    if (f.period && entity) {
      const [y, m] = f.period.split('-').map(Number);
      const per = lookups.period(entity.id, y!, m!);
      if (per) where.period_id = per.id;
    } else if (f.period) {
      const [y, m] = f.period.split('-').map(Number);
      const ids = [...lookups.entitiesById.values()].map((e) => lookups.period(e.id, y!, m!)?.id).filter((x): x is string => !!x);
      where.period_id = { in: ids };
    }
    if (f.status) where.status = f.status as Row<'journal_entries'>['status'];
    if (f.type) where.entry_type = f.type as Row<'journal_entries'>['entry_type'];
    if (f.source) where.source = f.source as Row<'journal_entries'>['source'];
    if (f.q) where.description = { contains: f.q };
    let rows = await tx.find('journal_entries', where, { orderBy: [['entry_date', 'desc'], ['entry_number', 'desc']], limit: Math.min(f.limit ?? 100, 500), offset: f.offset ?? 0 });
    if (f.account) {
      const a = lookups.account(f.account);
      if (a) {
        const lines = await tx.find('journal_lines', { journal_entry_id: { in: rows.map((r) => r.id) }, account_id: a.id });
        const keep = new Set(lines.map((l) => l.journal_entry_id));
        rows = rows.filter((r) => keep.has(r.id));
      }
    }
    const total = await tx.count('journal_entries', where);
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
    return {
      total,
      entries: rows.map((e) => ({
        id: e.id,
        number: e.entry_number,
        entity: lookups.entitiesById.get(e.entity_id)?.code,
        date: e.entry_date,
        type: e.entry_type,
        status: e.status,
        source: e.source,
        module: e.source_module,
        description: e.description,
        total: e.total_minor,
        currency: e.currency,
        basis: e.approval_basis,
        preparedBy: e.prepared_by ? users.get(e.prepared_by) ?? null : e.prepared_by_run_id ? 'Agent' : e.external_prepared_by,
        approvedBy: e.approved_by ? users.get(e.approved_by) ?? null : e.approval_basis === 'autonomy_policy' ? 'Autonomy policy' : e.external_approved_by,
        reversesEntryId: e.reverses_entry_id,
      })),
    };
  });
}

export async function entryDetail(app: App, p: Principal, id: string) {
  requirePermission(p, 'je.view');
  return app.read(async (tx) => {
    const e = await tx.get('journal_entries', id);
    if (!e || e.tenant_id !== p.tenantId || !canSeeEntity(p, e.entity_id)) app.notFound('Journal entry');
    const lookups = await app.lookups(tx, p.tenantId);
    const lines = await tx.find('journal_lines', { journal_entry_id: id }, { orderBy: [['line_number', 'asc']] });
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
    const doc = e.source_document_id ? await tx.get('source_documents', e.source_document_id) : null;
    const batch = e.import_batch_id ? await tx.get('import_batches', e.import_batch_id) : null;
    const reversedBy = await tx.findOne('journal_entries', { reverses_entry_id: id });
    const proposal = e.proposal_id ? await tx.get('proposals', e.proposal_id) : null;
    const vendors = new Map((await tx.find('vendors', { tenant_id: p.tenantId })).map((v) => [v.id, v.name]));
    const draft: EntryDraft = {
      entity: e.entity_id,
      date: e.entry_date,
      type: e.entry_type,
      description: e.description,
      currency: e.currency,
      fxRate: e.fx_rate,
      reversesEntryId: e.reverses_entry_id,
      autoReverseDate: e.auto_reverse_date,
      lines: lines.map((l) => ({ account: l.account_id, debit: l.debit_minor, credit: l.credit_minor, department: l.department_id, counterpartyEntity: l.counterparty_entity_id, txnCurrency: l.txn_currency, txnAmount: l.txn_amount_minor, memo: l.memo })),
    };
    const checks = verifyDraft(lookups, draft).violations.filter((v) => !(e.status === 'posted' && (v.axiom === 'AX-PER-01' || v.axiom === 'AX-PER-02')));
    return {
      entry: {
        id: e.id,
        number: e.entry_number,
        entity: lookups.entitiesById.get(e.entity_id)?.code,
        period: lookups.periodsById.get(e.period_id)?.name,
        date: e.entry_date,
        type: e.entry_type,
        typeLabel: closeOntology.term(`bh:JE_${e.entry_type}`)?.label ?? e.entry_type,
        status: e.status,
        description: e.description,
        source: e.source,
        module: e.source_module,
        currency: e.currency,
        fxRate: e.fx_rate,
        total: e.total_minor,
        basis: e.approval_basis,
        preparedBy: e.prepared_by ? users.get(e.prepared_by) ?? null : null,
        preparedByRunId: e.prepared_by_run_id,
        externalPreparedBy: e.external_prepared_by,
        externalApprovedBy: e.external_approved_by,
        externalRef: e.external_ref,
        approvedBy: e.approved_by ? users.get(e.approved_by) ?? null : null,
        approvedAt: e.approved_at,
        postedAt: e.posted_at,
        postedByRunId: e.posted_by_run_id,
        autoReverseDate: e.auto_reverse_date,
        icReference: e.ic_reference,
        reversesEntryId: e.reverses_entry_id,
        reversedBy: reversedBy ? { id: reversedBy.id, number: reversedBy.entry_number } : null,
      },
      lines: lines.map((l) => {
        const a = lookups.accountsById.get(l.account_id)!;
        return { id: l.id, line: l.line_number, accountId: a.id, account: a.number, accountName: a.name, accountClass: a.subtype, debit: l.debit_minor, credit: l.credit_minor, department: l.department_id ? lookups.departments.get(l.department_id)?.code ?? null : null, counterparty: l.counterparty_entity_id ? lookups.entitiesById.get(l.counterparty_entity_id)?.code ?? null : null, vendor: l.vendor_id ? vendors.get(l.vendor_id) ?? null : null, memo: l.memo, txnCurrency: l.txn_currency, txnAmount: l.txn_amount_minor };
      }),
      provenance: { document: doc ? { id: doc.id, filename: doc.filename, sha256: doc.sha256, uploadedAt: doc.uploaded_at } : null, batch: batch ? { id: batch.id, format: batch.format, status: batch.status } : null, locator: e.source_locator },
      proposal: proposal ? { id: proposal.id, title: proposal.title, status: proposal.status } : null,
      checks: checks.map((c) => ({ axiom: c.axiom, severity: c.severity, message: c.message })),
      canApprove: e.status === 'pending_approval' && canOn(p, 'je.approve', e.entity_id) && e.prepared_by !== p.user.id && withinLimit(p, e.total_minor, e.entity_id),
      canReverse: e.status === 'posted' && canOn(p, 'je.reverse', e.entity_id) && !reversedBy && e.entry_type !== 'opening',
    };
  });
}

export async function prepareEntry(app: App, p: Principal, draft: EntryDraft, meta: RequestMeta = {}) {
  requirePermission(p, 'je.prepare', 'prepare journal entries');
  return app.tx(async (tx) => {
    const ctx = app.ctx(p, meta);
    const lookups = await app.lookups(tx, p.tenantId);
    const target = lookups.entity(String(draft.entity ?? ''));
    if (target) requirePermissionOn(p, 'je.prepare', target.id, 'prepare journal entries');
    const { entry, warnings } = await createEntry(tx, ctx, lookups, draft, { status: 'pending_approval', source: 'manual', preparedBy: p.user.id });
    await appendAudit(tx, p.tenantId, ctx.actor, { action: 'journal_entry.prepare', objectType: 'journal_entry', objectId: entry.id, summary: `Prepared ${entry.entry_number} ${formatMoney(entry.total_minor)}: ${entry.description}` }, ctx.clock.now());
    return { entry, warnings };
  });
}

export async function previewEntry(app: App, p: Principal, draft: EntryDraft) {
  requirePermission(p, 'je.view');
  return app.read(async (tx) => {
    const lookups = await app.lookups(tx, p.tenantId);
    const target = lookups.entity(String(draft.entity ?? ''));
    if (target && !canSeeEntity(p, target.id)) app.notFound('Entity');
    const { violations } = verifyDraft(lookups, draft);
    return { ok: errorsOf(violations).length === 0, checks: violations };
  });
}

export async function approveEntry(app: App, p: Principal, id: string, meta: RequestMeta = {}) {
  requirePermission(p, 'je.approve', 'approve journal entries');
  return app.tx(async (tx) => {
    const e = await tx.get('journal_entries', id);
    if (!e || e.tenant_id !== p.tenantId || !canSeeEntity(p, e.entity_id)) app.notFound('Journal entry');
    requirePermissionOn(p, 'je.approve', e.entity_id, 'approve journal entries');
    if (!withinLimit(p, e.total_minor, e.entity_id)) throw new DomainError('FORBIDDEN', `${formatMoney(e.total_minor)} is above your approval limit.`);
    const ctx = app.ctx(p, meta);
    const posted = await postEntry(tx, ctx, id, { basis: 'human_approval', approvedBy: p.user.id, postedBy: p.user.id });
    await appendAudit(tx, p.tenantId, ctx.actor, { action: 'journal_entry.approve', objectType: 'journal_entry', objectId: id, summary: `Approved and posted ${posted.entry_number}` }, ctx.clock.now());
    return posted;
  });
}

export async function rejectEntry(app: App, p: Principal, id: string, reason: string, meta: RequestMeta = {}) {
  requirePermission(p, 'je.approve', 'reject journal entries');
  if (!reason || reason.trim().length < 3) throw new DomainError('VALIDATION', 'Give a reason.');
  return app.tx(async (tx) => {
    const e = await tx.get('journal_entries', id);
    if (!e || e.tenant_id !== p.tenantId || !canSeeEntity(p, e.entity_id)) app.notFound('Journal entry');
    requirePermissionOn(p, 'je.approve', e.entity_id, 'reject journal entries');
    if (e.status !== 'pending_approval' && e.status !== 'draft') throw new DomainError('CONFLICT', 'Only unposted entries can be rejected.');
    const updated = await tx.update('journal_entries', id, { status: 'rejected' });
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'journal_entry.reject', objectType: 'journal_entry', objectId: id, summary: `Rejected ${e.entry_number}: ${reason.trim()}` }, app.clock.now());
    return updated;
  });
}

/** Undo = reversal. The original stays; a mirror entry posts in the first open period. */
export async function reverse(app: App, p: Principal, id: string, reason: string, meta: RequestMeta = {}) {
  requirePermission(p, 'je.reverse', 'reverse journal entries');
  if (!reason || reason.trim().length < 5) throw new DomainError('VALIDATION', 'Say why you are reversing it.');
  return app.tx(async (tx) => {
    const e = await tx.get('journal_entries', id);
    if (!e || e.tenant_id !== p.tenantId || !canSeeEntity(p, e.entity_id)) app.notFound('Journal entry');
    requirePermissionOn(p, 'je.reverse', e.entity_id, 'reverse journal entries');
    if (!withinLimit(p, e.total_minor, e.entity_id)) throw new DomainError('FORBIDDEN', `${formatMoney(e.total_minor)} is above your approval limit.`);
    return reverseEntry(tx, app.ctx(p, meta), await app.lookups(tx, p.tenantId), id, { reason: reason.trim(), basis: { basis: 'human_approval', approvedBy: p.user.id, postedBy: p.user.id } });
  });
}

// ------------------------------------------------------------------ reports

/** The trial-balance axioms (AX-TB-01, AX-TB-02, AX-NB-01) evaluated on a balance-mode trial balance. */
function tbChecks(tb: Parameters<typeof checkTrialBalance>[0]) {
  if (tb.mode !== 'balance') return null;
  return checkTrialBalance(tb).map((v) => ({ axiom: v.axiom, severity: v.severity, message: v.message }));
}

async function periodFor(app: App, p: Principal, periodKey?: string) {
  if (periodKey) {
    const [y, m] = periodKey.split('-').map(Number);
    return { year: y!, month: m! };
  }
  const close = await currentClose(app, p.tenantId);
  if (!close) throw new DomainError('NOT_FOUND', 'No close found');
  return { year: close.fiscal_year, month: close.period_number };
}

export async function trialBalance(app: App, p: Principal, q: { entity?: string; period?: string; mode?: 'balance' | 'activity' }) {
  requirePermission(p, 'reports.view');
  const { year, month } = await periodFor(app, p, q.period);
  return app.read(async (tx) => {
    const lookups = await app.lookups(tx, p.tenantId);
    const tenant = (await tx.get('tenants', p.tenantId))!;
    if (!q.entity || q.entity === 'consolidated') {
      requireAllEntities(p, 'The consolidated trial balance');
      const tb = await consolidatedTrialBalance(tx, lookups, year, month, tenant.reporting_currency, q.mode ?? 'balance');
      return { ...tb, byColumn: tb.byColumn, period: `${year}-${String(month).padStart(2, '0')}`, checks: tbChecks(tb) };
    }
    const e = lookups.entity(q.entity);
    if (!e || !canSeeEntity(p, e.id)) app.notFound('Entity');
    const per = lookups.period(e.id, year, month);
    if (!per) app.notFound('Period');
    const tb = await entityTrialBalance(tx, lookups, e.id, per.id, q.mode ?? 'balance');
    return { ...tb, period: `${year}-${String(month).padStart(2, '0')}`, checks: tbChecks(tb) };
  });
}

export async function statements(app: App, p: Principal, q: { entity?: string; period?: string }) {
  requirePermission(p, 'reports.view');
  const { year, month } = await periodFor(app, p, q.period);
  return app.read(async (tx) => {
    const lookups = await app.lookups(tx, p.tenantId);
    const tenant = (await tx.get('tenants', p.tenantId))!;
    if (!q.entity || q.entity === 'consolidated') {
      requireAllEntities(p, 'The consolidated statements');
      const bal = await consolidatedTrialBalance(tx, lookups, year, month, tenant.reporting_currency, 'balance');
      const act = await consolidatedTrialBalance(tx, lookups, year, month, tenant.reporting_currency, 'activity');
      return { balanceSheet: balanceSheet(bal), incomeStatement: incomeStatement(act), incomeStatementYtd: incomeStatement(bal), currency: tenant.reporting_currency, period: `${year}-${String(month).padStart(2, '0')}`, label: 'Consolidated', columns: bal.columns };
    }
    const e = lookups.entity(q.entity);
    if (!e || !canSeeEntity(p, e.id)) app.notFound('Entity');
    const per = lookups.period(e.id, year, month)!;
    const bal = await entityTrialBalance(tx, lookups, e.id, per.id, 'balance');
    const act = await entityTrialBalance(tx, lookups, e.id, per.id, 'activity');
    return { balanceSheet: balanceSheet(bal), incomeStatement: incomeStatement(act), incomeStatementYtd: incomeStatement(bal), currency: e.functional_currency, period: `${year}-${String(month).padStart(2, '0')}`, label: e.code, columns: null };
  });
}

/** Drill-down: account activity for an entity (or all operating entities) in a period. */
export async function accountActivity(app: App, p: Principal, q: { account: string; entity?: string; period?: string }) {
  requirePermission(p, 'je.view');
  const { year, month } = await periodFor(app, p, q.period);
  return app.read(async (tx) => {
    const lookups = await app.lookups(tx, p.tenantId);
    const a = lookups.account(q.account);
    if (!a) app.notFound('Account');
    const entities = (q.entity && q.entity !== 'consolidated' ? [lookups.entity(q.entity)!].filter(Boolean) : [...lookups.entitiesById.values()]).filter((e) => canSeeEntity(p, e.id));
    const out = [];
    for (const e of entities) {
      const per = lookups.period(e.id, year, month);
      if (!per) continue;
      const lines = await tx.find('journal_lines', { entity_id: e.id, period_id: per.id, account_id: a.id });
      const entries = new Map((lines.length ? await tx.find('journal_entries', { id: { in: [...new Set(lines.map((l) => l.journal_entry_id))] } }) : []).map((x) => [x.id, x]));
      for (const l of lines) {
        const je = entries.get(l.journal_entry_id);
        if (je?.status !== 'posted') continue;
        out.push({ lineId: l.id, entryId: je.id, entryNumber: je.entry_number, entity: e.code, currency: e.functional_currency, date: l.entry_date, description: je.description, memo: l.memo, debit: l.debit_minor, credit: l.credit_minor, department: l.department_id ? lookups.departments.get(l.department_id)?.code ?? null : null, type: je.entry_type });
      }
    }
    out.sort((x, y) => x.date.localeCompare(y.date) || x.entryNumber.localeCompare(y.entryNumber));
    const term = closeOntology.term(a.subtype);
    return { account: { number: a.number, name: a.name, subtype: a.subtype, normalBalance: a.normal_balance, fsLine: a.fs_line, definition: term?.definition ?? null }, period: `${year}-${String(month).padStart(2, '0')}`, lines: out };
  });
}

// ------------------------------------------------------------------ flux

export async function fluxView(app: App, p: Principal, closeId?: string) {
  requirePermission(p, 'flux.view');
  const close = closeId ? await app.read((tx) => tx.get('closes', closeId)) : await currentClose(app, p.tenantId);
  if (!close || close.tenant_id !== p.tenantId) app.notFound('Close');
  return app.read(async (tx) => {
    // A consolidated analysis (no entity) covers every entity; an entity's budget analysis covers that entity.
    const analyses = (await tx.find('flux_analyses', { close_id: close.id })).filter((a) => canSeeEntity(p, a.entity_id));
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
    const accounts = new Map((await tx.find('accounts', { tenant_id: p.tenantId })).map((a) => [a.id, a]));
    const out = [];
    for (const a of analyses) {
      const lines = await tx.find('flux_lines', { analysis_id: a.id });
      const material = lines.filter((l) => l.is_material);
      out.push({
        id: a.id,
        comparison: a.comparison,
        status: a.status,
        thresholdPct: a.threshold_pct,
        thresholdMinor: a.threshold_minor,
        approvedBy: a.approved_by ? users.get(a.approved_by) ?? null : null,
        approvedAt: a.approved_at,
        canApprove: canOn(p, 'flux.approve', a.entity_id) && a.status !== 'approved' && material.every((l) => l.explanation_status === 'accepted') && !material.some((l) => l.explained_by === p.user.id),
        lines: lines
          .map((l) => {
            const acct = accounts.get(l.account_id)!;
            return { id: l.id, account: acct.number, name: acct.name, fsLine: l.fs_line, current: l.current_minor, comparison: l.comparison_minor, variance: l.variance_minor, variancePct: l.variance_pct, material: l.is_material, explanation: l.explanation, status: l.explanation_status, drivers: l.drivers, confidence: l.confidence, proposalId: l.proposal_id, explainedBy: l.explained_by ? users.get(l.explained_by) ?? null : l.explained_by_run_id ? 'Agent draft' : null, reviewedBy: l.reviewed_by ? users.get(l.reviewed_by) ?? null : null };
          })
          .sort((x, y) => Number(y.material) - Number(x.material) || Math.abs(y.variance) - Math.abs(x.variance)),
      });
    }
    return { close: { id: close.id, name: close.name, status: close.status }, analyses: out, canExplain: can(p, 'flux.explain') };
  });
}

export async function explainFlux(app: App, p: Principal, lineId: string, text: string, meta: RequestMeta = {}) {
  return app.tx((tx) => explainLine(tx, app.ctx(p, meta), p, lineId, text));
}

export async function approveFluxAnalysis(app: App, p: Principal, analysisId: string, comment: string | undefined, meta: RequestMeta = {}) {
  const approved = await app.tx(async (tx) => {
    const ctx = app.ctx(p, meta);
    const analysis = await approveFlux(tx, ctx, p, analysisId, comment);
    // The Controller's approval is also the flux task's sign-off: one decision, recorded once on each object.
    const task = await tx.findOne('close_tasks', { close_id: analysis.close_id, key: 'flux' });
    if (task?.status === 'ready_for_review' && canOn(p, 'close.task.review', task.entity_id) && task.completed_by !== p.user.id && !(await signOffProblems(tx, task)).length) {
      await reviewTask(tx, ctx, task.id, 'approve', 'Signed off with the flux analysis approval');
    }
    return analysis;
  });
  await continueClose(app, p.tenantId, approved.close_id);
  return approved;
}
