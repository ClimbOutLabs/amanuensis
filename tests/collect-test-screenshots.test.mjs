import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectScreenshots, pickRuns, SECTION, SOURCES, whenText } from '../scripts/collect-test-screenshots.mjs';

function finishedRun({ id, day }) {
  return {
    id,
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    created_at: `2026-11-${day}T09:17:00Z`,
  };
}

/** A stand-in for GitHub: each run's stored pictures are the files a real download would unpack. */
function standInGithub({ runs, stored }) {
  const asked = [];
  return {
    asked,
    github: {
      listRuns: async workflow => runs[workflow] ?? [],
      listArtifacts: async runId =>
        stored[runId]?.map(entry => ({ id: entry.id, name: entry.name, expired: false })) ?? [],
      downloadZip: async artifactId => {
        asked.push(artifactId);
        return artifactId;
      },
    },
    unzip: async ({ zip, folder }) => {
      const entry = Object.values(stored)
        .flat()
        .find(each => each.id === zip);
      for (const [file, text] of Object.entries(entry.files)) {
        await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
        await writeFile(path.join(folder, file), text);
      }
    },
  };
}

function nightFiles({ folder, pictures, failed }) {
  return {
    [`${folder}/index.html`]: '<h1>contact sheet</h1>',
    [`${folder}/results.json`]: JSON.stringify({ totals: { pictures, failed_pictures: failed } }),
    [`${folder}/chat/screen-chat--open.png`]: 'png',
  };
}

test('only finished runs on main are kept, newest first, up to the limit', () => {
  const runs = [
    finishedRun({ id: 1, day: '10' }),
    finishedRun({ id: 2, day: '12' }),
    { ...finishedRun({ id: 3, day: '13' }), status: 'in_progress' },
    { ...finishedRun({ id: 4, day: '14' }), head_branch: 'some-branch' },
    { ...finishedRun({ id: 5, day: '15' }), conclusion: 'cancelled' },
    finishedRun({ id: 6, day: '11' }),
  ];
  assert.deepEqual(
    pickRuns({ runs, keep: 2 }).map(run => run.id),
    [2, 6],
  );
});

test('a run folder reads as a date and time', () => {
  assert.equal(whenText('2026/11/14/1551'), '14 Nov 2026, 15:51 UTC');
  assert.equal(whenText('2026-11-21'), '2026-11-21');
});

test('the section lists every stored night and weekly look-over, newest first', async () => {
  const siteDir = await mkdtemp(path.join(tmpdir(), 'aman-site-'));
  const { github, unzip } = standInGithub({
    runs: {
      [SOURCES.nightly.workflow]: [finishedRun({ id: 11, day: '13' }), finishedRun({ id: 12, day: '14' })],
      [SOURCES.weekly.workflow]: [finishedRun({ id: 21, day: '14' })],
    },
    stored: {
      11: [{ id: 101, name: 'screenshots', files: nightFiles({ folder: '2026/11/13/1715', pictures: 40, failed: 2 }) }],
      12: [
        { id: 102, name: 'screenshots', files: nightFiles({ folder: '2026/11/14/1551', pictures: 41, failed: 0 }) },
        { id: 103, name: 'something-else', files: { 'other.txt': 'not pictures' } },
      ],
      21: [
        {
          id: 201,
          name: 'ui-sweep',
          files: {
            '2026-11-14/report.md':
              '# What the look-over found\n\n2 screens were opened. <b>0</b> have something to look at.\n',
            '2026-11-14/chat-desktop.png': 'png',
            '2026-11-14/chat-phone.png': 'png',
          },
        },
      ],
    },
  });

  const listed = await collectScreenshots({ siteDir, github, unzip });

  assert.deepEqual(
    listed.nights.map(night => night.folder),
    ['2026/11/14/1551', '2026/11/13/1715'],
  );
  const front = await readFile(path.join(siteDir, SECTION, 'index.html'), 'utf8');
  assert.ok(front.indexOf('14 Nov 2026, 15:51 UTC') < front.indexOf('13 Nov 2026, 17:15 UTC'), 'newest night first');
  assert.match(front, /href="nightly\/2026\/11\/13\/1715\/".*40 pictures.*2 from failed tests/);
  assert.match(front, /href="weekly\/2026-11-14\/".*2 pictures/);
  assert.match(front, /noindex/);
  assert.equal(
    await readFile(path.join(siteDir, SECTION, 'nightly/2026/11/14/1551/index.html'), 'utf8'),
    '<h1>contact sheet</h1>',
    'a night keeps its own contact sheet',
  );
  const sweep = await readFile(path.join(siteDir, SECTION, 'weekly/2026-11-14/index.html'), 'utf8');
  assert.match(sweep, /href="\.\.\/\.\.\/"/, 'links back to the list');
  assert.match(sweep, /src="chat-desktop\.png"/);
  assert.match(sweep, /&lt;b&gt;0&lt;\/b&gt;/, 'the report is shown as text, not as markup');
});

test('with nothing stored the page still builds and says so', async () => {
  const siteDir = await mkdtemp(path.join(tmpdir(), 'aman-site-'));
  const { github, unzip, asked } = standInGithub({ runs: {}, stored: {} });

  const listed = await collectScreenshots({ siteDir, github, unzip });

  assert.deepEqual(listed, { nights: [], sweeps: [] });
  assert.deepEqual(asked, []);
  assert.match(await readFile(path.join(siteDir, SECTION, 'index.html'), 'utf8'), /Nothing is stored yet/);
});

test('a link inside stored pictures is dropped, so nothing outside them is published', async () => {
  const siteDir = await mkdtemp(path.join(tmpdir(), 'aman-site-'));
  const outside = path.join(await mkdtemp(path.join(tmpdir(), 'aman-outside-')), 'private.txt');
  await writeFile(outside, 'not for the site');
  const { github, unzip } = standInGithub({
    runs: { [SOURCES.nightly.workflow]: [finishedRun({ id: 11, day: '14' })] },
    stored: {
      11: [{ id: 101, name: 'screenshots', files: nightFiles({ folder: '2026/11/14/1551', pictures: 1, failed: 0 }) }],
    },
  });
  const night = path.join(siteDir, SECTION, 'nightly/2026/11/14/1551');
  const unzipWithLinks = async ({ zip, folder }) => {
    await unzip({ zip, folder });
    await symlink(outside, path.join(night, 'chat', 'linked.png'));
    await symlink(path.dirname(outside), path.join(night, 'linked-folder'));
  };

  await collectScreenshots({ siteDir, github, unzip: unzipWithLinks });

  await assert.rejects(lstat(path.join(night, 'chat', 'linked.png')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(night, 'linked-folder')), { code: 'ENOENT' });
  assert.equal(await readFile(outside, 'utf8'), 'not for the site', 'the file outside is left alone');
  assert.equal(await readFile(path.join(night, 'chat/screen-chat--open.png'), 'utf8'), 'png');
});
