/**
 * Token-bucket rate limiter (in-process). Buckets refill continuously; each key has its own
 * bucket. Used for sign-in attempts (per IP and per account), expensive API calls and the
 * general API. A multi-instance deployment would back this with a shared store.
 */
export interface Bucket {
  tokens: number;
  updated: number;
}

export interface LimitRule {
  capacity: number;
  refillPerSecond: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rules: Record<string, LimitRule>,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys = 50_000,
  ) {}

  /** Take one token; returns retry-after seconds when limited, or 0 when allowed. */
  take(rule: string, key: string, cost = 1): number {
    const r = this.rules[rule];
    if (!r) throw new Error(`Unknown rate-limit rule ${rule}`);
    const k = `${rule}:${key}`;
    const t = this.now();
    let b = this.buckets.get(k);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evict(t);
      b = { tokens: r.capacity, updated: t };
      this.buckets.set(k, b);
    }
    b.tokens = Math.min(r.capacity, b.tokens + ((t - b.updated) / 1000) * r.refillPerSecond);
    b.updated = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return 0;
    }
    return Math.ceil((cost - b.tokens) / r.refillPerSecond);
  }

  private evict(t: number): void {
    for (const [k, b] of this.buckets) if (t - b.updated > 3_600_000) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}

/** Scale every rule's burst and refill (automated test runs sign in many times from one IP). */
export function scaleRules(rules: Record<string, LimitRule>, scale: number): Record<string, LimitRule> {
  if (scale === 1) return rules;
  return Object.fromEntries(Object.entries(rules).map(([k, r]) => [k, { capacity: r.capacity * scale, refillPerSecond: r.refillPerSecond * scale }]));
}

export const DEFAULT_RULES: Record<string, LimitRule> = {
  /** sign-in attempts per IP: burst 10, then one every 6 s */
  login_ip: { capacity: 10, refillPerSecond: 1 / 6 },
  /** sign-in attempts per account: burst 5, then one every 30 s */
  login_account: { capacity: 5, refillPerSecond: 1 / 30 },
  /** MFA code attempts per session */
  mfa: { capacity: 5, refillPerSecond: 1 / 30 },
  /** agent runs, bulk decisions, reports */
  expensive: { capacity: 20, refillPerSecond: 1 / 3 },
  /** everything else per user */
  api: { capacity: 300, refillPerSecond: 5 },
};
