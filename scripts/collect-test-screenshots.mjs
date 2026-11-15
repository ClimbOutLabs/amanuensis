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

const run = promisify(execFile);

export const SECTION = 'test-screenshots';
/** Where each kind of run comes from, and how many of them the site keeps. */
export const SOURCES = {
  nightly: { workflow: 'nightly.yml', artifact: 'screenshots', keep: 14 },
  weekly: { workflow: 'ui-sweep.yml', artifact: 'ui-sweep', keep: 4 },
};
const API = 'https://api.github.com';

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

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

/** One nightly run on the list: its folder, when it ran and how many pictures came from failed tests. */
export async function readNights(root) {
  const nights = [];
  for (const folder of await foldersHolding({ root, fileName: 'results.json' })) {
    const results = JSON.parse(await readFile(path.join(root, folder, 'results.json'), 'utf8'));
    nights.push({
      folder: folder.split(path.sep).join('/'),
      pictures: results.totals.pictures,
      failed_pictures: results.totals.failed_pictures,
    });
  }
  return nights.sort((a, b) => b.folder.localeCompare(a.folder));
}

/** The page for one weekly look-over: what it found, then every picture it took. */
export function sweepHtml({ title, report, pictures, home }) {
  const figures = pictures.map(
    file =>
      `<figure><a href="${escapeHtml(file)}"><img loading="lazy" src="${escapeHtml(file)}" alt="${escapeHtml(file)}"></a><figcaption>${escapeHtml(file.slice(0, -'.png'.length))}</figcaption></figure>`,
  );
  return page({
    title,
    body: `<p><a href="${escapeHtml(home)}">All test screenshots</a></p>
<h2>What it found</h2>
<pre>${escapeHtml(report)}</pre>
<h2>${pictureCount(pictures.length)}</h2>
<div class="grid">${figures.join('')}</div>`,
  });
}

/** Writes a page into each weekly folder and returns the folders, newest first. */
export async function readSweeps(root) {
  const sweeps = [];
  for (const folder of await foldersHolding({ root, fileName: 'report.md' })) {
    const full = path.join(root, folder);
    const pictures = (await readdir(full)).filter(name => name.endsWith('.png')).sort();
    const report = await readFile(path.join(full, 'report.md'), 'utf8');
    const name = folder.split(path.sep).join('/');
    const home = '../'.repeat(name.split('/').length + 1);
    await writeFile(
      path.join(full, 'index.html'),
      sweepHtml({ title: `Weekly look-over ${name}`, report, pictures, home }),
    );
    sweeps.push({ folder: name, pictures: pictures.length });
  }
  return sweeps.sort((a, b) => b.folder.localeCompare(a.folder));
}

function page({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --soft: #5c5c5c; --line: #d9d9d9; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #ededed; --soft: #a3a3a3; --line: #3a3a3a; --bad: #ff8a80; } }
body { margin: 0 auto; max-width: 75rem; padding: 1rem; background: var(--bg); color: var(--fg); font: 1rem/1.5 system-ui, sans-serif; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 0.5rem; border-top: 0.0625rem solid var(--line); padding-top: 1rem; }
p { margin: 0.25rem 0; color: var(--soft); }
a { color: inherit; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 0.5rem 0; border-bottom: 0.0625rem solid var(--line); display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
li span { color: var(--soft); }
.bad { color: var(--bad); font-weight: 600; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 0.875rem/1.5 ui-monospace, monospace; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
figure { margin: 0; border: 0.0625rem solid var(--line); border-radius: 0.5rem; overflow: hidden; }
img { display: block; width: 100%; height: 12rem; object-fit: cover; object-position: top; background: var(--line); }
figcaption { padding: 0.5rem; font-size: 0.8125rem; overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;
}

/** `2026/11/14/1551` as `14 Nov 2026, 15:51 UTC`; any other folder name is shown as it is. */
export function whenText(folder) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})$/.exec(folder);
  if (match === null) {
    return folder;
  }
  const [, year, month, day, hour, minute] = match;
  const monthName = new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleString('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  });
  return `${String(Number(day))} ${monthName} ${year}, ${hour}:${minute} UTC`;
}

/** The front page of the section: every night and every weekly look-over, newest first. */
export function listHtml({ nights, sweeps }) {
  const nightRows = nights.map(night => {
    const failed =
      night.failed_pictures > 0
        ? `<span class="bad">${String(night.failed_pictures)} from failed tests</span>`
        : '<span>all tests that took pictures passed</span>';
    return `<li><a href="nightly/${escapeHtml(night.folder)}/">${escapeHtml(whenText(night.folder))}</a><span>${pictureCount(night.pictures)}</span>${failed}</li>`;
  });
  const sweepRows = sweeps.map(
    sweep =>
      `<li><a href="weekly/${escapeHtml(sweep.folder)}/">${escapeHtml(whenText(sweep.folder))}</a><span>${pictureCount(sweep.pictures)}</span></li>`,
  );
  const none = '<p>Nothing is stored yet. Come back after the next run.</p>';
  return page({
    title: 'Aman test screenshots',
    body: `<p>Pictures the automatic tests take of the app. Everything shown is made-up test data.</p>
<h2>Nightly tests</h2>
<p>Every screen the tests open, sorted by feature. The last ${String(SOURCES.nightly.keep)} nights are kept.</p>
${nightRows.length > 0 ? `<ul>${nightRows.join('')}</ul>` : none}
<h2>Weekly look-over</h2>
<p>Every screen at computer, phone, small phone and dark phone size, with what looked wrong.</p>
${sweepRows.length > 0 ? `<ul>${sweepRows.join('')}</ul>` : none}`,
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
  const runs = pickRuns({ runs: await github.listRuns(source.workflow), keep: source.keep });
  for (const each of runs) {
    const stored = (await github.listArtifacts(each.id)).find(
      artifact => artifact.name === source.artifact && !artifact.expired,
    );
    if (stored !== undefined) {
      await unzip({ zip: await github.downloadZip(stored.id), folder });
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
