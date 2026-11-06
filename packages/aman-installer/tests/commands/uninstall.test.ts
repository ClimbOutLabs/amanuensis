import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runUninstall } from '../../src/commands/uninstall.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs, type FakeWindowsJobStep } from '../../src/host/fakeWindowsJobs.ts';
import { windowsPaths } from '../../src/host/windowsJobs.ts';
import {
  BACKUP_SAVED_LINE,
  UNINSTALL_BACKUP_FAILED,
  UNINSTALL_DECLINED_LINE,
  UNINSTALL_DOCKER_KEPT_LINE,
  UNINSTALL_DOCKER_LEFTOVERS,
  UNINSTALL_DOCKER_NOT_ANSWERING,
  UNINSTALL_DONE_LINE,
  UNINSTALL_NOT_WINDOWS,
  UNINSTALL_PLAN_LINES,
  UNINSTALL_QUESTION,
  UNINSTALL_WINDOWS_LEFTOVERS,
  problemText,
  uninstallBackupsKeptLine,
  uninstallBackupsQuestion,
  uninstallInstanceFailedProblem,
  uninstallRemovingInstanceLine,
} from '../../src/messages.ts';
import {
  RecordingProcessRunner,
  StubProcessRunner,
  commandLine,
  okResult,
  type ProcessResult,
} from '../../src/runner/processRunner.ts';
import { StateDockerError, type ReleaseRecord, type StateStore, type StateSummary } from '../../src/state/state.ts';
import { SETUP_IMAGE, SOURCE_DIR, SOURCE_VOLUME, STATE_VOLUME, VOLUME_HOME } from '../../src/state/volumeBackend.ts';

const RELEASE: ReleaseRecord = {
  schema: '1',
  sourceRef: 'abc123',
  appImage: 'aman-app:abc123',
  sttImage: 'aman-stt:abc123',
  ttsImage: null,
  calendarImage: 'aman-calendar-caldav:abc123',
  browserImage: 'aman-browser:abc123',
  browserGatewayImage: 'aman-browser-gateway:abc123',
  dexImage: 'ghcr.io/example/dex@sha256:aaaa',
  mailEmailImage: 'ghcr.io/example/mail@sha256:bbbb',
};

const LOCAL_APP_DATA = 'C:\\Users\\Friend\\AppData\\Local';
const PATHS = windowsPaths(LOCAL_APP_DATA);
const START_MENU = 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';

const CONTAINER_ARGS: readonly string[] = [
  'run',
  '--rm',
  '-v',
  '/var/run/docker.sock:/var/run/docker.sock',
  '-v',
  `${STATE_VOLUME}:${VOLUME_HOME}`,
  '-v',
  `${SOURCE_VOLUME}:${SOURCE_DIR}`,
];
const BACKUP_LINE = commandLine('docker', [
  ...CONTAINER_ARGS,
  '-v',
  `${PATHS.backupsDir}:${VOLUME_HOME}/backups`,
  '-w',
  SOURCE_DIR,
  SETUP_IMAGE,
  'installer/install.sh',
  'backup',
]);

function removeLine(name: string): string {
  return commandLine('docker', [
    ...CONTAINER_ARGS,
    '-w',
    SOURCE_DIR,
    SETUP_IMAGE,
    'installer/install.sh',
    '--yes',
    'instance',
    'remove',
    name,
    '--purge-data',
    '--confirm-name',
    name,
  ]);
}

const VOLUME_LS = commandLine('docker', ['volume', 'ls', '--quiet']);
const IMAGE_LS = commandLine('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
const SETUP_IMAGE_RM = commandLine('docker', ['image', 'rm', SETUP_IMAGE]);

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

function storeWith(read: () => Promise<StateSummary>): StateStore {
  return {
    readSummary: read,
    readCaCertificate: () => Promise.resolve(null),
    writeInstance: () => Promise.resolve(false),
    setInstanceValue: () => Promise.resolve(false),
    removeInstance: () => Promise.resolve(),
    writeRelease: () => Promise.resolve(false),
    setBackupsMode: () => Promise.resolve(false),
    refreshCache: () => undefined,
  };
}

const INSTALLED = summaryWith({
  release: RELEASE,
  instances: [
    { name: 'main', entries: [] },
    { name: 'sam', entries: [] },
  ],
});

function jobsWith(failSteps: ReadonlySet<FakeWindowsJobStep> = new Set()): FakeWindowsJobs {
  const jobs = new FakeWindowsJobs({
    localAppDataDir: LOCAL_APP_DATA,
    selfExePath: PATHS.programsExePath,
    startMenuProgramsDir: START_MENU,
    userPath: `C:\\Tools;${PATHS.programsDir}`,
    backupTask: true,
    backups: ['20261101T033000Z'],
    shortcuts: [
      { path: `${START_MENU}\\Aman.lnk`, target: PATHS.programsExePath, args: 'open' },
      { path: `${START_MENU}\\Check Aman.lnk`, target: PATHS.programsExePath, args: 'doctor' },
      { path: `${START_MENU}\\Backups.lnk`, target: PATHS.backupsDir, args: '' },
      { path: 'C:\\Users\\Friend\\Desktop\\Aman doctor.lnk', target: PATHS.setupCmdCopyPath, args: 'doctor' },
      { path: 'C:\\Users\\Friend\\Desktop\\Other.lnk', target: 'C:\\Tools\\other.exe', args: '' },
    ],
    failSteps,
  });
  jobs.firewallRule = true;
  jobs.caCertInStore = true;
  return jobs;
}

// Docker as an install leaves it: the volumes and images Aman made,
// beside some that are not Aman's.
function dockerAnswers(overrides: readonly [string, ProcessResult][] = []): Map<string, ProcessResult> {
  return new Map<string, ProcessResult>([
    [BACKUP_LINE, okResult('Saved a backup.\n')],
    [removeLine('main'), okResult('Removed instance main and deleted its data.\n')],
    [removeLine('sam'), okResult('Removed instance sam and deleted its data.\n')],
    [VOLUME_LS, okResult('aman_home\naman_source\naman_stt_cache\nsomeone_else\n')],
    [commandLine('docker', ['volume', 'rm', 'aman_home']), okResult('')],
    [commandLine('docker', ['volume', 'rm', 'aman_source']), okResult('')],
    [commandLine('docker', ['volume', 'rm', 'aman_stt_cache']), okResult('')],
    [IMAGE_LS, okResult('aman-app:abc123\naman-stt:abc123\npostgres:16\naman-app:<none>\n')],
    [commandLine('docker', ['image', 'rm', 'aman-app:abc123']), okResult('')],
    [commandLine('docker', ['image', 'rm', 'aman-stt:abc123']), okResult('')],
    [SETUP_IMAGE_RM, okResult('')],
    ...overrides,
  ]);
}

async function run(options: {
  store?: StateStore;
  answers?: Map<string, ProcessResult>;
  jobs?: FakeWindowsJobs;
  replies?: readonly boolean[];
  kind?: 'windows' | 'darwin';
}): Promise<{
  code: number;
  lines: string[];
  recorded: readonly string[];
  questions: string[];
  jobs: FakeWindowsJobs;
}> {
  const lines: string[] = [];
  const questions: string[] = [];
  const replies = [...(options.replies ?? [true, false])];
  const jobs = options.jobs ?? jobsWith();
  const recording = new RecordingProcessRunner(new StubProcessRunner(options.answers ?? dockerAnswers()));
  const code = await runUninstall({
    host: new FakeHost({ kind: options.kind ?? 'windows', memoryBytes: 8 * 1024 ** 3 }),
    runner: recording,
    store: options.store ?? storeWith(() => Promise.resolve(INSTALLED)),
    jobs,
    print: line => {
      lines.push(line);
    },
    confirm: question => {
      questions.push(question);
      return Promise.resolve(replies.shift() ?? false);
    },
  });
  return { code, lines, recorded: recording.lines(), questions, jobs };
}

test('uninstall keeps the backups by default: a last backup, every instance, Docker, then the Windows side', async () => {
  const { code, lines, recorded, questions, jobs } = await run({});
  assert.equal(code, 0);
  assert.deepEqual(questions, [UNINSTALL_QUESTION, uninstallBackupsQuestion(PATHS.backupsDir)]);
  assert.deepEqual(recorded, [
    BACKUP_LINE,
    removeLine('main'),
    removeLine('sam'),
    VOLUME_LS,
    commandLine('docker', ['volume', 'rm', 'aman_home']),
    commandLine('docker', ['volume', 'rm', 'aman_source']),
    commandLine('docker', ['volume', 'rm', 'aman_stt_cache']),
    IMAGE_LS,
    commandLine('docker', ['image', 'rm', 'aman-app:abc123']),
    commandLine('docker', ['image', 'rm', 'aman-stt:abc123']),
    SETUP_IMAGE_RM,
  ]);
  assert.deepEqual(lines, [
    ...UNINSTALL_PLAN_LINES,
    'Saved a backup.',
    uninstallRemovingInstanceLine('main'),
    'Removed instance main and deleted its data.',
    uninstallRemovingInstanceLine('sam'),
    'Removed instance sam and deleted its data.',
    UNINSTALL_DONE_LINE,
    uninstallBackupsKeptLine(PATHS.backupsDir),
    UNINSTALL_DOCKER_KEPT_LINE,
  ]);
  assert.ok(!lines.includes(BACKUP_SAVED_LINE));
  // Only shortcuts that point at Aman go.
  assert.deepEqual(
    jobs.shortcuts.map(shortcut => shortcut.path),
    ['C:\\Users\\Friend\\Desktop\\Other.lnk'],
  );
  assert.equal(jobs.backupTask, false);
  assert.equal(jobs.firewallRule, false);
  assert.equal(jobs.caCertInStore, false);
  assert.equal(jobs.userPath, 'C:\\Tools');
  assert.equal(jobs.dataFolder, 'backups-only');
  assert.equal(jobs.programsFolderRemovalScheduled, true);
});

test('uninstall answered yes twice deletes the backups and makes no last backup', async () => {
  const { code, lines, recorded, jobs } = await run({ replies: [true, true] });
  assert.equal(code, 0);
  assert.ok(!recorded.includes(BACKUP_LINE));
  assert.equal(jobs.dataFolder, 'gone');
  assert.ok(!lines.includes(uninstallBackupsKeptLine(PATHS.backupsDir)));
  assert.equal(lines.at(-1), UNINSTALL_DOCKER_KEPT_LINE);
});

test('uninstall answered no removes nothing', async () => {
  const { code, lines, recorded, jobs } = await run({ replies: [false] });
  assert.equal(code, 0);
  assert.deepEqual(lines, [...UNINSTALL_PLAN_LINES, UNINSTALL_DECLINED_LINE]);
  assert.deepEqual(recorded, []);
  assert.deepEqual(jobs.ops, []);
});

test('uninstall refuses on a computer that is not Windows, before reading anything', async () => {
  const { code, lines, recorded } = await run({
    kind: 'darwin',
    store: storeWith(() => Promise.reject(new Error('the store must not be read'))),
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(UNINSTALL_NOT_WINDOWS)]);
  assert.deepEqual(recorded, []);
});

test('uninstall with Docker not answering asks nothing and removes nothing', async () => {
  const { code, lines, questions, jobs } = await run({
    store: storeWith(() => Promise.reject(new StateDockerError('docker did not answer'))),
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(UNINSTALL_DOCKER_NOT_ANSWERING)]);
  assert.deepEqual(questions, []);
  assert.deepEqual(jobs.ops, []);
});

test('a last backup that fails stops the removal before anything is deleted', async () => {
  const failed: ProcessResult = { exitCode: 1, stdout: '', stderr: 'disk full\n', started: true };
  const { code, lines, recorded, jobs } = await run({ answers: dockerAnswers([[BACKUP_LINE, failed]]) });
  assert.equal(code, 1);
  assert.equal(lines.at(-1), problemText(UNINSTALL_BACKUP_FAILED));
  assert.deepEqual(recorded, [BACKUP_LINE]);
  assert.deepEqual(jobs.ops, []);
});

test('an instance that will not go stops the removal there, with the Windows side untouched', async () => {
  const failed: ProcessResult = { exitCode: 1, stdout: '', stderr: 'could not stop\n', started: true };
  const { code, lines, recorded, jobs } = await run({ answers: dockerAnswers([[removeLine('main'), failed]]) });
  assert.equal(code, 1);
  assert.equal(lines.at(-1), problemText(uninstallInstanceFailedProblem('main')));
  assert.ok(!recorded.includes(removeLine('sam')));
  assert.deepEqual(jobs.ops, []);
});

test('a volume that will not go is reported, and the Windows side is left for the next run', async () => {
  const failed: ProcessResult = { exitCode: 1, stdout: '', stderr: 'volume in use\n', started: true };
  const { code, lines, recorded, jobs } = await run({
    answers: dockerAnswers([[commandLine('docker', ['volume', 'rm', 'aman_home']), failed]]),
  });
  assert.equal(code, 1);
  assert.equal(lines.at(-1), problemText(UNINSTALL_DOCKER_LEFTOVERS));
  // The other volumes and the images are still tried.
  assert.ok(recorded.includes(commandLine('docker', ['volume', 'rm', 'aman_source'])));
  assert.ok(recorded.includes(commandLine('docker', ['image', 'rm', 'aman-app:abc123'])));
  assert.deepEqual(jobs.ops, []);
});

test('a refused firewall prompt keeps the aman command so the removal can run again', async () => {
  const jobs = jobsWith(new Set<FakeWindowsJobStep>(['remove-firewall']));
  const { code, lines } = await run({ jobs });
  assert.equal(code, 1);
  assert.equal(lines.at(-1), problemText(UNINSTALL_WINDOWS_LEFTOVERS));
  // Every other Windows step still ran; only the command's own folder stays.
  assert.equal(jobs.backupTask, false);
  assert.equal(jobs.caCertInStore, false);
  assert.equal(jobs.dataFolder, 'backups-only');
  assert.equal(jobs.programsFolderRemovalScheduled, false);
});

test('uninstall on a PC with no instances left cleans up what is there', async () => {
  const { code, recorded } = await run({ store: storeWith(() => Promise.resolve(summaryWith({}))) });
  assert.equal(code, 0);
  assert.ok(!recorded.includes(BACKUP_LINE));
  assert.equal(recorded[0], VOLUME_LS);
});
