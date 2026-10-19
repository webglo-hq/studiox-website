/**
 * In-process sliding-window rate limiter (per key). Good for a single node and the browser demo;
 * a multi-node deployment swaps this for a shared store behind the same interface.
 */
export interface RateDecision {
  ok: boolean;
  retryAfterSec: number;
  remaining: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  check(key: string, limit: number, windowMs: number, now = Date.now()): RateDecision {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - arr[0]!)) / 1000)), remaining: 0 };
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 50_000) this.gc(now, windowMs);
    return { ok: true, retryAfterSec: 0, remaining: limit - arr.length };
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private gc(now: number, windowMs: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < windowMs)) this.hits.delete(k);
  }
}
