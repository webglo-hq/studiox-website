/**
 * Randomness. Security-sensitive values (session tokens, CSRF, salts, TOTP secrets, ids) always
 * use the platform CSPRNG (WebCrypto `getRandomValues`, present in Node >= 19 and all browsers).
 * The seeded PRNG below is ONLY for deterministic demo/test data generation.
 */
import { bytesToHex } from './hash';

export function secureRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function secureToken(bytes = 32): string {
  return bytesToHex(secureRandomBytes(bytes));
}

const B32 = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l, o, 0, 1

/** Readable random id with a type prefix, e.g. `je_7kq2...`: 22 base32 chars = 110 random bits. */
export function newId(prefix: string): string {
  const bytes = secureRandomBytes(22);
  let s = '';
  for (const b of bytes) s += B32[b & 31]!;
  return `${prefix}_${s}`;
}

/** Deterministic PRNG (mulberry32) for reproducible seed data. NOT for security. */
export class SeededRandom {
  private state: number;
  constructor(seed: number | string) {
    this.state = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  float(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Approximately normal via Box-Muller. */
  normal(mean: number, sd: number): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Deterministic id stream for seeds: same seed, same ids. */
  id(prefix: string): string {
    let s = '';
    for (let i = 0; i < 22; i++) s += B32[Math.floor(this.next() * 32)]!;
    return `${prefix}_${s}`;
  }
  fork(label: string): SeededRandom {
    return new SeededRandom((this.state ^ hashString(label)) >>> 0);
  }
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export { bytesToHex };
