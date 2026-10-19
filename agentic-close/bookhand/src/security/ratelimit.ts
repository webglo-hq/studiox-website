/**
 * Token-bucket rate limiter (in process). Keys are e.g. `ip:1.2.3.4` or `login:1.2.3.4:email`. A multi-instance
 * deployment would back this with a shared store; the interface stays the same.
 */
export interface RateLimitRule {
  capacity: number;
  refillPerMinute: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  take(key: string, rule: RateLimitRule, cost = 1): RateLimitDecision {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: rule.capacity, updated: t };
    const refill = ((t - b.updated) / 60_000) * rule.refillPerMinute;
    b.tokens = Math.min(rule.capacity, b.tokens + refill);
    b.updated = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.buckets.set(key, b);
      this.gc();
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(b.tokens) };
    }
    this.buckets.set(key, b);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((cost - b.tokens) / rule.refillPerMinute) * 60)), remaining: 0 };
  }

  /** Would one more token be available? Does not consume (used to gate before work whose failure is charged). */
  peek(key: string, rule: RateLimitRule, cost = 1): RateLimitDecision {
    const t = this.now();
    const b = this.buckets.get(key);
    if (!b) return { allowed: true, retryAfterSeconds: 0, remaining: rule.capacity };
    const tokens = Math.min(rule.capacity, b.tokens + ((t - b.updated) / 60_000) * rule.refillPerMinute);
    return tokens >= cost ? { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(tokens) } : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((cost - tokens) / rule.refillPerMinute) * 60)), remaining: 0 };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private gc(): void {
    if (this.buckets.size < 10_000) return;
    const cutoff = this.now() - 3_600_000;
    for (const [k, v] of this.buckets) if (v.updated < cutoff) this.buckets.delete(k);
  }
}

/**
 * - signIn: every sign-in or code attempt per IP (bounds password-hashing work).
 * - login / mfa: FAILED attempts per IP; successful sign-ins are free, so switching between accounts on one
 *   machine never locks anyone out, while guessing does. Per-account lockout (5 failures) is separate.
 */
export const RATE_LIMITS = {
  api: { capacity: 600, refillPerMinute: 600 },
  mutation: { capacity: 120, refillPerMinute: 120 },
  signIn: { capacity: 30, refillPerMinute: 30 },
  login: { capacity: 8, refillPerMinute: 0.5 },
  mfa: { capacity: 6, refillPerMinute: 1 },
  agentRun: { capacity: 20, refillPerMinute: 10 },
} satisfies Record<string, RateLimitRule>;
