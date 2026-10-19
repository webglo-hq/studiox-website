import { appendAudit, verifyAuditChain } from '../../../audit/audit';
import type { Tx } from '../../../persistence/db';
import type { Row } from '../../../persistence/schema';
import { canonicalJson } from '../../../shared/canonical-json';
import type { DomainContext } from '../../../shared/context';
import { DomainError } from '../../../shared/errors';
import { sha256Hex } from '../../../shared/hash';
import { balanceSheet, consolidatedTrialBalance, entityTrialBalance, incomeStatement } from '../domain/reporting';
import type { LedgerLookups } from '../domain/lookups';
import { closeBlockers } from './periods';

/**
 * The close package: what a CFO or auditor reads to accept the month. Consolidated statements, entity trial
 * balances, flux commentary, reconciliation status, exceptions and the agent/approval record, with a content
 * hash and the audit-chain head at generation time.
 */

export interface ClosePackageContent {
  version: 1;
  close: { id: string; name: string; periodEnd: string; status: string };
  generatedAt: string;
  reportingCurrency: string;
  statements: {
    balanceSheet: ReturnType<typeof balanceSheet>;
    incomeStatement: ReturnType<typeof incomeStatement>;
    consolidatedTb: { totalDebit: number; totalCredit: number; columns: Array<{ code: string; currency: string; cta: number }> };
  };
  entities: Array<{ code: string; currency: string; totalDebit: number; totalCredit: number; balanced: boolean; netIncome: number }>;
  flux: Array<{ account: string; current: number; comparison: number; variance: number; variancePct: number | null; explanation: string | null; status: string }>;
  reconciliations: Array<{ entity: string; account: string; type: string; status: string; difference: number; openItems: number; preparedBy: string | null; reviewedBy: string | null }>;
  exceptions: Array<{ title: string; status: string; amount: number; kind: string }>;
  agentActivity: { runs: number; proposals: number; autoApplied: number; approved: number; rejected: number; pending: number; costUsd: number };
  openBlockers: string[];
  auditChain: { ok: boolean; events: number; headHash: string };
}

export async function assemblePackage(tx: Tx, ctx: DomainContext, lookups: LedgerLookups, closeId: string): Promise<ClosePackageContent> {
  const close = await tx.get('closes', closeId);
  if (!close) throw new DomainError('NOT_FOUND', 'close not found');
  const tenant = (await tx.get('tenants', ctx.tenantId))!;
  const consolidated = await consolidatedTrialBalance(tx, lookups, close.fiscal_year, close.period_number, tenant.reporting_currency, 'balance');
  const entities: ClosePackageContent['entities'] = [];
  for (const e of lookups.operatingEntities()) {
    const p = lookups.period(e.id, close.fiscal_year, close.period_number);
    if (!p) continue;
    const tb = await entityTrialBalance(tx, lookups, e.id, p.id, 'balance');
    entities.push({ code: e.code, currency: e.functional_currency, totalDebit: tb.totalDebit, totalCredit: tb.totalCredit, balanced: tb.totalDebit === tb.totalCredit, netIncome: incomeStatement(await entityTrialBalance(tx, lookups, e.id, p.id, 'activity')).netIncome });
  }
  const analyses = await tx.find('flux_analyses', { close_id: closeId });
  const flux: ClosePackageContent['flux'] = [];
  for (const a of analyses) {
    for (const l of await tx.find('flux_lines', { analysis_id: a.id, is_material: true })) {
      const acct = lookups.accountsById.get(l.account_id);
      flux.push({ account: `${acct?.number} ${acct?.name}`, current: l.current_minor, comparison: l.comparison_minor, variance: l.variance_minor, variancePct: l.variance_pct, explanation: l.explanation, status: l.explanation_status });
    }
  }
  const users = new Map((await tx.find('users', { tenant_id: ctx.tenantId })).map((u) => [u.id, u.display_name]));
  const recs: ClosePackageContent['reconciliations'] = [];
  for (const e of lookups.operatingEntities()) {
    const p = lookups.period(e.id, close.fiscal_year, close.period_number);
    if (!p) continue;
    for (const r of await tx.find('reconciliations', { period_id: p.id })) {
      const acct = lookups.accountsById.get(r.account_id);
      const open = (await tx.find('reconciling_items', { reconciliation_id: r.id })).filter((i) => i.status === 'open').length;
      recs.push({ entity: e.code, account: `${acct?.number} ${acct?.name}`, type: r.rec_type, status: r.status, difference: r.difference_minor, openItems: open, preparedBy: r.prepared_by ? (users.get(r.prepared_by) ?? null) : null, reviewedBy: r.reviewed_by ? (users.get(r.reviewed_by) ?? null) : null });
    }
  }
  const periodIds = new Set(lookups.operatingEntities().map((e) => lookups.period(e.id, close.fiscal_year, close.period_number)?.id).filter(Boolean) as string[]);
  const proposals = (await tx.find('proposals', { tenant_id: ctx.tenantId })).filter((p) => p.period_id && periodIds.has(p.period_id));
  const runs = await tx.find('agent_runs', { close_id: closeId });
  const exceptions = proposals.filter((p) => p.kind === 'anomaly' || p.risk_flags.length > 0).map((p) => ({ title: p.title, status: p.status, amount: p.amount_minor, kind: p.kind }));
  const chain = await verifyAuditChain(tx, ctx.tenantId);
  const blockers = await closeBlockers(tx, lookups, closeId, { ignoreTaskKeys: ['close-package', 'lock'] });
  return {
    version: 1,
    close: { id: close.id, name: close.name, periodEnd: close.period_end, status: close.status },
    generatedAt: ctx.clock.now(),
    reportingCurrency: tenant.reporting_currency,
    statements: {
      balanceSheet: balanceSheet(consolidated),
      incomeStatement: incomeStatement(await consolidatedTrialBalance(tx, lookups, close.fiscal_year, close.period_number, tenant.reporting_currency, 'activity')),
      consolidatedTb: { totalDebit: consolidated.totalDebit, totalCredit: consolidated.totalCredit, columns: consolidated.columns.map((c) => ({ code: c.code, currency: c.currency, cta: c.cta })) },
    },
    entities,
    flux,
    reconciliations: recs,
    exceptions,
    agentActivity: {
      runs: runs.length,
      proposals: proposals.length,
      autoApplied: proposals.filter((p) => p.status === 'auto_applied').length,
      approved: proposals.filter((p) => p.status === 'approved').length,
      rejected: proposals.filter((p) => p.status === 'rejected').length,
      pending: proposals.filter((p) => p.status === 'pending').length,
      costUsd: runs.reduce((s, r) => s + r.cost_usd_micros, 0) / 1e6,
    },
    openBlockers: blockers.filter((b) => b.kind !== 'package').map((b) => b.message),
    auditChain: { ok: chain.ok, events: chain.checked, headHash: chain.headHash },
  };
}

export async function publishPackage(tx: Tx, ctx: DomainContext, closeId: string, content: ClosePackageContent, opts: { approvedBy: string | null; runId: string | null; generatedBy: string | null }): Promise<Row<'close_packages'>> {
  const existing = await tx.find('close_packages', { close_id: closeId }, { orderBy: [['version', 'desc']] });
  const text = canonicalJson(content);
  const hash = sha256Hex(text);
  const docSha = sha256Hex(new TextEncoder().encode(text));
  const doc = (await tx.findOne('source_documents', { tenant_id: ctx.tenantId, sha256: docSha })) ?? await tx.insert('source_documents', {
    tenant_id: ctx.tenantId,
    kind: 'close_package',
    filename: `close-package-${content.close.periodEnd.slice(0, 7)}-v${(existing[0]?.version ?? 0) + 1}.json`,
    media_type: 'application/json',
    sha256: docSha,
    size_bytes: new TextEncoder().encode(text).length,
    text_content: text,
    uploaded_by: opts.approvedBy,
    metadata: { close_id: closeId },
  });
  const now = ctx.clock.now();
  const pkg = await tx.insert('close_packages', {
    tenant_id: ctx.tenantId,
    close_id: closeId,
    version: (existing[0]?.version ?? 0) + 1,
    status: opts.approvedBy ? 'final' : 'draft',
    generated_by: opts.generatedBy,
    generated_by_run_id: opts.runId,
    content: content as unknown as Record<string, unknown>,
    content_hash: hash,
    source_document_id: doc.id,
    approved_by: opts.approvedBy,
    approved_at: opts.approvedBy ? now : null,
  });
  if (opts.approvedBy) await tx.insert('signoffs', { tenant_id: ctx.tenantId, object_type: 'close_package', object_id: pkg.id, role: 'approver', user_id: opts.approvedBy, evidence_hash: hash });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'close_package.publish', objectType: 'close_package', objectId: pkg.id, summary: `Close package v${pkg.version} ${pkg.status} for ${content.close.name} (sha256 ${hash.slice(0, 12)}...)`, details: { content_hash: hash } }, now);
  return pkg;
}
