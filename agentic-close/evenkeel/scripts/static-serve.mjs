#!/usr/bin/env node
/*
 * Minimal static file server for the zero-install demo build (`npm run preview:demo`).
 * Usage: node scripts/static-serve.mjs <dir> [--port N] [--host H]
 * Port 0 (the default) picks a free port; the URL is printed. Stops on SIGINT/SIGTERM.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'dist-demo');
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(flag('port', process.env.PORT ?? '0'));
const host = flag('host', process.env.HOST ?? '127.0.0.1');

if (!existsSync(join(dir, 'index.html'))) {
  console.error(`No index.html in ${dir}. Build it first (npm run build:demo).`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer((req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (path.includes('\0')) {
    res.writeHead(400).end('Bad request');
    return;
  }
  const rel = normalize(path).replace(/^([/\\])+/, '');
  let file = join(dir, rel);
  if (!file.startsWith(dir + sep) && file !== dir) {
    res.writeHead(404).end('Not found');
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  const a = server.address();
  console.log(`Serving ${dir} at http://${a.address}:${a.port}/`);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
