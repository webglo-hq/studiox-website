import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { createServerApp } from './app';
import { loadConfig } from './config';

/** `npm start`: serve the API and the built web app. Stops cleanly on SIGINT/SIGTERM. */
const config = loadConfig();
const log = (m: string) => console.log(m);
const app = await createServerApp(config, { log });

/** A path relative to the working directory when it is inside it, else absolute. */
function shown(p: string): string {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith('..') ? r : p;
}

const server = createServer((req, res) => {
  void app.handler(req, res);
});
// Keep idle connections longer than clients do, so a client never reuses a socket the server
// is closing at that moment (embedded PGlite runs on this thread and can delay timers).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 180_000;

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && !process.env.PORT) {
    log(`Port ${config.port} is busy; using a free port instead (set PORT to choose one).`);
    server.listen(0, config.host);
    return;
  }
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set PORT to another value (0 picks a free port).` : err);
  void app.close().finally(() => process.exit(1));
});

server.on('listening', () => {
  const addr = server.address() as AddressInfo;
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  const url = config.publicOrigin ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}`;
  log('');
  log(`Evenkeel is running at ${url}`);
  log(`  database: ${app.dbKind === 'pglite' ? `embedded PGlite (${shown(join(dirname(app.credentialsFile), 'pglite'))})` : 'PostgreSQL (DATABASE_URL)'}`);
  log(`  agents:   ${app.env.engine.mode === 'live' ? 'live (Claude via the Anthropic API)' : 'offline deterministic engine (set ANTHROPIC_API_KEY for live Claude)'}`);
  if (app.seededNow && app.seededNow !== 'password-from-env') {
    log('');
    log(`Demo accounts (fictional company; generated now, saved to ${shown(app.credentialsFile)}):`);
    for (const u of app.seededNow.users) log(`  ${u.title.padEnd(30)} ${u.email.padEnd(28)} ${u.password}`);
  } else if (app.seededNow === 'password-from-env') {
    log('Demo accounts use DEMO_PASSWORD from your environment.');
  } else {
    log(`Demo account passwords: see ${shown(app.credentialsFile)} (or DEMO_PASSWORD if you set one).`);
  }
  log('');
});

server.listen(config.port, config.host);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`\n${signal} received, shutting down…`);
  server.close();
  server.closeAllConnections();
  try {
    await app.close();
    if (config.ephemeral && config.dataDir) rmSync(config.dataDir, { recursive: true, force: true });
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
