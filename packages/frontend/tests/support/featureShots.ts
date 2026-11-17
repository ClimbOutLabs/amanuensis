/**
 * Where browser tests save their pictures: one folder per feature set, as tests/nightly-coverage.json
 * names it. A test passes the feature it exercises and never picks a folder itself.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Browser } from 'playwright-core';

const COVERAGE_PATH = fileURLToPath(new URL('../../../../tests/nightly-coverage.json', import.meta.url));
const STEP_NAME = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let featureSets: Map<string, string> | undefined;

/** The feature set each feature belongs to, read once from the coverage map. */
function featureSetOf(surface: string): string {
  if (featureSets === undefined) {
    const parsed: unknown = JSON.parse(readFileSync(COVERAGE_PATH, 'utf8'));
    const surfaces = isRecord(parsed) ? parsed['surfaces'] : undefined;
    if (!isRecord(surfaces)) throw new Error(`${COVERAGE_PATH} has no surfaces table. Restore it from git.`);
    featureSets = new Map();
    for (const [id, row] of Object.entries(surfaces)) {
      const set = isRecord(row) ? row['set'] : undefined;
      if (typeof set === 'string') featureSets.set(id, set);
    }
  }
  const set = featureSets.get(surface);
  if (set === undefined) {
    throw new Error(`"${surface}" is not in tests/nightly-coverage.json. Add it there with its feature set.`);
  }
  return set;
}

let root: Promise<string> | undefined;

/** The run's picture folder: the one the run names, or a fresh temp folder for a run by hand. */
function shotRoot(): Promise<string> {
  root ??= (async () => {
    const configured = process.env['AMAN_SCREENSHOT_DIR'];
    if (configured != null && configured !== '') return configured;
    const made = await mkdtemp(join(tmpdir(), 'aman-screenshots-'));
    console.log(`screenshots are written to ${made}`);
    return made;
  })();
  return root;
}

/** What a person needs to read a picture: the test it came from, what the test did and what should show. */
interface ShotNote {
  test: string;
  did: string;
  expect: string;
  /** Set when the test ends. It stays null for a test that was cut off before it could end. */
  passed: boolean | null;
}

let runningTest = '';
const notesOfRunningTest = new Map<string, ShotNote>();

async function writeNote({ file, note }: { file: string; note: ShotNote }): Promise<void> {
  await writeFile(file, `${JSON.stringify(note, null, 2)}\n`);
}

// Each test file runs alone, so these hooks see every test of the file that imports this helper.
beforeEach(t => {
  runningTest = t.name;
  notesOfRunningTest.clear();
});
afterEach(async t => {
  // Older Node type definitions do not list `passed`, so it is read with a guard.
  const passed = 'passed' in t && typeof t.passed === 'boolean' ? t.passed : null;
  for (const [file, note] of notesOfRunningTest) {
    await writeNote({ file, note: { ...note, passed } });
  }
});

async function shotPath({
  surface,
  step,
  did,
  expect,
  failed,
}: {
  surface: string;
  step: string;
  did: string;
  expect: string;
  failed: boolean;
}): Promise<string> {
  if (!STEP_NAME.test(step)) {
    throw new Error(`The step name "${step}" must be lower-case letters, digits and hyphens.`);
  }
  const folder = join(await shotRoot(), featureSetOf(surface));
  await mkdir(folder, { recursive: true });
  const name = `${surface.replace(':', '.')}--${failed ? 'FAILED-' : ''}${step}`;
  const note: ShotNote = { test: runningTest, did, expect, passed: null };
  const noteFile = join(folder, `${name}.json`);
  notesOfRunningTest.set(noteFile, note);
  await writeNote({ file: noteFile, note });
  return join(folder, `${name}.png`);
}

/**
 * The path for one picture of a feature at a named step, with its feature-set folder made. `did` says
 * in plain words what the test did to reach this picture, and `expect` what the picture should show.
 * Both are saved beside the picture with the test's name and whether it passed.
 */
export async function featureShotPath({
  surface,
  step,
  did,
  expect,
}: {
  surface: string;
  step: string;
  did: string;
  expect: string;
}): Promise<string> {
  return shotPath({ surface, step, did, expect, failed: false });
}

/**
 * Saves a picture of every open page, marked FAILED, for a test that is about to fail. A page that
 * cannot be pictured is skipped, so the test still fails with its own error.
 */
export async function saveFailureShots({
  browser,
  surface,
}: {
  browser: Browser | undefined;
  surface: string;
}): Promise<void> {
  if (browser === undefined) return;
  const pages = browser.contexts().flatMap(context => context.pages());
  for (const [index, page] of pages.entries()) {
    const path = await shotPath({
      surface,
      step: `page-${String(index + 1)}`,
      did: 'The test failed. This is the page as it was at that moment.',
      expect: 'Nothing. This picture is here to show what went wrong.',
      failed: true,
    });
    await page.screenshot({ path, timeout: 10_000 }).catch(() => undefined);
  }
}
