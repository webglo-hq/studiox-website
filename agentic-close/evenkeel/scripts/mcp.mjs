#!/usr/bin/env node
/*
 * Launch the Evenkeel MCP server from any working directory, e.g. in an MCP client config:
 *   { "command": "node", "args": ["/path/to/evenkeel/scripts/mcp.mjs"],
 *     "env": { "EVENKEEL_URL": "http://127.0.0.1:4610", "EVENKEEL_TOKEN": "ekt_…" } }
 * tsx is resolved from this project, so the TypeScript sources run without a build step.
 */
import { register } from 'tsx/esm/api';

register();
await import('../src/mcp/main.ts');
