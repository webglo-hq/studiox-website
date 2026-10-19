/**
 * Read models for the web app. Each function returns exactly what one screen needs, already
 * permission-filtered and entity-scoped, so the UI never assembles business data itself.
 */
import { AUTONOMY_LABELS } from '../core/agent/types';
import { verifyAuditChain } from '../core/audit/chain';
import { MODEL_RATIONALE } from '../core/llm/pricing';
import { currentPolicyRow, GENERIC_THRESHOLDS } from '../core/skills/policy';
import { notFound } from '../core/util/errors';
import { periodEnd, periodLabel } from '../core/util/time';
import type { AuditRecord } from '../core/store/types';
import type { DbTx, ProposalRow } from '../schema';
import { formatWorkday, workdayOffset } from '../packs/accounting/close/workdays';
import { ROLES } from '../packs/accounting/controls/permissions';
import { balancesAsOf, trialBalanceRows } from '../packs/accounting/ledger/balances';
import { consolidatedStatements, entityStatements } from '../packs/accounting/ledger/statements';
import { toJsonLd, toTurtle } from '../core/ontology/export';
import { closeOntology } from '../packs/accounting/ontology';
import { ADAPTERS } from '../integrations/adapters';
import { RULE_EXAMPLES } from '../packs/accounting/agent/rules';
import { ACCOUNTING_TOOLS } from '../packs/accounting/agent/tools';
import type { AccountingServices } from '../packs/accounting/services';
import { csrfFor } from './auth';
import { assertInScope, asUser, inScope, requireGroupAccess, requirePermission, type AppContext, type RequestUser } from './context';
import { DECISION_PERMISSION, eligibility } from './proposals';

const OPEN: ProposalRow['status'][] = ['pending_approval', 'suggested'];

function workdayLabel(periodKey: string | null, businessDate: string): string | null {
  if (!periodKey) return null;
  const wd = workdayOffset(periodKey, businessDate);
  return wd === null ? null : formatWorkday(wd);
}

async function names(tx: DbTx): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const u of await tx.find('users', {})) m.set(u.id, u.display_name);
  return m;
}

function who(id: string | null, users: Map<string, string>): string | null {
  if (!id) return null;
  if (users.has(id)) return users.get(id)!;
  if (id.startsWith('agent:')) return `${id.slice(6).replace(/-/g, ' ')} agent`;
  if (id.startsWith('policy:')) return `Policy ${id.slice(7)}`;
  if (id.startsWith('system')) return 'System';
  if (id.startsWith('connector:')) return `${id.slice(10).replace(/-/g, ' ')} connector`;
  return id;
}

export async function me(ctx: AppContext, u: RequestUser, sessionToken: string | null) {
  return asUser(ctx, u, async (svc, tx) => {
    const user = (await tx.get('users', u.actor.id))!;
    const tenant = (await tx.get('tenants', u.tenantId))!;
    const entities = (await tx.find('entities', {}, { orderBy: [['sort_order', 'asc']] })).filter((e) => inScope(u, e.id));
    return {
      user: { id: user.id, name: user.display_name, email: user.email, title: user.title, roles: u.actor.roles, permissions: [...u.actor.permissions].sort(), approvalLimitMinor: u.actor.approvalLimitMinor, mfaEnabled: user.mfa_enabled, preferences: user.preferences },
      entityScope: u.actor.entityScope ? entities.map((e) => e.code) : null,
      tenant: { name: tenant.name, displayName: tenant.settings.displayName ?? tenant.name, demo: tenant.is_demo, businessDate: await svc.ctx.businessDate(), activeCloseKey: tenant.settings.activeCloseKey ?? null, workday: workdayLabel(tenant.settings.activeCloseKey ?? null, await svc.ctx.businessDate()), mfaRequiredRoles: tenant.settings.mfaRequiredRoles ?? [] },
      entities: entities.map((e) => ({ id: e.id, code: e.code, name: e.name, currency: e.functional_currency, kind: e.kind })),
      csrfToken: sessionToken ? csrfFor(sessionToken) : null,
      liveAgents: !!ctx.llm,
      canResetDemo: !!ctx.resetDemo && ctx.config.demoMode,
      version: ctx.config.version,
    };
  });
}

export async function home(ctx: AppContext, u: RequestUser, periodKey: string) {
  return asUser(ctx, u, async (svc, tx) => {
    const users = await names(tx);
    const t = await svc.close.tasks(periodKey);
    const props = (await tx.find('proposals', { period_key: periodKey })).filter((p) => inScope(u, p.entity_id));
    const open = props.filter((p) => OPEN.includes(p.status));
    let mine = 0;
    for (const p of open) if ((await eligibility(ctx, tx, u, p)).canDecide) mine++;
    const runs = (await tx.find('agent_runs', { period_key: periodKey }, { orderBy: [['created_at', 'desc']], limit: 40 })).filter((r) => inScope(u, r.entity_id)).slice(0, 8);
    const readiness = await svc.close.readiness(periodKey);
    const done = t.tasks.filter((x) => x.status === 'done' || x.status === 'skipped').length;
    return {
      periodKey,
      periodLabel: periodLabel(periodKey),
      businessDate: t.businessDate,
      workday: t.workday,
      closePeriod: t.closePeriod,
      progress: { done, total: t.tasks.length },
      myTasks: t.tasks.filter((x) => (x.owner_id === u.actor.id || x.reviewer_id === u.actor.id) && x.status !== 'done' && x.status !== 'skipped'),
      tasks: t.tasks,
      inbox: { awaitingMe: mine, pending: open.filter((p) => p.status === 'pending_approval').length, suggested: open.filter((p) => p.status === 'suggested').length, reviewQueue: props.filter((p) => p.review_status === 'pending').length, autoApplied: props.filter((p) => p.status === 'applied' && p.route !== 'human_approval' && p.route !== 'suggestion').length, total: props.length },
      highlights: open
        .sort((a, b) => Number(b.flags.length > 0) - Number(a.flags.length > 0) || b.amount_minor - a.amount_minor)
        .slice(0, 6)
        .map((p) => slim(p, users)),
      readiness,
      runs: runs.map((r) => ({ id: r.id, ref: r.ref, skillKey: r.skill_key, status: r.status, entityId: r.entity_id, headline: r.summary.headline ?? null, createdAt: r.created_at, mode: r.mode, costMicros: r.cost_micros })),
      agentsRun: runs.length > 0,
    };
  });
}

function slim(p: ProposalRow, users: Map<string, string>) {
  return { id: p.id, ref: p.ref, kind: p.kind, skillKey: p.skill_key, title: p.title, why: p.why, confidence: Number(p.confidence), amountMinor: p.amount_minor, currency: p.currency, materiality: p.materiality, status: p.status, route: p.route, reviewStatus: p.review_status, flags: p.flags, assignedRole: p.assigned_role, entityId: p.entity_id, periodKey: p.period_key, createdAt: p.created_at, decidedBy: who(p.decided_by, users), decidedAt: p.decided_at, decisionReason: p.decision_reason, ontologyType: p.ontology_type };
}

export async function listProposals(ctx: AppContext, u: RequestUser, q: { status?: string; kind?: string; skill?: string; entity?: string; period?: string; text?: string; run?: string; limit?: number }) {
  requirePermission(u, 'proposal.view');
  return asUser(ctx, u, async (_svc, tx) => {
    const users = await names(tx);
    const where: Record<string, unknown> = {};
    if (q.period) where.period_key = q.period;
    if (q.kind) where.kind = q.kind;
    if (q.skill) where.skill_key = q.skill;
    if (q.entity) where.entity_id = q.entity;
    if (q.run) where.run_id = q.run;
    if (q.status === 'open') where.status = { in: OPEN };
    else if (q.status === 'review') where.review_status = 'pending';
    else if (q.status === 'auto') where.route = { in: ['auto_post', 'auto_post_sampled'] };
    else if (q.status && q.status !== 'all') where.status = q.status;
    let rows = await tx.find('proposals', where as never, { orderBy: [['created_at', 'desc'], ['ref', 'desc']], limit: Math.min(q.limit ?? 500, 1000) });
    rows = rows.filter((p) => inScope(u, p.entity_id));
    if (q.text) {
      const t = q.text.toLowerCase();
      rows = rows.filter((p) => p.title.toLowerCase().includes(t) || p.ref.toLowerCase().includes(t) || p.why.toLowerCase().includes(t));
    }
    const out = [];
    for (const p of rows) {
      const el = OPEN.includes(p.status) ? await eligibility(ctx, tx, u, p) : null;
      out.push({ ...slim(p, users), canDecide: el?.canDecide ?? false, blockedBy: el?.reasons ?? [] });
    }
    return { items: out, counts: countBy(rows) };
  });
}

function countBy(rows: ProposalRow[]) {
  return {
    open: rows.filter((p) => OPEN.includes(p.status)).length,
    review: rows.filter((p) => p.review_status === 'pending').length,
    applied: rows.filter((p) => p.status === 'applied').length,
    rejected: rows.filter((p) => p.status === 'rejected').length,
    all: rows.length,
  };
}

export async function proposalDetail(ctx: AppContext, u: RequestUser, id: string) {
  requirePermission(u, 'proposal.view');
  return asUser(ctx, u, async (svc, tx) => {
    const p = await tx.get('proposals', id);
    if (!p) throw notFound('Proposal', id);
    svc.ctx.assertEntityInScope(p.entity_id);
    const users = await names(tx);
    const run = p.run_id ? await tx.get('agent_runs', p.run_id) : null;
    const steps = p.run_id ? (await tx.find('agent_steps', { run_id: p.run_id })).filter((s) => (s.detail as { proposalId?: string }).proposalId === p.id) : [];
    const chart = await svc.ctx.chart();
    const lines = p.kind === 'journal_entry' ? ((p.payload.lines ?? []) as { account: string; debit?: number; credit?: number; department?: string | null; memo?: string | null }[]).map((l) => ({ ...l, accountName: chart.tryAccount(l.account)?.name ?? '?' })) : null;
    const deps = [];
    for (const d of (p.payload.dependsOnProposalIds as string[] | undefined) ?? []) {
      const x = await tx.get('proposals', d);
      if (x) deps.push({ id: x.id, ref: x.ref, title: x.title, status: x.status });
    }
    const approvals = await tx.find('approvals', { subject_type: 'proposal', subject_id: p.id }, { orderBy: [['at', 'asc']] });
    const el = await eligibility(ctx, tx, u, p);
    const applied = p.applied_ref_type === 'journal_entry' && p.applied_ref_id ? await tx.get('journal_entries', p.applied_ref_id) : null;
    return {
      ...slim(p, users),
      payload: p.payload,
      evidence: p.evidence,
      verification: p.verification,
      preparedBy: who(p.prepared_by, users),
      requestedBy: who(p.requested_by, users),
      editedBy: who(p.edited_by, users),
      run: run ? { id: run.id, ref: run.ref, skillKey: run.skill_key, mode: run.mode, status: run.status } : null,
      routeReasons: steps.filter((s) => s.phase === 'route').map((s) => s.title),
      steps: steps.map((s) => ({ seq: s.seq, phase: s.phase, title: s.title, status: s.status })),
      lines,
      dependsOn: deps,
      approvals: approvals.map((a) => ({ decision: a.decision, by: who(a.actor_id, users), actorType: a.actor_type, reason: a.reason, at: a.at })),
      appliedEntry: applied ? { id: applied.id, number: applied.je_number, status: applied.status } : null,
      eligibility: el,
      decisionPermission: DECISION_PERMISSION[p.kind],
      skillTitle: ctx.skills.has(p.skill_key) ? ctx.skills.get(p.skill_key).manifest.title : p.skill_key,
    };
  });
}

export async function closeView(ctx: AppContext, u: RequestUser, periodKey: string) {
  requirePermission(u, 'close.view');
  return asUser(ctx, u, async (svc, tx) => {
    const t = await svc.close.tasks(periodKey);
    const readiness = await svc.close.readiness(periodKey);
    const runs = (await tx.find('agent_runs', { period_key: periodKey }, { orderBy: [['created_at', 'asc']] })).filter((r) => inScope(u, r.entity_id));
    const props = (await tx.find('proposals', { period_key: periodKey })).filter((p) => inScope(u, p.entity_id));
    const packages = u.actor.entityScope ? [] : await tx.find('close_packages', { period_key: periodKey }, { orderBy: [['version', 'desc']] });
    const periods = (await tx.find('periods', { period_key: periodKey })).filter((p) => inScope(u, p.entity_id));
    return {
      ...t,
      readiness,
      periods: periods.map((p) => ({ entityId: p.entity_id, status: p.status })),
      packages: packages.map((p) => ({ id: p.id, version: p.version, status: p.status, generatedAt: p.generated_at, contentHash: p.content_hash })),
      bySkill: Object.fromEntries(
        [...new Set(t.tasks.map((x) => x.skill_key).filter(Boolean))].map((k) => [
          k!,
          { runs: runs.filter((r) => r.skill_key === k).map((r) => ({ id: r.id, ref: r.ref, status: r.status, entityId: r.entity_id, headline: r.summary.headline ?? null })), open: props.filter((p) => p.skill_key === k && OPEN.includes(p.status)).length, applied: props.filter((p) => p.skill_key === k && p.status === 'applied').length },
        ]),
      ),
    };
  });
}

export async function closePackage(ctx: AppContext, u: RequestUser, id: string) {
  requirePermission(u, 'report.view');
  requireGroupAccess(u, 'The close package');
  return asUser(ctx, u, async (_svc, tx) => {
    const pkg = await tx.get('close_packages', id);
    if (!pkg) throw notFound('Close package', id);
    const signoffs = await tx.find('signoffs', { subject_type: 'close_package', subject_id: id });
    const users = await names(tx);
    return { ...pkg, signoffs: signoffs.map((s) => ({ role: s.role, name: who(s.user_id, users), at: s.signed_at, statement: s.statement })) };
  });
}

export async function recsList(ctx: AppContext, u: RequestUser, periodKey: string) {
  requirePermission(u, 'subledger.read');
  return asUser(ctx, u, async (svc, tx) => {
    const users = await names(tx);
    const chart = await svc.ctx.chart();
    const bank = [];
    for (const ba of await svc.bank.accounts()) {
      const st = await svc.bank.state(ba.id, periodKey);
      bank.push({ kind: 'bank', bankAccountId: ba.id, entityId: ba.entity_id, entityCode: chart.entity(ba.entity_id).code, name: `${ba.name} ••${ba.account_last4}`, currency: ba.currency, glAccount: chart.account(ba.gl_account_id).code, glBalanceMinor: st.glBalanceMinor, externalBalanceMinor: st.externalBalanceMinor, unreconciledMinor: st.unreconciledMinor, tiesOut: st.tiesOut, matched: st.matchedCount, unmatchedBank: st.unmatchedBank, unmatchedLedger: st.unmatchedLedger, openItems: st.items.filter((i) => i.status === 'open').length, status: st.reconciliation?.status ?? 'not_started', recId: st.reconciliation?.id ?? null, preparer: who(st.reconciliation?.preparer_id ?? null, users), reviewer: who(st.reconciliation?.reviewer_id ?? null, users) });
    }
    const sub = [];
    for (const e of await svc.ctx.legalEntities()) {
      const period = await svc.ctx.period(e.id, periodKey);
      for (const kind of ['ap', 'ar'] as const) {
        const t = await svc.subledgers.tieOut(e.id, kind, periodEnd(periodKey));
        const rec = await tx.findOne('reconciliations', { entity_id: e.id, period_id: period.id, rec_type: kind === 'ap' ? 'subledger_ap' : 'subledger_ar' });
        sub.push({ kind, entityId: e.id, entityCode: e.code, currency: e.functional_currency, accountCode: t.accountCode, subledgerMinor: t.subledgerMinor, glMinor: t.glMinor, differenceMinor: t.differenceMinor, counterparties: t.rows.length, wrongSign: t.wrongSign.map((w) => ({ name: w.name, openMinor: w.openMinor })), status: rec?.status ?? 'not_started', recId: rec?.id ?? null, preparer: who(rec?.preparer_id ?? null, users), reviewer: who(rec?.reviewer_id ?? null, users), aging: t.rows.slice(0, 12).map((r) => ({ name: r.name, openMinor: r.openMinor, buckets: r.buckets })) });
      }
    }
    return { periodKey, bank, subledgers: sub };
  });
}

export async function bankWorkbench(ctx: AppContext, u: RequestUser, bankAccountId: string, periodKey: string) {
  requirePermission(u, 'subledger.read');
  return asUser(ctx, u, async (svc, tx) => {
    const users = await names(tx);
    const st = await svc.bank.state(bankAccountId, periodKey);
    const { statement, lines, subsequent } = await svc.bank.statement(bankAccountId, periodKey);
    const ledger = await svc.bank.ledgerLines(bankAccountId, periodKey);
    const matches = st.reconciliation ? await tx.find('rec_matches', { reconciliation_id: st.reconciliation.id }, { orderBy: [['created_at', 'asc']] }) : [];
    const items = matches.length ? await tx.find('rec_match_items', { rec_match_id: { in: matches.map((m) => m.id) } }) : [];
    const props = (await tx.find('proposals', { period_key: periodKey, kind: { in: ['rec_match', 'reconciling_item', 'journal_entry'] } })).filter((p) => (p.payload as { bankAccountId?: string; effects?: { bankMatch?: { bankAccountId: string } } }).bankAccountId === bankAccountId || (p.payload as { effects?: { bankMatch?: { bankAccountId: string } } }).effects?.bankMatch?.bankAccountId === bankAccountId);
    const proposedFor = new Map<string, { id: string; ref: string; status: string }>();
    for (const p of props) {
      const pl = p.payload as { externalIds?: string[]; ledgerLineIds?: string[]; relatedItemId?: string | null; effects?: { bankMatch?: { bankTxnId: string } } };
      for (const x of [...(pl.externalIds ?? []), ...(pl.ledgerLineIds ?? []), ...(pl.relatedItemId ? [pl.relatedItemId] : []), ...(pl.effects?.bankMatch ? [pl.effects.bankMatch.bankTxnId] : [])]) proposedFor.set(x, { id: p.id, ref: p.ref, status: p.status });
    }
    const matchOf = new Map(items.map((i) => [i.item_id, i.rec_match_id]));
    const signoffs = st.reconciliation ? await tx.find('signoffs', { subject_type: 'reconciliation', subject_id: st.reconciliation.id }) : [];
    return {
      periodKey,
      account: { id: st.bankAccount.id, name: st.bankAccount.name, bank: st.bankAccount.bank_name, last4: st.bankAccount.account_last4, currency: st.bankAccount.currency, format: st.bankAccount.statement_format },
      state: { glBalanceMinor: st.glBalanceMinor, statementBalanceMinor: st.externalBalanceMinor, adjustedExternalMinor: st.adjustedExternalMinor, adjustedLedgerMinor: st.adjustedLedgerMinor, unreconciledMinor: st.unreconciledMinor, unexplainedMinor: st.unexplainedMinor, tiesOut: st.tiesOut, matched: st.matchedCount, unmatchedBank: st.unmatchedBank, unmatchedLedger: st.unmatchedLedger },
      reconciliation: st.reconciliation ? { id: st.reconciliation.id, status: st.reconciliation.status, preparer: who(st.reconciliation.preparer_id, users), reviewer: who(st.reconciliation.reviewer_id, users), notes: st.reconciliation.notes } : null,
      statement: statement ? { opening: statement.opening_balance_minor, closing: statement.closing_balance_minor, date: statement.statement_date, sourceDocumentId: statement.source_document_id } : null,
      bankLines: lines.map((l) => ({ ...l, matchId: matchOf.get(l.id) ?? null, proposal: proposedFor.get(l.id) ?? null })),
      ledgerLines: ledger.map((l) => ({ ...l, matchId: matchOf.get(l.id) ?? null, proposal: proposedFor.get(l.id) ?? null })),
      subsequent: subsequent.slice(0, 20),
      matches: matches.map((m) => ({ id: m.id, type: m.match_type, status: m.status, confidence: Number(m.confidence), explanation: m.explanation, matchedBy: who(m.matched_by, users), confirmedBy: who(m.confirmed_by, users), items: items.filter((i) => i.rec_match_id === m.id).map((i) => ({ side: i.side, type: i.item_type, id: i.item_id, amountMinor: i.amount_minor })) })),
      items: st.items.map((i) => ({ id: i.id, kind: i.kind, side: i.side, description: i.description, amountMinor: i.amount_minor, date: i.item_date, status: i.status, requiresAdjustment: i.requires_adjustment })),
      proposals: props.filter((p) => OPEN.includes(p.status)).map((p) => slim(p, users)),
      signoffs: signoffs.map((s) => ({ role: s.role, name: who(s.user_id, users), at: s.signed_at, statement: s.statement })),
    };
  });
}

export async function fluxView(ctx: AppContext, u: RequestUser, entityId: string, periodKey: string) {
  requirePermission(u, 'report.view');
  return asUser(ctx, u, async (svc, tx) => {
    svc.ctx.assertEntityInScope(entityId);
    const users = await names(tx);
    const r = await svc.flux.compute(entityId, periodKey);
    const props = await tx.find('proposals', { entity_id: entityId, period_key: periodKey, kind: 'flux_explanation' });
    const byAccount = new Map(props.map((p) => [(p.payload as { accountCode: string }).accountCode, p]));
    return { ...r, lines: r.lines.map((l) => ({ ...l, proposal: byAccount.has(l.code) ? slim(byAccount.get(l.code)!, users) : null, draftText: byAccount.has(l.code) ? String((byAccount.get(l.code)!.payload as { text?: string }).text ?? '') : null, explanationAuthor: l.explanation ? who(l.explanation.author_id, users) : null, explanationApprover: l.explanation?.approved_by ? who(l.explanation.approved_by, users) : null })) };
  });
}

export async function journalList(ctx: AppContext, u: RequestUser, q: { entity?: string; period?: string; status?: string; source?: string; text?: string; limit?: number }) {
  requirePermission(u, 'ledger.read');
  return asUser(ctx, u, async (svc, tx) => {
    const users = await names(tx);
    const where: Record<string, unknown> = {};
    if (q.entity) where.entity_id = q.entity;
    if (q.status) where.status = q.status;
    if (q.source) where.source = q.source;
    if (q.period) where.posting_date = { gte: `${q.period}-01`, lte: periodEnd(q.period) };
    let rows = await tx.find('journal_entries', where as never, { orderBy: [['posting_date', 'desc'], ['je_number', 'desc']], limit: Math.min(q.limit ?? 300, 1000) });
    rows = rows.filter((r) => !u.actor.entityScope || u.actor.entityScope.includes(r.entity_id));
    if (q.text) {
      const t = q.text.toLowerCase();
      rows = rows.filter((r) => r.memo.toLowerCase().includes(t) || r.je_number.toLowerCase().includes(t) || (r.source_ref ?? '').toLowerCase().includes(t));
    }
    const chart = await svc.ctx.chart();
    return { items: rows.map((r) => ({ id: r.id, number: r.je_number, entityCode: chart.entity(r.entity_id).code, date: r.posting_date, type: r.entry_type, status: r.status, memo: r.memo, source: r.source, totalMinor: r.total_minor, currency: r.currency, preparedBy: who(r.prepared_by, users), approvedBy: who(r.approved_by, users), route: r.approval_route, proposalId: r.proposal_id, reverses: r.reverses_je_id, autoReverseOn: r.auto_reverse_on })) };
  });
}

export async function journalDetail(ctx: AppContext, u: RequestUser, id: string) {
  requirePermission(u, 'ledger.read');
  return asUser(ctx, u, async (svc, tx) => {
    const je = await tx.get('journal_entries', id);
    if (!je) throw notFound('Journal entry', id);
    svc.ctx.assertEntityInScope(je.entity_id);
    const users = await names(tx);
    const chart = await svc.ctx.chart();
    const lines = await tx.find('journal_lines', { journal_entry_id: id }, { orderBy: [['line_no', 'asc']] });
    const approvals = await tx.find('approvals', { subject_type: 'journal_entry', subject_id: id });
    const events = await tx.find('audit_log', { subject_type: 'journal_entry', subject_id: id }, { orderBy: [['seq', 'asc']] });
    const reversal = await tx.findOne('journal_entries', { reverses_je_id: id });
    const proposal = je.proposal_id ? await tx.get('proposals', je.proposal_id) : null;
    const doc = je.source_document_id ? await tx.get('source_documents', je.source_document_id) : null;
    return {
      entry: { ...je, entityCode: chart.entity(je.entity_id).code, preparedByName: who(je.prepared_by, users), approvedByName: who(je.approved_by, users), postedByName: who(je.posted_by, users) },
      lines: lines.map((l) => ({ ...l, accountCode: chart.account(l.account_id).code, accountName: chart.account(l.account_id).name })),
      approvals: approvals.map((a) => ({ decision: a.decision, by: who(a.actor_id, users), actorType: a.actor_type, policyRef: a.policy_ref, at: a.at, reason: a.reason })),
      events: events.map((e) => ({ seq: e.seq, at: e.at, action: e.action, actor: e.actor_label, summary: e.summary })),
      reversal: reversal ? { id: reversal.id, number: reversal.je_number, status: reversal.status } : null,
      proposal: proposal ? { id: proposal.id, ref: proposal.ref, title: proposal.title } : null,
      sourceDocument: doc ? { id: doc.id, filename: doc.filename, kind: doc.kind } : null,
      canApprove: je.status === 'pending_approval' && !je.proposal_id && u.actor.permissions.has('je.approve') && je.prepared_by !== u.actor.id,
    };
  });
}

export async function trialBalance(ctx: AppContext, u: RequestUser, entityId: string, periodKey: string) {
  requirePermission(u, 'report.view');
  return asUser(ctx, u, async (svc, tx) => {
    svc.ctx.assertEntityInScope(entityId);
    const chart = await svc.ctx.chart();
    const tb = trialBalanceRows(chart, await balancesAsOf(tx, [entityId], periodEnd(periodKey)));
    const check = closeOntology().check('AX-DE-04', { debits: tb.totalDebitMinor, credits: tb.totalCreditMinor });
    return { entity: chart.entity(entityId), asOf: periodEnd(periodKey), ...tb, balanced: check.passed };
  });
}

export async function statements(ctx: AppContext, u: RequestUser, entityId: string | 'consolidated', periodKey: string) {
  requirePermission(u, 'report.view');
  return asUser(ctx, u, async (svc, tx) => {
    const chart = await svc.ctx.chart();
    if (entityId === 'consolidated') {
      requireGroupAccess(u, 'The consolidated view');
      const c = await consolidatedStatements(tx, chart, periodKey, 'USD');
      return { scope: 'consolidated', currency: c.currency, balanceSheet: c.balanceSheet, incomeStatement: c.incomeStatement, netIncomeMinor: c.netIncomeMinor, checks: c.checks, consolidation: { ctaMinor: c.ctaMinor, eliminationsMinor: c.eliminationsMinor, closingRate: c.closingRate, averageRate: c.averageRate } };
    }
    svc.ctx.assertEntityInScope(entityId);
    const s = await entityStatements(tx, chart, entityId, periodKey);
    return { scope: chart.entity(entityId).code, ...s, consolidation: null };
  });
}

export async function runsList(ctx: AppContext, u: RequestUser, q: { period?: string; skill?: string; limit?: number }) {
  requirePermission(u, 'agent.view');
  return asUser(ctx, u, async (_svc, tx) => {
    const users = await names(tx);
    const where: Record<string, unknown> = {};
    if (q.period) where.period_key = q.period;
    if (q.skill) where.skill_key = q.skill;
    const rows = (await tx.find('agent_runs', where as never, { orderBy: [['created_at', 'desc']], limit: Math.min(q.limit ?? 100, 500) })).filter((r) => inScope(u, r.entity_id));
    return { items: rows.map((r) => ({ id: r.id, ref: r.ref, skillKey: r.skill_key, skillVersion: r.skill_version, entityId: r.entity_id, periodKey: r.period_key, status: r.status, mode: r.mode, model: r.model, autonomy: r.autonomy_level, requestedBy: who(r.requested_by, users), createdAt: r.created_at, finishedAt: r.finished_at, steps: r.steps_used, costMicros: r.cost_micros, headline: r.summary.headline ?? null, proposals: r.summary.proposals ?? 0, orchestrationId: r.orchestration_id, attempts: r.attempts })) };
  });
}

export async function runDetail(ctx: AppContext, u: RequestUser, id: string) {
  requirePermission(u, 'agent.view');
  return asUser(ctx, u, async (_svc, tx) => {
    const r = await tx.get('agent_runs', id);
    if (!r) throw notFound('Run', id);
    assertInScope(u, r.entity_id);
    const users = await names(tx);
    const steps = await tx.find('agent_steps', { run_id: id }, { orderBy: [['seq', 'asc']] });
    const calls = await tx.find('agent_tool_calls', { run_id: id }, { orderBy: [['seq', 'asc']] });
    const props = await tx.find('proposals', { run_id: id }, { orderBy: [['ref', 'asc']] });
    const msgs = r.mode === 'live' ? await tx.find('agent_messages', { run_id: id }, { orderBy: [['seq', 'asc']] }) : [];
    const skill = ctx.skills.has(r.skill_key) ? ctx.skills.get(r.skill_key) : null;
    return {
      run: { ...r, requestedByName: who(r.requested_by, users), skillTitle: skill?.manifest.title ?? r.skill_key },
      steps: steps.map((s) => ({ seq: s.seq, phase: s.phase, status: s.status, title: s.title, detail: s.detail, durationMs: s.duration_ms, inputTokens: s.input_tokens, outputTokens: s.output_tokens, costMicros: s.cost_micros })),
      toolCalls: calls.map((c) => ({ seq: c.seq, tool: c.tool, input: c.input, outputPreview: JSON.stringify(c.output).slice(0, 1500), flags: c.untrusted_flags, durationMs: c.duration_ms })),
      proposals: props.map((p) => slim(p, users)),
      transcript: msgs.map((m) => ({ seq: m.seq, role: m.role, content: m.content })),
    };
  });
}

export async function skillsCatalog(ctx: AppContext, u: RequestUser) {
  requirePermission(u, 'skill.view');
  return asUser(ctx, u, async (_svc, tx) => {
    const rows = await tx.find('skills', {});
    const props = await tx.find('proposals', {});
    const runs = await tx.find('agent_runs', {});
    const out = [];
    for (const s of ctx.skills.all()) {
      const row = rows.find((r) => r.key === s.key);
      const policy = row ? await currentPolicyRow(tx, row.id, null) : null;
      const mine = props.filter((p) => p.skill_key === s.key);
      const decided = mine.filter((p) => p.status === 'applied' || p.status === 'rejected');
      const evals = row ? await tx.find('skill_eval_runs', { skill_id: row.id }, { orderBy: [['ran_at', 'desc']], limit: 1 }) : [];
      out.push({ key: s.key, title: s.manifest.title, summary: s.manifest.summary, description: s.frontmatter.description, category: s.manifest.category, version: s.version, model: s.manifest.model, modelRationale: MODEL_RATIONALE[s.manifest.model.live], autonomy: policy?.autonomy_level ?? s.manifest.autonomy.default, autonomyMax: s.manifest.autonomy.max, autonomyLabel: AUTONOMY_LABELS[policy?.autonomy_level ?? s.manifest.autonomy.default], enabled: (row?.enabled ?? false) && (policy?.enabled ?? false), policyVersion: policy?.version ?? null, stats: { runs: runs.filter((r) => r.skill_key === s.key).length, proposals: mine.length, applied: mine.filter((p) => p.status === 'applied').length, rejected: mine.filter((p) => p.status === 'rejected').length, autoApplied: mine.filter((p) => p.status === 'applied' && (p.route === 'auto_post' || p.route === 'auto_post_sampled')).length, acceptance: decided.length ? mine.filter((p) => p.status === 'applied').length / decided.length : null }, lastEval: evals[0] ? { passed: evals[0].passed, total: evals[0].total, at: evals[0].ran_at } : null, evalCases: s.evals.length });
    }
    return { items: out, autonomyLevels: AUTONOMY_LABELS };
  });
}

export async function skillDetail(ctx: AppContext, u: RequestUser, key: string) {
  requirePermission(u, 'skill.view');
  if (!ctx.skills.has(key)) throw notFound('Skill', key);
  const s = ctx.skills.get(key);
  return asUser(ctx, u, async (_svc, tx) => {
    const users = await names(tx);
    const row = await tx.findOne('skills', { key });
    const history = row ? await tx.find('skill_policies', { skill_id: row.id }, { orderBy: [['version', 'desc']] }) : [];
    const evals = row ? await tx.find('skill_eval_runs', { skill_id: row.id }, { orderBy: [['ran_at', 'desc']], limit: 5 }) : [];
    const current = history.filter((h) => h.is_current);
    return {
      key,
      title: s.manifest.title,
      description: s.frontmatter.description,
      version: s.version,
      manifest: s.manifest,
      body: s.body,
      skillMd: s.skillMd,
      contentHash: s.contentHash,
      resources: [...s.resources.entries()].map(([path, content]) => ({ path, content })),
      allowedTools: s.allowedTools.map((n) => {
        const t = ACCOUNTING_TOOLS.find((x) => x.name === n);
        return { name: n, title: t?.title ?? n, effect: t?.effect ?? 'read', permission: t?.permission ?? '', description: t?.description ?? '', outputType: t?.outputType ?? '' };
      }),
      evals: s.evals.map((e) => ({ id: e.id, title: e.title, expectations: e.expect.map((x) => x.description) })),
      evalRuns: evals.map((e) => ({ id: e.id, passed: e.passed, total: e.total, at: e.ran_at, by: who(e.ran_by, users), results: e.results })),
      policies: current.map((p) => ({ id: p.id, scopeEntityId: p.scope_entity_id, version: p.version, autonomy: p.autonomy_level, thresholds: p.thresholds, mappings: p.mappings, rules: p.rules, enabled: p.enabled })),
      history: history.map((p) => ({ version: p.version, scopeEntityId: p.scope_entity_id, autonomy: p.autonomy_level, note: p.change_note, by: who(p.changed_by, users), at: p.created_at, current: p.is_current })),
      thresholdSpecs: { ...GENERIC_THRESHOLDS, ...s.manifest.thresholds } as Record<string, { label: string; description: string; unit: 'minor' | 'pct' | 'days' | 'ratio' | 'count'; min?: number; max?: number; default?: number }>,
      ruleExamples: RULE_EXAMPLES,
      autonomyLevels: AUTONOMY_LABELS,
    };
  });
}

export function ontologyView() {
  const o = closeOntology();
  const m = o.module;
  return {
    version: o.version,
    hash: o.hash,
    stats: o.stats(),
    classes: o.allClasses().map((c) => ({ id: c.id, label: c.label, group: c.group, parents: c.parents, abstract: !!c.abstract, definition: c.definition, whyItMatters: c.whyItMatters, example: c.example, synonyms: c.synonyms ?? [], rea: c.rea ?? null, mappings: c.mappings ?? [], citations: c.citations ?? [], properties: o.properties(c.id).map((p) => ({ name: p.name, label: p.label, range: p.range, required: !!p.required, description: p.description })) })),
    relations: m.relations,
    axioms: m.axioms.map((a) => ({ id: a.id, title: a.title, formal: a.formal, plainEnglish: a.plainEnglish, appliesTo: a.appliesTo, severity: a.severity, enforcedBy: a.enforcedBy, citations: a.citations, executable: !!a.check })),
    citations: m.citations,
    terms: o.allTerms().map((t) => ({ id: t.id, label: t.label, synonyms: t.synonyms ?? [], definition: t.definition, classId: t.classId ?? null })),
    changelog: m.changelog ?? [],
  };
}

export function ontologyExplain(term: string) {
  const o = closeOntology();
  const e = o.explain(term);
  if (!e) throw notFound('Term', term);
  return e;
}

export function ontologyExport(format: 'jsonld' | 'ttl'): string {
  const o = closeOntology();
  return format === 'jsonld' ? JSON.stringify(toJsonLd(o), null, 2) : toTurtle(o);
}

export async function auditList(ctx: AppContext, u: RequestUser, q: { limit?: number; before?: number; action?: string; subject?: string }) {
  requirePermission(u, 'audit.view');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const where: Record<string, unknown> = {};
    if (q.before) where.seq = { lt: q.before };
    if (q.subject) where.subject_id = q.subject;
    let rows = await tx.find('audit_log', where as never, { orderBy: [['seq', 'desc']], limit: Math.min(q.limit ?? 100, 500) });
    if (q.action) rows = rows.filter((r) => r.action.startsWith(q.action!));
    rows = rows.filter((r) => inScope(u, r.entity_id));
    const total = await tx.count('audit_log', {});
    const users = await names(tx);
    return { total, items: rows.map((r) => ({ seq: r.seq, at: r.at, actorType: r.actor_type, actor: r.actor_label, onBehalfOf: who(r.on_behalf_of, users), action: r.action, subjectType: r.subject_type, subjectId: r.subject_id, entityId: r.entity_id, summary: r.summary, hash: r.hash, prevHash: r.prev_hash })) };
  });
}

export async function auditVerify(ctx: AppContext, u: RequestUser) {
  requirePermission(u, 'audit.view');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const rows = await tx.find('audit_log', {}, { orderBy: [['seq', 'asc']] });
    const v = verifyAuditChain(rows as unknown as AuditRecord[]);
    return { ...v, count: rows.length, head: rows[rows.length - 1]?.hash ?? null, axiom: 'AX-AUD-01' };
  });
}

/** A user's entity scope as entity codes (null = every entity), from their role grants. */
function scopeOf(grants: { scope_entity_id: string | null }[], entities: { id: string; code: string }[]): string[] | null {
  if (!grants.length || grants.some((g) => g.scope_entity_id === null)) return null;
  return [...new Set(grants.map((g) => entities.find((e) => e.id === g.scope_entity_id)?.code ?? '?'))].sort();
}

export async function adminView(ctx: AppContext, u: RequestUser) {
  const canUsers = u.actor.permissions.has('admin.users');
  return asUser(ctx, u, async (_svc, tx) => {
    const users = await tx.find('users', {}, { orderBy: [['display_name', 'asc']] });
    const grants = await tx.find('user_roles', {});
    const roles = await tx.find('roles', {});
    const rp = await tx.find('role_permissions', {});
    const tenant = (await tx.get('tenants', u.tenantId))!;
    const entities = await tx.find('entities', {}, { orderBy: [['sort_order', 'asc']] });
    const tokens = await tx.find('api_tokens', { user_id: u.actor.id });
    return {
      canManage: { users: canUsers, sod: u.actor.permissions.has('admin.sod'), settings: u.actor.permissions.has('admin.settings'), tokens: u.actor.permissions.has('mcp.token') },
      users: users.map((x) => ({ id: x.id, name: x.display_name, email: canUsers ? x.email : x.email.replace(/^(.).*(@.*)$/, '$1…$2'), title: x.title, status: x.status, mfa: x.mfa_enabled, lastLoginAt: x.last_login_at, roles: [...new Set(grants.filter((g) => g.user_id === x.id).map((g) => roles.find((r) => r.id === g.role_id)?.key ?? '?'))], scope: scopeOf(grants.filter((g) => g.user_id === x.id), entities) })),
      roles: ROLES.map((r) => ({ key: r.key, name: r.name, description: r.description, approvalLimitMinor: r.approvalLimitMinor, permissions: rp.filter((x) => x.role_id === roles.find((y) => y.key === r.key)?.id).map((x) => x.permission_id).sort() })),
      sod: await tx.find('sod_rules', {}, { orderBy: [['code', 'asc']] }),
      settings: tenant.settings,
      entities: entities.map((e) => ({ id: e.id, code: e.code, name: e.name, currency: e.functional_currency, kind: e.kind, materiality: e.materiality })),
      tokens: tokens.map((t) => ({ id: t.id, name: t.name, createdAt: t.created_at, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, revoked: !!t.revoked_at })),
    };
  });
}

export async function importsView(ctx: AppContext, u: RequestUser) {
  requirePermission(u, 'import.view');
  return asUser(ctx, u, async (_svc, tx) => {
    const users = await names(tx);
    const connectors = (await tx.find('connectors', {})).filter((c) => inScope(u, c.entity_id));
    const batches = (await tx.find('import_batches', {}, { orderBy: [['started_at', 'desc']], limit: 60 })).filter((b) => connectors.some((c) => c.id === b.connector_id)).slice(0, 30);
    const docs = new Map((await tx.find('source_documents', { id: { in: batches.map((b) => b.source_document_id) } })).map((d) => [d.id, d]));
    return {
      connectors: connectors.map((c) => {
        const ad = ADAPTERS.find((a) => a.id === c.config.adapter);
        return { key: c.key, name: c.name, kind: c.kind, format: c.format, status: c.status, entityId: c.entity_id, lastImportAt: c.last_import_at, adapter: ad ? { id: ad.id, name: ad.name, description: ad.description, extension: ad.fileExtension, sample: ad.sample() } : null };
      }),
      batches: batches.map((b) => ({ id: b.id, connector: connectors.find((c) => c.id === b.connector_id)?.name ?? '', filename: docs.get(b.source_document_id)?.filename ?? '', status: b.status, total: b.records_total, created: b.records_created, skipped: b.records_skipped, failed: b.records_failed, errors: b.errors.slice(0, 10), by: who(b.imported_by, users), at: b.started_at, contentHash: docs.get(b.source_document_id)?.content_hash ?? null })),
    };
  });
}

export async function sourceDocument(ctx: AppContext, u: RequestUser, id: string) {
  requirePermission(u, 'subledger.read');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const d = await tx.get('source_documents', id);
    if (!d) throw notFound('Source document', id);
    if (d.connector_id) assertInScope(u, (await tx.get('connectors', d.connector_id))?.entity_id);
    return { id: d.id, filename: d.filename, mime: d.mime, kind: d.kind, size: d.size_bytes, contentHash: d.content_hash, receivedAt: d.received_at, content: d.content.slice(0, 200_000) };
  });
}

export type Services = AccountingServices;
