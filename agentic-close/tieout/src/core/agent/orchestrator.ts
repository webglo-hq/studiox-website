/**
 * Orchestration (domain-agnostic): plan a dependency graph of agent work into waves with Kahn's
 * algorithm, then run each wave with bounded concurrency. Nodes whose prerequisites failed are
 * skipped (not run on bad inputs); cycles are rejected at planning time.
 */
import { precondition } from '../util/errors';

export interface PlanNode {
  id: string;
  deps: readonly string[];
}

/** Topological layering (Kahn 1962). Dependencies on ids outside the graph are ignored. */
export function topoWaves(nodes: readonly PlanNode[]): string[][] {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, indeg.get(n.id) ?? 0);
    for (const d of n.deps) {
      if (!ids.has(d)) continue;
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
      out.set(d, [...(out.get(d) ?? []), n.id]);
    }
  }
  const waves: string[][] = [];
  let frontier = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  let seen = 0;
  while (frontier.length) {
    waves.push([...frontier]);
    seen += frontier.length;
    const next: string[] = [];
    for (const id of frontier)
      for (const m of out.get(id) ?? []) {
        indeg.set(m, indeg.get(m)! - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
    frontier = next;
  }
  if (seen !== nodes.length) throw precondition(`The task graph has a cycle among: ${nodes.filter((n) => indeg.get(n.id)! > 0).map((n) => n.id).join(', ')}`);
  return waves;
}

export type NodeOutcome = 'succeeded' | 'failed' | 'skipped';

export interface OrchestrationEvent {
  type: 'wave_start' | 'node_start' | 'node_done' | 'node_skipped';
  wave: number;
  nodeId?: string;
  outcome?: NodeOutcome;
  detail?: string;
}

export async function runWaves(
  nodes: readonly PlanNode[],
  runNode: (id: string) => Promise<NodeOutcome>,
  opts: { concurrency?: number; onEvent?: (e: OrchestrationEvent) => void | Promise<void> } = {},
): Promise<Map<string, NodeOutcome>> {
  const waves = topoWaves(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outcome = new Map<string, NodeOutcome>();
  const limit = Math.max(1, opts.concurrency ?? 2);
  for (let w = 0; w < waves.length; w++) {
    await opts.onEvent?.({ type: 'wave_start', wave: w + 1, detail: waves[w]!.join(', ') });
    const queue = [...waves[w]!];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const blocked = byId.get(id)!.deps.filter((d) => byId.has(d) && outcome.get(d) !== 'succeeded');
        if (blocked.length) {
          outcome.set(id, 'skipped');
          await opts.onEvent?.({ type: 'node_skipped', wave: w + 1, nodeId: id, outcome: 'skipped', detail: `prerequisite ${blocked.join(', ')} did not succeed` });
          continue;
        }
        await opts.onEvent?.({ type: 'node_start', wave: w + 1, nodeId: id });
        let o: NodeOutcome;
        try {
          o = await runNode(id);
        } catch (e) {
          o = 'failed';
          await opts.onEvent?.({ type: 'node_done', wave: w + 1, nodeId: id, outcome: o, detail: (e as Error).message });
          outcome.set(id, o);
          continue;
        }
        outcome.set(id, o);
        await opts.onEvent?.({ type: 'node_done', wave: w + 1, nodeId: id, outcome: o });
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  }
  return outcome;
}
