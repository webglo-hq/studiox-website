/**
 * `npm run dev`: API server (tsx watch) + Vite dev server with HMR, each on a free random port
 * unless PORT / VITE_PORT are set. Prints the URL to open. Ctrl+C stops both.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.unref();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

const host = process.env.HOST ?? '127.0.0.1';
const apiPort = Number(process.env.PORT ?? 0) || (await freePort());
const webPort = Number(process.env.VITE_PORT ?? 0) || (await freePort());
const children: ChildProcess[] = [];

function run(cmd: string, args: string[], env: Record<string, string>) {
  const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  children.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0) shutdown(code);
  });
  return child;
}

run(process.execPath, ['--import', 'tsx', '--watch', 'src/server/node.ts'], { PORT: String(apiPort), HOST: host });
run(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.config.ts'], { VITE_PORT: String(webPort), HOST: host, TIEOUT_API_ORIGIN: `http://${host}:${apiPort}` });
console.log(`\n[tieout] dev: open http://${host}:${webPort}  (API on ${apiPort}; Ctrl+C to stop)\n`);

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
