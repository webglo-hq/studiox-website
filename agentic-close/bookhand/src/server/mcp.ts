import { createInterface } from 'node:readline';
import { type BookhandClient, McpServer } from '../mcp/server';

/**
 * Bookhand MCP server over stdio (newline-delimited JSON-RPC on stdin/stdout; diagnostics on stderr only).
 *
 *   BOOKHAND_URL=http://127.0.0.1:8787 BOOKHAND_TOKEN=bh_pat_... node dist/server/mcp.mjs
 *
 * BOOKHAND_TOKEN is a personal access token from Settings > Access tokens. The server forwards every tool
 * call to the Bookhand API with it, so the assistant acts as that person: same roles, limits, SoD rules and
 * audit trail (recorded as "<name> (via MCP)"). A read-only token can look but never change anything.
 */

const base = new URL(process.env.BOOKHAND_URL || 'http://127.0.0.1:8787');
const token = process.env.BOOKHAND_TOKEN ?? '';
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function fail(message: string): never {
  process.stderr.write(`[bookhand-mcp] ${message}\n`);
  process.exit(2);
}
if (!token) fail('Set BOOKHAND_TOKEN to a personal access token (Bookhand > Settings > Access tokens).');
if (base.protocol !== 'https:' && !LOCAL.has(base.hostname)) fail(`Refusing to send an access token over plain http to ${base.hostname}; use https.`);

const client: BookhandClient = {
  async request(method, path, body) {
    const res = await fetch(new URL(path, base), {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-bookhand-client': 'mcp', 'user-agent': 'bookhand-mcp/0.1.0', ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
    } catch {
      return { status: res.status, body: { error: { message: `Unexpected response from ${base.origin} (HTTP ${res.status}).` } } };
    }
  },
};

const server = new McpServer(client);
const write = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
let inFlight = 0;
let inputClosed = false;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  inFlight++;
  server
    .handle(message)
    .then((response) => {
      if (response) write(response);
    })
    .catch((e: unknown) => process.stderr.write(`[bookhand-mcp] ${e instanceof Error ? e.message : String(e)}\n`))
    .finally(() => {
      inFlight--;
      if (inputClosed && inFlight === 0) process.exit(0);
    });
});
lines.on('close', () => {
  inputClosed = true;
  if (inFlight === 0) process.exit(0);
});
