import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ADOPT_DOCKER_NOT_ANSWERING,
  ADOPT_IMAGE_UNAVAILABLE,
  ADOPT_NOT_INSTALLED,
  ADOPT_NOT_WINDOWS,
  ADOPT_SETUP_FAILED,
  ADOPT_STATE_UNREADABLE,
  COMPOSE_MISSING,
  DOCKER_NOT_ANSWERING,
  DOCKER_NOT_INSTALLED,
  DOCKER_NOT_RUNNING,
  ENGINE_TOO_OLD,
  ENGINE_VERSION_MISSING,
  LOW_MEMORY,
  MEMORY_NOT_REPORTED,
  NETWORK_ADDRESS_MISSING,
  NETWORK_BUSY,
  NETWORK_CLOSE_FAILED,
  NETWORK_DOCKER_NOT_ANSWERING,
  NETWORK_FIREWALL_CLOSE_FAILED,
  NETWORK_FIREWALL_OPEN_FAILED,
  NETWORK_IMAGE_UNAVAILABLE,
  NETWORK_NOT_INSTALLED,
  NETWORK_NOT_WINDOWS,
  NETWORK_NO_ADDRESS,
  NETWORK_OPEN_FAILED,
  NETWORK_STATE_UNREADABLE,
  NETWORK_USAGE,
  NOT_INSTALLED,
  OPEN_ADDRESS_MISSING,
  OPEN_CERT_MISSING,
  OPEN_DID_NOT_ANSWER,
  OPEN_DOCKER_DID_NOT_START,
  OPEN_DOCKER_MISSING,
  OPEN_IMAGE_UNAVAILABLE,
  OPEN_NOT_INSTALLED,
  OPEN_NOT_WINDOWS,
  OPEN_STATE_UNREADABLE,
  OPEN_TRUST_FAILED,
  STATE_BUSY,
  STATE_IMAGE_UNAVAILABLE,
  STATE_UNREADABLE,
  UNKNOWN_DOCTOR_CHECK,
  UPGRADE_BUSY,
  UPGRADE_CONTAINER_FAILED,
  UPGRADE_DOCKER_NOT_ANSWERING,
  UPGRADE_DOWNLOAD_FAILED,
  UPGRADE_NEW_PROGRAM_WAITING,
  UPGRADE_NOT_PUT_BACK,
  UPGRADE_NOT_WINDOWS,
  UPGRADE_OLD_PROGRAM_NOT_BACK,
  UPGRADE_PROGRAM_MISSING,
  UPGRADE_REPLACE_FAILED,
  UPGRADE_ROLLED_BACK,
  UPGRADE_SMOKE_FAILED,
  UPGRADE_SOURCE_FAILED,
  UPGRADE_SOURCE_MISSING,
  VERIFY_DOWNLOAD_UNREADABLE,
  VERIFY_MANIFEST_MISSING,
  VERIFY_MANIFEST_UNREADABLE,
  VERIFY_SIGNATURE_BAD,
  VERIFY_SIGNATURE_MISSING,
  VERIFY_SOURCE_IDS_MISMATCH,
  VERIFY_USAGE,
  allMessageLines,
  openBrowserFailedProblem,
  problemText,
  unknownCommandProblem,
  upgradeNotReadyProblem,
  verifyChangedProblem,
  verifyNotListedProblem,
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
    STATE_IMAGE_UNAVAILABLE,
    VERIFY_USAGE,
    VERIFY_MANIFEST_MISSING,
    VERIFY_SIGNATURE_MISSING,
    VERIFY_MANIFEST_UNREADABLE,
    VERIFY_SIGNATURE_BAD,
    VERIFY_DOWNLOAD_UNREADABLE,
    verifyNotListedProblem('aman-linux-x64'),
    verifyChangedProblem('aman-linux-x64'),
    VERIFY_SOURCE_IDS_MISMATCH,
    ADOPT_NOT_WINDOWS,
    ADOPT_NOT_INSTALLED,
    ADOPT_DOCKER_NOT_ANSWERING,
    ADOPT_IMAGE_UNAVAILABLE,
    ADOPT_STATE_UNREADABLE,
    ADOPT_SETUP_FAILED,
    OPEN_NOT_WINDOWS,
    OPEN_NOT_INSTALLED,
    OPEN_DOCKER_MISSING,
    OPEN_DOCKER_DID_NOT_START,
    OPEN_IMAGE_UNAVAILABLE,
    OPEN_STATE_UNREADABLE,
    OPEN_ADDRESS_MISSING,
    OPEN_DID_NOT_ANSWER,
    OPEN_CERT_MISSING,
    OPEN_TRUST_FAILED,
    openBrowserFailedProblem('http://127.0.0.1:8791'),
    UPGRADE_NOT_WINDOWS,
    UPGRADE_PROGRAM_MISSING,
    UPGRADE_SOURCE_MISSING,
    UPGRADE_DOWNLOAD_FAILED,
    upgradeNotReadyProblem('Run aman doctor'),
    UPGRADE_SMOKE_FAILED,
    UPGRADE_REPLACE_FAILED,
    UPGRADE_NEW_PROGRAM_WAITING,
    UPGRADE_OLD_PROGRAM_NOT_BACK,
    UPGRADE_SOURCE_FAILED,
    UPGRADE_DOCKER_NOT_ANSWERING,
    UPGRADE_BUSY,
    UPGRADE_ROLLED_BACK,
    UPGRADE_NOT_PUT_BACK,
    UPGRADE_CONTAINER_FAILED,
    NETWORK_USAGE,
    NETWORK_NOT_WINDOWS,
    NETWORK_NOT_INSTALLED,
    NETWORK_IMAGE_UNAVAILABLE,
    NETWORK_STATE_UNREADABLE,
    NETWORK_ADDRESS_MISSING,
    NETWORK_NO_ADDRESS,
    NETWORK_DOCKER_NOT_ANSWERING,
    NETWORK_BUSY,
    NETWORK_OPEN_FAILED,
    NETWORK_CLOSE_FAILED,
    NETWORK_FIREWALL_OPEN_FAILED,
    NETWORK_FIREWALL_CLOSE_FAILED,
  ];
  for (const record of [
    DOCKER_NOT_INSTALLED,
    DOCKER_NOT_RUNNING,
    COMPOSE_MISSING,
    LOW_MEMORY,
    MEMORY_NOT_REPORTED,
    DOCKER_NOT_ANSWERING,
    ENGINE_TOO_OLD,
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
