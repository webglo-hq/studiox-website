import { AppError } from '../../../framework/util/errors';
import { audit } from '../domain/audit';
import { canSeeEntity, requireEntity, requirePermission, withDb, type ServiceContext } from '../domain/context';
import { entities } from '../domain/refdata';
import { person, type PersonRef } from './common';

/** Exceptions found by agents or people: open → acknowledged → resolved / dismissed. */

export interface IssueView {
  id: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  amount: number | null;
  entityCode: string | null;
  periodKey: string | null;
  subjectRefs: { type: string; id: string; label?: string }[];
  recommendedAction: string;
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  owner: PersonRef | null;
  resolutionNote: string | null;
  resolvedBy: PersonRef | null;
  resolvedAt: string | null;
  proposalId: string | null;
  createdAt: string;
}

export async function listIssues(ctx: ServiceContext, filter: { periodKey?: string; status?: IssueView['status'][] } = {}): Promise<IssueView[]> {
  requirePermission(ctx, 'close.view');
  const rows = (await ctx.db.find('issue', { tenant_id: ctx.tenantId, ...(filter.periodKey ? { period_key: filter.periodKey } : {}), ...(filter.status ? { status: { in: filter.status } } : {}) }, { orderBy: [['created_at', 'desc']] })).filter((r) => canSeeEntity(ctx, r.entity_id));
  const ents = await entities(ctx);
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const out: IssueView[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      category: r.category,
      severity: r.severity,
      title: r.title,
      description: r.description,
      amount: r.amount,
      entityCode: r.entity_id ? (ents.get(r.entity_id)?.code ?? null) : null,
      periodKey: r.period_key,
      subjectRefs: r.subject_refs as IssueView['subjectRefs'],
      recommendedAction: r.recommended_action,
      status: r.status,
      owner: await person(ctx, r.owner_id),
      resolutionNote: r.resolution_note,
      resolvedBy: await person(ctx, r.resolved_by),
      resolvedAt: r.resolved_at,
      proposalId: r.proposal_id,
      createdAt: r.created_at,
    });
  }
  return out.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || rank[a.severity] - rank[b.severity] || b.createdAt.localeCompare(a.createdAt));
}

export async function updateIssue(ctx: ServiceContext, input: { issueId: string; action: 'acknowledge' | 'resolve' | 'dismiss' | 'reopen'; note?: string }): Promise<void> {
  requirePermission(ctx, 'issue.resolve');
  const i = await ctx.db.get('issue', input.issueId);
  if (!i || i.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Exception not found');
  requireEntity(ctx, i.entity_id);
  const note = input.note?.trim() ?? '';
  const now = ctx.clock.nowIso();
  if ((input.action === 'resolve' || input.action === 'dismiss') && note.length < 5) throw new AppError('VALIDATION', 'Explain how this was resolved (at least 5 characters).');
  if (input.action === 'dismiss' && (i.severity === 'critical' || i.severity === 'high')) requirePermission(ctx, 'proposal.approve.material');
  await ctx.db.tx(async (db) => {
    if (input.action === 'acknowledge') await db.update('issue', i.id, { status: 'acknowledged', owner_id: i.owner_id ?? ctx.actor.userId });
    else if (input.action === 'resolve') await db.update('issue', i.id, { status: 'resolved', resolution_note: note, resolved_by: ctx.actor.userId, resolved_at: now });
    else if (input.action === 'dismiss') await db.update('issue', i.id, { status: 'dismissed', resolution_note: note, resolved_by: ctx.actor.userId, resolved_at: now });
    else await db.update('issue', i.id, { status: 'open', resolution_note: null, resolved_by: null, resolved_at: null });
    await audit(withDb(ctx, db), { action: `issue.${input.action}`, subjectType: 'issue', subjectId: i.id, data: { title: i.title, note: note || null } });
  });
}
