#!/usr/bin/env node
/**
 * Run a command against a throwaway PostgreSQL server.
 *   node scripts/with-postgres.mjs vitest run --project integration
 *
 * - If DATABASE_URL is already set, the command runs against it unchanged.
 * - Otherwise a fresh cluster is created under .pgdata/ (gitignored), started on a random free localhost
 *   port, and removed afterwards. When running as root, the server runs as the unprivileged `postgres`
 *   user because initdb/pg_ctl refuse to run as root.
 * - PG_BIN overrides the binaries directory (default /usr/lib/postgresql/16/bin).
 */
import { spawn, spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: with-postgres.mjs <command> [args...]');
  process.exit(2);
}

function run(command, commandArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

if (process.env.DATABASE_URL) {
  process.exit(await run(cmd, args, {}));
}

const binDir = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
if (!existsSync(join(binDir, 'initdb'))) {
  console.warn(`[with-postgres] no Postgres binaries at ${binDir}; running without a real server (PGlite + memory only)`);
  process.exit(await run(cmd, args, {}));
}

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = join(root, '.pgdata', `run-${process.pid}`);
mkdirSync(dataDir, { recursive: true });

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
let asUser = (bin, binArgs) => [join(binDir, bin), binArgs];
if (isRoot) {
  const uid = Number(spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).stdout.trim());
  const gid = Number(spawnSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).stdout.trim());
  if (!Number.isInteger(uid) || uid === 0) {
    console.error('[with-postgres] running as root but no unprivileged "postgres" user exists');
    process.exit(1);
  }
  chownSync(join(root, '.pgdata'), uid, gid);
  chownSync(dataDir, uid, gid);
  asUser = (bin, binArgs) => ['runuser', ['-u', 'postgres', '--', join(binDir, bin), ...binArgs]];
}

function sync(bin, binArgs) {
  const [c, a] = asUser(bin, binArgs);
  const r = spawnSync(c, a, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`${bin} failed with exit code ${r.status}`);
  }
  return r.stdout;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let started = false;
function stop() {
  if (!started) return;
  started = false;
  try {
    sync('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
  } catch (e) {
    console.error('[with-postgres] stop failed:', e.message);
  }
  rmSync(dataDir, { recursive: true, force: true });
}
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});
process.on('SIGTERM', () => {
  stop();
  process.exit(143);
});

let exitCode = 1;
try {
  sync('initdb', ['-D', dataDir, '-U', 'bookhand', '--auth=trust', '-E', 'UTF8', '--no-sync', '--no-instructions']);
  const port = await freePort();
  sync('pg_ctl', [
    '-D', dataDir,
    '-l', join(dataDir, 'server.log'),
    '-o', `-p ${port} -c unix_socket_directories='' -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
    '-w', 'start',
  ]);
  started = true;
  sync('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'bookhand', 'bookhand_test']);
  const url = `postgres://bookhand@127.0.0.1:${port}/bookhand_test`;
  console.log(`[with-postgres] PostgreSQL ${sync('postgres', ['--version']).trim()} on 127.0.0.1:${port}`);
  exitCode = await run(cmd, args, { DATABASE_URL: url });
} catch (e) {
  console.error('[with-postgres]', e.message);
} finally {
  stop();
}
process.exit(exitCode);
