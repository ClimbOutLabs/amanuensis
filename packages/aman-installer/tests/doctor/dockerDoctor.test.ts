import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkDocker } from '../../src/doctor/dockerDoctor.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import type { SystemKind } from '../../src/host/host.ts';
import {
  COMPOSE_MISSING,
  DOCKER_NOT_INSTALLED,
  DOCKER_NOT_RUNNING,
  ENGINE_VERSION_MISSING,
  LOW_MEMORY,
  MEMORY_NOT_REPORTED,
  problemText,
} from '../../src/messages.ts';
import {
  RecordingProcessRunner,
  StubProcessRunner,
  okResult,
  type ProcessResult,
} from '../../src/runner/processRunner.ts';

const GIB = 1024 * 1024 * 1024;

function failedResult(): ProcessResult {
  return { exitCode: 1, stdout: '', stderr: '', started: true };
}

function goodAnswers(memoryBytes: number): Map<string, ProcessResult> {
  return new Map<string, ProcessResult>([
    ['docker --version', okResult('Docker version 27.3.1, build 0a1b2c3\n')],
    ['docker info --format {{.ServerVersion}}', okResult('27.3.1\n')],
    ['docker compose version', okResult('Docker Compose version v2.29.1\n')],
    ['docker info --format {{.MemTotal}}', okResult(`${String(memoryBytes)}\n`)],
  ]);
}

function runDoctor(options: { kind: SystemKind; answers: Map<string, ProcessResult> }) {
  const printed: string[] = [];
  const recording = new RecordingProcessRunner(new StubProcessRunner(options.answers));
  const deps = {
    host: new FakeHost({ kind: options.kind, memoryBytes: 16 * GIB }),
    runner: recording,
    print: (line: string) => {
      printed.push(line);
    },
  };
  return { deps, printed, recording };
}

test('a ready computer passes every check and runs the golden command lines', async () => {
  const { deps, printed, recording } = runDoctor({ kind: 'linux', answers: goodAnswers(8 * GIB) });
  const exitCode = await checkDocker(deps);
  assert.equal(exitCode, 0);
  assert.deepEqual(printed, [
    'Docker is installed, version 27.3.1.',
    'Docker is running, Engine version 27.3.1.',
    'Docker Compose is ready, version 2.29.1.',
    'Docker has 8 GB of memory to work with, which is enough.',
    'Docker is ready for Aman on this computer.',
  ]);
  const golden = readFileSync(new URL('../golden/doctor-docker-commands.txt', import.meta.url), 'utf8');
  assert.equal(recording.goldenText(), golden);
});

test('no Docker on Windows says so in Windows words and stops', async () => {
  const { deps, printed, recording } = runDoctor({ kind: 'windows', answers: new Map() });
  const exitCode = await checkDocker(deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(DOCKER_NOT_INSTALLED.windows)]);
  assert.ok(printed[0]?.includes('Docker Desktop'));
  assert.deepEqual(recording.lines(), ['docker --version']);
});

test('Docker stopped on a Mac says how to start it', async () => {
  const answers = goodAnswers(8 * GIB);
  answers.set('docker info --format {{.ServerVersion}}', failedResult());
  const { deps, printed } = runDoctor({ kind: 'darwin', answers });
  const exitCode = await checkDocker(deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, ['Docker is installed, version 27.3.1.', problemText(DOCKER_NOT_RUNNING.darwin)]);
  assert.ok(printed[1]?.includes('Launchpad'));
});

test('a missing Compose tool on Linux is the third check', async () => {
  const answers = goodAnswers(8 * GIB);
  answers.set('docker compose version', failedResult());
  const { deps, printed } = runDoctor({ kind: 'linux', answers });
  const exitCode = await checkDocker(deps);
  assert.equal(exitCode, 1);
  assert.equal(printed[2], problemText(COMPOSE_MISSING.linux));
});

test('low memory on Windows names Settings and Resources', async () => {
  const { deps, printed } = runDoctor({ kind: 'windows', answers: goodAnswers(4 * GIB) });
  const exitCode = await checkDocker(deps);
  assert.equal(exitCode, 1);
  const last = printed[printed.length - 1];
  assert.equal(last, problemText(LOW_MEMORY.windows));
  assert.ok(last?.includes('Settings'));
  assert.ok(last?.includes('Resources'));
});

test('low memory on a Mac names Docker Desktop, not its settings pages', async () => {
  const { deps, printed } = runDoctor({ kind: 'darwin', answers: goodAnswers(4 * GIB) });
  const exitCode = await checkDocker(deps);
  assert.equal(exitCode, 1);
  const last = printed[printed.length - 1];
  assert.equal(last, problemText(LOW_MEMORY.darwin));
  assert.ok(last?.includes('Docker Desktop'));
  assert.ok(!(last?.includes('Resources') ?? true));
});

test('Docker that does not report an Engine version fails that check, after Compose and memory', async () => {
  const answers = goodAnswers(8 * GIB);
  answers.set('docker info --format {{.ServerVersion}}', okResult('\n'));
  const { deps, printed } = runDoctor({ kind: 'linux', answers });
  const exitCode = await checkDocker(deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [
    'Docker is installed, version 27.3.1.',
    'Docker Compose is ready, version 2.29.1.',
    'Docker has 8 GB of memory to work with, which is enough.',
    problemText(ENGINE_VERSION_MISSING),
  ]);
});

test('Docker that does not report its memory on Windows fails instead of counting the whole computer', async () => {
  const answers = goodAnswers(8 * GIB);
  answers.set('docker info --format {{.MemTotal}}', okResult('\n'));
  // The fake host reports 16 GB of computer memory, so the old silent
  // fallback to the host total would have passed this check.
  const { deps, printed } = runDoctor({ kind: 'windows', answers });
  const exitCode = await checkDocker(deps);
  assert.equal(exitCode, 1);
  const last = printed[printed.length - 1];
  assert.equal(last, problemText(MEMORY_NOT_REPORTED.windows));
});

test('on Linux a memory Docker does not report falls back to the computer memory', async () => {
  const answers = goodAnswers(8 * GIB);
  answers.set('docker info --format {{.MemTotal}}', okResult('\n'));
  // Docker Engine on Linux uses the computer's memory directly, and the
  // fake host reports 16 GB, so the check passes on the host total.
  const { deps, printed } = runDoctor({ kind: 'linux', answers });
  const exitCode = await checkDocker(deps);
  assert.equal(exitCode, 0);
  assert.ok(printed.includes('Docker has 16 GB of memory to work with, which is enough.'));
});
