/**
 * Production server bundle: dist/server/node.js (ESM, Node 22). Dependencies stay external and
 * are resolved from node_modules at runtime (`npm ci --omit=dev` in the container image).
 */
import { build } from 'esbuild';

await build({
  entryPoints: { node: 'src/server/node.ts', mcp: 'src/mcp/main.ts' },
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
console.log('server bundle: dist/server/node.js (+ mcp.js). Run with `npm run start:prod` after `npm run build:web`.');
