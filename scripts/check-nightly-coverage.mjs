#!/usr/bin/env node
// Checks that every feature names the test that exercises it. Run by `pnpm test:nightly-coverage`.
//
// The features are the surfaces the help check reads from the code, plus the screens listed by hand in
// tests/nightly-coverage.json. Each feature has a feature set, which is also the folder its screenshots
// go in, and the tests that exercise it. A feature with no test yet must be in `not_yet`, so the gap is
// written down and a new feature cannot arrive without a test unnoticed.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultSources, readSurfaces } from './check-help-coverage.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COVERAGE_FILE = 'tests/nightly-coverage.json';
const FEATURE_SET_ID = /^[a-z][a-z-]*$/;
const SCREEN_ID = /^screen:[a-z][a-z0-9-]*$/;

export class NightlyCoverageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'NightlyCoverageError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value) {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

/** The coverage map: `feature_sets`, `screens`, `surfaces` and `not_yet`, with their shapes checked. */
export async function readCoverageMap(coveragePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(coveragePath, 'utf8'));
  } catch (error) {
    throw new NightlyCoverageError(`${coveragePath} must be JSON. Fix the file so it parses.`, { cause: error });
  }
  const { feature_sets: featureSets, screens, surfaces, not_yet: notYet } = isRecord(parsed) ? parsed : {};
  const surfacesOk =
    isRecord(surfaces) &&
    Object.values(surfaces).every(
      row =>
        isRecord(row) &&
        typeof row.set === 'string' &&
        Array.isArray(row.tests) &&
        row.tests.every(test => typeof test === 'string'),
    );
  if (
    !isStringRecord(featureSets) ||
    !isStringRecord(screens) ||
    !surfacesOk ||
    !Array.isArray(notYet) ||
    !notYet.every(id => typeof id === 'string')
  ) {
    throw new NightlyCoverageError(
      `${coveragePath} must hold feature_sets as { id: name }, screens as { id: what it is }, surfaces as { id: { set, tests: [paths] } } and not_yet as [ids].`,
    );
  }
  return { featureSets, screens, surfaces, notYet };
}

/** Whether a test's text names this feature itself, not a longer id that starts the same way. */
function mentions({ text, id }) {
  for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + 1)) {
    if (!/[A-Za-z0-9_-]/.test(text.charAt(at + id.length))) {
      return true;
    }
  }
  return false;
}

/** The file name a feature's screenshots start with: its id with the colon made safe for every system. */
export function surfaceFileName(surface) {
  return surface.replace(':', '.');
}

/**
 * Every problem as one plain line, with the counts. An empty `problems` means every feature has a
 * feature set and either a real test that names it or a row in `not_yet`. `codeSurfaces` are the
 * features read from the code.
 */
export async function checkNightlyCoverage({ repoRoot, codeSurfaces }) {
  const coverage = await readCoverageMap(path.join(repoRoot, COVERAGE_FILE));
  const problems = [];

  for (const id of Object.keys(coverage.featureSets)) {
    if (!FEATURE_SET_ID.test(id)) {
      problems.push(`Feature set "${id}" is a folder name. Use lower-case letters and hyphens only.`);
    }
  }
  for (const id of Object.keys(coverage.screens)) {
    if (!SCREEN_ID.test(id)) {
      problems.push(`Screen "${id}" must be written as screen:name, in lower-case letters, digits and hyphens.`);
    }
  }

  const expected = new Set([...codeSurfaces, ...Object.keys(coverage.screens)]);
  for (const id of expected) {
    if (!(id in coverage.surfaces)) {
      problems.push(
        `"${id}" has no row in ${COVERAGE_FILE}. Add it under surfaces with its feature set and the test that exercises it.`,
      );
    }
  }

  const notYet = new Set(coverage.notYet);
  if (notYet.size !== coverage.notYet.length) {
    problems.push(`not_yet lists a feature twice. Remove the repeat.`);
  }
  for (const id of notYet) {
    if (!(id in coverage.surfaces)) {
      problems.push(`not_yet names "${id}", which has no row under surfaces. Remove it from not_yet.`);
    }
  }

  const testText = new Map();
  for (const [id, row] of Object.entries(coverage.surfaces)) {
    if (!expected.has(id)) {
      problems.push(`"${id}" is not a feature any more. Remove its row, or list it under screens.`);
      continue;
    }
    if (!(row.set in coverage.featureSets)) {
      problems.push(`"${id}" is in feature set "${row.set}", which is not listed under feature_sets. Fix the name.`);
    }
    if (row.tests.length === 0 && !notYet.has(id)) {
      problems.push(`"${id}" has no test. Name the test that exercises it, or add it to not_yet.`);
    }
    if (row.tests.length > 0 && notYet.has(id)) {
      problems.push(`"${id}" has a test and is also in not_yet. Remove it from not_yet.`);
    }
    for (const test of row.tests) {
      if (!testText.has(test)) {
        testText.set(test, await readFile(path.join(repoRoot, test), 'utf8').catch(() => undefined));
      }
      const text = testText.get(test);
      if (text === undefined) {
        problems.push(`"${id}" names the test ${test}, which does not exist. Fix the path.`);
      } else if (!mentions({ text, id })) {
        problems.push(
          `${test} never mentions "${id}". Save its screenshots under that name in the test, or remove the test from the row.`,
        );
      }
    }
  }

  const sets = Object.entries(coverage.featureSets)
    .map(([id, name]) => {
      const rows = Object.entries(coverage.surfaces).filter(([, row]) => row.set === id);
      return { id, name, total: rows.length, covered: rows.filter(([, row]) => row.tests.length > 0).length };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const set of sets) {
    if (set.total === 0) {
      problems.push(`Feature set "${set.id}" has no feature. Remove it from feature_sets.`);
    }
  }
  const total = Object.keys(coverage.surfaces).length;
  const covered = total - notYet.size;
  return { problems, total, covered, sets, coverage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkNightlyCoverage({
      repoRoot: DEFAULT_REPO_ROOT,
      codeSurfaces: await readSurfaces(defaultSources(DEFAULT_REPO_ROOT)),
    });
    for (const set of result.sets) {
      console.log(`${set.name}: ${String(set.covered)} of ${String(set.total)} features have a test`);
    }
    console.log(`All features: ${String(result.covered)} of ${String(result.total)} have a test.`);
    if (result.problems.length > 0) {
      for (const problem of result.problems) {
        console.error(problem);
      }
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof NightlyCoverageError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
