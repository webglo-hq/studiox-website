/*
 * `npm run build:site`: the marketing site in dist-site/ — the landing page with pricing, the
 * zero-install demo as demo.html, self-hosted fonts and product screenshots. Static, no
 * external requests; deploy the folder to any static host.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromRoot } from '../src/server/paths';

const out = fromRoot('dist-site');
const demo = fromRoot('dist-demo', 'index.html');
if (!existsSync(demo)) {
  console.error('Build the demo first: npm run build:demo');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'fonts'), { recursive: true });
mkdirSync(join(out, 'shots'), { recursive: true });

const html = readFileSync(fromRoot('site', 'index.html'), 'utf8');
const external = [...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)].map((m) => m[0]);
if (external.length) throw new Error(`The landing page must not load external resources: ${external.join(', ')}`);
writeFileSync(join(out, 'index.html'), html);
copyFileSync(fromRoot('site', 'site.css'), join(out, 'site.css'));
copyFileSync(demo, join(out, 'demo.html'));

const fonts: [string, string][] = [
  ['@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'inter-latin-wght-normal.woff2'],
  ['@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2', 'newsreader-latin-wght-normal.woff2'],
];
for (const [from, to] of fonts) copyFileSync(fromRoot('node_modules', from), join(out, 'fonts', to));

const shots: [string, string][] = [
  ['desktop-06-proposal-why.png', 'proposal.png'],
  ['desktop-04-cockpit.png', 'cockpit.png'],
  ['desktop-08-reconciliation-workbench.png', 'reconciliation.png'],
  ['desktop-14-ontology-graph.png', 'ontology.png'],
];
for (const [from, to] of shots) {
  const src = fromRoot('docs', 'screenshots', from);
  if (!existsSync(src)) throw new Error(`Missing ${src}; run npm run screenshots first.`);
  copyFileSync(src, join(out, 'shots', to));
}

const size = (dir: string): number => readdirSync(dir).reduce((n, f) => n + (statSync(join(dir, f)).isDirectory() ? size(join(dir, f)) : statSync(join(dir, f)).size), 0);
console.log(`Site built in ${out} (${(size(out) / 1024 / 1024).toFixed(2)} MB): index.html, demo.html, fonts, screenshots.`);
