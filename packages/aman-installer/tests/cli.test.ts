import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCli } from '../src/cli.ts';
import { FakeHost } from '../src/host/fakeHost.ts';
import { HELP_LINES, problemText, UNKNOWN_DOCTOR_CHECK, unknownCommandProblem } from '../src/messages.ts';
import {
  okResult,
  RecordingProcessRunner,
  StubProcessRunner,
  type ProcessResult,
} from '../src/runner/processRunner.ts';

const GIB = 1024 * 1024 * 1024;

function makeCli(answers: Map<string, ProcessResult>) {
  const printed: string[] = [];
  const deps = {
    host: new FakeHost({ kind: 'linux', memoryBytes: 16 * GIB }),
    runner: new RecordingProcessRunner(new StubProcessRunner(answers)),
    print: (line: string) => {
      printed.push(line);
    },
  };
  return { deps, printed };
}

test('--version prints the version and nothing else', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['--version'], deps);
  assert.equal(exitCode, 0);
  assert.deepEqual(printed, ['aman 0.1.0']);
});

test('no command prints what aman can do', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli([], deps);
  assert.equal(exitCode, 0);
  assert.deepEqual(printed, [...HELP_LINES]);
});

test('doctor docker passes on a ready computer', async () => {
  const answers = new Map<string, ProcessResult>([
    ['docker --version', okResult('Docker version 27.3.1, build 0a1b2c3\n')],
    ['docker info --format {{.ServerVersion}}', okResult('27.3.1\n')],
    ['docker compose version', okResult('Docker Compose version v2.29.1\n')],
    ['docker info --format {{.MemTotal}}', okResult(`${String(8 * GIB)}\n`)],
  ]);
  const { deps, printed } = makeCli(answers);
  const exitCode = await runCli(['doctor', 'docker'], deps);
  assert.equal(exitCode, 0);
  assert.equal(printed[printed.length - 1], 'Docker is ready for Aman on this computer.');
});

test('an unknown doctor check gets one plain line', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['doctor', 'weather'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(UNKNOWN_DOCTOR_CHECK)]);
});

test('an unknown command gets one plain line', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['dance'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(unknownCommandProblem('dance'))]);
});
