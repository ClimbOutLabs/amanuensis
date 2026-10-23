import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RecordingProcessRunner,
  StubProcessRunner,
  SystemProcessRunner,
  commandLine,
  okResult,
} from '../../src/runner/processRunner.ts';

test('a command line joins the command and its arguments', () => {
  assert.equal(commandLine('docker', ['info', '--format', '{{.MemTotal}}']), 'docker info --format {{.MemTotal}}');
});

test('an argument with a space is quoted', () => {
  assert.equal(commandLine('tool', ['two words']), 'tool "two words"');
});

test('the stub answers only the command lines it was given', async () => {
  const stub = new StubProcessRunner(new Map([['docker --version', okResult('Docker version 27.3.1\n')]]));
  const found = await stub.run('docker', ['--version']);
  assert.equal(found.exitCode, 0);
  assert.equal(found.stdout, 'Docker version 27.3.1\n');
  const missing = await stub.run('docker', ['info']);
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.started, false);
});

test('the recording runner writes down every command line in order', async () => {
  const stub = new StubProcessRunner(
    new Map([
      ['docker --version', okResult('Docker version 27.3.1\n')],
      ['docker info', okResult('')],
    ]),
  );
  const recording = new RecordingProcessRunner(stub);
  await recording.run('docker', ['--version']);
  await recording.run('docker', ['info']);
  assert.deepEqual(recording.lines(), ['docker --version', 'docker info']);
  assert.equal(recording.goldenText(), 'docker --version\ndocker info\n');
});

test('the system runner really runs a program', async () => {
  const runner = new SystemProcessRunner();
  const result = await runner.run(process.execPath, ['--version']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.started, true);
  assert.ok(result.stdout.startsWith('v'));
});
