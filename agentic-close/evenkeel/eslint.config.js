import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint: JavaScript and TypeScript recommended rules, React hook rules for the web app, and
 * module boundaries that keep the layers honest:
 *   framework (domain-agnostic) ← packs (accounting) ← app (typed API) ← server | web
 * The web app reaches the API through types only; the in-browser demo backend is the one
 * place that runs the services client-side.
 */
const boundary = (patterns) => ['error', { patterns }];

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dist/', 'dist-demo/', 'dist-site/', '.data/', 'coverage/', 'playwright-report/', 'test-results/', 'blob-report/', 'docs/ads/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['src/framework/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundary([{ group: ['**/packs/**', '**/server/**', '**/web/**', '**/app/**'], message: 'The framework is domain-agnostic: it must not depend on packs, the app API, the server or the web app.' }]),
    },
  },
  {
    files: ['src/packs/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundary([{ group: ['**/server/**', '**/web/**', '**/app/**'], message: 'Domain packs must not depend on the app API, the server or the web app.' }]),
    },
  },
  {
    files: ['src/app/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundary([{ group: ['**/server/**', '**/web/**'], message: 'The app API is shared by the server and the in-browser demo: no server or web imports.' }]),
    },
  },
  {
    files: ['src/server/**/*.ts', 'src/mcp/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundary([{ group: ['**/web/**'], message: 'Server code must not import the web app.' }]),
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    ignores: ['src/web/backend/demo/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundary([
        { group: ['**/server/**', '**/packs/**'], message: 'The web app talks to the API; it must not import server or domain code.' },
        { group: ['**/app/**'], allowTypeImports: true, message: 'Import API types only (import type …); calls go through the backend client.' },
      ]),
    },
  },
  {
    files: ['src/web/backend/demo/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundary([{ group: ['**/server/**'], message: 'The in-browser demo must not import server code (Node-only).' }]),
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
