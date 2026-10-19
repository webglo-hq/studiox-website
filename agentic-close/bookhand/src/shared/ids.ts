/** Identifier helpers. UUID v4 from a CSPRNG (works in Node 22 and every modern browser, secure context or not). */

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function bytesToUuid(b: Uint8Array): string {
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += HEX[b[i]!];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Random UUID v4. */
export function newId(): string {
  return bytesToUuid(randomBytes(16));
}

/** Deterministic UUID-shaped id from a 0..1 random source (seeded PRNG); used only by the seed generator. */
export function idFromRandom(next: () => number): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(next() * 256) & 0xff;
  return bytesToUuid(b);
}

/** URL-safe random token (base64url, no padding) for sessions, CSRF and API tokens. */
export function randomToken(byteLength = 32): string {
  return toBase64Url(randomBytes(byteLength));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
