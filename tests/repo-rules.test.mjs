import assert from 'node:assert/strict';
import test from 'node:test';
import { findRepoRuleProblems } from '../scripts/check-repo-rules.mjs';

function check(contents) {
  return findRepoRuleProblems({
    files: Object.keys(contents),
    readText: file => contents[file] ?? '',
  });
}

test('a tree that follows the rules passes', () => {
  assert.deepEqual(
    check({
      'AGENTS.md': 'rules',
      'packages/a/src/thing.ts': '',
      'packages/a/tests/thing.test.ts': '',
      'packages/a/src/store/AGENTS.md': 'rules',
      'packages/a/src/store/CLAUDE.md': '@AGENTS.md\n',
    }),
    [],
  );
});

test('a test under src fails', () => {
  const problems = check({ 'packages/a/src/thing.test.ts': '', 'packages/a/src/__tests__/x.ts': '' });
  assert.equal(problems.length, 2);
});

test('a nested AGENTS.md without a CLAUDE.md, or with other text in it, fails', () => {
  assert.equal(check({ 'packages/a/AGENTS.md': 'rules' }).length, 1);
  assert.match(
    check({ 'packages/a/AGENTS.md': 'rules', 'packages/a/CLAUDE.md': '@AGENTS.md\nmore\n' })[0],
    /must contain only @AGENTS\.md/,
  );
});

test('a changeset file fails', () => {
  assert.match(check({ '.changeset/brave-owls.md': '---\n---\n' })[0], /changeset/);
});
