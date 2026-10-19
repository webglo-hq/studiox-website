/** Minimal SQL driver contract shared by PGlite (embedded) and node-postgres (server). */
export type SqlRow = Record<string, unknown>;

export interface SqlQueryable {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: SqlRow[] }>;
  /** Multi-statement script without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface SqlDriver extends SqlQueryable {
  readonly name: 'pglite' | 'pg';
  transaction<R>(fn: (q: SqlQueryable) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

/** Normalise Postgres text timestamps (`2026-10-02 09:00:00.123456+00`) to ISO-8601 UTC. */
export function parsePgTimestamp(value: string): string {
  let s = value.trim().replace(' ', 'T');
  s = s.replace(/(\.\d{3})\d+/, '$1');
  if (/[+-]\d{2}$/.test(s)) s += ':00';
  else if (!/(Z|[+-]\d{2}:\d{2})$/.test(s)) s += 'Z';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable timestamp ${value}`);
  return d.toISOString();
}

export const PG_OID = {
  INT8: 20,
  INT4: 23,
  NUMERIC: 1700,
  DATE: 1082,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
} as const;
