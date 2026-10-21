import { readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { PYTHON_STDLIB_MODULES } from './pythonStdlibModules';
import type { PathResolution } from './trackedExecutables';

/** Longer scripts keep their card: the check reads the whole file and does not try to be complete. */
export const MAX_CHECKED_SCRIPT_BYTES = 256 * 1024;

/** Python modules that load code by name or start programs. A script that uses one keeps its card. */
const PYTHON_LOADER_MODULES: ReadonlySet<string> = new Set(['subprocess', 'pty', 'runpy', 'importlib', 'ctypes']);

/** Node built-ins that start programs or load code by name. A script that uses one keeps its card. */
const NODE_LOADER_MODULES: ReadonlySet<string> = new Set([
  'child_process',
  'cluster',
  'module',
  'repl',
  'vm',
  'worker_threads',
]);

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules.map(name => name.replace(/^node:/u, '')));

/**
 * True when a script can only load the standard library (Python) or Node built-ins. Anything else keeps its
 * card: an import of a name that is not a built-in may resolve to a file in the workspace, and so may a
 * dynamic import, and a script that starts programs can run any file it likes.
 */
export function scriptLoadsOnlyStandardCode(input: { runtime: 'python' | 'node'; source: string }): boolean {
  if (input.source.length > MAX_CHECKED_SCRIPT_BYTES) {
    return false;
  }
  return input.runtime === 'python' ? pythonLoadsOnlyStandard(input.source) : nodeLoadsOnlyBuiltins(input.source);
}

/** The file version of the check. A file the server cannot read, or one too large, keeps its card. */
export function scriptFileLoadsOnlyStandardCode(input: {
  runtime: 'python' | 'node';
  file: string;
  resolution: PathResolution | undefined;
}): boolean {
  if (input.resolution === 'remote') {
    return false;
  }
  try {
    if (statSync(input.file).size > MAX_CHECKED_SCRIPT_BYTES) {
      return false;
    }
    return scriptLoadsOnlyStandardCode({ runtime: input.runtime, source: readFileSync(input.file, 'utf8') });
  } catch {
    return false;
  }
}

function pythonLoadsOnlyStandard(source: string): boolean {
  if (/\b__import__\b|\bos\.(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b/u.test(source)) {
    return false;
  }
  const modules: string[] = [];
  // `from X import Y`: X is the module. A relative `from .x import y` yields an empty top-level name and fails below.
  const fromImportKeywords = new Set<number>();
  for (const match of source.matchAll(/\bfrom\s+([^\s]+)\s+import\b/gu)) {
    modules.push(match[1] ?? '');
    fromImportKeywords.add(match.index + match[0].length - 'import'.length);
  }
  // Every other `import` keyword: a comma-separated list of names, each optionally `as` an alias.
  for (const match of source.matchAll(/\bimport\b/gu)) {
    if (fromImportKeywords.has(match.index)) {
      continue;
    }
    const rest = source.slice(match.index + 'import'.length).split(/[\n;#]/u, 1)[0] ?? '';
    const names = rest.split(',').map(item => (item.trim().split(/\s+as\s+/u)[0] ?? '').trim());
    if (names.some(name => name === '')) {
      return false;
    }
    modules.push(...names);
  }
  return modules.every(name => {
    const top = name.split('.')[0] ?? '';
    return PYTHON_STDLIB_MODULES.has(top) && !PYTHON_LOADER_MODULES.has(top);
  });
}

function nodeLoadsOnlyBuiltins(source: string): boolean {
  if (/\b(?:eval|createRequire|mainModule)\b|\bnew\s+Function\b|\bFunction\s*\(/u.test(source)) {
    return false;
  }
  // Every `require(` and `import(` must take a literal specifier, so the check sees what it loads.
  const calls = source.match(/\b(?:require|import)\s*\(/gu)?.length ?? 0;
  const literalCalls = [...source.matchAll(/\b(?:require|import)\s*\(\s*(['"`])([^'"`$\\]*)\1\s*\)/gu)];
  if (calls !== literalCalls.length) {
    return false;
  }
  const specifiers = [
    ...literalCalls.map(match => match[2] ?? ''),
    ...[...source.matchAll(/\bfrom\s+(['"`])([^'"`]*)\1/gu)].map(match => match[2] ?? ''),
    ...[...source.matchAll(/\bimport\s+(['"`])([^'"`]*)\1/gu)].map(match => match[2] ?? ''),
  ];
  return specifiers.every(specifier => {
    const name = specifier.replace(/^node:/u, '');
    return NODE_BUILTINS.has(name) && !NODE_LOADER_MODULES.has(name);
  });
}
