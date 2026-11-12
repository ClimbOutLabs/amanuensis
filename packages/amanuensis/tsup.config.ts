import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Options } from 'tsup';

const serverDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../trueforge/dist');

// The server builds each migration as its own module that imports @truefoundry/trueforge-core,
// which this tarball does not ship. Re-bundling them inlines it, as for main.js, and keeps them
// under dist/{engine}/migrations/ where the server looks for them next to its own module.
function migrationEntries(engine: 'postgres' | 'sqlite'): Record<string, string> {
  const migrationsDir = path.join(serverDist, engine, 'migrations');
  return Object.fromEntries(
    readdirSync(migrationsDir)
      .filter(name => name.endsWith('.js'))
      .map(name => [`${engine}/migrations/${name.replace(/\.js$/, '')}`, path.join(migrationsDir, name)] as const),
  );
}

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
    entry: {
      main: '../trueforge/dist/main.js',
      ...migrationEntries('postgres'),
      ...migrationEntries('sqlite'),
    },
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
