/**
 * Package version for `--help`. Read from `package.json` at the package root,
 * which is the parent of both `src/` and `dist/`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPackageVersion(): string {
  const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    // A bare SyntaxError here names no file, and this runs before any logger exists.
    throw new Error(`Could not read ${packageJsonPath}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
    throw new Error(`${packageJsonPath} is missing a version field`);
  }
  const { version } = parsed;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${packageJsonPath} version must be a non-empty string`);
  }
  return version;
}

export const PACKAGE_VERSION = readPackageVersion();
