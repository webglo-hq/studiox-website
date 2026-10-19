import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** SHA-256 hex of a UTF-8 string or bytes (portable: Node and browser). */
export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input));
}

export function hmacSha256Hex(key: Uint8Array | string, message: string): string {
  const k = typeof key === 'string' ? utf8ToBytes(key) : key;
  return bytesToHex(hmac(sha256, k, utf8ToBytes(message)));
}

/** Constant-time string comparison for secrets/tokens of equal expected length. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const GENESIS_HASH = '0'.repeat(64);
