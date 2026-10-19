import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { canonicalJson } from './json';

const enc = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? enc.encode(input) : input));
}

export function hashObject(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function hmacSha256Hex(key: Uint8Array, message: string): string {
  return bytesToHex(hmac(sha256, key, enc.encode(message)));
}

export function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha1, key, message);
}

/** Constant-time comparison for secrets of equal length (hex digests, tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const ZERO_HASH = '0'.repeat(64);
