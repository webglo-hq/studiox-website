/**
 * Deterministic pseudo-random generator (sfc32 seeded via splitmix of a string hash). Used only by the
 * seed generator and samplers that must be reproducible; never for security tokens.
 */
export class Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string | number) {
    let h = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
    const next = () => {
      h = (h + 0x9e3779b9) >>> 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform in [0, 1). */
  next(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick from empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r <= 0) return item;
    }
    return items[items.length - 1]![0];
  }

  /** Normal(mean, sd) via Box-Muller. */
  normal(mean = 0, sd = 1): number {
    const u = 1 - this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Log-normal amount around a median, useful for spend amounts. */
  logNormal(median: number, spread = 0.5): number {
    return median * Math.exp(this.normal(0, spread));
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  /** Independent child stream (stable regardless of how much the parent is consumed later). */
  fork(label: string): Prng {
    return new Prng(`${this.a}:${this.b}:${label}`);
  }
}

/** FNV-1a 32-bit. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic value in [0,1) for a key: used for reproducible sampling (e.g. post-hoc review). */
export function unitHash(key: string): number {
  return new Prng(key).next();
}
