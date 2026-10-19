// Bundles the server (src/server/main.ts) into dist/server/main.mjs with esbuild. Dependencies stay external
// (resolved from node_modules at runtime) so PGlite's WASM and data files load normally.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'src/server/main.ts'), ...(existsSync(join(root, 'src/server/mcp.ts')) ? [join(root, 'src/server/mcp.ts')] : [])],
  outdir: join(root, 'dist/server'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('built dist/server/*.mjs');
