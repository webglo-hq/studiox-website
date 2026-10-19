/**
 * `npm run mcp` — Tieout MCP server over stdio.
 *   TIEOUT_URL        base URL of a running Tieout server, e.g. http://127.0.0.1:41873
 *   TIEOUT_API_TOKEN  personal API token (Admin → My account → API tokens), `tko_…`
 * Example Claude Desktop / Claude Code config:
 *   { "command": "npx", "args": ["tsx", "src/mcp/main.ts"], "cwd": "<this folder>",
 *     "env": { "TIEOUT_URL": "http://127.0.0.1:41873", "TIEOUT_API_TOKEN": "tko_…" } }
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, httpApi } from './server';

const url = process.env.TIEOUT_URL;
const token = process.env.TIEOUT_API_TOKEN;
if (!url || !token || !token.startsWith('tko_')) {
  console.error('Set TIEOUT_URL and TIEOUT_API_TOKEN (create a token in Tieout: Admin → My account → API tokens).');
  process.exit(2);
}
const server = createMcpServer(httpApi(url, token));
await server.connect(new StdioServerTransport());
console.error(`[tieout-mcp] connected to ${url}`);
