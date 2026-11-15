#!/usr/bin/env node
// Builds the contact sheet for one test run's screenshots. Run by `pnpm nightly:gallery <folder>`.
//
// The folder holds one sub-folder per feature set, as the browser tests save them. This writes
// index.html, which shows every picture grouped by feature set with failures first, and results.json,
// which holds the same facts for a later run to be compared with.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COVERAGE_FILE, readCoverageMap, surfaceFileName } from './check-nightly-coverage.mjs';
import { cardHtml, escapeHtml, pageHtml, parsedJson, tilesHtml } from './screenshot-pages.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAILED_MARK = 'FAILED-';

/** The picture files in one feature-set folder, or none when the run saved nothing there. */
async function pictureFiles(folder) {
  const names = await readdir(folder).catch(error => {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  return names.filter(name => name.endsWith('.png')).sort();
}

/**
 * What the test wrote beside a picture: its name, what it did, what the picture should show and
 * whether it passed. All null for a picture saved without a note.
 */
async function pictureNote(file) {
  const empty = { test: null, did: null, expect: null, passed: null };
  const text = await readFile(`${file.slice(0, -'.png'.length)}.json`, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (text === undefined) {
    return empty;
  }
  const parsed = parsedJson(text);
  const note = typeof parsed === 'object' && parsed !== null ? parsed : {};
  const words = value => (typeof value === 'string' && value !== '' ? value : null);
  return {
    test: words(note.test),
    did: words(note.did),
    expect: words(note.expect),
    passed: typeof note.passed === 'boolean' ? note.passed : null,
  };
}

/**
 * The run as data: every feature set with its features, each feature's pictures, and whether the
 * feature has a test at all. A picture whose step starts with FAILED- was saved at the moment a test
 * failed; `passed` says how the test that took a picture ended.
 */
export async function readRun({ folder, coverage }) {
  const byFileName = new Map(Object.keys(coverage.surfaces).map(id => [surfaceFileName(id), id]));
  const sets = [];
  const unknown = [];
  for (const [setId, name] of Object.entries(coverage.featureSets).sort(([, a], [, b]) => a.localeCompare(b))) {
    const pictures = new Map();
    for (const file of await pictureFiles(path.join(folder, setId))) {
      const [surfaceFile, step] = file.slice(0, -'.png'.length).split('--');
      const surface = byFileName.get(surfaceFile);
      if (surface === undefined || step === undefined || coverage.surfaces[surface].set !== setId) {
        unknown.push(`${setId}/${file}`);
        continue;
      }
      const failed = step.startsWith(FAILED_MARK);
      pictures.set(surface, [
        ...(pictures.get(surface) ?? []),
        {
          file: `${setId}/${file}`,
          step: failed ? step.slice(FAILED_MARK.length) : step,
          failed,
          ...(await pictureNote(path.join(folder, setId, file))),
        },
      ]);
    }
    const features = Object.entries(coverage.surfaces)
      .filter(([, row]) => row.set === setId)
      .map(([id, row]) => ({ id, has_test: row.tests.length > 0, pictures: pictures.get(id) ?? [] }))
      .sort((a, b) => a.id.localeCompare(b.id));
    sets.push({ id: setId, name, features });
  }
  const features = sets.flatMap(set => set.features);
  const pictures = features.flatMap(feature => feature.pictures);
  return {
    feature_sets: sets,
    totals: {
      features: features.length,
      features_with_a_test: features.filter(feature => feature.has_test).length,
      pictures: pictures.length,
      failed_pictures: pictures.filter(fromFailedTest).length,
    },
    unknown_files: unknown,
  };
}

/** True for a picture taken when a test failed, or by a test that went on to fail. */
function fromFailedTest(picture) {
  return picture.failed || picture.passed === false;
}

function resultText(picture) {
  if (picture.failed) {
    return 'Test failed. This is the page at that moment.';
  }
  if (picture.passed === true) {
    return 'Test passed';
  }
  if (picture.passed === false) {
    return 'Test failed later';
  }
  return picture.test === null ? 'No result was recorded' : 'Test did not finish';
}

function pictureHtml({ feature, picture }) {
  const bad = fromFailedTest(picture);
  const rows = [
    ['What the test did', picture.did],
    ['What it should show', picture.expect],
  ]
    .filter(([, words]) => typeof words === 'string')
    .map(([name, words]) => [name, escapeHtml(words)]);
  return cardHtml({
    file: picture.file,
    alt: `${feature.id} · ${picture.step}`,
    pill: { text: resultText(picture), tone: bad ? 'bad' : picture.passed === true ? 'good' : undefined },
    where: `${feature.id} · ${picture.step}`,
    heading: picture.test ?? null,
    rows,
    bad,
  });
}

function count(number, word) {
  return `${String(number)} ${word}${number === 1 ? '' : 's'}`;
}

/**
 * The contact sheet as one page with no outside files, so it opens straight from the download. `home`
 * is the link back to the list when the page sits on the site.
 */
export function galleryHtml({ run, title, home }) {
  const shownIn = set => set.features.flatMap(feature => feature.pictures.map(picture => ({ feature, picture })));
  const failures = run.feature_sets.flatMap(set => shownIn(set).filter(({ picture }) => fromFailedTest(picture)));
  const withPictures = run.feature_sets.filter(set => shownIn(set).length > 0);
  const sections = run.feature_sets.map(set => {
    const shown = shownIn(set);
    const tested = set.features.filter(feature => feature.has_test).length;
    const noTest = set.features.filter(feature => !feature.has_test).map(feature => feature.id);
    return [
      `<section id="${escapeHtml(set.id)}">`,
      `<div class="section-head"><h2>${escapeHtml(set.name)}</h2><p>${count(shown.length, 'picture')}. ${String(tested)} of ${String(set.features.length)} features have a test.</p></div>`,
      shown.length > 0 ? `<div class="grid">${shown.map(pictureHtml).join('')}</div>` : '',
      noTest.length > 0 ? `<p class="note">No test yet: ${escapeHtml(noTest.join(', '))}</p>` : '',
      '</section>',
    ].join('\n');
  });
  const { totals } = run;
  const chips = withPictures.map(
    set => `<a href="#${escapeHtml(set.id)}">${escapeHtml(set.name)}<i>${String(shownIn(set).length)}</i></a>`,
  );
  if (failures.length > 0) {
    chips.unshift(`<a class="bad" href="#failed">Failed<i>${String(failures.length)}</i></a>`);
  }
  return pageHtml({
    title,
    eyebrow: 'Nightly tests',
    lead: 'Every picture the automatic tests took on this run. Each one says which test took it, what the test did and what the picture should show.',
    home,
    hidden: home !== undefined,
    body: `${tilesHtml([
      { value: totals.pictures, label: 'pictures' },
      { value: totals.pictures - totals.failed_pictures, label: 'from tests that did not fail', tone: 'good' },
      {
        value: totals.failed_pictures,
        label: 'from failed tests',
        tone: totals.failed_pictures > 0 ? 'bad' : undefined,
      },
      { value: `${String(totals.features_with_a_test)} of ${String(totals.features)}`, label: 'features have a test' },
    ])}
<nav>${chips.join('')}</nav>
${
  failures.length > 0
    ? `<section id="failed"><div class="section-head"><h2>Failed</h2><p>${count(failures.length, 'picture')} from tests that failed.</p></div><div class="grid">${failures.map(pictureHtml).join('')}</div></section>`
    : ''
}
${sections.join('\n')}`,
  });
}

/** Writes index.html and results.json into the run folder and returns the run's data. */
export async function buildGallery({ folder, repoRoot, title }) {
  const coverage = await readCoverageMap(path.join(repoRoot, COVERAGE_FILE));
  const run = await readRun({ folder, coverage });
  await writeFile(path.join(folder, 'index.html'), galleryHtml({ run, title }));
  await writeFile(path.join(folder, 'results.json'), `${JSON.stringify({ title, ...run }, null, 2)}\n`);
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folder = process.argv[2];
  if (folder === undefined || folder === '') {
    console.error('Name the screenshot folder: pnpm nightly:gallery <folder>');
    process.exit(1);
  }
  const title = process.argv[3] ?? `Screenshots ${path.basename(path.resolve(folder))}`;
  const run = await buildGallery({ folder: path.resolve(folder), repoRoot: DEFAULT_REPO_ROOT, title });
  console.log(
    `${String(run.totals.pictures)} pictures, ${String(run.totals.failed_pictures)} from failed tests. Open ${path.join(folder, 'index.html')}.`,
  );
  if (run.unknown_files.length > 0) {
    console.error(
      `These pictures are not named after a feature in ${COVERAGE_FILE}: ${run.unknown_files.join(', ')}. Save them through featureShotPath.`,
    );
    process.exit(1);
  }
}
