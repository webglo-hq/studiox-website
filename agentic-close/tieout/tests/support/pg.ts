/** Connection settings for the throwaway PostgreSQL cluster started by `scripts/pgtest.ts start`. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PgTestEnv {
  adminUrl: string;
  appUrl: string;
}

export function pgTestEnv(): PgTestEnv | null {
  const fromEnv = process.env.TIEOUT_PG_ADMIN_URL && process.env.TIEOUT_PG_APP_URL ? { adminUrl: process.env.TIEOUT_PG_ADMIN_URL, appUrl: process.env.TIEOUT_PG_APP_URL } : null;
  if (fromEnv) return fromEnv;
  const file = resolve(process.cwd(), '.pgtest/env');
  if (!existsSync(file)) return null;
  const kv = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return kv.TIEOUT_PG_ADMIN_URL && kv.TIEOUT_PG_APP_URL ? { adminUrl: kv.TIEOUT_PG_ADMIN_URL, appUrl: kv.TIEOUT_PG_APP_URL } : null;
}
