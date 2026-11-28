#!/usr/bin/env node
// Adds the test screenshots to the built docs site. Run by `npm run docs:site:screenshots <site folder>`
// in the Docs site workflow, after the site is built and only when it is about to be published.
//
// It fetches the stored pictures of the last nightly runs and the last weekly look-overs, and writes
// them under test-screenshots/ with one page that lists them, newest first. The pages are not part of
// the help or the docs menu.

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  cardHtml,
  escapeHtml,
  filterHtml,
  galleryHtml,
  pageHtml,
  parsedJson,
  pillHtml,
  tilesHtml,
} from './screenshot-pages.mjs';

const run = promisify(execFile);

export const SECTION = 'test-screenshots';
/** Where each kind of run comes from, and how many of them the site keeps. */
export const SOURCES = {
  nightly: { workflow: 'nightly.yml', artifact: 'screenshots', keep: 14 },
  weekly: { workflow: 'model-evals.yml', earlierWorkflow: 'ui-sweep.yml', artifact: 'ui-sweep', keep: 4 },
};
const API = 'https://api.github.com';

function pictureCount(count) {
  return count === 1 ? '1 picture' : `${String(count)} pictures`;
}

/** The newest finished runs on main, newest first, at most `keep` of them. */
export function pickRuns({ runs, keep }) {
  return runs
    .filter(entry => entry.status === 'completed' && entry.head_branch === 'main' && entry.conclusion !== 'cancelled')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, keep);
}

/** Every folder under `root` that holds the named file, as paths relative to `root`. */
async function foldersHolding({ root, fileName }) {
  const found = [];
  const visit = async relative => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    if (entries.some(entry => entry.isFile() && entry.name === fileName)) {
      found.push(relative);
      return;
    }
    for (const entry of entries.filter(each => each.isDirectory())) {
      await visit(path.join(relative, entry.name));
    }
  };
  await visit('');
  return found.sort();
}

const PREVIEWS = 3;

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/** The link from a page `folder` levels deep (plus its kind folder) back to the list. */
function homeLink(folder) {
  return '../'.repeat(folder.split('/').length + 1);
}

/** The first picture of each feature set, so a night's card shows a few different screens. */
function nightPreviews(results) {
  if (!Array.isArray(results.feature_sets)) {
    return [];
  }
  return results.feature_sets
    .map(set => set?.features?.flatMap?.(feature => feature?.pictures ?? [])[0]?.file)
    .filter(file => typeof file === 'string')
    .slice(0, PREVIEWS);
}

/**
 * The nightly runs for the list, newest first: folder, picture counts and a few pictures to show. A
 * night that stored its details gets its page written again, so every night has today's look and a
 * link back to the list. A night whose results cannot be read is left off the list.
 */
export async function readNights(root) {
  const nights = [];
  for (const found of await foldersHolding({ root, fileName: 'results.json' })) {
    const results = parsedJson(await readFile(path.join(root, found, 'results.json'), 'utf8'));
    const totals = results?.totals;
    if (!isCount(totals?.pictures) || !isCount(totals?.failed_pictures)) {
      continue;
    }
    const folder = found.split(path.sep).join('/');
    const previews = nightPreviews(results);
    if (previews.length > 0 && isCount(totals.features) && isCount(totals.features_with_a_test)) {
      await writeFile(
        path.join(root, found, 'index.html'),
        galleryHtml({ run: results, title: whenText(folder), home: homeLink(folder) }),
      );
    }
    nights.push({ folder, pictures: totals.pictures, failed_pictures: totals.failed_pictures, previews });
  }
  return nights.sort((a, b) => b.folder.localeCompare(a.folder));
}

const SIZE_NAMES = { desktop: 'Computer', phone: 'Phone', 'small-phone': 'Small phone', 'phone-dark': 'Phone, dark' };

/** The saved notes that are whole: a picture name, a screen, a size and a list of findings in words. */
function usableFindings(saved) {
  if (!Array.isArray(saved)) {
    return [];
  }
  return saved.filter(
    entry =>
      typeof entry?.picture === 'string' &&
      typeof entry.surface === 'string' &&
      typeof entry.size === 'string' &&
      Array.isArray(entry.problems) &&
      entry.problems.every(problem => typeof problem === 'string'),
  );
}

/** The page for one weekly look-over: every picture with the screen, its size and what was found. */
export function sweepHtml({ title, report, pictures, findings, home }) {
  const byPicture = new Map(findings.map(finding => [finding.picture, finding]));
  const card = file => {
    const finding = byPicture.get(file);
    const problems = finding?.problems ?? [];
    const found =
      finding === undefined
        ? 'No notes were saved for this picture.'
        : problems.length === 0
          ? 'Nothing to look at.'
          : `<ul>${problems.map(problem => `<li>${escapeHtml(problem)}</li>`).join('')}</ul>`;
    return cardHtml({
      file,
      alt: file,
      pill:
        problems.length > 0
          ? { text: 'Something to look at', tone: 'bad' }
          : {
              text: finding === undefined ? 'No notes' : 'Looks fine',
              tone: finding === undefined ? undefined : 'good',
            },
      where: finding === undefined ? file : (SIZE_NAMES[finding.size] ?? finding.size),
      heading: finding?.surface ?? null,
      rows: [['What was found', found]],
      bad: problems.length > 0,
      filter: {
        values: {
          result: problems.length > 0 ? 'look' : finding === undefined ? 'unknown' : 'fine',
          size: finding?.size ?? '',
          screen: finding?.surface ?? '',
        },
        search: [finding?.surface ?? file, SIZE_NAMES[finding?.size ?? ''] ?? '', ...problems].join(' '),
      },
    });
  };
  const named = (values, label = value => value) =>
    [...new Set(values)].sort().map(value => ({ value, label: label(value) }));
  const withProblems = pictures.filter(file => (byPicture.get(file)?.problems ?? []).length > 0);
  const fine = pictures.filter(file => !withProblems.includes(file));
  return pageHtml({
    title,
    eyebrow: 'Weekly look-over',
    lead: 'Every screen was opened with made-up data at four sizes. Each one was checked for page errors, failed requests, sideways scrolling, parts that stick out of the window, cut-off words, controls with no name and tap targets that are too small. This is a look, not a test, so nothing here passes or fails.',
    home,
    hidden: true,
    body: `${tilesHtml([
      { value: pictures.length, label: 'pictures' },
      {
        value: withProblems.length,
        label: 'have something to look at',
        tone: withProblems.length > 0 ? 'bad' : undefined,
      },
      { value: fine.length, label: 'look fine', tone: 'good' },
    ])}
${filterHtml({
  placeholder: 'Screen or what was found',
  choices: [
    {
      name: 'result',
      label: 'Result',
      options: [
        { value: 'look', label: 'Something to look at' },
        { value: 'fine', label: 'Looks fine' },
      ],
    },
    {
      name: 'size',
      label: 'Screen size',
      options: named(
        findings.map(finding => finding.size),
        size => SIZE_NAMES[size] ?? size,
      ),
    },
    { name: 'screen', label: 'Screen', options: named(findings.map(finding => finding.surface)) },
  ],
})}
<section><div class="section-head"><h2>Something to look at</h2><p>${pictureCount(withProblems.length)}</p></div>
${withProblems.length > 0 ? `<div class="grid">${withProblems.map(card).join('')}</div>` : '<p class="empty">Nothing this week.</p>'}</section>
<section><div class="section-head"><h2>Looks fine</h2><p>${pictureCount(fine.length)}</p></div>
<div class="grid">${fine.map(card).join('')}</div></section>
<details><summary>The full list as text</summary><pre>${escapeHtml(report)}</pre></details>`,
  });
}

/** Writes a page into each weekly folder and returns the folders, newest first. */
export async function readSweeps(root) {
  const sweeps = [];
  for (const folder of await foldersHolding({ root, fileName: 'report.md' })) {
    const full = path.join(root, folder);
    const pictures = (await readdir(full)).filter(name => name.endsWith('.png')).sort();
    const report = await readFile(path.join(full, 'report.md'), 'utf8');
    const saved = await readFile(path.join(full, 'findings.json'), 'utf8').catch(error => {
      if (error?.code === 'ENOENT') {
        return '[]';
      }
      throw error;
    });
    const name = folder.split(path.sep).join('/');
    await writeFile(
      path.join(full, 'index.html'),
      sweepHtml({
        title: whenText(name),
        report,
        pictures,
        findings: usableFindings(parsedJson(saved)),
        home: homeLink(name),
      }),
    );
    const computer = pictures.filter(file => file.endsWith('-desktop.png'));
    sweeps.push({
      folder: name,
      pictures: pictures.length,
      previews: (computer.length >= PREVIEWS ? computer : pictures).slice(0, PREVIEWS),
    });
  }
  return sweeps.sort((a, b) => b.folder.localeCompare(a.folder));
}

function monthName({ year, month }) {
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleString('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  });
}

/** A run folder as a day and a time: `2026/11/14/1551` or `2026-11-21`. Any other name is the day as it is. */
function whenParts(folder) {
  const night = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})$/.exec(folder);
  if (night !== null) {
    const [, year, month, day, hour, minute] = night;
    return { day: `${String(Number(day))} ${monthName({ year, month })} ${year}`, time: `${hour}:${minute} UTC` };
  }
  const week = /^(\d{4})-(\d{2})-(\d{2})$/.exec(folder);
  if (week !== null) {
    const [, year, month, day] = week;
    return { day: `${String(Number(day))} ${monthName({ year, month })} ${year}`, time: null };
  }
  return { day: folder, time: null };
}

/** `2026/11/14/1551` as `14 Nov 2026, 15:51 UTC` and `2026-11-21` as `21 Nov 2026`. */
export function whenText(folder) {
  const { day, time } = whenParts(folder);
  return time === null ? day : `${day}, ${time}`;
}

function runCard({ kind, run, pills }) {
  const { day, time } = whenParts(run.folder);
  const base = `${kind}/${run.folder}/`;
  const strip =
    run.previews.length > 0
      ? `<div class="strip">${run.previews.map(file => `<img loading="lazy" src="${escapeHtml(base + file)}" alt="">`).join('')}</div>`
      : '';
  return `<a class="card run" href="${escapeHtml(base)}" aria-label="${escapeHtml(whenText(run.folder))}">${strip}<div class="body"><p class="day">${escapeHtml(day)}</p><p class="time">${escapeHtml(time ?? 'Weekly look-over')}</p><div class="top">${pills.map(pillHtml).join('')}</div></div></a>`;
}

/** The front page of the section: every night and every weekly look-over, newest first. */
export function listHtml({ nights, sweeps }) {
  const nightCards = nights.map(night =>
    runCard({
      kind: 'nightly',
      run: night,
      pills: [
        { text: pictureCount(night.pictures) },
        night.failed_pictures > 0
          ? { text: `${String(night.failed_pictures)} from failed tests`, tone: 'bad' }
          : { text: 'No failed tests', tone: 'good' },
      ],
    }),
  );
  const sweepCards = sweeps.map(sweep =>
    runCard({ kind: 'weekly', run: sweep, pills: [{ text: pictureCount(sweep.pictures) }] }),
  );
  const none = '<p class="empty">Nothing is stored yet. Come back after the next run.</p>';
  return pageHtml({
    title: 'Test screenshots',
    eyebrow: 'Aman',
    lead: 'Pictures the automatic tests take of the app, with what each test did and what it should show.',
    hidden: true,
    body: `<section><div class="section-head"><h2>Nightly tests</h2><p>Every screen the tests open, sorted by feature. The last ${String(SOURCES.nightly.keep)} nights are kept.</p></div>
${nightCards.length > 0 ? `<div class="runs">${nightCards.join('')}</div>` : none}</section>
<section><div class="section-head"><h2>Weekly look-over</h2><p>Every screen at computer, phone, small phone and dark phone size, with what looked wrong.</p></div>
${sweepCards.length > 0 ? `<div class="runs">${sweepCards.join('')}</div>` : none}</section>`,
  });
}

/** Talks to GitHub with the workflow's own token. */
export function githubClient({ repository, token, fetchImpl = fetch }) {
  const get = async url => {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      throw new Error(`GitHub answered ${String(response.status)} for ${url}. Check the workflow has "actions: read".`);
    }
    return response;
  };
  return {
    async listRuns(workflow) {
      const response = await get(
        `${API}/repos/${repository}/actions/workflows/${workflow}/runs?branch=main&per_page=40`,
      );
      return (await response.json()).workflow_runs;
    },
    async listArtifacts(runId) {
      const response = await get(`${API}/repos/${repository}/actions/runs/${String(runId)}/artifacts?per_page=100`);
      return (await response.json()).artifacts;
    },
    async downloadZip(artifactId) {
      const response = await get(`${API}/repos/${repository}/actions/artifacts/${String(artifactId)}/zip`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

async function unzipInto({ zip, folder }) {
  const work = await mkdtemp(path.join(tmpdir(), 'aman-shots-'));
  const file = path.join(work, 'pictures.zip');
  try {
    await writeFile(file, zip);
    await mkdir(folder, { recursive: true });
    await run('unzip', ['-q', '-o', file, '-d', folder]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Fetches the stored pictures of one kind of run into `folder`. A run with nothing stored is passed over. */
async function fetchKind({ github, source, folder, unzip }) {
  const runs = [...(await github.listRuns(source.workflow))];
  if (source.earlierWorkflow) {
    runs.push(...(await github.listRuns(source.earlierWorkflow)));
  }
  let collected = 0;
  for (const each of pickRuns({ runs, keep: runs.length })) {
    const stored = (await github.listArtifacts(each.id)).find(
      artifact => artifact.name === source.artifact && !artifact.expired,
    );
    if (stored !== undefined) {
      await unzip({ zip: await github.downloadZip(stored.id), folder });
      collected += 1;
      if (collected === source.keep) break;
    }
  }
}

/**
 * Removes everything under `folder` that is not a plain file or folder. A stored download could hold a
 * link to a file outside it, and publishing follows links.
 */
export async function removeLinks(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      await removeLinks(full);
    } else if (!entry.isFile()) {
      await rm(full, { force: true });
    }
  }
}

/** Fills `<site>/test-screenshots/` and returns what it listed. */
export async function collectScreenshots({ siteDir, github, unzip = unzipInto }) {
  const root = path.join(siteDir, SECTION);
  await rm(root, { recursive: true, force: true });
  for (const [kind, source] of Object.entries(SOURCES)) {
    await mkdir(path.join(root, kind), { recursive: true });
    await fetchKind({ github, source, folder: path.join(root, kind), unzip });
    await removeLinks(path.join(root, kind));
  }
  const nights = await readNights(path.join(root, 'nightly'));
  const sweeps = await readSweeps(path.join(root, 'weekly'));
  await writeFile(path.join(root, 'index.html'), listHtml({ nights, sweeps }));
  return { nights, sweeps };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const siteDir = process.argv[2];
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (siteDir === undefined || siteDir === '') {
    console.error('Name the built site folder: npm run docs:site:screenshots <folder>');
    process.exit(1);
  }
  if (!repository || !token) {
    console.error('Set GITHUB_REPOSITORY and GITHUB_TOKEN so the stored pictures can be fetched.');
    process.exit(1);
  }
  const listed = await collectScreenshots({
    siteDir: path.resolve(siteDir),
    github: githubClient({ repository, token }),
  });
  console.log(
    `Listed ${String(listed.nights.length)} nights and ${String(listed.sweeps.length)} weekly look-overs under ${SECTION}/.`,
  );
}
