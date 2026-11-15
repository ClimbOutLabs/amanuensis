import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    conditions: ['trueforge-dev', 'module', 'development|production'],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    globals: false,
    setupFiles: ['./test/setup.ts'],
  },
});
