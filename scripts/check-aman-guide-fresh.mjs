#!/usr/bin/env node
// Fails when the committed help pack differs from what `pnpm guide:build` writes. Run by `pnpm guide:check`.
//
// The pack is built into a temporary folder and compared with the committed file, so the check
// never rewrites the working tree. Same rule as `pnpm sdk:check`: generated output is never trusted stale.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AmanGuideBuildError, buildAmanGuide } from './build-aman-guide.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const STALE_PACK_MESSAGE = 'The help pack is out of date. Run `pnpm guide:build` and commit the result.';

function isMissingFileError(error) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

/**
 * Builds the pack from its sources into a scratch file and compares it with `committedPath`.
 * Returns `{ fresh: true }` or `{ fresh: false }`; a broken source still throws AmanGuideBuildError.
 */
export async function checkAmanGuideFresh(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const committedPath =
    options.committedPath ??
    path.join(repoRoot, 'packages/trueforge/src/personas/amanGuide/knowledgePack.generated.ts');
  const scratch = await mkdtemp(path.join(tmpdir(), 'aman-guide-fresh-'));
  try {
    const outPath = path.join(scratch, 'knowledgePack.generated.ts');
    await buildAmanGuide({ ...options.buildOptions, repoRoot, outPath });
    const built = await readFile(outPath, 'utf8');
    let committed;
    try {
      committed = await readFile(committedPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return { fresh: false };
      }
      throw error;
    }
    return { fresh: built === committed };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkAmanGuideFresh()
    .then(result => {
      if (result.fresh) {
        console.log('The help pack is up to date.');
        return;
      }
      console.error(STALE_PACK_MESSAGE);
      process.exitCode = 1;
    })
    .catch(error => {
      console.error(error instanceof AmanGuideBuildError ? error.message : error);
      process.exitCode = 1;
    });
}
