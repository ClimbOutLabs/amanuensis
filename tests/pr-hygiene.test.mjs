import assert from 'node:assert/strict';
import test from 'node:test';
import { findHygieneProblems, parseAddedLines } from '../scripts/check-pr-hygiene.mjs';

const clean = { body: '## Description\n\nFixes the reply recipient.\n', commits: [], addedLines: [] };

test('a plain description, commit and diff pass', () => {
  assert.deepEqual(
    findHygieneProblems({
      ...clean,
      commits: [{ sha: 'a'.repeat(40), message: 'Fix the reply recipient\n\nUse Reply-To first.\n' }],
      addedLines: [{ file: 'src/a.ts', line: 3, text: "const host = 'claude.ai';" }],
    }),
    [],
  );
});

test('the attribution block and footer in a description fail', () => {
  const body = [
    '<!-- claude-projects-attribution: {"github_login":"someone"} -->',
    '_Requested by **Someone** · [project thread](https://claude.ai/code/project/chan_x?thread=y)_',
    '',
    'Body.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
  const problems = findHygieneProblems({ ...clean, body });
  assert.equal(problems.length, 4);
  assert.ok(problems.every(problem => problem.startsWith('PR description:')));
});

test('assistant trailers in a commit message fail and name the commit', () => {
  const problems = findHygieneProblems({
    ...clean,
    commits: [
      {
        sha: 'b'.repeat(40),
        message:
          'Fix\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01abcdefghijklmnopqrstuvwxyz\n',
      },
    ],
  });
  assert.ok(problems.some(problem => problem.includes('co-author trailer')));
  assert.ok(problems.some(problem => problem.includes('session trailer')));
  assert.ok(problems.every(problem => problem.startsWith(`Commit ${'b'.repeat(12)}`)));
});

test('a human co-author trailer passes', () => {
  assert.deepEqual(
    findHygieneProblems({
      ...clean,
      commits: [{ sha: 'c'.repeat(40), message: 'Fix\n\nCo-Authored-By: Pat Lee <pat@example.com>\n' }],
    }),
    [],
  );
});

test('a project-folder path on an added line fails with its file and line', () => {
  const problems = findHygieneProblems({
    ...clean,
    addedLines: [{ file: 'docs/x.md', line: 12, text: 'See /mnt/project-files/briefs/plan.md' }],
  });
  assert.deepEqual(problems.length, 1);
  assert.match(problems[0], /^docs\/x\.md:12: private project-folder path/);
});

test('this check and its test are not scanned for the patterns they spell out', () => {
  assert.deepEqual(
    findHygieneProblems({
      ...clean,
      addedLines: [{ file: 'scripts/check-pr-hygiene.mjs', line: 1, text: '/mnt/project-files' }],
    }),
    [],
  );
});

test('a privacy or license checklist in the description fails, ticked or not', () => {
  for (const line of [
    '- [x] No Private Info',
    '- [ ] Private data scan passes',
    '* [x] License OK',
    '- [x] No new dependencies with copyleft or AGPL licenses',
    '- [x] Aman is licensed under MPL-2.0; per-file headers are not required',
  ]) {
    const problems = findHygieneProblems({ ...clean, body: `## Testing\n\n${line}\n` });
    assert.equal(problems.length, 1, line);
    assert.match(problems[0], /privacy or license checklist/);
  }
});

test('privacy and license words in ordinary lines and checklist items pass', () => {
  const body = [
    'Moves the license check into CI.',
    '- [x] Docs updated for this change: docs/privacy.md, THIRD_PARTY_NOTICES',
    '- [x] `pnpm test` passes: `pnpm test:licenses`',
  ].join('\n');
  assert.deepEqual(findHygieneProblems({ ...clean, body }), []);
});

test('added lines carry the file and the line they land on', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,0 +2,2 @@',
    '+second',
    '+third',
    '@@ -9 +11 @@',
    '-old',
    '+new',
    'diff --git a/gone.txt b/gone.txt',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');
  assert.deepEqual(parseAddedLines(diff), [
    { file: 'a.txt', line: 2, text: 'second' },
    { file: 'a.txt', line: 3, text: 'third' },
    { file: 'a.txt', line: 11, text: 'new' },
  ]);
});
