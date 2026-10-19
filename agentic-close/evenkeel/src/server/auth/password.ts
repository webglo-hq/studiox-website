import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (memory-hard KDF, RFC 7914) from Node's crypto module.
 * Format: scrypt$N$r$p$<salt b64url>$<hash b64url>. Parameters are stored per hash so they can
 * be raised later without breaking existing users (needsRehash()).
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet: N=2^15 (32 MiB), r=8, p=3, one of
 * its equivalent-cost settings to N=2^17, p=1, chosen for the smaller memory footprint per
 * concurrent sign-in.
 */
const DEFAULT = { N: 1 << 15, r: 8, p: 3, keylen: 64 };

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password.normalize('NFKC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string, params = DEFAULT): Promise<string> {
  if (password.length < 12) throw new Error('Passwords must be at least 12 characters.');
  if (password.length > 256) throw new Error('Passwords must be at most 256 characters.');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  // Always do the same amount of work, even for unknown users (no user enumeration by timing).
  const target = stored && stored.startsWith('scrypt$') ? stored : DUMMY_HASH;
  const parts = target.split('$');
  if (parts.length !== 6) return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scrypt(password.slice(0, 256), Buffer.from(saltB64, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 });
  const ok = key.length === expected.length && timingSafeEqual(key, expected);
  return ok && target === stored;
}

/** True when a stored hash is weaker than the current parameters (rehashed at the next sign-in). */
export function needsRehash(stored: string): boolean {
  const [scheme, n, r, p] = stored.split('$');
  const cost = (N: number, R: number, P: number) => N * R * P;
  return scheme !== 'scrypt' || Number(r) < DEFAULT.r || !(cost(Number(n), Number(r), Number(p)) >= cost(DEFAULT.N, DEFAULT.r, DEFAULT.p));
}

/** A fixed, well-formed hash of a random value; only used to equalise timing. */
const DUMMY_HASH = `scrypt$${DEFAULT.N}$${DEFAULT.r}$${DEFAULT.p}$AAAAAAAAAAAAAAAAAAAAAA$${Buffer.alloc(64, 7).toString('base64url')}`;

/** Simple strength policy for new passwords (length beats composition rules — NIST SP 800-63B). */
export function passwordProblems(password: string, context: string[] = []): string[] {
  const out: string[] = [];
  if (password.length < 12) out.push('Use at least 12 characters.');
  if (password.length > 256) out.push('Use at most 256 characters.');
  if (/^(.)\1+$/.test(password)) out.push('Avoid repeating a single character.');
  const lower = password.toLowerCase();
  const words = context.flatMap((c) => (c ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 4);
  if (words.some((w) => lower.includes(w))) out.push('Do not include your name or email.');
  if (['password1234', 'correcthorsebatterystaple', '123456789012'].includes(lower)) out.push('This password is too common.');
  return [...new Set(out)];
}
