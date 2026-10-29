import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A dependency cache for one test's Vite server. Browser test files run in parallel with different
 * configs, and a shared cache lets one server re-optimize it and reload another test's page.
 */
export function privateViteCache(name: string): { cacheDir: string; remove: () => void } {
  const cacheDir = mkdtempSync(join(tmpdir(), `${name}-vite-`));
  return { cacheDir, remove: () => rmSync(cacheDir, { recursive: true, force: true }) };
}
