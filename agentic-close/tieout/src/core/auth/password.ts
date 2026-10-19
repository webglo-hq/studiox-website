/**
 * Password hashing with scrypt (RFC 7914), encoded PHC-style:
 *   $scrypt$ln=<log2 N>,r=<r>,p=<p>$<base64 salt>$<base64 hash>
 * Production parameters follow OWASP's scrypt guidance (N=2^15, r=8, p=3 ≈ 32 MiB).
 * The implementation is injected: node:crypto natively on the server, @noble/hashes in the
 * browser demo. Parameters live in the hash, so verification works across both and rehashing on
 * login upgrades weaker (demo/test) hashes.
 */
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { base64ToBytes, bytesToBase64 } from '../util/base64';
import { secureRandomBytes } from '../util/random';

export interface ScryptParams {
  ln: number;
  r: number;
  p: number;
}

export type ScryptImpl = (password: Uint8Array, salt: Uint8Array, params: ScryptParams, dkLen: number) => Promise<Uint8Array>;

export const PRODUCTION_SCRYPT: ScryptParams = { ln: 15, r: 8, p: 3 };
/** Fast, weak parameters for fictional demo users and tests only (never for real accounts). */
export const DEMO_SCRYPT: ScryptParams = { ln: 10, r: 8, p: 1 };

export const nobleScrypt: ScryptImpl = (password, salt, params, dkLen) => scryptAsync(password, salt, { N: 2 ** params.ln, r: params.r, p: params.p, dkLen, maxmem: 2 ** 31 });

const enc = new TextEncoder();
const PHC = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

export class PasswordHasher {
  constructor(
    private readonly impl: ScryptImpl,
    readonly params: ScryptParams = PRODUCTION_SCRYPT,
  ) {}

  async hash(password: string): Promise<string> {
    assertPasswordPolicy(password);
    const salt = secureRandomBytes(16);
    const dk = await this.impl(enc.encode(password.normalize('NFKC')), salt, this.params, 32);
    return `$scrypt$ln=${this.params.ln},r=${this.params.r},p=${this.params.p}$${bytesToBase64(salt)}$${bytesToBase64(dk)}`;
  }

  async verify(password: string, encoded: string | null): Promise<boolean> {
    const m = encoded ? PHC.exec(encoded) : null;
    if (!m) {
      // burn comparable time to avoid user-enumeration timing differences
      await this.impl(enc.encode(password), secureRandomBytes(16), DEMO_SCRYPT, 32);
      return false;
    }
    const params = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
    if (params.ln > 20 || params.r > 32 || params.p > 16) return false;
    const salt = base64ToBytes(m[4]!);
    const expected = base64ToBytes(m[5]!);
    const dk = await this.impl(enc.encode(password.normalize('NFKC')), salt, params, expected.length);
    let diff = dk.length ^ expected.length;
    for (let i = 0; i < Math.min(dk.length, expected.length); i++) diff |= dk[i]! ^ expected[i]!;
    return diff === 0;
  }

  needsRehash(encoded: string): boolean {
    const m = PHC.exec(encoded);
    if (!m) return true;
    return Number(m[1]) < this.params.ln || Number(m[2]) < this.params.r || Number(m[3]) < this.params.p;
  }
}

export function assertPasswordPolicy(password: string) {
  if (password.length < 12) throw new Error('Passwords need at least 12 characters');
  if (password.length > 256) throw new Error('Password too long');
}
