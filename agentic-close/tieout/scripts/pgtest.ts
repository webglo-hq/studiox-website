/**
 * Throwaway PostgreSQL cluster for the integration tests, kept inside this folder (.pgtest/,
 * git-ignored) on a random localhost port.
 *   npx tsx scripts/pgtest.ts start   → initdb (first time), start, create databases, write .pgtest/env
 *   npx tsx scripts/pgtest.ts stop
 * initdb/pg_ctl refuse to run as root, so as root the cluster runs as an unprivileged system
 * user (PGTEST_OS_USER, default `tieoutpg`), created on first use.
 * Two roles: `tieout` (cluster superuser, runs migrations) and `tieout_app` (ordinary role the
 * application uses, so row-level security is really enforced in the tests).
 * Authentication is `trust` on 127.0.0.1 only: this cluster holds fictional test data only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const root = process.cwd();
const dir = resolve(root, '.pgtest');
const data = resolve(dir, 'data');
const sock = resolve(dir, 'tmp');
const envFile = resolve(dir, 'env');
const osUser = process.env.PGTEST_OS_USER ?? 'tieoutpg';
const isRoot = process.getuid?.() === 0;

function bindir(): string {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  try {
    return execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
  } catch {
    for (const v of ['17', '16', '15']) if (existsSync(`/usr/lib/postgresql/${v}/bin/initdb`)) return `/usr/lib/postgresql/${v}/bin`;
    throw new Error('PostgreSQL binaries not found; set PG_BIN');
  }
}

function asPg(cmd: string, args: string[]) {
  const full = isRoot ? ['runuser', ['-u', osUser, '--', cmd, ...args]] : [cmd, args];
  const r = spawnSync(full[0] as string, full[1] as string[], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

const bin = bindir();
const cmd = process.argv[2];

if (cmd === 'start') {
  mkdirSync(sock, { recursive: true });
  if (isRoot) {
    if (spawnSync('id', ['-u', osUser]).status !== 0) execFileSync('useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', osUser]);
    execFileSync('chown', ['-R', `${osUser}:`, dir]);
  }
  chmodSync(dir, 0o755);
  if (!existsSync(resolve(data, 'PG_VERSION'))) asPg(`${bin}/initdb`, ['-D', data, '-U', 'tieout', '--auth=trust', '--encoding=UTF8', '--no-locale', '--no-sync']);
  // already running (pg_ctl status exits 0): keep it and its port
  const status = isRoot ? spawnSync('runuser', ['-u', osUser, '--', `${bin}/pg_ctl`, 'status', '-D', data]) : spawnSync(`${bin}/pg_ctl`, ['status', '-D', data]);
  if (status.status === 0 && existsSync(envFile)) {
    console.log(`PostgreSQL test cluster already running; env in .pgtest/env\n${readFileSync(envFile, 'utf8').trim()}`);
    process.exit(0);
  }
  const port = await freePort();
  asPg(`${bin}/pg_ctl`, ['-D', data, '-l', resolve(dir, 'server.log'), '-w', '-o', `-p ${port} -k '' -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`, 'start']);
  const psql = (db: string, sql: string) => asPg(`${bin}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'tieout', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql]);
  psql('postgres', "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tieout_app') THEN CREATE ROLE tieout_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$;");
  for (const db of ['tieout_test', 'tieout_e2e']) {
    const exists = asPg(`${bin}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'tieout', '-d', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${db}'`]).trim();
    if (!exists) psql('postgres', `CREATE DATABASE ${db} OWNER tieout`);
    psql(db, 'GRANT USAGE ON SCHEMA public TO tieout_app; ALTER DEFAULT PRIVILEGES FOR ROLE tieout IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tieout_app; ALTER DEFAULT PRIVILEGES FOR ROLE tieout IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tieout_app;');
  }
  const env = [`TIEOUT_PG_ADMIN_URL=postgres://tieout@127.0.0.1:${port}/tieout_test`, `TIEOUT_PG_APP_URL=postgres://tieout_app@127.0.0.1:${port}/tieout_test`, `TIEOUT_PG_E2E_URL=postgres://tieout@127.0.0.1:${port}/tieout_e2e`, `TIEOUT_PG_PORT=${port}`].join('\n');
  writeFileSync(envFile, `${env}\n`);
  console.log(`PostgreSQL ${asPg(`${bin}/postgres`, ['--version']).trim()} on 127.0.0.1:${port} (data in .pgtest/); env written to .pgtest/env`);
} else if (cmd === 'stop') {
  if (existsSync(resolve(data, 'postmaster.pid'))) asPg(`${bin}/pg_ctl`, ['-D', data, '-m', 'fast', '-w', 'stop']);
  console.log('PostgreSQL test cluster stopped');
} else if (cmd === 'env') {
  console.log(existsSync(envFile) ? readFileSync(envFile, 'utf8') : '(not started)');
} else {
  console.error('usage: tsx scripts/pgtest.ts start|stop|env');
  process.exit(2);
}
