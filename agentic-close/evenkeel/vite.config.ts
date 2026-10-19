import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Two builds from one codebase:
 *   --mode server → dist/       the web app served by `npm start` (talks to the API)
 *   --mode demo   → dist-demo/  a single self-contained index.html: the whole product runs in
 *                               the browser on an in-memory store; no network calls at all.
 * Both use hash routing and relative asset paths.
 */

/** Inline the entry script and stylesheet into index.html so the demo is one file. */
function singleFile(): Plugin {
  return {
    name: 'evenkeel-single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName === 'index.html');
      if (!html || html.type !== 'asset') return;
      let source = String(html.source);
      for (const [fileName, file] of Object.entries(bundle)) {
        if (file.type === 'chunk' && fileName.endsWith('.js')) {
          const tag = new RegExp(`<script type="module"[^>]*src="[^"]*${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*></script>`);
          if (!tag.test(source)) continue;
          const code = file.code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
          source = source.replace(tag, () => `<script type="module">${code}</script>`);
          delete bundle[fileName];
        } else if (file.type === 'asset' && fileName.endsWith('.css')) {
          const tag = new RegExp(`<link rel="stylesheet"[^>]*href="[^"]*${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`);
          if (!tag.test(source)) continue;
          source = source.replace(tag, () => `<style>${String(file.source)}</style>`);
          delete bundle[fileName];
        }
      }
      source = source.replace(/<link rel="modulepreload"[^>]*>/g, '');
      html.source = source;
    },
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    base: './',
    publicDir: false,
    plugins: [react(), ...(demo ? [singleFile()] : [])],
    resolve: {
      alias: {
        '@fonts': fileURLToPath(new URL('./node_modules/@fontsource-variable', import.meta.url)),
        // One static import, two backends: the demo never ships the HTTP client, the server
        // build never ships the in-browser database and agents.
        '@ek/backend': fileURLToPath(new URL(demo ? './src/web/backend/select-demo.ts' : './src/web/backend/select-server.ts', import.meta.url)),
      },
    },
    worker: { format: 'es' },
    build: {
      outDir: demo ? 'dist-demo' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 6000,
      assetsInlineLimit: demo ? 100_000_000 : 4096,
      cssCodeSplit: !demo,
      modulePreload: demo ? false : { polyfill: false },
      rolldownOptions: demo ? { output: { codeSplitting: false } } : {},
    },
    server: {
      host: '127.0.0.1',
      port: Number(process.env.WEB_PORT ?? 5174),
      strictPort: false,
      proxy: { '/api': { target: `http://127.0.0.1:${process.env.PORT ?? 4610}`, changeOrigin: false } },
    },
  };
});
