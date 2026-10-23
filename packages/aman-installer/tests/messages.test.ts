import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  COMPOSE_MISSING,
  DOCKER_NOT_ANSWERING,
  DOCKER_NOT_INSTALLED,
  DOCKER_NOT_RUNNING,
  ENGINE_VERSION_MISSING,
  LOW_MEMORY,
  MEMORY_NOT_REPORTED,
  NOT_INSTALLED,
  STATE_BUSY,
  STATE_UNREADABLE,
  UNKNOWN_DOCTOR_CHECK,
  allMessageLines,
  problemText,
  unknownCommandProblem,
  type Problem,
} from '../src/messages.ts';

const JARGON: readonly string[] = [
  'socket',
  'daemon',
  'sudo',
  'path',
  'container',
  'volume',
  'wsl',
  'exit code',
  'stack trace',
  'permission denied',
  'port',
  'tls',
  'certificate chain',
];

function wordCount(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

function sentenceCount(text: string): number {
  return text.split('. ').filter(part => part.trim().length > 0).length;
}

function allProblems(): Problem[] {
  const problems: Problem[] = [
    ENGINE_VERSION_MISSING,
    UNKNOWN_DOCTOR_CHECK,
    unknownCommandProblem('example'),
    NOT_INSTALLED,
    STATE_UNREADABLE,
    STATE_BUSY,
  ];
  for (const record of [
    DOCKER_NOT_INSTALLED,
    DOCKER_NOT_RUNNING,
    COMPOSE_MISSING,
    LOW_MEMORY,
    MEMORY_NOT_REPORTED,
    DOCKER_NOT_ANSWERING,
  ]) {
    problems.push(record.windows, record.darwin, record.linux);
  }
  return problems;
}

test('every problem says what happened and the one thing to do', () => {
  for (const problem of allProblems()) {
    assert.ok(problem.happened.endsWith('.'), problem.happened);
    assert.equal(sentenceCount(problem.happened), 1, problem.happened);
    assert.ok(problem.fix.endsWith('.'), problem.fix);
    assert.equal(sentenceCount(problem.fix), 1, problem.fix);
    assert.ok(wordCount(problemText(problem)) <= 40, problemText(problem));
  }
});

test('no message uses a word from the jargon list', () => {
  for (const line of allMessageLines()) {
    const lower = line.toLowerCase();
    for (const word of JARGON) {
      const pattern = new RegExp(`\\b${word}\\b`);
      assert.ok(!pattern.test(lower), `"${line}" uses "${word}"`);
    }
    assert.ok(wordCount(line) <= 40, line);
    assert.ok(!line.includes('\u2014'), line);
  }
});

// The plan's fourth message rule: a message that names a file path must
// also name the Start menu entry or the folder the person would use, so a
// later stage cannot add a path message without this test firing.
function namesFilePath(text: string): boolean {
  return /(?:[A-Za-z]:\\|\\\\|~\/|\/[\w.-]+\/|\.exe\b|\.cmd\b)/.test(text);
}

test('a message that names a file path also names the Start menu or a folder', () => {
  for (const line of allMessageLines()) {
    if (namesFilePath(line)) {
      assert.ok(line.includes('Start menu') || line.includes('folder'), line);
    }
  }
});

test('the golden file holds every message', () => {
  const golden = readFileSync(new URL('./golden/messages.txt', import.meta.url), 'utf8');
  assert.equal(`${allMessageLines().join('\n')}\n`, golden);
});
