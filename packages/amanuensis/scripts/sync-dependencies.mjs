/**
 * Regenerates this package's runtime `dependencies` from the packages whose code it ships.
 *
 * `@truefoundry/trueforge` is external at runtime for everything tsup does not bundle, so the
 * wrapper must declare the same ranges. `@truefoundry/trueforge-core` is a workspace package
 * this fork has modified and does not publish, so its code is bundled in and its own runtime
 * dependencies become the wrapper's too. Workspace ranges are never emitted: nothing published
 * may point at a package that is not on the registry.
 *
 * Run before tsup, which reads `dependencies` to decide what stays external.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.resolve(packageRoot, '..');

/** Ordered: the server's own ranges win over the library's where both name a package. */
const sources = ['trueforge', 'trueforge-core'];

function readManifest(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

const merged = new Map();
for (const source of sources) {
  const manifest = readManifest(path.join(packagesDir, source));
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (range.startsWith('workspace:')) {
      continue;
    }
    if (!merged.has(name)) {
      merged.set(name, range);
    }
  }
}

const dependencies = Object.fromEntries([...merged].sort(([a], [b]) => a.localeCompare(b)));
const manifestPath = path.join(packageRoot, 'package.json');
const manifest = readManifest(packageRoot);

if (JSON.stringify(manifest.dependencies) === JSON.stringify(dependencies)) {
  console.log('dependencies already match the packages this wrapper ships');
} else {
  manifest.dependencies = dependencies;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${String(Object.keys(dependencies).length)} dependencies to ${manifestPath}`);
}
