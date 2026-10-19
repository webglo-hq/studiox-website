/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { inlineDemoBundle } from './scripts/vite-inline-demo.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    root: 'src/web',
    base: demo ? './' : '/',
    publicDir: false,
    plugins: [react(), ...(demo ? [inlineDemoBundle()] : [])],
    resolve: {
      alias: { '@': src },
    },
    define: {
      __BOOKHAND_MODE__: JSON.stringify(demo ? 'demo' : 'server'),
    },
    build: {
      outDir: demo ? `${here}dist-demo` : `${here}dist/web`,
      emptyOutDir: true,
      assetsInlineLimit: demo ? 100_000_000 : 4096,
      cssCodeSplit: !demo,
      sourcemap: false,
      chunkSizeWarningLimit: 4096,
      rolldownOptions: demo
        ? { output: { codeSplitting: false } }
        : undefined,
    },
    server: {
      port: Number(process.env.WEB_PORT ?? 0) || undefined,
      proxy: {
        '/api': process.env.API_ORIGIN ?? 'http://127.0.0.1:8787',
      },
    },
    test: {
      root: here,
      globals: false,
      environment: 'node',
      testTimeout: 30_000,
      hookTimeout: 120_000,
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
            exclude: ['**/*.int.test.ts', '**/*.eval.test.ts', 'node_modules/**'],
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['src/**/*.int.test.ts', 'tests/integration/**/*.test.ts'],
            fileParallelism: false,
            testTimeout: 180_000,
          },
        },
        {
          extends: true,
          test: {
            name: 'evals',
            include: ['src/**/*.eval.test.ts', 'tests/evals/**/*.test.ts'],
            testTimeout: 120_000,
          },
        },
      ],
    },
  };
});
