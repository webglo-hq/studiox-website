import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ApiKernel, ApiRequest, CookieSpec } from '../api/kernel';

/** Node HTTP adapter: JSON API through the kernel, static web assets, strict security headers. */

const MAX_BODY = 6 * 1024 * 1024;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

export function securityHeaders(secure: boolean): Record<string, string> {
  return {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    ...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

function serializeCookie(c: CookieSpec): string {
  const parts = [`${c.name}=${encodeURIComponent(c.value)}`, `Path=${c.path}`, `Max-Age=${c.maxAgeSeconds}`, `SameSite=${c.sameSite}`];
  if (c.httpOnly) parts.push('HttpOnly');
  if (c.secure) parts.push('Secure');
  return parts.join('; ');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface HttpOptions {
  kernel: ApiKernel;
  webRoot: string | null;
  secure: boolean;
  trustProxy: boolean;
}

export function createHttpServer(opts: HttpOptions): Server {
  const headers = securityHeaders(opts.secure);
  const root = opts.webRoot ? resolve(opts.webRoot) : null;
  const indexHtml = root && existsSync(join(root, 'index.html')) ? readFileSync(join(root, 'index.html')) : null;

  const send = (res: ServerResponse, status: number, body: string | Buffer, extra: Record<string, string>) => {
    res.writeHead(status, { ...headers, ...extra });
    res.end(body);
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let body: unknown;
        const method = (req.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          const raw = await readBody(req);
          if (raw) {
            if (!(req.headers['content-type'] ?? '').includes('application/json')) return send(res, 415, JSON.stringify({ error: { code: 'VALIDATION', message: 'Send JSON (Content-Type: application/json).' } }), { 'content-type': 'application/json' });
            try {
              body = JSON.parse(raw);
            } catch {
              return send(res, 400, JSON.stringify({ error: { code: 'VALIDATION', message: 'Malformed JSON.' } }), { 'content-type': 'application/json' });
            }
          }
        }
        const forwarded = opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
        const apiReq: ApiRequest = {
          method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : String(v ?? '')])),
          cookies: parseCookies(req.headers.cookie),
          body,
          ip: forwarded || req.socket.remoteAddress || 'unknown',
        };
        const out = await opts.kernel.handle(apiReq);
        res.writeHead(out.status, { ...headers, 'content-type': 'application/json; charset=utf-8', ...out.headers, ...(out.cookies.length ? { 'set-cookie': out.cookies.map(serializeCookie) } : {}) });
        res.end(JSON.stringify(out.body));
        return;
      }
      if (!root || !indexHtml) return send(res, 404, 'Web bundle not built. Run npm run build:web.', { 'content-type': 'text/plain; charset=utf-8' });
      let decoded: string;
      try {
        decoded = decodeURIComponent(url.pathname);
      } catch {
        return send(res, 400, 'Bad request.', { 'content-type': 'text/plain; charset=utf-8' });
      }
      const rel = normalize(decoded).replace(/^([/\\])+/, '');
      const file = resolve(root, rel);
      // Only files inside the web root (a sibling such as "web-old" shares the prefix, hence the separator).
      if (file.startsWith(root + sep) && rel && !rel.includes('\0') && existsSync(file) && statSync(file).isFile()) {
        const immutable = rel.startsWith('assets/');
        res.writeHead(200, { ...headers, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
        createReadStream(file).pipe(res);
        return;
      }
      send(res, 200, indexHtml, { 'content-type': TYPES['.html']!, 'cache-control': 'no-cache' });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      send(res, status, JSON.stringify({ error: { code: status === 413 ? 'VALIDATION' : 'INTERNAL', message: status === 413 ? 'Request too large.' : 'Server error.' } }), { 'content-type': 'application/json' });
    }
  });
}
