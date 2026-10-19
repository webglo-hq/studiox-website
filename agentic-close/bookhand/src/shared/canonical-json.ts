/**
 * Canonical JSON: object keys sorted (by UTF-16 code units), no whitespace, `undefined` dropped,
 * non-finite numbers rejected. Two semantically equal values always serialize to the same bytes,
 * which the audit hash chain, idempotency keys and prompt caching all rely on.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : serialize(v))).join(',')}]`;
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      if (value instanceof Uint8Array) return JSON.stringify(Array.from(value));
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
