import type { AgentRuntime } from '../agents/framework/runtime';

/**
 * In-process background executor for agent runs. Runs execute one at a time per process (deterministic,
 * friendly to the embedded databases); the database is the source of truth, so a crashed process loses
 * nothing: on start-up `recover()` resumes runs whose heartbeat went stale.
 */
export class RunQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();
  private pending = 0;

  constructor(
    private readonly runtime: AgentRuntime<unknown>,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  enqueue(runId: string): Promise<void> {
    if (this.active.has(runId)) return Promise.resolve();
    this.active.add(runId);
    this.pending++;
    const job = this.chain.then(async () => {
      try {
        await this.runtime.execute(runId);
      } catch (e) {
        this.log(`run ${runId} crashed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.active.delete(runId);
        this.pending--;
      }
    });
    this.chain = job;
    return job;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  get size(): number {
    return this.pending;
  }

  /** Resolves when every queued run has finished (tests, demo scripts). */
  async idle(): Promise<void> {
    for (let i = 0; i < 1000 && this.pending > 0; i++) await this.chain;
  }
}
