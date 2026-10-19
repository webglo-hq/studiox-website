/*
 * Evenkeel MCP server over stdio (newline-delimited JSON-RPC 2.0).
 *   EVENKEEL_URL=http://127.0.0.1:4610 EVENKEEL_TOKEN=ekt_… npm run --silent mcp
 * or, for MCP clients that start it from another directory: node <evenkeel>/scripts/mcp.mjs
 * Create the token in the web app (Account → API tokens). Logs go to stderr; stdout carries
 * only protocol messages.
 */
import { createInterface } from 'node:readline';
import { createMcpServer, httpBackend, type JsonRpcMessage } from './server';

const url = process.env.EVENKEEL_URL || 'http://127.0.0.1:4610';
const token = process.env.EVENKEEL_TOKEN ?? '';
if (!token) {
  process.stderr.write('evenkeel-mcp: set EVENKEEL_TOKEN to a personal API token (create one in the web app under Account → API tokens).\n');
  process.exit(2);
}

const server = createMcpServer(httpBackend(url, token));
const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
let closing = false;
rl.on('line', (line) => {
  if (!line.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const batch = Array.isArray(parsed) ? parsed : [parsed];
  pending++;
  void Promise.all(batch.map((m) => server.handle(m as JsonRpcMessage)))
    .then((responses) => {
      const out = responses.filter((r) => r !== null);
      if (out.length) write(Array.isArray(parsed) ? out : out[0]);
    })
    .catch((e: unknown) => process.stderr.write(`evenkeel-mcp: ${e instanceof Error ? e.message : String(e)}\n`))
    .finally(() => {
      pending--;
      if (closing && pending === 0) process.exit(0);
    });
});
rl.on('close', () => {
  closing = true;
  if (pending === 0) process.exit(0);
});
process.stderr.write(`evenkeel-mcp: ready (API ${url})\n`);
