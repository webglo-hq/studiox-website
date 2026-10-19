/**
 * Zero-install static demo: the whole product (API, agents on the offline engine, in-memory
 * store, web app) in one static folder. The JS, CSS and fonts are inlined into index.html, so the
 * demo is a single self-contained page: it works from any static host, any sub-path, a sandboxed
 * iframe, or straight from disk (file://, where browsers refuse to load module scripts from
 * separate files). Output: dist/demo (checked by scripts/verify-demo-build.ts).
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Make text safe inside an inline <script>/<style> element. */
const safeInline = (code: string) => code.replace(/<\/(script|style)/gi, '<\\/$1');

function singleFile(): Plugin {
  return {
    name: 'tieout-single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((a) => a.type === 'asset' && a.fileName === 'index.html');
      if (!html || html.type !== 'asset') return;
      let page = String(html.source);
      for (const [name, item] of Object.entries(bundle)) {
        if (item.type === 'chunk' && item.isEntry) {
          const tag = new RegExp(`<script type="module" crossorigin src="\\./${item.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"></script>`);
          if (!tag.test(page)) throw new Error(`single-file: script tag for ${item.fileName} not found`);
          page = page.replace(tag, () => `<script type="module">${safeInline(item.code)}</script>`);
          delete bundle[name];
        } else if (item.type === 'asset' && item.fileName.endsWith('.css')) {
          const tag = new RegExp(`<link rel="stylesheet" crossorigin href="\\./${item.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`);
          if (!tag.test(page)) throw new Error(`single-file: stylesheet tag for ${item.fileName} not found`);
          page = page.replace(tag, () => `<style>${safeInline(String(item.source))}</style>`);
          delete bundle[name];
        }
      }
      html.source = page;
    },
  };
}

export default defineConfig({
  root: here('./src/demo'),
  base: './',
  publicDir: here('./src/web/public'),
  plugins: [react(), singleFile()],
  build: {
    outDir: here('./dist/demo'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    modulePreload: false,
    // fonts become data: URIs inside the inlined CSS
    assetsInlineLimit: 200_000,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
