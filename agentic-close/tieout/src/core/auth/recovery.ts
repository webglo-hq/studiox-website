/**
 * Two-factor recovery codes: ten one-time codes for when the authenticator app is lost. Each is
 * ten characters from an unambiguous 32-symbol alphabet (50 random bits), shown once as
 * `xxxxx-xxxxx`, stored only as a hash, and accepted once (verification is rate limited).
 */
import { sha256Hex } from '../util/hash';
import { secureRandomBytes } from '../util/random';

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l, o, 0, 1

export function newRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const out = new Set<string>();
  while (out.size < n) {
    let s = '';
    for (const b of secureRandomBytes(10)) s += ALPHABET[b & 31]!; // 256 is a multiple of 32: unbiased
    out.add(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return [...out];
}

/** Canonical form (lower case, no separators), or null when the input cannot be a recovery code. */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]/g, '');
  return /^[a-km-np-z2-9]{10}$/.test(s) ? s : null;
}

export function hashRecoveryCode(normalized: string): string {
  return sha256Hex(`tieout.mfa-recovery.v1:${normalized}`);
}
