/**
 * Crash recovery for agent runs. A run whose process died stays `running` with a heartbeat that
 * no longer moves. The server resumes such runs on its own: once when it starts and then on a
 * timer, for every tenant. Resuming replays recorded tool results and re-uses proposals by key,
 * so nothing is done twice; each run is claimed atomically first, so two servers never both
 * resume it (AgentRuntime.recoverStale).
 */
import type { AppContext } from './context';

export interface RunRecovery {
  /** one recovery pass over every tenant; resolves to the ids of the runs it resumed */
  pass(): Promise<string[]>;
  stop(): void;
}

export interface RunRecoveryOptions {
  /** how often to look again (default every minute) */
  intervalMs?: number;
  /** how long a run may go without a heartbeat before it counts as abandoned (default 5 minutes:
   * longer than any single model call, so a run that is merely slow is never resumed twice) */
  staleMs?: number;
}

export function startRunRecovery(ctx: AppContext, opts: RunRecoveryOptions = {}): RunRecovery {
  const staleMs = opts.staleMs ?? 5 * 60_000;
  let running: Promise<string[]> | null = null;
  const pass = (): Promise<string[]> => {
    // passes never overlap: a slow resume finishes before the next look
    running ??= (async () => {
      const resumed: string[] = [];
      try {
        for (const tenantId of await ctx.db.tenantIds()) {
          try {
            const ids = await ctx.runtime.recoverStale(tenantId, staleMs);
            if (ids.length) ctx.log('agent runs resumed after an interruption', { tenantId, runs: ids });
            resumed.push(...ids);
          } catch (e) {
            ctx.log('agent run recovery failed', { tenantId, error: (e as Error).message });
          }
        }
      } finally {
        running = null;
      }
      return resumed;
    })();
    return running;
  };
  void pass();
  const timer = setInterval(() => void pass(), opts.intervalMs ?? 60_000);
  timer.unref?.();
  return { pass, stop: () => clearInterval(timer) };
}
