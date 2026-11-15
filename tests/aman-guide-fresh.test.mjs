import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildAmanGuide } from '../scripts/build-aman-guide.mjs';
import { checkAmanGuideFresh, STALE_PACK_MESSAGE } from '../scripts/check-aman-guide-fresh.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'aman-guide-fresh-test-'));
  const topicsDir = path.join(dir, 'topics');
  await mkdir(topicsDir);
  await mkdir(path.join(dir, 'docs'));
  await writeFile(
    path.join(dir, 'tourPrompts.ts'),
    "export type TourCapabilities = { email: boolean };\nexport const CARDS = { brief: { title: 'Your morning brief' } };\n",
  );
  await writeFile(path.join(dir, 'required-cards.json'), '[]');
  await writeFile(path.join(topicsDir, 'a.md'), '---\nid: a\ntitle: A page\ncovers: brief\n---\nPlain words.\n');
  const buildOptions = {
    tourPath: path.join(dir, 'tourPrompts.ts'),
    topicsDir,
    docsDir: path.join(dir, 'docs'),
    requiredCardsPath: path.join(dir, 'required-cards.json'),
  };
  const committedPath = path.join(dir, 'knowledgePack.generated.ts');
  return { dir, buildOptions, committedPath };
}

test('the committed help pack in this repository is up to date', async () => {
  assert.deepEqual(await checkAmanGuideFresh({ repoRoot }), { fresh: true }, STALE_PACK_MESSAGE);
});

test('a hand-edited pack is stale, and guide:build makes it fresh again', async () => {
  const fx = await fixture();
  try {
    const options = { repoRoot, committedPath: fx.committedPath, buildOptions: fx.buildOptions };
    await buildAmanGuide({ ...fx.buildOptions, repoRoot, outPath: fx.committedPath });
    assert.deepEqual(await checkAmanGuideFresh(options), { fresh: true });

    const built = await readFile(fx.committedPath, 'utf8');
    await writeFile(fx.committedPath, built.replace('Plain words.', 'Edited by hand.'));
    assert.deepEqual(await checkAmanGuideFresh(options), { fresh: false });

    await buildAmanGuide({ ...fx.buildOptions, repoRoot, outPath: fx.committedPath });
    assert.deepEqual(await checkAmanGuideFresh(options), { fresh: true });
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('a topic changed without rebuilding makes the pack stale', async () => {
  const fx = await fixture();
  try {
    const options = { repoRoot, committedPath: fx.committedPath, buildOptions: fx.buildOptions };
    await buildAmanGuide({ ...fx.buildOptions, repoRoot, outPath: fx.committedPath });
    await writeFile(
      path.join(fx.buildOptions.topicsDir, 'a.md'),
      '---\nid: a\ntitle: A page\ncovers: brief\n---\nNew words.\n',
    );
    assert.deepEqual(await checkAmanGuideFresh(options), { fresh: false });
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('a missing pack is stale', async () => {
  const fx = await fixture();
  try {
    const options = { repoRoot, committedPath: fx.committedPath, buildOptions: fx.buildOptions };
    assert.deepEqual(await checkAmanGuideFresh(options), { fresh: false });
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('the stale message says the one thing to do', () => {
  assert.equal(STALE_PACK_MESSAGE, 'The help pack is out of date. Run `pnpm guide:build` and commit the result.');
});
