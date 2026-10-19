// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', '.data/**', '.tmp/**', 'test-results/**', 'playwright-report/**', '**/*.generated.ts', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // Layering: the framework core must stay domain-agnostic (accounting is a pack on top of it).
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/packs/**', '**/app/**', '**/server/**', '**/web/**'], message: 'src/core is the reusable framework and must not depend on domain packs or delivery layers.' }] }],
    },
  },
  {
    // The browser bundle must never pull in Node-only drivers.
    files: ['src/web/**/*.{ts,tsx}', 'src/demo/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/drivers/**', 'pg', '@electric-sql/pglite', 'node:*'], message: 'Node-only module in browser code.' }] }],
    },
  },
  {
    files: ['src/web/**/*.tsx', 'src/web/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'src/server/node.ts', 'src/server/bootstrap.ts', 'src/mcp/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
