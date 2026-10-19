import { scryptAsync } from '@noble/hashes/scrypt.js';
import { timingSafeEqual } from '../shared/hash';
import { fromBase64Url, randomBytes, toBase64Url } from '../shared/ids';

/**
 * Password hashing with scrypt (RFC 7914), encoded as `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash>` so the
 * cost parameters travel with the hash and can be raised later (verify reports `needsRehash`).
 *
 * The Node server injects the native `crypto.scrypt` (fast, off the event loop) and uses N = 2^17. The
 * zero-install static demo runs in a browser and uses the pure-JS implementation with demo-only parameters.
 */

export interface ScryptParams {
  ln: number;
  r: number;
  p: number;
}

export type ScryptImpl = (password: Uint8Array, salt: Uint8Array, params: ScryptParams, dkLen: number) => Promise<Uint8Array>;

/** OWASP-recommended floor for scrypt is N=2^17, r=8, p=1. */
export const SERVER_SCRYPT: ScryptParams = { ln: 17, r: 8, p: 1 };
/** Static demo only (in-browser, ephemeral data): fast enough for one-tap demo logins. */
export const DEMO_SCRYPT: ScryptParams = { ln: 12, r: 8, p: 1 };

const DK_LEN = 32;

let impl: ScryptImpl = async (password, salt, params, dkLen) =>
  scryptAsync(password, salt, { N: 2 ** params.ln, r: params.r, p: params.p, dkLen, maxmem: 2 ** (params.ln + 8) * params.r });
let defaults: ScryptParams = SERVER_SCRYPT;

export function configurePasswordHashing(opts: { impl?: ScryptImpl; params?: ScryptParams }): void {
  if (opts.impl) impl = opts.impl;
  if (opts.params) defaults = opts.params;
}

export function passwordHashingParams(): ScryptParams {
  return defaults;
}

export async function hashPassword(password: string, params: ScryptParams = defaults): Promise<string> {
  const salt = randomBytes(16);
  const hash = await impl(new TextEncoder().encode(password.normalize('NFKC')), salt, params, DK_LEN);
  return `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

function parse(stored: string): { params: ScryptParams; salt: Uint8Array; hash: string } | null {
  const m = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return null;
  const params = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  if (params.ln < 10 || params.ln > 22 || params.r < 1 || params.p < 1) return null;
  return { params, salt: fromBase64Url(m[4]!), hash: m[5]! };
}

export interface VerifyResult {
  ok: boolean;
  needsRehash: boolean;
}

/** Constant-time verification. Unknown or malformed hashes never verify. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<VerifyResult> {
  const parsed = stored ? parse(stored) : null;
  if (!parsed) {
    // Burn comparable time so a missing user is not distinguishable by latency.
    await impl(new TextEncoder().encode(password), randomBytes(16), defaults, DK_LEN);
    return { ok: false, needsRehash: false };
  }
  const computed = await impl(new TextEncoder().encode(password.normalize('NFKC')), parsed.salt, parsed.params, DK_LEN);
  const ok = timingSafeEqual(toBase64Url(computed), parsed.hash);
  const needsRehash = ok && (parsed.params.ln < defaults.ln || parsed.params.r !== defaults.r || parsed.params.p !== defaults.p);
  return { ok, needsRehash };
}

/** Minimal strength policy for passwords set by people (NIST 800-63B: length over composition rules). */
export function passwordProblems(password: string, context: { email?: string; name?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Use at least 12 characters.');
  if (password.length > 256) problems.push('Use at most 256 characters.');
  const lower = password.toLowerCase();
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) problems.push('Do not include your email name.');
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat a single character.');
  if (['password', 'passw0rd', 'letmein', 'qwerty', '123456'].some((w) => lower.includes(w))) problems.push('Avoid common passwords.');
  return problems;
}
