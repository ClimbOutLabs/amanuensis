#!/usr/bin/env node
// Builds the contact sheet for one test run's screenshots. Run by `pnpm nightly:gallery <folder>`.
//
// The folder holds one sub-folder per feature set, as the browser tests save them. This writes
// index.html, which shows every picture grouped by feature set with failures first, and results.json,
// which holds the same facts for a later run to be compared with.

import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COVERAGE_FILE, readCoverageMap, surfaceFileName } from './check-nightly-coverage.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAILED_MARK = 'FAILED-';

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

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
 * The run as data: every feature set with its features, each feature's pictures, and whether the
 * feature has a test at all. A picture whose step starts with FAILED- was saved by a failing test.
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
        { file: `${setId}/${file}`, step: failed ? step.slice(FAILED_MARK.length) : step, failed },
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
      failed_pictures: pictures.filter(picture => picture.failed).length,
    },
    unknown_files: unknown,
  };
}

function pictureHtml({ feature, picture }) {
  const label = `${feature.id} · ${picture.step}`;
  const tag = picture.failed ? '<span class="tag failed">FAILED</span>' : '<span class="tag">OK</span>';
  return `<figure${picture.failed ? ' class="failed"' : ''}><a href="${escapeHtml(picture.file)}"><img loading="lazy" src="${escapeHtml(picture.file)}" alt="${escapeHtml(label)}"></a><figcaption>${tag} ${escapeHtml(label)}</figcaption></figure>`;
}

/** The contact sheet as one page with no outside files, so it opens straight from the download. */
export function galleryHtml({ run, title }) {
  const failures = run.feature_sets.flatMap(set =>
    set.features.flatMap(feature =>
      feature.pictures.filter(picture => picture.failed).map(picture => ({ feature, picture })),
    ),
  );
  const sections = run.feature_sets.map(set => {
    const shown = set.features.flatMap(feature => feature.pictures.map(picture => ({ feature, picture })));
    const tested = set.features.filter(feature => feature.has_test).length;
    const noTest = set.features.filter(feature => !feature.has_test).map(feature => feature.id);
    return [
      `<section id="${escapeHtml(set.id)}">`,
      `<h2>${escapeHtml(set.name)}</h2>`,
      `<p>${String(tested)} of ${String(set.features.length)} features have a test. ${String(shown.length)} pictures.</p>`,
      shown.length > 0 ? `<div class="grid">${shown.map(pictureHtml).join('')}</div>` : '',
      noTest.length > 0 ? `<p class="gap">No test yet: ${escapeHtml(noTest.join(', '))}</p>` : '',
      '</section>',
    ].join('\n');
  });
  const { totals } = run;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --soft: #5c5c5c; --line: #d9d9d9; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #ededed; --soft: #a3a3a3; --line: #3a3a3a; --bad: #ff8a80; } }
body { margin: 0; padding: 1rem; background: var(--bg); color: var(--fg); font: 1rem/1.5 system-ui, sans-serif; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 0.25rem; border-top: 0.0625rem solid var(--line); padding-top: 1rem; }
p { margin: 0.25rem 0; color: var(--soft); }
nav { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; }
nav a { white-space: nowrap; }
a { color: inherit; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; margin-top: 0.75rem; }
figure { margin: 0; border: 0.0625rem solid var(--line); border-radius: 0.5rem; overflow: hidden; }
figure.failed { border-color: var(--bad); }
img { display: block; width: 100%; height: 12rem; object-fit: cover; object-position: top; background: var(--line); }
figcaption { padding: 0.5rem; font-size: 0.8125rem; overflow-wrap: anywhere; }
.tag { font-weight: 600; }
.failed .tag, .tag.failed, .bad { color: var(--bad); }
.gap { font-size: 0.8125rem; overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${String(totals.features_with_a_test)} of ${String(totals.features)} features have a test. ${String(totals.pictures)} pictures, ${String(totals.failed_pictures)} from failed tests.</p>
<nav>${run.feature_sets.map(set => `<a href="#${escapeHtml(set.id)}">${escapeHtml(set.name)}</a>`).join('')}</nav>
${
  failures.length > 0
    ? `<section><h2 class="bad">Failed</h2><div class="grid">${failures.map(pictureHtml).join('')}</div></section>`
    : ''
}
${sections.join('\n')}
</body>
</html>
`;
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
