/**
 * Python packages the person adds to the sandbox image themselves, on top of the ones Aman ships. The list lives
 * next to the toolchain pack choice and stays until removed; the image build installs it from the Python package
 * site, as ready-made wheels only, without changing any version Aman ships.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A package name, optionally pinned with `==<version>`. No extras, ranges, paths or addresses. */
const PACKAGE_SPEC = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:==[A-Za-z0-9][A-Za-z0-9.+!_-]*)?$/;

/** The name part of a spec, compared the way the Python package site compares names. */
function normalizedName(spec: string): string {
  const name = spec.split('==')[0] ?? spec;
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Splits `--add-python feedparser,arxiv==2.1.0` style input; anything that is not a plain spec is reported. */
export function parsePythonPackageList(input: string): { packages: string[]; invalid: string[] } {
  const packages: string[] = [];
  const invalid: string[] = [];
  for (const item of input.split(',')) {
    const spec = item.trim();
    if (spec === '') {
      continue;
    }
    if (!PACKAGE_SPEC.test(spec)) {
      invalid.push(spec);
      continue;
    }
    if (!packages.some(existing => normalizedName(existing) === normalizedName(spec))) {
      packages.push(spec);
    }
  }
  return { packages, invalid };
}

/** The list after additions and removals. An added spec replaces an earlier one for the same package. */
export function nextPythonPackages(input: { current: string[]; add: string[]; remove: string[] }): string[] {
  const removed = new Set([...input.add, ...input.remove].map(normalizedName));
  return [...input.current.filter(spec => !removed.has(normalizedName(spec))), ...input.add];
}

export interface PythonPackagesPort {
  /** Applies additions and removals, saves the result and returns it. */
  update(input: { add: string[]; remove: string[] }): Promise<string[]>;
}

/** The list is kept in `dir` (ops/sandbox-slot/packs) as python-packages.json, which is local to this machine. */
export function createPythonPackagesPort({ dir }: { dir: string }): PythonPackagesPort {
  const file = join(dir, 'python-packages.json');

  async function selected(): Promise<string[]> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited entry that is not a plain spec is dropped, so it never reaches the image build.
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && PACKAGE_SPEC.test(item))
      : [];
  }

  return {
    async update({ add, remove }) {
      const current = await selected();
      const next = nextPythonPackages({ current, add, remove });
      if (add.length > 0 || remove.length > 0) {
        await mkdir(dir, { recursive: true });
        const partial = `${file}.part`;
        await writeFile(partial, `${JSON.stringify(next, null, 2)}\n`);
        await rename(partial, file);
      }
      return next;
    },
  };
}
