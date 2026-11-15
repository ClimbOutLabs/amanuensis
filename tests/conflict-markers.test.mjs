import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { conflictMarkerLines, scanConflictMarkers } from '../scripts/check-conflict-markers.mjs';

// Built at run time, so this file never holds a line the check itself would flag.
const OURS = `${'<'.repeat(7)} HEAD`;
const BASE = `${'|'.repeat(7)} base`;
const MIDDLE = '='.repeat(7);
const THEIRS = `${'>'.repeat(7)} other-branch`;

test('finds each marker line of an unfinished merge, with its line number', () => {
  const text = ['# Title', OURS, 'ours', BASE, 'base', MIDDLE, 'theirs', THEIRS, ''].join('\n');
  assert.deepEqual(conflictMarkerLines(text), [
    { line: 2, text: OURS },
    { line: 4, text: BASE },
    { line: 8, text: THEIRS },
  ]);
});

test('finds a marker a Markdown formatter put a backslash in front of, and one with Windows line ends', () => {
  assert.deepEqual(conflictMarkerLines(`\\${OURS}\n`), [{ line: 1, text: `\\${OURS}` }]);
  assert.deepEqual(conflictMarkerLines(`${THEIRS}\r\nnext\r\n`), [{ line: 1, text: THEIRS }]);
});

test('leaves ordinary text alone', () => {
  const text = [
    'Heading',
    MIDDLE,
    `  ${OURS}`,
    `${'<'.repeat(8)} eight is not a marker`,
    `${'<'.repeat(6)} nor is six`,
    'a << b >> c',
    '',
  ].join('\n');
  assert.deepEqual(conflictMarkerLines(text), []);
});

function git(root, args) {
  // Hooks export the parent repository's variables; the fixture must stay its own repository.
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GIT_')) {
      Reflect.deleteProperty(environment, name);
    }
  }
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: environment });
}

test('scans tracked text files only: not untracked files, not binary files', () => {
  const root = mkdtempSync(join(tmpdir(), 'conflict-markers-'));
  try {
    git(root, ['init', '--quiet']);
    writeFileSync(join(root, 'clean.md'), '# Fine\n');
    writeFileSync(join(root, 'broken.md'), `intro\n${OURS}\nours\n${MIDDLE}\ntheirs\n${THEIRS}\n`);
    writeFileSync(join(root, 'picture.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`\n${OURS}\n`)]));
    git(root, ['add', 'clean.md', 'broken.md', 'picture.bin']);
    writeFileSync(join(root, 'untracked.md'), `${OURS}\n`);
    assert.deepEqual(scanConflictMarkers(root), [
      { file: 'broken.md', line: 2, text: OURS },
      { file: 'broken.md', line: 6, text: THEIRS },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('this repository has no conflict markers', () => {
  assert.deepEqual(scanConflictMarkers(join(import.meta.dirname, '..')), []);
});
