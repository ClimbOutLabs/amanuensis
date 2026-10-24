import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The package root, found from wherever the runner started. */
export function packageRoot(): string {
  let dir = process.cwd();
  for (;;) {
    for (const relative of ['.', 'packages/trueforge-ui']) {
      const candidate = resolve(dir, relative);
      if (existsSync(join(candidate, 'src/styles.css')) && existsSync(join(candidate, 'src/theme'))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not locate the trueforge-ui package');
    dir = parent;
  }
}

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
