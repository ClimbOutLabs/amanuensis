import { defineConfig, type Options } from 'tsup';

const shared: Options = {
  format: ['esm'],
  dts: false,
  splitting: false,
  sourcemap: false,
  target: 'esnext',
  outDir: 'dist',
};

// tsup runs these concurrently, so neither may use `clean`: it would wipe dist/ mid-flight.
// The build script clears dist/ first.
export default defineConfig([
  {
    ...shared,
    // The already-built server bundle, not its sources: this wrapper must not restate how
    // @truefoundry/trueforge compiles itself. Re-bundling inlines @truefoundry/trueforge-core,
    // which this fork modifies and does not publish, so the tarball carries the fork's code
    // rather than resolving an unrelated version from the registry.
    entry: { main: '../trueforge/dist/main.js' },
    // SRT vendor helpers must resolve from node_modules at runtime (createRequire).
    external: ['@anthropic-ai/sandbox-runtime'],
    // scripts/vendor-server.mjs checks the declared dependencies against this, then removes it.
    metafile: true,
  },
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
