import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildGallery } from '../scripts/build-nightly-gallery.mjs';
import { defaultSources, readSurfaces } from '../scripts/check-help-coverage.mjs';
import { COVERAGE_FILE, checkNightlyCoverage, surfaceFileName } from '../scripts/check-nightly-coverage.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_SURFACES = ['route:session', 'settings:models'];
const CHAT_TEST = 'tests/chat.test.ts';

function goodMap() {
  return {
    feature_sets: { chat: 'Chat', models: 'Models' },
    screens: { 'screen:chat-layout': 'The chat screen.' },
    surfaces: {
      'route:session': { set: 'chat', tests: [CHAT_TEST] },
      'screen:chat-layout': { set: 'chat', tests: [CHAT_TEST] },
      'settings:models': { set: 'models', tests: [] },
    },
    not_yet: ['settings:models'],
  };
}

/** A small repository with a coverage map and one test file that names two features. */
async function withRepo({ map, testText = "shot('route:session'); shot('screen:chat-layout');" }, run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nightly-coverage-'));
  try {
    await mkdir(path.join(dir, 'tests'));
    await writeFile(path.join(dir, COVERAGE_FILE), JSON.stringify(map));
    await writeFile(path.join(dir, CHAT_TEST), testText);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function problemsFor(input) {
  return withRepo(
    input,
    async dir => (await checkNightlyCoverage({ repoRoot: dir, codeSurfaces: CODE_SURFACES })).problems,
  );
}

test('this repository passes its own coverage check', async () => {
  const result = await checkNightlyCoverage({
    repoRoot,
    codeSurfaces: await readSurfaces(defaultSources(repoRoot)),
  });
  assert.deepEqual(result.problems, []);
  assert.ok(result.covered > 0 && result.covered <= result.total);
});

test('a complete map passes and counts features with a test', async () => {
  await withRepo({ map: goodMap() }, async dir => {
    const result = await checkNightlyCoverage({ repoRoot: dir, codeSurfaces: CODE_SURFACES });
    assert.deepEqual(result.problems, []);
    assert.equal(result.total, 3);
    assert.equal(result.covered, 2);
    assert.deepEqual(result.sets, [
      { id: 'chat', name: 'Chat', total: 2, covered: 2 },
      { id: 'models', name: 'Models', total: 1, covered: 0 },
    ]);
  });
});

test('a feature the code gained must get a row', async () => {
  const problems = await withRepo(
    { map: goodMap() },
    async dir =>
      (await checkNightlyCoverage({ repoRoot: dir, codeSurfaces: [...CODE_SURFACES, 'route:voice'] })).problems,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"route:voice" has no row/);
});

test('a row for a feature that is gone must be removed', async () => {
  const map = goodMap();
  map.surfaces['route:old'] = { set: 'chat', tests: [CHAT_TEST] };
  assert.match((await problemsFor({ map }))[0], /"route:old" is not a feature any more/);
});

test('a feature with no test must be listed in not_yet, and only then', async () => {
  const missing = goodMap();
  missing.not_yet = [];
  assert.match((await problemsFor({ map: missing }))[0], /"settings:models" has no test/);

  const both = goodMap();
  both.not_yet.push('route:session');
  assert.match((await problemsFor({ map: both }))[0], /"route:session" has a test and is also in not_yet/);
});

test('a named test must exist and must mention the feature', async () => {
  const gone = goodMap();
  gone.surfaces['route:session'].tests = ['tests/missing.test.ts'];
  assert.match((await problemsFor({ map: gone }))[0], /tests\/missing\.test\.ts, which does not exist/);

  const silent = await problemsFor({ map: goodMap(), testText: "shot('screen:chat-layout');" });
  assert.match(silent[0], /tests\/chat\.test\.ts never mentions "route:session"/);

  // A longer id that starts the same way is another feature, not a mention of this one.
  const longer = await problemsFor({
    map: goodMap(),
    testText: "shot('route:sessionFolder'); shot('screen:chat-layout');",
  });
  assert.match(longer[0], /never mentions "route:session"/);
});

test('feature sets must be real, used, and safe as folder names', async () => {
  const unknown = goodMap();
  unknown.surfaces['route:session'].set = 'talk';
  assert.match((await problemsFor({ map: unknown }))[0], /feature set "talk", which is not listed/);

  const unused = goodMap();
  unused.feature_sets.voice = 'Voice';
  assert.match((await problemsFor({ map: unused }))[0], /Feature set "voice" has no feature/);

  const unsafe = goodMap();
  unsafe.feature_sets['Chat Room'] = 'Chat room';
  assert.match((await problemsFor({ map: unsafe }))[0], /"Chat Room" is a folder name/);
});

test('a map with the wrong shape says what shape it needs', async () => {
  await withRepo({ map: { feature_sets: {}, surfaces: [] } }, async dir => {
    await assert.rejects(
      checkNightlyCoverage({ repoRoot: dir, codeSurfaces: CODE_SURFACES }),
      /must hold feature_sets as \{ id: name \}/,
    );
  });
});

test('the contact sheet groups pictures by feature set and puts failures first', async () => {
  await withRepo({ map: goodMap() }, async dir => {
    const folder = path.join(dir, 'shots');
    await mkdir(path.join(folder, 'chat'), { recursive: true });
    const session = surfaceFileName('route:session');
    const layout = surfaceFileName('screen:chat-layout');
    await writeFile(path.join(folder, 'chat', `${session}--reply-shown.png`), '');
    await writeFile(path.join(folder, 'chat', `${layout}--FAILED-page-1.png`), '');
    await writeFile(path.join(folder, 'chat', 'stray.png'), '');

    const run = await buildGallery({ folder, repoRoot: dir, title: 'Run <1>' });
    assert.deepEqual(run.totals, { features: 3, features_with_a_test: 2, pictures: 2, failed_pictures: 1 });
    assert.deepEqual(run.unknown_files, ['chat/stray.png']);
    const chat = run.feature_sets.find(set => set.id === 'chat');
    assert.deepEqual(chat.features, [
      {
        id: 'route:session',
        has_test: true,
        pictures: [{ file: `chat/${session}--reply-shown.png`, step: 'reply-shown', failed: false }],
      },
      {
        id: 'screen:chat-layout',
        has_test: true,
        pictures: [{ file: `chat/${layout}--FAILED-page-1.png`, step: 'page-1', failed: true }],
      },
    ]);

    const html = await readFile(path.join(folder, 'index.html'), 'utf8');
    assert.ok(html.includes('<title>Run &lt;1&gt;</title>'), 'the title is escaped');
    assert.ok(html.indexOf('>Failed<') < html.indexOf('<section id="chat">'), 'failures come first');
    assert.ok(html.includes('No test yet: settings:models'), 'features with no test are listed');
    assert.ok(!html.includes('http'), 'the page loads nothing from outside');
    const results = JSON.parse(await readFile(path.join(folder, 'results.json'), 'utf8'));
    assert.equal(results.title, 'Run <1>');
    assert.deepEqual(results.totals, run.totals);
  });
});
