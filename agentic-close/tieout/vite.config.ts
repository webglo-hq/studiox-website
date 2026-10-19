/**
 * Web app build (served by the Node server from dist/web). In development `npm run dev` starts
 * the API on a random free port and passes it here as TIEOUT_API_ORIGIN for the /api proxy.
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('./src/web'),
  base: './',
  plugins: [react()],
  build: {
    outDir: here('./dist/web'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.VITE_PORT ?? 0) || undefined,
    strictPort: false,
    proxy: { '/api': { target: process.env.TIEOUT_API_ORIGIN ?? 'http://127.0.0.1:8787', changeOrigin: false } },
  },
});
