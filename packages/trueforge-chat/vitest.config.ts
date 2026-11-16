import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['trueforge-dev', 'module', 'development|production'],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
