import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli } from '../src/cli.ts';
import { FakeHost } from '../src/host/fakeHost.ts';
import { FakeWindowsJobs } from '../src/host/fakeWindowsJobs.ts';
import {
  ADOPT_NOT_WINDOWS,
  HELP_LINES,
  NOT_INSTALLED,
  OPEN_NOT_WINDOWS,
  problemText,
  UNKNOWN_DOCTOR_CHECK,
  unknownCommandProblem,
  UPGRADE_NOT_WINDOWS,
} from '../src/messages.ts';
import {
  okResult,
  RecordingProcessRunner,
  StubProcessRunner,
  type ProcessResult,
} from '../src/runner/processRunner.ts';
import { folderBackend } from '../src/state/folderBackend.ts';
import { createStateStore } from '../src/state/state.ts';

const GIB = 1024 * 1024 * 1024;
let homeCounter = 0;

function makeCli(answers: Map<string, ProcessResult>) {
  const printed: string[] = [];
  homeCounter += 1;
  const home = join(tmpdir(), `aman-cli-empty-${String(process.pid)}-${String(homeCounter)}`);
  const deps = {
    host: new FakeHost({ kind: 'linux', memoryBytes: 16 * GIB }),
    runner: new RecordingProcessRunner(new StubProcessRunner(answers)),
    store: createStateStore(folderBackend(home)),
    print: (line: string) => {
      printed.push(line);
    },
    now: () => 1791633600,
    homeDir: home,
    stateHome: home,
    osReleasePath: join(home, 'os-release'),
    dockerConfigDir: join(home, '.docker'),
    appService: 'app',
    windowsJobs: new FakeWindowsJobs({
      localAppDataDir: 'C:\\Users\\Friend\\AppData\\Local',
      selfExePath: 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
      startMenuProgramsDir: 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
    }),
    probeHealth: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
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

test('doctor on an empty home with no Docker prints the plain report', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['doctor'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [
    '',
    'Checking this computer',
    'Docker is not installed.',
    'Next: Install Docker Desktop (macOS, Windows) or Docker Engine with Compose 2 (Linux), then run aman doctor.',
    'Skipped: Docker is not reachable. (runtime)',
    'Skipped: Docker is not reachable. (images, disk, docker_memory, clock)',
    'No instances yet; nothing to back up.',
    '',
    '1 problem.',
    'Run the Next command for each, then run aman doctor again.',
  ]);
});

test('doctor --json on an empty home prints the checks as data', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['doctor', '--json'], deps);
  assert.equal(exitCode, 1);
  assert.equal(printed.length, 1);
  const skipped = { state: 'off', detail: 'Skipped: Docker is not reachable.', fix: '' };
  assert.deepEqual(JSON.parse(printed[0] ?? ''), {
    machine: [
      {
        id: 'docker',
        state: 'fail',
        detail: 'Docker is not installed.',
        fix: 'Install Docker Desktop (macOS, Windows) or Docker Engine with Compose 2 (Linux), then run aman doctor.',
      },
      { id: 'runtime', ...skipped },
      { id: 'credentials', state: 'ok', detail: 'No Docker settings file, so no credential store is in use.', fix: '' },
      { id: 'images', ...skipped },
      { id: 'disk', ...skipped },
      { id: 'docker_memory', ...skipped },
      { id: 'clock', ...skipped },
      { id: 'backup', state: 'ok', detail: 'No instances yet; nothing to back up.', fix: '' },
    ],
    instances: {},
  });
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

test('status on a computer with nothing installed prints the not-installed problem', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['status'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(NOT_INSTALLED)]);
});

test('doctor --local runs the doctor instead of refusing the flag', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['doctor', '--local'], deps);
  assert.equal(exitCode, 1);
  assert.ok(!printed.includes(problemText(UNKNOWN_DOCTOR_CHECK)));
  assert.ok(printed.includes('Checking this computer'));
});

test('doctor --json --local prints the checks as data, in either order', async () => {
  for (const args of [
    ['doctor', '--json', '--local'],
    ['doctor', '--local', '--json'],
  ]) {
    const { deps, printed } = makeCli(new Map());
    const exitCode = await runCli(args, deps);
    assert.equal(exitCode, 1);
    assert.equal(printed.length, 1);
    const doc: unknown = JSON.parse(printed[0] ?? '');
    assert.ok(typeof doc === 'object' && doc !== null && 'machine' in doc);
  }
});

test('upgrade refuses plainly where it cannot run', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['upgrade'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(UPGRADE_NOT_WINDOWS)]);
});

test('adopt on a computer that is not Windows refuses with its problem', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['adopt'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(ADOPT_NOT_WINDOWS)]);
});

test('open on a computer that is not Windows refuses with its problem', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['open'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(OPEN_NOT_WINDOWS)]);
});
