/**
 * Imports every bundled migration under `dist/{postgres,sqlite}/migrations/` the way the
 * migrator does at startup. Each migration is its own tsup entry, so a module that resolves
 * files relative to its bundle (runtime config reading package.json) breaks only here, not in src.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const failures = [];
let checked = 0;
for (const engine of ['postgres', 'sqlite']) {
  const migrationsDir = path.join(distDir, engine, 'migrations');
  for (const name of readdirSync(migrationsDir).filter(file => file.endsWith('.js'))) {
    const file = path.join(migrationsDir, name);
    checked += 1;
    try {
      const migration = await import(pathToFileURL(file).href);
      if (typeof migration.up !== 'function') {
        failures.push(`${engine}/migrations/${name}: no up() export`);
      }
    } catch (error) {
      failures.push(`${engine}/migrations/${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} bundled migration(s) failed to load:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`Loaded ${checked} bundled migrations`);
