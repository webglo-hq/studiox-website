import { bytesToUuid, Prng } from './prng';

/**
 * Identifier generation. Runtime ids are UUIDv7 (time-ordered, index friendly) using the
 * platform CSPRNG (`crypto.getRandomValues`, available in browsers and Node).
 * Seeds and tests can inject a deterministic generator.
 */
export interface IdGenerator {
  next(): string;
}

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error('No CSPRNG available (crypto.getRandomValues)');
  c.getRandomValues(bytes);
  return bytes;
}

let lastMs = 0;
let seq = 0;

export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  // Monotonic within the same millisecond: bump a 12-bit counter in rand_a.
  if (nowMs === lastMs) {
    seq = (seq + 1) & 0x0fff;
    if (seq === 0) nowMs = lastMs + 1;
  } else {
    seq = ((bytes[6]! & 0x0f) << 8) | bytes[7]!;
    seq &= 0x07ff;
  }
  lastMs = nowMs;
  let ms = nowMs;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms & 0xff;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

export const systemIds: IdGenerator = { next: () => uuidv7() };

export function deterministicIds(seed: number | string): IdGenerator {
  const prng = new Prng(seed);
  return { next: () => prng.uuid() };
}

/** URL-safe random token (CSPRNG). */
export function randomToken(bytes = 32): string {
  const b = randomBytes(bytes);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
