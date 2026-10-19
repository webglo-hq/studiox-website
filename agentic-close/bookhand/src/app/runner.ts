import { type AgentRuntime, HEARTBEAT_MS } from '../agents/framework/runtime';

/**
 * In-process background executor for agent runs. Runs execute one at a time per process (deterministic,
 * friendly to the embedded databases); the database is the source of truth, so a crashed process loses
 * nothing: a run's worker renews its heartbeat while executing (and the queue renews it for runs still waiting
 * their turn), and App.maintain() (at start-up and periodically) takes over runs whose heartbeat went stale.
 */
export class RunQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();
  private readonly waiting = new Set<string>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private pending = 0;

  constructor(
    private readonly runtime: AgentRuntime<unknown>,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  enqueue(runId: string): Promise<void> {
    if (this.active.has(runId)) return Promise.resolve();
    this.active.add(runId);
    this.waiting.add(runId);
    this.pending++;
    this.startTicker();
    const job = this.chain.then(async () => {
      this.waiting.delete(runId);
      try {
        await this.runtime.execute(runId);
      } catch (e) {
        this.log(`run ${runId} crashed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.active.delete(runId);
        this.pending--;
        if (this.pending === 0) this.stopTicker();
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

  /** Runs waiting their turn keep their lease, so another process never mistakes them for abandoned. */
  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.renewWaiting(), HEARTBEAT_MS);
    (this.ticker as { unref?: () => void }).unref?.();
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private async renewWaiting(): Promise<void> {
    const ids = [...this.waiting];
    if (!ids.length) return;
    const now = this.runtime.deps.clock.now();
    await this.runtime.deps.db
      .tx(async (tx) => {
        for (const id of ids) if ((await tx.get('agent_runs', id))?.status === 'queued') await tx.update('agent_runs', id, { heartbeat_at: now });
      })
      .catch(() => undefined);
  }
}
