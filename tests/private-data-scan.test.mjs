import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanPrivateData } from '../scripts/check-no-private-data.mjs';

function git(root, args, options = {}) {
  // Hooks export parent-repository variables; the fixture must remain an
  // independent repository when this test runs from pre-push.
  const environment = { ...process.env };
  for (const name of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_WORK_TREE',
  ]) {
    Reflect.deleteProperty(environment, name);
  }
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    ...options,
  }).trim();
}

test('tree scan cannot be bypassed by an unstaged working-tree cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'aman-private-data-scan-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.email', 'private-data-test@example.invalid']);
    git(root, ['config', 'user.name', 'Private Data Test']);

    const token = ['ghp', '_', 'a'.repeat(24)].join('');
    writeFileSync(join(root, 'notes.txt'), `credential=${token}\n`);
    git(root, ['add', 'notes.txt']);
    git(root, ['commit', '--quiet', '-m', 'fixture with private data']);
    const pushedHead = git(root, ['rev-parse', 'HEAD']);

    writeFileSync(join(root, 'notes.txt'), 'credential=removed from working tree\n');

    assert.deepEqual(scanPrivateData({ rootDirectory: root }).findings, []);
    assert.deepEqual(scanPrivateData({ rootDirectory: root, treeish: pushedHead }).findings, [
      {
        file: 'notes.txt',
        reasons: ['file content matches GitHub token (ghp_/gho_/ghu_/ghs_/ghr_...)'],
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tree scan preserves distinct slash and literal-backslash paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'aman-private-data-paths-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.email', 'private-data-test@example.invalid']);
    git(root, ['config', 'user.name', 'Private Data Test']);

    const token = ['ghp', '_', 'b'.repeat(24)].join('');
    const sensitiveBlob = git(root, ['hash-object', '-w', '--stdin'], { input: `credential=${token}\n` });
    const benignBlob = git(root, ['hash-object', '-w', '--stdin'], { input: 'credential=removed\n' });
    const nestedTree = git(root, ['mktree', '-z'], {
      input: `100644 blob ${sensitiveBlob}\tpath.txt\0`,
    });
    const rootTree = git(root, ['mktree', '-z'], {
      input: `040000 tree ${nestedTree}\tsafe\0` + `100644 blob ${benignBlob}\tsafe\\path.txt\0`,
    });
    const commit = git(root, ['commit-tree', rootTree], { input: 'path collision fixture\n' });

    assert.deepEqual(scanPrivateData({ rootDirectory: root, treeish: commit }).findings, [
      {
        file: 'safe/path.txt',
        reasons: ['file content matches GitHub token (ghp_/gho_/ghu_/ghs_/ghr_...)'],
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tree scan fails closed on duplicate decoded Git pathnames', () => {
  const root = mkdtempSync(join(tmpdir(), 'aman-private-data-duplicate-paths-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.email', 'private-data-test@example.invalid']);
    git(root, ['config', 'user.name', 'Private Data Test']);

    const token = ['ghp', '_', 'c'.repeat(24)].join('');
    const sensitiveBlob = git(root, ['hash-object', '-w', '--stdin'], { input: `credential=${token}\n` });
    const benignBlob = git(root, ['hash-object', '-w', '--stdin'], { input: 'credential=removed\n' });
    const rootTree = git(root, ['mktree', '-z'], {
      input: `100644 blob ${sensitiveBlob}\tnotes.txt\0` + `100644 blob ${benignBlob}\tnotes.txt\0`,
    });
    const commit = git(root, ['commit-tree', rootTree], { input: 'duplicate path fixture\n' });

    assert.throws(
      () => scanPrivateData({ rootDirectory: root, treeish: commit }),
      /Git tree contains a duplicate pathname \("notes\.txt"\); refusing to scan it/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tree scan fails closed on non-UTF-8 Git pathnames', () => {
  const root = mkdtempSync(join(tmpdir(), 'aman-private-data-non-utf8-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.email', 'private-data-test@example.invalid']);
    git(root, ['config', 'user.name', 'Private Data Test']);

    const token = ['ghp', '_', 'c'.repeat(24)].join('');
    const sensitiveBlob = git(root, ['hash-object', '-w', '--stdin'], { input: `credential=${token}\n` });
    const benignBlob = git(root, ['hash-object', '-w', '--stdin'], { input: 'credential=removed\n' });
    const treeInput = Buffer.concat([
      Buffer.from(`100644 blob ${sensitiveBlob}\t`),
      Buffer.from([0x80]),
      Buffer.from('\0'),
      Buffer.from(`100644 blob ${benignBlob}\t`),
      Buffer.from([0x81]),
      Buffer.from('\0'),
    ]);
    const rootTree = git(root, ['mktree', '-z'], { input: treeInput });
    const commit = git(root, ['commit-tree', rootTree], { input: 'non-UTF-8 path fixture\n' });

    assert.throws(
      () => scanPrivateData({ rootDirectory: root, treeish: commit }),
      /Git tree contains a non-UTF-8 pathname; refusing to scan an ambiguous tree/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
