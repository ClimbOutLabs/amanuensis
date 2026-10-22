/**
 * Eval-mode page fixtures: the invented pages the page reader answers for one reserved host when `AMAN_EVAL_MODE`
 * is on. The host is not a real domain, so a fixture link can never reach the web.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { PageFixtureSource } from '@truefoundry/trueforge-core/core/search/pageFixtures';

import configuration from '../config';

export const EVAL_PAGE_FIXTURE_HOST = 'fixtures.aman.invalid';

const PAGE_EXTENSION = '.md';
const PAGE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Loads every `<name>.md` page in `dir`. A file name the link path cannot name is refused at load time. */
export function buildEvalPageFixtures(dir: string): PageFixtureSource {
  const pages = new Map<string, { title: string; text: string }>();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    throw new Error(`The eval page fixtures could not be listed. Check that ${dir} exists.`, { cause: error });
  }
  for (const file of files) {
    if (!file.endsWith(PAGE_EXTENSION)) {
      continue;
    }
    const name = file.slice(0, -PAGE_EXTENSION.length);
    if (!PAGE_NAME.test(name)) {
      throw new Error(
        `The eval page fixture ${file} has a name that is not allowed. Use lower-case letters, digits and hyphens.`,
      );
    }
    pages.set(name, { title: name, text: readFileSync(path.join(dir, file), 'utf8') });
  }
  return {
    serves: url => new URL(url).hostname === EVAL_PAGE_FIXTURE_HOST,
    read: url => pages.get(new URL(url).pathname.slice(1)),
  };
}

let fixtures: PageFixtureSource | undefined;

/** The page fixtures for this process. Loaded once; throws when the folder cannot be read. */
export function evalPageFixtures(): PageFixtureSource {
  fixtures ??= buildEvalPageFixtures(path.join(configuration.EVAL_FIXTURE_DIR, 'pages'));
  return fixtures;
}
