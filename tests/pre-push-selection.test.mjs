import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyChanges, pushedHeadFromInput, readGitVisibleWorktreeChanges } from '../scripts/pre-push-selection.mjs';

test('selects package, format, and lint checks from changed paths', () => {
  const selection = classifyChanges([
    'packages/frontend/src/App.tsx',
    'packages/trueforge/src/schemas/session.ts',
    'packages/trueforge-sdk/src/Client.ts',
  ]);

  assert.deepEqual([...selection.packageDirectories].sort(), ['frontend', 'trueforge', 'trueforge-sdk']);
  assert.deepEqual(selection.formatFiles, [
    'packages/frontend/src/App.tsx',
    'packages/trueforge/src/schemas/session.ts',
    'packages/trueforge-sdk/src/Client.ts',
  ]);
  assert.deepEqual(selection.lintFiles, [
    'packages/frontend/src/App.tsx',
    'packages/trueforge/src/schemas/session.ts',
    'packages/trueforge-sdk/src/Client.ts',
  ]);
  assert.equal(selection.broadChecks, true);
  assert.equal(selection.prePushPolicy, false);
});

test('normalizes Windows paths', () => {
  const selection = classifyChanges(['packages\\trueforge-sdk\\src\\Client.ts']);

  assert.deepEqual([...selection.packageDirectories], ['trueforge-sdk']);
});

test('reads clean, staged, untracked, and ignored Git-visible worktree boundaries', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'amanuensis-pre-push-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  // A hook's repository environment must not redirect fixture writes into the real checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = args => execFileSync('git', args, { cwd, env });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(cwd, '.gitignore'), 'cache/\n');
  writeFileSync(join(cwd, 'dependency.ts'), 'export const value = 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  assert.deepEqual(readGitVisibleWorktreeChanges({ cwd, env }), []);

  writeFileSync(join(cwd, 'dependency.ts'), 'export const value = 2;\n');
  writeFileSync(join(cwd, 'new-source.ts'), 'export const source = true;\n');
  mkdirSync(join(cwd, 'cache'));
  writeFileSync(join(cwd, 'cache', 'ignored.js'), 'ignored();\n');
  assert.deepEqual(readGitVisibleWorktreeChanges({ cwd, env }).sort(), ['dependency.ts', 'new-source.ts']);
  git(['add', 'dependency.ts']);
  assert.deepEqual(readGitVisibleWorktreeChanges({ cwd, env }).sort(), ['dependency.ts', 'new-source.ts']);
});

test("selects the policy's own tests when the hook implementation changes", () => {
  const selection = classifyChanges(['scripts/pre-push.mjs']);

  assert.equal(selection.prePushPolicy, true);
  assert.equal(selection.broadChecks, false);
});

test('unknown base forces broader checks but does not invent changed paths', () => {
  const selection = classifyChanges([], { baseAvailable: false });

  assert.equal(selection.broadChecks, true);
});

test('accepts only pushed refs that resolve to the checked-out HEAD', () => {
  const head = 'a'.repeat(40);
  const deleted = '0'.repeat(40);

  assert.equal(pushedHeadFromInput({ input: '', head }), head);
  assert.equal(pushedHeadFromInput({ input: `refs/heads/topic ${head} refs/heads/topic ${deleted}\n`, head }), head);
  assert.equal(pushedHeadFromInput({ input: `(delete) ${deleted} refs/heads/old ${head}\n`, head }), null);
  assert.throws(
    () =>
      pushedHeadFromInput({
        input: `refs/heads/other ${'b'.repeat(40)} refs/heads/other ${deleted}\n`,
        head,
      }),
    /only validates the checked-out HEAD/u,
  );
  assert.throws(() => pushedHeadFromInput({ input: 'malformed', head }), /invalid pre-push input/u);
});
