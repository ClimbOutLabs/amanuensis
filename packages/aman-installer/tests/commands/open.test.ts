import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runOpen } from '../../src/commands/open.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs, type FakeWindowsJobStep } from '../../src/host/fakeWindowsJobs.ts';
import {
  OPEN_ADDRESS_MISSING,
  OPEN_DID_NOT_ANSWER,
  OPEN_DOCKER_DID_NOT_START,
  OPEN_DOCKER_MISSING,
  OPEN_NOT_INSTALLED,
  OPEN_NOT_WINDOWS,
  openBrowserFailedProblem,
  openReadyLine,
  problemText,
} from '../../src/messages.ts';
import {
  commandLine,
  okResult,
  type ProcessBytesResult,
  type ProcessResult,
  type ProcessRunner,
} from '../../src/runner/processRunner.ts';
import { parseRegistry, type StateStore, type StateSummary } from '../../src/state/state.ts';

const FAILED: ProcessResult = { exitCode: 1, stdout: '', stderr: '', started: false };
const NOT_THERE: ProcessResult = { exitCode: 1, stdout: '', stderr: '', started: false };

const INFO_LINE = commandLine('docker', ['info', '--format', '{{.ServerVersion}}']);
const VERSION_LINE = commandLine('docker', ['--version']);

// A runner whose Docker answers on a script: the version always answers,
// and info fails a set number of times before it answers.
class DockerRunner implements ProcessRunner {
  private infoFailures: number;
  private readonly installed: boolean;

  constructor(options: { infoFailures?: number; installed?: boolean } = {}) {
    this.infoFailures = options.infoFailures ?? 0;
    this.installed = options.installed ?? true;
  }

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    const line = commandLine(command, args);
    if (line === VERSION_LINE) {
      return Promise.resolve(this.installed ? okResult('Docker version 28.0.0, build abc\n') : NOT_THERE);
    }
    if (line === INFO_LINE) {
      if (this.infoFailures > 0) {
        this.infoFailures -= 1;
        return Promise.resolve(FAILED);
      }
      return Promise.resolve(okResult('28.0.0\n'));
    }
    return Promise.resolve(NOT_THERE);
  }

  runBytes(): Promise<ProcessBytesResult> {
    return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false });
  }
}

function summaryWith(instances: StateSummary['instances']): StateSummary {
  return {
    release: null,
    releaseUnreadable: false,
    previousRelease: null,
    instances,
    backups: [],
    backupEntries: [],
    backupsMode: null,
    backupsModeTimeSeconds: null,
    certificateAuthority: { certPresent: false, keyMode: null, fingerprint: null, fingerprintHasContent: false },
    sourceCheckout: null,
    installedAppImage: null,
  };
}

function storeWith(summary: StateSummary): StateStore {
  return {
    readSummary: () => Promise.resolve(summary),
    writeInstance: () => Promise.resolve(false),
    setInstanceValue: () => Promise.resolve(false),
    removeInstance: () => Promise.resolve(),
    writeRelease: () => Promise.resolve(false),
    setBackupsMode: () => Promise.resolve(false),
  };
}

function jobsWith(failSteps: ReadonlySet<FakeWindowsJobStep> = new Set()): FakeWindowsJobs {
  return new FakeWindowsJobs({
    localAppDataDir: 'C:\\Users\\Friend\\AppData\\Local',
    selfExePath: 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
    startMenuProgramsDir: 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
    failSteps,
  });
}

async function run(options: {
  runner: DockerRunner;
  store: StateStore;
  jobs: FakeWindowsJobs;
  healthy?: boolean;
  kind?: 'windows' | 'linux';
}): Promise<{ code: number; lines: string[]; probes: string[] }> {
  const lines: string[] = [];
  const probes: string[] = [];
  let clock = 1_000_000;
  const code = await runOpen({
    host: new FakeHost({ kind: options.kind ?? 'windows', memoryBytes: 8 * 1024 ** 3 }),
    runner: options.runner,
    store: options.store,
    jobs: options.jobs,
    print: line => {
      lines.push(line);
    },
    now: () => clock,
    probeHealth: (url: string) => {
      probes.push(url);
      return Promise.resolve(options.healthy ?? true);
    },
    sleep: (ms: number) => {
      clock += ms / 1000;
      return Promise.resolve();
    },
  });
  return { code, lines, probes };
}

const MAIN_AT_8792 = summaryWith([
  { name: 'main', entries: parseRegistry('name=main\napp_port=8792\npublic_url=http://127.0.0.1:8792\n') },
]);

test('open waits for the health check at the recorded port and opens the browser there', async () => {
  const jobs = jobsWith();
  const { code, lines, probes } = await run({ runner: new DockerRunner(), store: storeWith(MAIN_AT_8792), jobs });
  assert.equal(code, 0);
  assert.deepEqual(probes, ['http://127.0.0.1:8792/healthz']);
  assert.deepEqual(jobs.browserUrls, ['http://127.0.0.1:8792']);
  assert.deepEqual(lines, [openReadyLine('http://127.0.0.1:8792')]);
  assert.equal(jobs.dockerDesktopStarts, 0);
});

test('open falls back to the recorded public address when there is no app port', async () => {
  const jobs = jobsWith();
  const summary = summaryWith([
    { name: 'main', entries: parseRegistry('name=main\npublic_url=http://127.0.0.1:8793\n') },
  ]);
  const { code, probes } = await run({ runner: new DockerRunner(), store: storeWith(summary), jobs });
  assert.equal(code, 0);
  assert.deepEqual(probes, ['http://127.0.0.1:8793/healthz']);
  assert.deepEqual(jobs.browserUrls, ['http://127.0.0.1:8793']);
});

test('open starts Docker Desktop when it is not running, then opens', async () => {
  const jobs = jobsWith();
  const { code } = await run({
    runner: new DockerRunner({ infoFailures: 3 }),
    store: storeWith(MAIN_AT_8792),
    jobs,
  });
  assert.equal(code, 0);
  assert.equal(jobs.dockerDesktopStarts, 1);
  assert.deepEqual(jobs.browserUrls, ['http://127.0.0.1:8792']);
});

test('open with Docker Desktop missing prints its problem and starts nothing', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run({
    runner: new DockerRunner({ installed: false }),
    store: storeWith(MAIN_AT_8792),
    jobs,
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(OPEN_DOCKER_MISSING)]);
  assert.equal(jobs.dockerDesktopStarts, 0);
});

test('open with Docker Desktop that never answers prints its problem', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run({
    runner: new DockerRunner({ infoFailures: Number.POSITIVE_INFINITY }),
    store: storeWith(MAIN_AT_8792),
    jobs,
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(OPEN_DOCKER_DID_NOT_START)]);
  assert.equal(jobs.dockerDesktopStarts, 1);
  assert.deepEqual(jobs.browserUrls, []);
});

test('open with an app that never answers prints its problem and opens no browser', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run({
    runner: new DockerRunner(),
    store: storeWith(MAIN_AT_8792),
    jobs,
    healthy: false,
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(OPEN_DID_NOT_ANSWER)]);
  assert.deepEqual(jobs.browserUrls, []);
});

test('open with no instance prints the not-installed problem', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run({ runner: new DockerRunner(), store: storeWith(summaryWith([])), jobs });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(OPEN_NOT_INSTALLED)]);
});

test('open with a record that names no address prints its problem', async () => {
  const jobs = jobsWith();
  const summary = summaryWith([{ name: 'main', entries: parseRegistry('name=main\n') }]);
  const { code, lines } = await run({ runner: new DockerRunner(), store: storeWith(summary), jobs });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(OPEN_ADDRESS_MISSING)]);
});

test('open prefers the main instance when the record holds more than one', async () => {
  const jobs = jobsWith();
  const summary = summaryWith([
    { name: 'guest', entries: parseRegistry('name=guest\napp_port=8801\n') },
    { name: 'main', entries: parseRegistry('name=main\napp_port=8802\n') },
  ]);
  const { code, probes } = await run({ runner: new DockerRunner(), store: storeWith(summary), jobs });
  assert.equal(code, 0);
  assert.deepEqual(probes, ['http://127.0.0.1:8802/healthz']);
});

test('open with a browser that will not open names the address to go to', async () => {
  const jobs = jobsWith(new Set<FakeWindowsJobStep>(['browser']));
  const { code, lines } = await run({ runner: new DockerRunner(), store: storeWith(MAIN_AT_8792), jobs });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(openBrowserFailedProblem('http://127.0.0.1:8792'))]);
});

test('open follows the recorded app port when the public address names another port', async () => {
  const jobs = jobsWith();
  const summary = summaryWith([
    { name: 'main', entries: parseRegistry('name=main\napp_port=8807\npublic_url=http://127.0.0.1:8792\n') },
  ]);
  const { code, lines, probes } = await run({ runner: new DockerRunner(), store: storeWith(summary), jobs });
  assert.equal(code, 0);
  assert.deepEqual(probes, ['http://127.0.0.1:8807/healthz']);
  assert.deepEqual(jobs.browserUrls, ['http://127.0.0.1:8807']);
  assert.deepEqual(lines, [openReadyLine('http://127.0.0.1:8807')]);
});

test('open refuses on a computer that is not Windows', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run({
    runner: new DockerRunner(),
    store: storeWith(MAIN_AT_8792),
    jobs,
    kind: 'linux',
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(OPEN_NOT_WINDOWS)]);
  assert.equal(jobs.dockerDesktopStarts, 0);
});
