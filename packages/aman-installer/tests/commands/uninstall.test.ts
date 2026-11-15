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
  UNINSTALL_DOCKER_GONE_LINE,
  UNINSTALL_DOCKER_KEPT_LINE,
  UNINSTALL_DOCKER_LEFTOVERS,
  UNINSTALL_DOCKER_NOT_ANSWERING,
  UNINSTALL_DONE_LINE,
  UNINSTALL_NOT_WINDOWS,
  UNINSTALL_PLAN_LINES,
  UNINSTALL_QUESTION,
  problemText,
  uninstallBackupsKeptLine,
  uninstallBackupsQuestion,
  uninstallInstanceFailedProblem,
  uninstallRemovingInstanceLine,
  uninstallWindowsLeftoversProblem,
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

const DOCKER_VERSION = commandLine('docker', ['--version']);
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

function jobsWith(
  failSteps: ReadonlySet<FakeWindowsJobStep> = new Set(),
  options: { dockerRemovedMark?: boolean } = {},
): FakeWindowsJobs {
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
    ...options,
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
    [removeLine('main'), okResult('rm -r /root/.aman/instances/main\nRemoved instance main.\n')],
    [removeLine('sam'), okResult('rm -r /root/.aman/instances/sam\nRemoved instance sam.\n')],
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
    uninstallRemovingInstanceLine('sam'),
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
  assert.equal(jobs.dockerRemovedMark, true);
  // The prompts come first and the Start menu entries last, so a
  // removal stopped by a No can still be started again.
  assert.deepEqual(jobs.ops, [
    'mark-docker',
    'remove-task',
    'runOnceQuery',
    'remove-firewall',
    'remove-cert',
    'remove-data',
    'remove-path',
    'list',
    'remove-shortcut',
    'remove-shortcut',
    'remove-shortcut',
    'remove-shortcut',
    'remove-programs',
  ]);
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
    answers: new Map([[DOCKER_VERSION, okResult('Docker version 28.0.0\n')]]),
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
  // The shell's own lines are shown when they explain a failure.
  assert.deepEqual(lines.slice(-2), ['could not stop', problemText(uninstallInstanceFailedProblem('main'))]);
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

// What a refused Windows prompt must leave behind: everything a second
// run needs to be started and to find what is left.
function assertFinishable(jobs: FakeWindowsJobs): void {
  assert.equal(jobs.dataFolder, 'present');
  assert.equal(jobs.userPath, `C:\\Tools;${PATHS.programsDir}`);
  assert.ok(jobs.shortcuts.some(shortcut => shortcut.path === `${START_MENU}\\Aman.lnk`));
  assert.equal(jobs.programsFolderRemovalScheduled, false);
}

test('a refused firewall prompt leaves the command, the entries and the folder for the next run', async () => {
  const jobs = jobsWith(new Set<FakeWindowsJobStep>(['remove-firewall']));
  const { code, lines } = await run({ jobs });
  assert.equal(code, 1);
  assert.equal(lines.at(-1), problemText(uninstallWindowsLeftoversProblem(PATHS.programsExePath)));
  assert.ok(lines.at(-1)?.includes(PATHS.programsExePath));
  assert.ok(!lines.includes(UNINSTALL_DONE_LINE));
  // The other prompt-free steps still ran.
  assert.equal(jobs.backupTask, false);
  assertFinishable(jobs);
});

test('a No to the certificate dialog is not reported as removed, and the next run finishes it', async () => {
  const refused = jobsWith(new Set<FakeWindowsJobStep>(['remove-cert']));
  const first = await run({ jobs: refused });
  assert.equal(first.code, 1);
  assert.equal(first.lines.at(-1), problemText(uninstallWindowsLeftoversProblem(PATHS.programsExePath)));
  assert.ok(!first.lines.includes(UNINSTALL_DONE_LINE));
  assert.equal(refused.caCertInStore, true);
  assertFinishable(refused);
  assert.equal(refused.dockerRemovedMark, true);

  // The second run, Docker Desktop closed: the Docker side is not read
  // again, and the Windows side is finished.
  const again = jobsWith(new Set(), { dockerRemovedMark: true });
  again.caCertInStore = true;
  const second = await run({
    jobs: again,
    store: storeWith(() => Promise.reject(new StateDockerError('docker did not answer'))),
  });
  assert.equal(second.code, 0);
  assert.deepEqual(second.recorded, []);
  assert.equal(again.caCertInStore, false);
  assert.equal(again.dataFolder, 'backups-only');
  assert.equal(again.programsFolderRemovalScheduled, true);
  assert.ok(second.lines.includes(UNINSTALL_DONE_LINE));
});

test('a data folder that will not go keeps the PATH entry and the Start menu entries', async () => {
  const jobs = jobsWith(new Set<FakeWindowsJobStep>(['remove-data']));
  const { code, lines } = await run({ jobs });
  assert.equal(code, 1);
  assert.equal(lines.at(-1), problemText(uninstallWindowsLeftoversProblem(PATHS.programsExePath)));
  assert.equal(jobs.caCertInStore, false);
  assert.equal(jobs.userPath, `C:\\Tools;${PATHS.programsDir}`);
  assert.ok(jobs.shortcuts.some(shortcut => shortcut.path === `${START_MENU}\\Aman.lnk`));
  assert.equal(jobs.programsFolderRemovalScheduled, false);
});

test('uninstall on a PC with no instances left cleans up what is there', async () => {
  const { code, recorded } = await run({ store: storeWith(() => Promise.resolve(summaryWith({}))) });
  assert.equal(code, 0);
  assert.ok(!recorded.includes(BACKUP_LINE));
  assert.equal(recorded[0], VOLUME_LS);
});

test('with Docker Desktop already taken off the computer, the Windows parts are still removed', async () => {
  const { code, lines, recorded, jobs } = await run({
    store: storeWith(() => Promise.reject(new StateDockerError('docker did not answer'))),
    answers: new Map(),
  });
  assert.equal(code, 0);
  assert.equal(lines[0], UNINSTALL_DOCKER_GONE_LINE);
  assert.deepEqual(recorded, [DOCKER_VERSION]);
  assert.equal(jobs.caCertInStore, false);
  assert.equal(jobs.programsFolderRemovalScheduled, true);
  assert.ok(lines.includes(UNINSTALL_DONE_LINE));
});
