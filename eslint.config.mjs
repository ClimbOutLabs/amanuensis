// @ts-check

import react from '@eslint-react/eslint-plugin';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** Minimal browser globals for the Vite React frontend (avoid adding a globals dep). */
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  HTMLElement: 'readonly',
  HTMLButtonElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLSelectElement: 'readonly',
  HTMLDivElement: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  crypto: 'readonly',
  process: 'readonly', // Vite injects import.meta / some env via process in configs
};

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.pnpm-store/**',
      '**/.eslintcache',
      // Excluded from package tsconfigs; run via tsx/jest, not the type-aware ESLint project.
      '**/*.test.ts',
      '**/*.test.tsx',
      // Fern-generated SDK: not part of any tsconfig project, and not ours to lint.
      'packages/trueforge-sdk/**',
      // Build-generated sources (catalogs, sandbox scripts); not in package tsconfigs.
      '**/*.gen.ts',
      // Railway IaC config: consumed by the railway CLI, not part of a package tsconfig.
      '.railway/**',
    ],
  },
  {
    // Require braces on every control statement, including single-line and multi-line.
    rules: {
      curly: ['error', 'all'],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    ignores: [
      'packages/frontend/**',
      // Vendored Gmail MCP has its own tsconfig + tsx TUI; covered by the
      // dedicated block below.
      'mcp/**',
    ],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['packages/frontend/src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      react.configs['recommended-type-checked'],
      reactHooks.configs.flat['recommended-latest'],
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
      globals: browserGlobals,
    },
  },
  {
    // Vite config is outside the frontend src tsconfig project.
    files: ['packages/frontend/*.{ts,mts,cts}', 'packages/frontend/*.config.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  {
    // Vendored Gmail MCP server: type-aware lint over its own tsconfig,
    // including the Ink TUI .tsx components (previously these had no matching
    // configuration and were silently skipped).
    files: ['mcp/gmail/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
      },
    },
  },
  {
    // Vendored Gmail MCP server: third-party fork kept as a private copy with
    // its own tsconfig. Bug-class checks stay on, but `any`-tolerance and
    // first-party style rules are off so vendor syncs don't become lint churn.
    files: ['mcp/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/prefer-regexp-exec': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-useless-default-assignment': 'off',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',
      '@typescript-eslint/no-unnecessary-type-arguments': 'off',
      // Braceless single-statement ifs are the vendored codebase's style;
      // mechanically rewriting ~200 of them adds churn with no behavior change.
      curly: 'off',
      // The vendored code signals intentionally-unused params with a `_`
      // prefix; honor that convention instead of rewriting call signatures.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The vendored tree pins @modelcontextprotocol/sdk ^1.29.0; SDK-side
      // deprecation renames are upstream's migration to make, not this fork's.
      '@typescript-eslint/no-deprecated': 'off',
      // Fires on `any`-typed operands at untyped library boundaries; the
      // any-tolerance rules above already cover those.
      '@typescript-eslint/restrict-plus-operands': 'off',
      // The paginate helper's `void | Promise<void> | boolean` return union is
      // intentional (sync/async callbacks that optionally return false).
      '@typescript-eslint/no-invalid-void-type': 'off',
      // Account manifests are small JSON dictionaries mutated rarely; `delete`
      // on a computed key is the natural operation, not a hot-path deopt.
      '@typescript-eslint/no-dynamic-delete': 'off',
    },
  },
  {
    // Credential- and path-handling code gets the full strict treatment —
    // no `any`-tolerance and no non-null assertions where OAuth tokens and
    // sandbox boundaries are decided. This deliberately narrows the broad
    // `mcp/**` relaxations above for exactly these files. Tradeoff: vendor
    // syncs touching these files may need type fixes; that friction is
    // intentional for security-sensitive code.
    files: [
      'mcp/gmail/src/auth-errors.ts',
      'mcp/gmail/src/safe-path.ts',
      'mcp/gmail/src/scopes.ts',
      'mcp/gmail/src/core/account-gmail.ts',
      'mcp/gmail/src/core/auth-flow.ts',
      'mcp/gmail/src/core/config-paths.ts',
      'mcp/gmail/src/core/credentials.ts',
      'mcp/gmail/src/core/session.ts',
      'mcp/gmail/src/cli/account-auth.ts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
      // Flat config does not support /* eslint-env node */; Node scripts and CJS configs need Node globals.
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
  {
    // Buildbox test runner scripts are not production code; the strict
    // curly rule adds churn with no behavior change (same rationale as
    // the vendored mcp/ exception above). Browser globals are needed for
    // Playwright page.evaluate() callbacks which run in page context.
    files: ['buildbox/**/*.mjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      curly: 'off',
      'no-empty': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    // The browser sidecar's page extractor runs inside `page.evaluate()`, in page context, not Node.
    files: ['ops/browser-sidecar/src/extract.mjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        CSS: 'readonly',
      },
    },
  },
);
