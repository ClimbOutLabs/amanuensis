import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_POLICIES,
  GROUPS,
  loadTokenSet,
  parseTokenSet,
  TokenSetError,
} from '../scripts/eval-tokens/parse.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realSetPath = path.join(rootDir, 'packages', 'trueforge', 'evals', 'token-set.json');
const fixtureSetPath = path.join(rootDir, 'tests', 'fixtures', 'eval-tokens', 'token-set.json');

function validSet() {
  return {
    version: 1,
    prompts: Array.from({ length: 18 }, (_, index) => ({
      id: `p-${String(index + 1).padStart(2, '0')}`,
      group: GROUPS[index % GROUPS.length],
      prompt: `Prompt ${String(index + 1)}`,
      approval_policy: APPROVAL_POLICIES[index % APPROVAL_POLICIES.length],
      checklist: ['One', 'Two', 'Three'],
    })),
  };
}

function problemsOf(value) {
  try {
    parseTokenSet(value);
  } catch (error) {
    assert.ok(error instanceof TokenSetError, 'expected a TokenSetError');
    return error.problems;
  }
  assert.fail('expected the set to be rejected');
}

test('every eval page link in the real set names a page in the fixture folder', async () => {
  const set = await loadTokenSet(realSetPath);
  const pagesDir = path.join(path.dirname(realSetPath), 'fixtures', 'pages');
  let links = 0;
  for (const prompt of set.prompts) {
    for (const [, name] of prompt.prompt.matchAll(/https:\/\/fixtures\.aman\.invalid\/([a-z0-9-]+)/g)) {
      links += 1;
      assert.ok(
        existsSync(path.join(pagesDir, `${name}.md`)),
        `${prompt.id} links to a page that is not in the folder: ${name}`,
      );
    }
  }
  assert.equal(links, 1);
});

test('the real token-set.json parses: 18 prompts, unique ids, valid policies and checklists', async () => {
  const set = await loadTokenSet(realSetPath);
  assert.equal(set.version, 1);
  assert.equal(set.prompts.length, 18);
  assert.equal(new Set(set.prompts.map(prompt => prompt.id)).size, 18);
  for (const prompt of set.prompts) {
    assert.ok(GROUPS.includes(prompt.group), `${prompt.id} group`);
    assert.ok(APPROVAL_POLICIES.includes(prompt.approval_policy), `${prompt.id} policy`);
    assert.ok(prompt.checklist.length >= 3 && prompt.checklist.length <= 5, `${prompt.id} checklist size`);
  }
});

test('the fixture set used by the fake-instance test parses', async () => {
  const set = await loadTokenSet(fixtureSetPath);
  assert.equal(set.prompts.length, 18);
});

test('a valid set is returned in normalized form', () => {
  const set = parseTokenSet(validSet());
  assert.equal(set.prompts[0].id, 'p-01');
  assert.deepEqual(set.prompts[0].checklist, ['One', 'Two', 'Three']);
});

test('rejects a wrong version, a wrong prompt count, and a non-object file', () => {
  const wrongVersion = { ...validSet(), version: 2 };
  assert.ok(problemsOf(wrongVersion).some(problem => problem.includes('version must be 1')));
  const short = validSet();
  short.prompts.pop();
  assert.ok(problemsOf(short).some(problem => problem.includes('expected 18 prompts, found 17')));
  assert.throws(() => parseTokenSet([]), TokenSetError);
});

test('rejects duplicate ids, unknown groups, bad policies and bad checklist sizes, listing every problem', () => {
  const broken = validSet();
  broken.prompts[1].id = broken.prompts[0].id;
  broken.prompts[2].group = 'mystery';
  broken.prompts[3].approval_policy = 'maybe';
  broken.prompts[4].checklist = ['Only one'];
  broken.prompts[5].checklist = ['1', '2', '3', '4', '5', '6'];
  const problems = problemsOf(broken);
  assert.ok(problems.some(problem => problem.includes('"p-01" is used more than once')));
  assert.ok(problems.some(problem => problem.includes('prompts[2] (p-03).group')));
  assert.ok(problems.some(problem => problem.includes('approval_policy')));
  assert.ok(problems.some(problem => problem.includes('checklist must have 3 to 5 items')));
});

test('an unreadable or invalid JSON file fails with the cause kept', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-tokens-set-'));
  try {
    const file = path.join(dir, 'token-set.json');
    await writeFile(file, '{ not json');
    await assert.rejects(loadTokenSet(file), error => {
      assert.ok(error instanceof TokenSetError);
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    });
    await assert.rejects(loadTokenSet(path.join(dir, 'missing.json')), error => {
      assert.ok(error.message.includes('Check the --set path'));
      assert.ok(error.cause !== undefined);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
