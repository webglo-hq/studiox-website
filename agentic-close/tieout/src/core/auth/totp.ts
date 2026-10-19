/**
 * TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s) for multi-factor authentication, plus AES-256-GCM
 * encryption of the shared secret at rest (WebCrypto, so it runs on the server and in the demo).
 * Replay protection: the last accepted time step is stored and must strictly increase.
 */
import { base32ToBytes, base64ToBytes, bytesToBase32, bytesToBase64 } from '../util/base64';
import { hmacSha1 } from '../util/hash';
import { secureRandomBytes } from '../util/random';

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;

export function newTotpSecret(): string {
  return bytesToBase32(secureRandomBytes(20));
}

export function totpAt(secretBase32: string, step: number): string {
  const key = base32ToBytes(secretBase32);
  const msg = new Uint8Array(8);
  let s = step;
  for (let i = 7; i >= 0; i--) {
    msg[i] = s & 0xff;
    s = Math.floor(s / 256);
  }
  const h = hmacSha1(key, msg);
  const o = h[h.length - 1]! & 0xf;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** Verify a code within ±1 step of `nowMs`; returns the matched step (for replay protection) or null. */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(nowMs / 1000 / TOTP_PERIOD);
  for (const s of [step, step - 1, step + 1]) {
    if (lastUsedStep !== null && s <= lastUsedStep) continue;
    if (totpAt(secretBase32, s) === code) return s;
  }
  return null;
}

export function otpauthUri(secretBase32: string, account: string, issuer = 'Tieout'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyBase64);
  if (raw.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes (base64)');
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string, keyBase64: string): Promise<string> {
  const iv = secureRandomBytes(12);
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await importKey(keyBase64), new TextEncoder().encode(plaintext));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
}

export async function decryptSecret(ciphertext: string, keyBase64: string): Promise<string> {
  const [v, iv, ct] = ciphertext.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('unsupported ciphertext');
  const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) as BufferSource }, await importKey(keyBase64), base64ToBytes(ct) as BufferSource);
  return new TextDecoder().decode(pt);
}
