import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

/**
 * Migrations are bundled into the installable `amanuensis` package, which does not ship the
 * workspace libraries. Everything a migration imports at runtime, directly or through what it
 * imports, must therefore resolve from that package alone: a Node builtin or one of its declared
 * dependencies. Type-only imports are erased before bundling, so they do not count.
 *
 * The scan is textual: it reads import statements rather than executing the modules, so a
 * migration cannot hide a runtime dependency behind a helper the test never calls.
 */
const srcRoot = path.resolve(__dirname, '../../../src');
const wrapperManifestPath = path.resolve(__dirname, '../../../../amanuensis/package.json');

const IMPORT_STATEMENT = /(?:^|\n)\s*import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const EXPORT_STATEMENT = /(?:^|\n)\s*export\s+(type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

interface BareImport {
  /** File doing the importing, relative to src. */
  from: string;
  specifier: string;
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

/** Every runtime package import in the transitive closure of `entry`, following relative imports. */
function closureBareImports(entry: string): BareImport[] {
  const visited = new Set<string>();
  const bare: BareImport[] = [];
  const queue = [entry];
  for (let head = 0; head < queue.length; head += 1) {
    const file = queue[head];
    if (file === undefined || visited.has(file)) {
      continue;
    }
    visited.add(file);
    const text = readFileSync(file, 'utf8');
    const from = path.relative(srcRoot, file);
    for (const pattern of [IMPORT_STATEMENT, EXPORT_STATEMENT]) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[2];
        if (specifier === undefined || match[1] !== undefined) {
          continue;
        }
        if (specifier.startsWith('.')) {
          const target = resolveRelative(file, specifier);
          if (target !== undefined) {
            queue.push(target);
          }
        } else {
          bare.push({ from, specifier });
        }
      }
    }
    for (const match of text.matchAll(DYNAMIC_IMPORT)) {
      const specifier = match[1];
      if (specifier === undefined) {
        continue;
      }
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier);
        if (target !== undefined) {
          queue.push(target);
        }
      } else {
        bare.push({ from, specifier });
      }
    }
  }
  return bare;
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
}

function wrapperDependencies(): Set<string> {
  const parsed: unknown = JSON.parse(readFileSync(wrapperManifestPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('dependencies' in parsed)) {
    return new Set();
  }
  const dependencies = parsed.dependencies;
  if (typeof dependencies !== 'object' || dependencies === null) {
    return new Set();
  }
  return new Set(Object.keys(dependencies));
}

function migrationEntries(): string[] {
  return ['sqlite', 'postgres'].flatMap(engine => {
    const dir = path.join(srcRoot, 'db', engine, 'migrations');
    return readdirSync(dir)
      .filter(name => name.endsWith('.ts'))
      .map(name => path.join(dir, name));
  });
}

describe('migration imports', () => {
  const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
  const declared = wrapperDependencies();
  const entries = migrationEntries();

  it('finds the shipped migrations to scan', () => {
    expect(entries.length).toBeGreaterThan(0);
    const searchProvider = entries.find(entry => entry.endsWith('20261016_000004_search_provider_default.ts'));
    expect(searchProvider).toBeDefined();
  });

  it('every runtime import of every migration resolves from the installable package alone', () => {
    const violations: string[] = [];
    for (const entry of entries) {
      for (const bare of closureBareImports(entry)) {
        const name = packageNameOf(bare.specifier);
        const isBuiltin = builtins.has(name.replace(/^node:/, ''));
        if (!isBuiltin && !declared.has(name)) {
          violations.push(
            `${path.relative(srcRoot, entry)} reaches ${bare.specifier} via ${bare.from}, ` +
              'which the installable package does not provide',
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
