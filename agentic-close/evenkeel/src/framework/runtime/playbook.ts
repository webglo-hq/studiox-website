import type { Brain, BrainSession } from './types';

/**
 * Offline engine: deterministic playbooks (rules, heuristics, the ontology and the domain
 * engines) that drive the same typed tools and proposal path the live model uses. Fully
 * functional without an API key; traces are labelled "offline engine".
 */
export type Playbook = (session: BrainSession) => Promise<void>;

export class PlaybookBrain implements Brain {
  readonly engine = 'offline' as const;
  readonly model = null;
  constructor(private readonly playbooks: Record<string, Playbook>) {}

  async run(session: BrainSession): Promise<void> {
    const pb = this.playbooks[session.skill.id];
    if (!pb) throw new Error(`No offline playbook for skill ${session.skill.id}`);
    await pb(session);
  }
}
