import assert from 'node:assert/strict';
import test from 'node:test';
import { countLines, findFileSizeProblems, isCheckedFile, LINE_LIMIT } from '../scripts/check-file-sizes.mjs';

function check({ sizes, baseline = {} }) {
  return findFileSizeProblems({
    files: Object.keys(sizes),
    countLinesOf: file => sizes[file] ?? 0,
    baseline,
  });
}

test('lines are counted the way an editor numbers them', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n\n'), 3);
});

test('tests, generated and vendored files are not checked', () => {
  assert.equal(isCheckedFile('packages/a/src/thing.ts'), true);
  assert.equal(isCheckedFile('ops/sidecar/src/server.mjs'), true);
  assert.equal(isCheckedFile('packages/a/tests/thing.test.ts'), false);
  assert.equal(isCheckedFile('packages/a/test/helpers.tsx'), false);
  assert.equal(isCheckedFile('packages/a/src/knowledgePack.generated.ts'), false);
  assert.equal(isCheckedFile('packages/trueforge-sdk/src/api/Client.ts'), false);
  assert.equal(isCheckedFile('mcp/gmail/src/tools.ts'), false);
  assert.equal(isCheckedFile('packages/a/src/sandbox/vendor/patch.ts'), false);
  assert.equal(isCheckedFile('demo/fixtures/mailbox/generate.mjs'), false);
  assert.equal(isCheckedFile('README.md'), false);
});

test('a tree within the limit passes', () => {
  const { problems } = check({ sizes: { 'packages/a/src/small.ts': LINE_LIMIT } });
  assert.deepEqual(problems, []);
});

test('a new file over the limit fails', () => {
  const { problems } = check({ sizes: { 'packages/a/src/big.ts': LINE_LIMIT + 1 } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /over the 1000-line limit/);
});

test('a grandfathered file at its listed size passes, and growing fails', () => {
  const baseline = { 'packages/a/src/big.ts': 3000 };
  assert.deepEqual(check({ sizes: { 'packages/a/src/big.ts': 3000 }, baseline }).problems, []);
  const grown = check({ sizes: { 'packages/a/src/big.ts': 3001 }, baseline });
  assert.match(grown.problems[0], /grew from 3000 to 3001/);
  assert.deepEqual(grown.updatedBaseline, baseline);
});

test('a grandfathered file that shrank passes, and the tidy lowers its number', () => {
  const { problems, notes, updatedBaseline } = check({
    sizes: { 'packages/a/src/big.ts': 2500 },
    baseline: { 'packages/a/src/big.ts': 3000 },
  });
  assert.deepEqual(problems, []);
  assert.match(notes[0], /shrank from 3000 to 2500/);
  assert.deepEqual(updatedBaseline, { 'packages/a/src/big.ts': 2500 });
});

test('a grandfathered file under the limit, or gone, passes, and the tidy takes it off the list', () => {
  const { problems, notes, updatedBaseline } = check({
    sizes: { 'packages/a/src/split.ts': 400 },
    baseline: { 'packages/a/src/split.ts': 3000, 'packages/a/src/deleted.ts': 2000 },
  });
  assert.deepEqual(problems, []);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /under the limit/);
  assert.match(notes[1], /no longer checked/);
  assert.deepEqual(updatedBaseline, {});
});
