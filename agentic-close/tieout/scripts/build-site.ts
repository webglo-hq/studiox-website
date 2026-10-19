/**
 * `npm run build:site`: the static marketing site with the zero-install demo inside it.
 *   dist/site/index.html      landing page (site/index.html)
 *   dist/site/demo/           the self-contained demo (dist/demo)
 *   dist/site/img/            product screenshots (docs/screenshots)
 *   dist/site/fonts/          the three typefaces (latin subsets)
 * Every link is relative, so the folder can be hosted anywhere or opened from disk.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve('dist/site');
if (!existsSync('dist/demo/index.html')) throw new Error('Build the demo first: npm run build:demo');
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'fonts'), { recursive: true });
copyFileSync('site/index.html', resolve(out, 'index.html'));
copyFileSync('src/web/public/favicon.svg', resolve(out, 'favicon.svg'));
cpSync('dist/demo', resolve(out, 'demo'), { recursive: true });
cpSync('docs/screenshots', resolve(out, 'img'), { recursive: true });
for (const f of [
  '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2',
  '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2',
  '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
])
  copyFileSync(resolve('node_modules', f), resolve(out, 'fonts', f.split('/').pop()!));
console.log('site: dist/site/ (index.html, demo/, img/, fonts/)');
