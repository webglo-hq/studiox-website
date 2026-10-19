import type { DelegatedActor, RunRecord, SkillPolicy } from '../../../framework/runtime/types';
import type { SkillPackage } from '../../../framework/skills/manifest';
import type { Clock } from '../../../framework/util/clock';
import { makeContext, type Actor, type ServiceContext } from '../domain/context';
import { loadActor } from '../domain/rbac';
import type { EkDb } from '../store';

/** Context handed to every accounting tool and effector during an agent run or decision. */
export interface AgentCtx {
  svc: ServiceContext;
  run: RunRecord;
  skill: SkillPackage;
  policy: SkillPolicy;
  periodKey: string;
  /** The person who started the run (the requester) — null for system runs. */
  requester: Actor | null;
  /** Set when a person is deciding on a proposal (approve/reject/review). */
  decider: Actor | null;
  /** Late-bound access to the engine (dispatch tool only). */
  dispatch: (parentRun: RunRecord) => Promise<unknown>;
}

/**
 * Delegated authority: an agent may use a permission only if the skill declares it AND the
 * person the agent acts for holds it (least privilege). Read-only report permissions that
 * every tool needs are implied by close.view.
 */
/** Read-only permissions every agent needs to see the close it works on (still intersected with the requester's). */
export const IMPLIED_READ_PERMISSIONS = ['close.view', 'report.view', 'ontology.view'] as const;

export async function delegatedActorFor(db: EkDb, tenantId: string, requesterId: string | null, skill: SkillPackage): Promise<DelegatedActor> {
  const declared = new Set<string>([...skill.manifest.permissions, ...IMPLIED_READ_PERMISSIONS]);
  if (!requesterId) return { kind: 'agent', userId: null, label: `${skill.manifest.title} agent (system)`, permissions: declared };
  const user = await loadActor(db, tenantId, requesterId);
  const perms = new Set([...declared].filter((p) => user.permissions.has(p) || user.permissions.has('*')));
  return { kind: 'agent', userId: requesterId, label: `${skill.manifest.title} agent for ${user.label}`, permissions: perms };
}

/** A person deciding on agent work. `label` names the channel when it is not the web app. */
export async function humanDelegate(db: EkDb, tenantId: string, userId: string, label?: string | null): Promise<DelegatedActor> {
  const user = await loadActor(db, tenantId, userId);
  return { kind: 'user', userId, label: label || user.label, permissions: user.permissions };
}

/**
 * The agent's own service context. It sees only entities that both the person it works for
 * (the task owner, `actor`) and the person who started it (the requester) may see.
 */
export function agentServiceContext(db: EkDb, tenantId: string, clock: Clock, run: RunRecord, actor: DelegatedActor, requester: Actor | null, owner: Actor | null = null): ServiceContext {
  const a: Actor = {
    type: 'agent',
    userId: actor.userId,
    label: actor.label,
    roles: [],
    permissions: actor.permissions,
    entityScope: intersectScopes(requester?.entityScope ?? 'all', owner?.entityScope ?? 'all'),
    agentRunId: run.id,
    skillId: run.skillId,
  };
  return makeContext(db, tenantId, a, clock);
}

function intersectScopes(a: Actor['entityScope'], b: Actor['entityScope']): Actor['entityScope'] {
  if (a === 'all') return b;
  if (b === 'all') return a;
  return a.filter((id) => b.includes(id));
}
