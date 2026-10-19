/**
 * Canonical JSON encodings.
 *
 * `jsonbText` reproduces PostgreSQL's `jsonb::text` output exactly for the value shapes we
 * store (objects, arrays, strings, booleans, null and finite numbers): object keys ordered by
 * byte length then bytewise, ", " and ": " separators. This lets the audit hash chain be
 * computed by a database trigger and re-verified byte-for-byte in TypeScript (and vice versa).
 *
 * `stableStringify` is compact JSON with recursively sorted keys, used for content hashes.
 */
const encoder = new TextEncoder();

function compareKeysJsonb(a: string, b: string): number {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return ab.length - bb.length;
  for (let i = 0; i < ab.length; i++) {
    if (ab[i] !== bb[i]) return ab[i]! - bb[i]!;
  }
  return 0;
}

function quote(s: string): string {
  // Same escaping as Postgres escape_json(): " \ \b \f \n \r \t and other C0 controls as \u00XX.
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
    }
  }
  return out + '"';
}

function numberText(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError('non-finite number in canonical JSON');
  if (Object.is(n, -0)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toString();
  const s = n.toString();
  if (!/e/i.test(s)) return s;
  // Expand exponent notation the way numeric output would (plain decimal).
  return expandExponent(s);
}

function expandExponent(s: string): string {
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) return s;
  const sign = m[1]!;
  const digits = m[2]! + (m[3] ?? '');
  const exp = Number(m[4]);
  const pointPos = 1 + exp;
  if (pointPos <= 0) return `${sign}0.${'0'.repeat(-pointPos)}${digits}`;
  if (pointPos >= digits.length) return `${sign}${digits}${'0'.repeat(pointPos - digits.length)}`;
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

export function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return numberText(value);
    case 'string':
      return quote(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => jsonbText(v === undefined ? null : v)).join(', ')}]`;
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      // jsonb keeps the last value for duplicate keys; JS objects cannot have duplicates.
      entries.sort(([a], [b]) => compareKeysJsonb(a, b));
      return `{${entries.map(([k, v]) => `${quote(k)}: ${jsonbText(v)}`).join(', ')}}`;
    }
    default:
      throw new TypeError(`cannot encode ${typeof value} as jsonb`);
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
