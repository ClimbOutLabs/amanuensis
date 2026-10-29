import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBackup } from '../../src/commands/backup.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs } from '../../src/host/fakeWindowsJobs.ts';
import { windowsPaths } from '../../src/host/windowsJobs.ts';
import {
  BACKUP_BUSY,
  BACKUP_DOCKER_NOT_ANSWERING,
  BACKUP_FAILED,
  BACKUP_IMAGE_UNAVAILABLE,
  BACKUP_NOT_INSTALLED,
  BACKUP_NOT_WINDOWS,
  BACKUP_SAVED_LINE,
  BACKUP_STATE_UNREADABLE,
  problemText,
} from '../../src/messages.ts';
import {
  RecordingProcessRunner,
  StubProcessRunner,
  commandLine,
  okResult,
  type ProcessResult,
} from '../../src/runner/processRunner.ts';
import {
  StateDockerError,
  StateImageError,
  type ReleaseRecord,
  type StateStore,
  type StateSummary,
} from '../../src/state/state.ts';
import { SETUP_IMAGE, SOURCE_DIR, SOURCE_VOLUME, STATE_VOLUME, VOLUME_HOME } from '../../src/state/volumeBackend.ts';

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
const BACKUPS_DIR = windowsPaths(LOCAL_APP_DATA).backupsDir;

// The one command line a backup runs: the upgrade's container shape,
// with the backups folder on the Windows disk mounted where the shell
// writes its backups. That mount is the retention proof this package
// can give: the shell's keep-the-last-seven pruning runs on the
// folder it writes to, and the mount makes that folder the one on
// the person's disk.
const RUN_ARGS: readonly string[] = [
  'run',
  '--rm',
  '-v',
  '/var/run/docker.sock:/var/run/docker.sock',
  '-v',
  `${STATE_VOLUME}:${VOLUME_HOME}`,
  '-v',
  `${SOURCE_VOLUME}:${SOURCE_DIR}`,
  '-v',
  `${BACKUPS_DIR}:${VOLUME_HOME}/backups`,
  '-w',
  SOURCE_DIR,
  SETUP_IMAGE,
  'installer/install.sh',
  'backup',
];
const RUN_LINE = commandLine('docker', RUN_ARGS);

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
    readCaCertificate: () => Promise.resolve(null),
    writeInstance: () => Promise.resolve(false),
    setInstanceValue: () => Promise.resolve(false),
    removeInstance: () => Promise.resolve(),
    writeRelease: () => Promise.resolve(false),
    setBackupsMode: () => Promise.resolve(false),
  };
}

function failingStore(error: Error): StateStore {
  return {
    readSummary: () => Promise.reject(error),
    readCaCertificate: () => Promise.resolve(null),
    writeInstance: () => Promise.resolve(false),
    setInstanceValue: () => Promise.resolve(false),
    removeInstance: () => Promise.resolve(),
    writeRelease: () => Promise.resolve(false),
    setBackupsMode: () => Promise.resolve(false),
  };
}

function jobsWith(): FakeWindowsJobs {
  return new FakeWindowsJobs({
    localAppDataDir: LOCAL_APP_DATA,
    selfExePath: 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
    startMenuProgramsDir: 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
  });
}

async function run(
  store: StateStore,
  answers: Map<string, ProcessResult>,
  kind: 'windows' | 'darwin' = 'windows',
): Promise<{ code: number; lines: string[]; recorded: readonly string[] }> {
  const lines: string[] = [];
  const recording = new RecordingProcessRunner(new StubProcessRunner(answers));
  const code = await runBackup({
    host: new FakeHost({ kind, memoryBytes: 8 * 1024 ** 3 }),
    runner: recording,
    store,
    jobs: jobsWith(),
    print: line => {
      lines.push(line);
    },
  });
  return { code, lines, recorded: recording.lines() };
}

const INSTALLED = summaryWith({ release: RELEASE, instances: [{ name: 'main', entries: [] }] });

test('a backup runs the shell backup with the Windows backups folder mounted in', async () => {
  const saved = 'Saved a backup to /root/.amanuensis/backups/20261010T033000Z.';
  const { code, lines, recorded } = await run(
    storeWith(INSTALLED),
    new Map([[RUN_LINE, okResult(`Backing up instance main\n${saved}\n`)]]),
  );
  assert.equal(code, 0);
  assert.deepEqual(recorded, [RUN_LINE]);
  assert.ok(RUN_ARGS.includes(`${BACKUPS_DIR}:${VOLUME_HOME}/backups`));
  assert.deepEqual(lines, ['Backing up instance main', saved, BACKUP_SAVED_LINE]);
});

test('backup refuses on a computer that is not Windows, before reading anything', async () => {
  const { code, lines, recorded } = await run(
    failingStore(new Error('the store must not be read')),
    new Map(),
    'darwin',
  );
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(BACKUP_NOT_WINDOWS)]);
  assert.deepEqual(recorded, []);
});

test('backup on a PC with no install refuses and runs nothing', async () => {
  const { code, lines, recorded } = await run(storeWith(summaryWith({})), new Map());
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(BACKUP_NOT_INSTALLED)]);
  assert.deepEqual(recorded, []);
});

test('backup with Docker not answering prints its problem', async () => {
  const { code, lines } = await run(failingStore(new StateDockerError('docker did not answer')), new Map());
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(BACKUP_DOCKER_NOT_ANSWERING)]);
});

test('backup with the helper image missing prints its problem', async () => {
  const { code, lines } = await run(failingStore(new StateImageError('docker could not get the image')), new Map());
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(BACKUP_IMAGE_UNAVAILABLE)]);
});

test('backup with an unreadable record prints its problem', async () => {
  const { code, lines } = await run(storeWith(summaryWith({ releaseUnreadable: true })), new Map());
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(BACKUP_STATE_UNREADABLE)]);
});

test('backup when Docker does not start the container says Docker is not answering', async () => {
  const notStarted: ProcessResult = { exitCode: 1, stdout: '', stderr: '', started: false };
  const { code, lines } = await run(storeWith(INSTALLED), new Map([[RUN_LINE, notStarted]]));
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(BACKUP_DOCKER_NOT_ANSWERING)]);
});

test('a backup stopped by the install lock names the wait', async () => {
  const locked: ProcessResult = {
    exitCode: 3,
    stdout: '',
    stderr:
      'Another install is running right now. Wait for it to finish, or wait 15 minutes if you stopped an install a moment ago, then run this again.\n',
    started: true,
  };
  const { code, lines } = await run(storeWith(INSTALLED), new Map([[RUN_LINE, locked]]));
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    'Another install is running right now. Wait for it to finish, or wait 15 minutes if you stopped an install a moment ago, then run this again.',
    problemText(BACKUP_BUSY),
  ]);
});

test('a backup that fails in the container prints its words, then its problem', async () => {
  const failed: ProcessResult = {
    exitCode: 1,
    stdout: 'Backing up instance main\n',
    stderr: 'The backup of main failed, so the unfinished backup was removed.\n',
    started: true,
  };
  const { code, lines } = await run(storeWith(INSTALLED), new Map([[RUN_LINE, failed]]));
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    'Backing up instance main',
    'The backup of main failed, so the unfinished backup was removed.',
    problemText(BACKUP_FAILED),
  ]);
});

test('an install with nothing left to back up saves nothing and says so in the shell words', async () => {
  const { code, lines } = await run(
    storeWith(summaryWith({ release: RELEASE })),
    new Map([[RUN_LINE, okResult('No instances yet; nothing to back up.\n')]]),
  );
  assert.equal(code, 0);
  assert.deepEqual(lines, ['No instances yet; nothing to back up.']);
});
