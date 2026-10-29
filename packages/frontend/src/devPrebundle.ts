import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DepOptimizationOptions } from 'vite';

const SDK_SOURCE = fileURLToPath(new URL('../../trueforge-sdk/src', import.meta.url));

/** A hash of every file's path, size and modified time under `root`, so any edit or regen changes it. */
export function sourceTreeFingerprint(root: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        const { size, mtimeMs } = statSync(path);
        hash.update(`${relative(root, path)}\0${String(size)}\0${String(mtimeMs)}\n`);
      }
    }
  };
  visit(root);
  return hash.digest('hex').slice(0, 16);
}

/**
 * The SDK loads from source in dev, about 1,700 files. One request per file pushes a page load past
 * 2,000 requests, and a reload or second tab then hits the browser's open-request limit, so imports
 * fail and the app never mounts. One pre-bundled file keeps a load to a few hundred requests.
 */
export const DEV_OPTIMIZE_DEPS: DepOptimizationOptions = {
  include: ['@truefoundry/trueforge-sdk'],
  // Vite keys its dependency cache on config, not on linked sources. The fingerprint in the banner
  // makes a regenerated, pulled or switched SDK rebuild the bundle instead of serving the old one.
  esbuildOptions: { banner: { js: `/* trueforge-sdk ${sourceTreeFingerprint(SDK_SOURCE)} */` } },
};
