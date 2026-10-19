import { verifyChain, type ChainVerification } from '../../../framework/audit/chain';
import type { EkDb } from '../store';
import type { ServiceContext } from './context';

export interface AuditInput {
  action: string;
  subjectType?: string | null;
  subjectId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Append an audit event inside the caller's transaction. The hash chain is computed by the
 * store (Postgres trigger / memory hook), so callers cannot forge seq or hashes.
 */
export async function audit(ctx: ServiceContext, input: AuditInput): Promise<void> {
  const a = ctx.actor;
  await ctx.db.insert('audit_log', {
    tenant_id: ctx.tenantId,
    occurred_at: ctx.clock.nowIso(),
    actor_type: a.type,
    actor_id: a.type === 'agent' ? (a.agentRunId ?? a.skillId ?? null) : a.userId,
    actor_label: a.label,
    action: input.action,
    subject_type: input.subjectType ?? null,
    subject_id: input.subjectId ?? null,
    data: sanitizeForAudit(input.data ?? {}),
    ip: a.ip ?? null,
  });
}

/** Keep audit payloads small and free of secrets. */
function sanitizeForAudit(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (/password|secret|token|totp|hash$/i.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (typeof v === 'string' && v.length > 2000) out[k] = `${v.slice(0, 2000)}…`;
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export async function verifyAuditChain(db: EkDb, tenantId: string): Promise<ChainVerification> {
  const rows = await db.find('audit_log', { tenant_id: tenantId }, { orderBy: [['seq', 'asc']] });
  return verifyChain(
    rows.map((r) => ({
      seq: r.seq,
      tenantId: r.tenant_id,
      occurredAt: r.occurred_at,
      actorType: r.actor_type,
      actorId: r.actor_id,
      action: r.action,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      data: r.data,
      prevHash: r.prev_hash,
      hash: r.hash,
    })),
  );
}
