/**
 * Copies the assets the bundled server loads from disk at runtime, then checks that every
 * package the bundle still imports is declared.
 *
 * `dist/_frontend` is where the server looks for the UI when it runs from a package root
 * rather than the monorepo, and `dist/{sqlite,postgres}/migrations` is resolved next to the
 * server module. A tarball missing either installs and starts but cannot serve or migrate,
 * so both are hard failures here rather than warnings.
 *
 * The dependency check reads tsup's metafile rather than scanning the bundle for import
 * statements, which cannot tell an import apart from a string that looks like one.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDist = path.resolve(packageRoot, '../trueforge/dist');
const dist = path.join(packageRoot, 'dist');

const frontendSource = path.join(serverDist, '_frontend');
if (!existsSync(path.join(frontendSource, 'index.html'))) {
  throw new Error(
    `No UI at ${frontendSource}. Run \`pnpm --filter frontend build\` then rebuild @truefoundry/trueforge.`,
  );
}

for (const asset of ['_frontend', 'sqlite', 'postgres']) {
  const source = path.join(serverDist, asset);
  if (!existsSync(source)) {
    throw new Error(`Missing ${source}; @truefoundry/trueforge has not been built.`);
  }
  const destination = path.join(dist, asset);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

/** `@scope/name/sub` and `name/sub` both reduce to the installable package name. */
function packageNameOf(specifier) {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

const metafilePath = path.join(dist, 'metafile-esm.json');
if (!existsSync(metafilePath)) {
  throw new Error(`Missing ${metafilePath}; tsup did not run with metafile enabled.`);
}

const metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const declared = new Set(Object.keys(manifest.dependencies ?? {}));
const builtins = new Set(builtinModules);
const missing = new Set();

for (const output of Object.values(metafile.outputs)) {
  for (const imported of output.imports ?? []) {
    if (!imported.external || imported.path.startsWith('.') || imported.path.startsWith('node:')) {
      continue;
    }
    const name = packageNameOf(imported.path);
    if (!builtins.has(name) && !declared.has(name)) {
      missing.add(name);
    }
  }
}

// Build metadata, not something a consumer installs.
rmSync(metafilePath, { force: true });

if (missing.size > 0) {
  throw new Error(
    `The built server imports packages this wrapper does not declare: ${[...missing].sort().join(', ')}. ` +
      'Re-run scripts/sync-dependencies.mjs, or add the package to the source it came from.',
  );
}

const migrationCount = ['sqlite', 'postgres'].reduce(
  (total, engine) =>
    total + readdirSync(path.join(dist, engine, 'migrations')).filter(name => name.endsWith('.js')).length,
  0,
);
const frontendCount = readdirSync(path.join(dist, '_frontend')).length;
if (migrationCount === 0 || frontendCount === 0) {
  throw new Error('Vendored assets are empty; the tarball would install but not run.');
}

console.log(`Vendored ${String(frontendCount)} UI entries and ${String(migrationCount)} migrations into ${dist}`);
