/**
 * Node server entry. `npm run dev` / `npm start`.
 *   PORT (default 0 = a random free port), HOST (default 127.0.0.1), DATABASE_URL or PGLITE_DIR,
 *   ANTHROPIC_API_KEY (optional: live agents), SEED_DEMO (default true), DEMO_PASSWORD,
 *   TRUST_PROXY (true only behind your own reverse proxy).
 * Serves the built web app from dist/web when present.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createServerApp } from './app';
import { boot } from './bootstrap';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function staticRoutes(webRoot: string) {
  return (app: Hono<never>) => {
    app.get('*', (c) => {
      const url = new URL(c.req.url);
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      let file = join(webRoot, rel);
      if (!file.startsWith(webRoot) || !existsSync(file) || rel.endsWith('/')) file = join(webRoot, 'index.html');
      if (!existsSync(file)) return c.text('Web app not built. Run `npm run build:web` (or use `npm run dev`).', 404);
      const ext = extname(file);
      const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' };
      headers['Cache-Control'] = ext === '.html' ? 'no-cache' : /\/assets\//.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
      return c.body(readFileSync(file), 200, headers);
    });
  };
}

const root = process.cwd();
const booted = await boot({ root });
const webRoot = resolve(root, 'dist/web');
const app = createServerApp(booted.ctx, { static: staticRoutes(webRoot) as never });
const host = process.env.HOST ?? '127.0.0.1';
const trustProxy = process.env.TRUST_PROXY === 'true';
const port = Number(process.env.PORT ?? 0);

const server = serve({
  fetch: (req, env) => {
    // The client address comes from the socket; proxy headers are honoured only with TRUST_PROXY=true
    // (set it when Tieout runs behind your own reverse proxy), so clients cannot spoof rate-limit keys.
    const headers = new Headers(req.headers);
    headers.delete('x-tieout-client-ip');
    const socketIp = (env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress;
    const proxied = trustProxy ? (req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip')) : null;
    const ip = proxied || socketIp;
    if (ip) headers.set('x-tieout-client-ip', ip);
    return app.fetch(new Request(req, { headers }), env);
  },
  hostname: host,
  port,
}, (info) => {
  console.log(`[tieout] store: ${booted.storeLabel}${booted.seeded ? ' (demo seeded)' : ''}; agents: ${booted.ctx.llm ? 'live (Claude) + offline' : 'offline engine (set ANTHROPIC_API_KEY for live Claude)'}`);
  console.log(`[tieout] listening on http://${host}:${info.port}`);
  if (booted.ctx.config.demoMode) console.log('[tieout] demo users: sam@ / jordan@ / casey@ / riley@ / devon@bramblewood.example — password from DEMO_PASSWORD (dev default documented in README)');
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[tieout] ${signal}: shutting down`);
  server.close();
  await booted.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
