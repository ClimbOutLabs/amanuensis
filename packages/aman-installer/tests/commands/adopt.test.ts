import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runAdopt } from '../../src/commands/adopt.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs, type FakeWindowsJobStep } from '../../src/host/fakeWindowsJobs.ts';
import { SETUP_CMD_FORWARDER } from '../../src/host/windowsJobs.ts';
import {
  ADOPT_DOCKER_NOT_ANSWERING,
  ADOPT_IMAGE_UNAVAILABLE,
  ADOPT_NOT_INSTALLED,
  ADOPT_NOT_WINDOWS,
  ADOPT_SETUP_FAILED,
  ADOPT_STATE_UNREADABLE,
  ADOPTED_LINE,
  problemText,
} from '../../src/messages.ts';
import {
  StateDockerError,
  StateImageError,
  type ReleaseRecord,
  type StateStore,
  type StateSummary,
} from '../../src/state/state.ts';

const RELEASE: ReleaseRecord = {
  schema: '1',
  sourceRef: 'abc123',
  appImage: 'aman-app:abc123',
  sttImage: 'aman-stt:abc123',
  calendarImage: 'aman-calendar-caldav:abc123',
  dexImage: 'ghcr.io/example/dex@sha256:aaaa',
  mailEmailImage: 'ghcr.io/example/mail@sha256:bbbb',
};

const LOCAL_APP_DATA = 'C:\\Users\\Friend\\AppData\\Local';
const START_MENU_PROGRAMS = 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';
const SETUP_CMD_COPY = 'C:\\Users\\Friend\\AppData\\Local\\Amanuensis\\Aman-Setup.cmd';
const PROGRAMS_EXE = 'C:\\Users\\Friend\\AppData\\Local\\Programs\\Amanuensis\\aman.exe';

function summaryWith(overrides: Partial<StateSummary>): StateSummary {
  return {
    release: null,
    releaseUnreadable: false,
    previousRelease: null,
    instances: [],
    backups: [],
    backupEntries: [],
    backupsMode: null,
    backupsModeTimeSeconds: null,
    certificateAuthority: { certPresent: false, keyMode: null, fingerprint: null, fingerprintHasContent: false },
    sourceCheckout: null,
    installedAppImage: null,
    ...overrides,
  };
}

function storeWith(summary: StateSummary): StateStore {
  return {
    readSummary: () => Promise.resolve(summary),
    writeInstance: () => Promise.resolve(false),
    setInstanceValue: () => Promise.resolve(false),
    removeInstance: () => Promise.resolve(),
    writeRelease: () => Promise.resolve(false),
  };
}

function failingStore(error: Error): StateStore {
  return {
    readSummary: () => Promise.reject(error),
    writeInstance: () => Promise.resolve(false),
    setInstanceValue: () => Promise.resolve(false),
    removeInstance: () => Promise.resolve(),
    writeRelease: () => Promise.resolve(false),
  };
}

function jobsWith(
  options: { selfExePath?: string; failSteps?: ReadonlySet<FakeWindowsJobStep> } = {},
): FakeWindowsJobs {
  return new FakeWindowsJobs({
    localAppDataDir: LOCAL_APP_DATA,
    selfExePath: options.selfExePath ?? 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
    startMenuProgramsDir: START_MENU_PROGRAMS,
    shortcuts: [
      { path: 'C:\\Users\\Friend\\Desktop\\Aman.lnk', target: SETUP_CMD_COPY, args: 'open' },
      { path: `${START_MENU_PROGRAMS}\\Aman.lnk`, target: SETUP_CMD_COPY, args: 'open' },
      { path: 'C:\\Users\\Friend\\Desktop\\Aman doctor.lnk', target: SETUP_CMD_COPY, args: 'doctor' },
      { path: 'C:\\Users\\Friend\\Desktop\\Other.lnk', target: 'C:\\Tools\\other.exe', args: 'open' },
    ],
    ...(options.failSteps === undefined ? {} : { failSteps: options.failSteps }),
  });
}

async function run(
  store: StateStore,
  jobs: FakeWindowsJobs,
  kind: 'windows' | 'darwin' = 'windows',
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runAdopt({
    host: new FakeHost({ kind, memoryBytes: 8 * 1024 ** 3 }),
    store,
    jobs,
    print: line => {
      lines.push(line);
    },
  });
  return { code, lines };
}

test('adopt moves the shortcuts, makes the Check Aman entry and replaces the starter file', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run(storeWith(summaryWith({ release: RELEASE })), jobs);
  assert.equal(code, 0);
  assert.deepEqual(lines, [ADOPTED_LINE]);
  assert.deepEqual(jobs.ops, ['copy', 'path', 'list', 'point', 'point', 'check', 'forwarder']);
  const byPath = new Map(jobs.shortcuts.map(shortcut => [shortcut.path, shortcut]));
  assert.equal(byPath.get('C:\\Users\\Friend\\Desktop\\Aman.lnk')?.target, PROGRAMS_EXE);
  assert.equal(byPath.get('C:\\Users\\Friend\\Desktop\\Aman.lnk')?.args, 'open');
  assert.equal(byPath.get(`${START_MENU_PROGRAMS}\\Aman.lnk`)?.target, PROGRAMS_EXE);
  // A shortcut to the starter file that does not open Aman is left alone,
  // and so is a shortcut to anything else.
  assert.equal(byPath.get('C:\\Users\\Friend\\Desktop\\Aman doctor.lnk')?.target, SETUP_CMD_COPY);
  assert.equal(byPath.get('C:\\Users\\Friend\\Desktop\\Other.lnk')?.target, 'C:\\Tools\\other.exe');
  const check = byPath.get(`${START_MENU_PROGRAMS}\\Check Aman.lnk`);
  assert.equal(check?.target, PROGRAMS_EXE);
  assert.equal(check?.args, 'doctor');
  assert.equal(jobs.forwarderContents, SETUP_CMD_FORWARDER);
  assert.ok(jobs.userPath.includes('C:\\Users\\Friend\\AppData\\Local\\Programs\\Amanuensis'));
});

test('adopt on a PC with no install refuses and changes nothing', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run(storeWith(summaryWith({})), jobs);
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(ADOPT_NOT_INSTALLED)]);
  assert.deepEqual(jobs.ops, []);
  assert.equal(jobs.forwarderContents, null);
});

test('adopt refuses on a computer that is not Windows, before reading anything', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run(failingStore(new Error('the store must not be read')), jobs, 'darwin');
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(ADOPT_NOT_WINDOWS)]);
  assert.deepEqual(jobs.ops, []);
});

test('adopt with Docker not answering prints its problem and changes nothing', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run(failingStore(new StateDockerError('docker did not answer')), jobs);
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(ADOPT_DOCKER_NOT_ANSWERING)]);
  assert.deepEqual(jobs.ops, []);
});

test('adopt with the helper image missing prints its problem', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run(failingStore(new StateImageError('docker could not get the image')), jobs);
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(ADOPT_IMAGE_UNAVAILABLE)]);
  assert.deepEqual(jobs.ops, []);
});

test('adopt with an unreadable record prints its problem', async () => {
  const jobs = jobsWith();
  const { code, lines } = await run(storeWith(summaryWith({ releaseUnreadable: true })), jobs);
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(ADOPT_STATE_UNREADABLE)]);
  assert.deepEqual(jobs.ops, []);
});

test('a failed Windows step stops adopt with its problem', async () => {
  const jobs = jobsWith({ failSteps: new Set<FakeWindowsJobStep>(['copy']) });
  const { code, lines } = await run(storeWith(summaryWith({ release: RELEASE })), jobs);
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(ADOPT_SETUP_FAILED)]);
});

test('adopt run from the installed copy still completes and says the same line', async () => {
  const jobs = jobsWith({ selfExePath: PROGRAMS_EXE });
  const { code, lines } = await run(storeWith(summaryWith({ release: RELEASE })), jobs);
  assert.equal(code, 0);
  assert.deepEqual(lines, [ADOPTED_LINE]);
  assert.equal(jobs.forwarderContents, SETUP_CMD_FORWARDER);
});

test('adopt finds the install from an instance alone, with no release record', async () => {
  const jobs = jobsWith();
  const summary = summaryWith({ instances: [{ name: 'main', entries: [] }] });
  const { code, lines } = await run(storeWith(summary), jobs);
  assert.equal(code, 0);
  assert.deepEqual(lines, [ADOPTED_LINE]);
});
