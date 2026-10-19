/*
 * Run a command against a throwaway PostgreSQL 16 cluster:
 *   node --import tsx scripts/with-postgres.ts <command…>
 * Creates a cluster under .data/pg16-<port> (gitignored) on a random free port, exports
 * DATABASE_URL, runs the command, then stops the cluster and removes it. initdb refuses to run
 * as root, so when we are root the cluster is owned by an unprivileged user (PG_RUN_AS,
 * default "postgres"). Set DATABASE_URL yourself to use an existing server instead.
 * Environment: PG_BIN (default /usr/lib/postgresql/16/bin), PG_PORT, PG_KEEP=1 keeps the data.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import pg from 'pg';
import { fromRoot } from '../src/server/paths';

const PG_BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
const RUN_AS = process.env.PG_RUN_AS ?? 'postgres';
const command = process.argv.slice(2);
if (!command.length) {
  console.error('usage: with-postgres.ts <command…>');
  process.exit(2);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function run(cmd: string, args: string[], asUser: boolean): void {
  const isRoot = process.getuid?.() === 0;
  const [c, a] = asUser && isRoot ? ['runuser', ['-u', RUN_AS, '--', cmd, ...args]] : [cmd, args];
  const r = spawnSync(c, a, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr || r.stdout}`);
}

async function main(): Promise<number> {
  if (process.env.DATABASE_URL) return runCommand(process.env.DATABASE_URL);
  const port = Number(process.env.PG_PORT ?? (await freePort()));
  const dir = fromRoot('.data', `pg16-${port}`);
  const data = join(dir, 'data');
  const log = join(dir, 'server.log');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let started = false;
  try {
    if (process.getuid?.() === 0) {
      const id = spawnSync('id', ['-u', RUN_AS], { encoding: 'utf8' });
      const gid = spawnSync('id', ['-g', RUN_AS], { encoding: 'utf8' });
      if (id.status !== 0) throw new Error(`User ${RUN_AS} does not exist; set PG_RUN_AS to an unprivileged user.`);
      chownSync(dir, Number(id.stdout.trim()), Number(gid.stdout.trim()));
    }
    console.log(`[with-postgres] initdb ${data} (port ${port})`);
    run(join(PG_BIN, 'initdb'), ['-D', data, '-U', 'evenkeel', '--auth=trust', '--encoding=UTF8', '--locale=C'], true);
    // TCP on loopback only; no Unix socket (paths this deep exceed the 107-byte socket limit).
    // Durability is off: the cluster is thrown away after the run.
    const opts = `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off -c full_page_writes=off`;
    try {
      run(join(PG_BIN, 'pg_ctl'), ['-D', data, '-l', log, '-o', opts, '-w', 'start'], true);
    } catch (e) {
      const tail = existsSync(log) ? spawnSync('tail', ['-n', '15', log], { encoding: 'utf8' }).stdout : '';
      throw new Error(`${(e as Error).message}\n${tail}`);
    }
    started = true;
    const admin = new pg.Client({ connectionString: `postgres://evenkeel@127.0.0.1:${port}/postgres` });
    await admin.connect();
    await admin.query('CREATE DATABASE evenkeel_test');
    const version = (await admin.query('SHOW server_version')).rows[0] as { server_version: string };
    console.log(`[with-postgres] PostgreSQL ${version.server_version} ready on 127.0.0.1:${port}`);
    await admin.end();
    return await runCommand(`postgres://evenkeel@127.0.0.1:${port}/evenkeel_test`);
  } finally {
    if (started) {
      try {
        run(join(PG_BIN, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], true);
        console.log('[with-postgres] stopped');
      } catch (e) {
        console.error(`[with-postgres] could not stop cleanly: ${(e as Error).message}`);
      }
    }
    if (existsSync(dir) && !process.env.PG_KEEP) rmSync(dir, { recursive: true, force: true });
  }
}

function runCommand(url: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url }, shell: process.platform === 'win32' });
    const forward = (sig: NodeJS.Signals) => child.kill(sig);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('exit', (code) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(code ?? 1);
    });
  });
}

process.exit(await main());
