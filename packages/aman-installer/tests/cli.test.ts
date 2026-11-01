import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli } from '../src/cli.ts';
import { FakeHost } from '../src/host/fakeHost.ts';
import { FakeWindowsJobs } from '../src/host/fakeWindowsJobs.ts';
import {
  ADOPT_NOT_WINDOWS,
  ADOPTED_LINE,
  HELP_LINES,
  INSTALL_KEY_ON_COMMAND_LINE,
  INSTALL_NOT_WINDOWS,
  installUsageProblem,
  NETWORK_NOT_WINDOWS,
  NETWORK_USAGE,
  NOT_INSTALLED,
  OPEN_NOT_WINDOWS,
  problemText,
  UNKNOWN_DOCTOR_CHECK,
  unknownCommandProblem,
  UPGRADE_DOWNLOAD_FAILED,
  UPGRADE_NOT_WINDOWS,
} from '../src/messages.ts';
import type { FetchBytesResult } from '../src/release/download.ts';
import {
  okResult,
  RecordingProcessRunner,
  StubProcessRunner,
  type ProcessResult,
} from '../src/runner/processRunner.ts';
import { folderBackend } from '../src/state/folderBackend.ts';
import { createStateStore, parseRegistry, type StateStore, type StateSummary } from '../src/state/state.ts';

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

test('network open on a computer that is not Windows refuses with its problem', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['network', 'open'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(NETWORK_NOT_WINDOWS)]);
});

test('network with no word after it prints its usage problem', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['network'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(NETWORK_USAGE)]);
});

test('install on a computer that is not Windows refuses with its problem', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['install'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(INSTALL_NOT_WINDOWS)]);
});

test('install refuses the model key on the command line', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['install', '--token-factory-key', 'a-key typed here'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(INSTALL_KEY_ON_COMMAND_LINE)]);
});

test('install refuses a word it does not know', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['install', '--force'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(installUsageProblem('--force'))]);
});

test('setup on a computer with nothing installed routes to the first install', async () => {
  const { deps, printed } = makeCli(new Map());
  const exitCode = await runCli(['setup'], deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(INSTALL_NOT_WINDOWS)]);
});

// A store that reports a starter install on the computer: one
// instance, no release record read through this side.
function starterSummary(): StateSummary {
  return {
    release: null,
    releaseUnreadable: false,
    previousRelease: null,
    instances: [{ name: 'main', entries: parseRegistry('name=main\napp_port=8791\n') }],
    backups: [],
    backupEntries: [],
    backupsMode: null,
    backupsModeTimeSeconds: null,
    certificateAuthority: { certPresent: false, keyMode: null, fingerprint: null, fingerprintHasContent: false },
    sourceCheckout: null,
    installedAppImage: null,
  };
}

class StarterStore implements StateStore {
  readSummary(): Promise<StateSummary> {
    return Promise.resolve(starterSummary());
  }

  readCaCertificate(): Promise<string | null> {
    return Promise.resolve(null);
  }

  refreshCache(): void {
    // This store holds nothing back: every read answers afresh.
  }

  writeInstance(): Promise<boolean> {
    return Promise.resolve(false);
  }

  setInstanceValue(): Promise<boolean> {
    return Promise.resolve(false);
  }

  removeInstance(): Promise<void> {
    return Promise.resolve();
  }

  writeRelease(): Promise<boolean> {
    return Promise.resolve(false);
  }

  setBackupsMode(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

// A Windows computer with a starter install: the aman command's
// folder is named, and the program itself is in it only when the test
// says the install has been adopted already. Downloads answer
// nothing, so a command that goes looking for a release stops there.
async function makeWindowsCli(options: { programInPlace: boolean }) {
  const printed: string[] = [];
  homeCounter += 1;
  const home = join(tmpdir(), `aman-cli-windows-${String(process.pid)}-${String(homeCounter)}`);
  const programsDir = await mkdtemp(join(tmpdir(), 'aman-cli-programs-'));
  if (options.programInPlace) {
    await writeFile(join(programsDir, 'aman.exe'), 'the aman program');
  }
  const deps = {
    host: new FakeHost({ kind: 'windows', memoryBytes: 16 * GIB }),
    runner: new RecordingProcessRunner(new StubProcessRunner(new Map())),
    store: new StarterStore(),
    print: (line: string) => {
      printed.push(line);
    },
    now: () => 1791633600,
    homeDir: home,
    stateHome: null,
    osReleasePath: join(home, 'os-release'),
    dockerConfigDir: join(home, '.docker'),
    appService: 'app',
    windowsJobs: new FakeWindowsJobs({
      localAppDataDir: 'C:\\Users\\Friend\\AppData\\Local',
      selfExePath: 'C:\\Users\\Friend\\Downloads\\Aman-Setup.exe',
      startMenuProgramsDir: 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
    }),
    probeHealth: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
    programsDir,
    fetchBytes: (): Promise<FetchBytesResult> => Promise.resolve({ unreachable: true }),
    confirm: () => Promise.resolve(true),
    arch: 'x64',
  };
  return { deps, printed };
}

test('setup on a computer with the program in place routes to the upgrade', async () => {
  const { deps, printed } = await makeWindowsCli({ programInPlace: true });
  const exitCode = await runCli(['setup'], deps);
  // The upgrade looks for the newest release and stops at the
  // download: the adopt and install routes print neither of these.
  assert.equal(exitCode, 1);
  assert.deepEqual(printed, [problemText(UPGRADE_DOWNLOAD_FAILED)]);
});

test('setup on a computer with a starter install routes to adopt', async () => {
  const { deps, printed } = await makeWindowsCli({ programInPlace: false });
  const exitCode = await runCli(['setup'], deps);
  assert.equal(exitCode, 0);
  assert.deepEqual(printed, [ADOPTED_LINE]);
  assert.equal(deps.windowsJobs.backupTask, true);
});
