/**
 * Close-calendar orchestration: run every agent-enabled task whose dependencies are
 * satisfied, in waves, with bounded concurrency. A dependency is satisfied when the upstream
 * task is prepared (ready for review or complete) and none of its proposals still await a
 * decision — so downstream agents (e.g. flux analysis) never explain numbers that are about
 * to change. The orchestrator is re-entrant: calling it again after approvals continues the
 * close from where it stopped.
 */
export type OrchTaskStatus = 'not_started' | 'in_progress' | 'blocked' | 'ready_for_review' | 'complete';

export interface OrchTask {
  id: string;
  code: string;
  title: string;
  skillId: string | null;
  deps: string[];
  status: OrchTaskStatus;
  pendingProposals: number;
  /** true once an agent run has been started for the task in this cycle */
  ran: boolean;
}

export interface OrchestratorPort {
  loadTasks(): Promise<OrchTask[]>;
  runTask(task: OrchTask): Promise<{ status: string; pending: number; summary: string | null }>;
}

export interface Blocker {
  taskId: string;
  title: string;
  waitingOn: { taskId: string; title: string; reason: string }[];
}

export interface OrchestrationReport {
  waves: { taskId: string; title: string; status: string; pending: number; summary: string | null }[][];
  blocked: Blocker[];
  done: boolean;
}

export function satisfied(t: OrchTask): boolean {
  return (t.status === 'ready_for_review' || t.status === 'complete') && t.pendingProposals === 0;
}

export function eligible(tasks: OrchTask[]): OrchTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((t) => t.skillId && !t.ran && (t.status === 'not_started' || t.status === 'in_progress') && t.deps.every((d) => byId.get(d) && satisfied(byId.get(d)!)));
}

export function blockers(tasks: OrchTask[]): Blocker[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks
    .filter((t) => t.skillId && !t.ran && t.status !== 'complete')
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      waitingOn: t.deps
        .map((d) => byId.get(d)!)
        .filter((d) => d && !satisfied(d))
        .map((d) => ({
          taskId: d.id,
          title: d.title,
          reason: d.pendingProposals > 0 ? `${d.pendingProposals} proposal${d.pendingProposals === 1 ? '' : 's'} awaiting approval` : d.status === 'blocked' ? 'blocked' : d.skillId ? 'agent has not run yet' : 'manual task not finished',
        })),
    }))
    .filter((b) => b.waitingOn.length > 0);
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function advance(port: OrchestratorPort, opts: { concurrency?: number; maxWaves?: number } = {}): Promise<OrchestrationReport> {
  const report: OrchestrationReport = { waves: [], blocked: [], done: false };
  for (let w = 0; w < (opts.maxWaves ?? 12); w++) {
    const tasks = await port.loadTasks();
    const ready = eligible(tasks);
    if (!ready.length) {
      report.blocked = blockers(tasks);
      report.done = tasks.filter((t) => t.skillId).every((t) => t.ran);
      return report;
    }
    const results = await pool(ready, opts.concurrency ?? 3, async (t) => ({ taskId: t.id, title: t.title, ...(await port.runTask(t)) }));
    report.waves.push(results);
  }
  report.blocked = blockers(await port.loadTasks());
  return report;
}

/** Topological order (Kahn) — used for display and to validate calendars. */
export function topoOrder(tasks: { id: string; deps: string[] }[]): string[] {
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) for (const d of t.deps) if (indeg.has(d)) indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
  const queue = tasks.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
  const out: string[] = [];
  const children = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.deps) children.set(d, [...(children.get(d) ?? []), t.id]);
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const c of children.get(id) ?? []) {
      indeg.set(c, (indeg.get(c) ?? 0) - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }
  if (out.length !== tasks.length) throw new Error('dependency cycle');
  return out;
}
