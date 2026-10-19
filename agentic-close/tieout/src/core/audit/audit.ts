/** Every mutation in Tieout is recorded through this one function (tamper-evident chain). */
import type { Actor } from '../agent/types';
import type { AuditRecord, Tx } from '../store/types';
import { newId } from '../util/random';
import type { Clock } from '../util/time';

export interface AuditInput {
  action: string;
  subjectType: string;
  subjectId: string;
  entityId?: string | null;
  summary: string;
  data?: Record<string, unknown>;
}

export async function audit<M, I>(tx: Tx<M, I>, actor: Pick<Actor, 'type' | 'id' | 'label' | 'onBehalfOf'>, clock: Clock, e: AuditInput, ip: string | null = null): Promise<AuditRecord> {
  return tx.appendAudit({
    id: newId('aud'),
    at: clock.now().toISOString(),
    actor_type: actor.type,
    actor_id: actor.id,
    actor_label: actor.label,
    on_behalf_of: actor.onBehalfOf ?? null,
    action: e.action,
    subject_type: e.subjectType,
    subject_id: e.subjectId,
    entity_id: e.entityId ?? null,
    summary: e.summary,
    data: e.data ?? {},
    ip,
  });
}

export const SYSTEM_ACTOR: Actor = {
  type: 'system',
  id: 'system',
  label: 'Tieout system',
  permissions: new Set(['*']),
  roles: ['system'],
  entityScope: null,
};
