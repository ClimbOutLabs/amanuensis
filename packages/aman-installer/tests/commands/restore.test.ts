import assert from 'node:assert/strict';
import { test } from 'node:test';

import { backupLabel, parseRestoreArgs, runRestore, type RestoreRequest } from '../../src/commands/restore.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs, type FakeWindowsJobStep } from '../../src/host/fakeWindowsJobs.ts';
import { windowsPaths } from '../../src/host/windowsJobs.ts';
import {
  RESTORE_BOTH_GIVEN,
  RESTORE_BUSY,
  RESTORE_CHOICE_QUESTION,
  RESTORE_COULD_NOT_LIST,
  RESTORE_DECLINED_LINE,
  RESTORE_DOCKER_NOT_ANSWERING,
  RESTORE_FAILED,
  RESTORE_IMAGE_UNAVAILABLE,
  RESTORE_LIST_HEADING_LINE,
  RESTORE_NOT_A_CHOICE,
  RESTORE_NOT_INSTALLED,
  RESTORE_NOT_WINDOWS,
  RESTORE_NO_ANSWER,
  RESTORE_PASSWORD_LINE,
  RESTORE_REMOVAL_NOTE_STUCK,
  RESTORE_STATE_UNREADABLE,
  RESTORE_WORKING_LINE,
  RESTORE_YES_PROMPT,
  problemText,
  restoreChoiceLine,
  restoreNoBackupsProblem,
  restoreNoSuchBackupProblem,
  restoreNoSuchInstanceProblem,
  restoreQuestionLine,
  restoreUsageProblem,
  restoreWhichInstanceProblem,
} from '../../src/messages.ts';
import {
  commandLine,
  okResult,
  type ProcessBytesResult,
  type ProcessResult,
  type ProcessRunner,
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
  ttsImage: null,
  calendarImage: 'aman-calendar-caldav:abc123',
  browserImage: 'aman-browser:abc123',
  browserGatewayImage: 'aman-browser-gateway:abc123',
  dexImage: 'ghcr.io/example/dex@sha256:aaaa',
  mailEmailImage: 'ghcr.io/example/mail@sha256:bbbb',
};

const LOCAL_APP_DATA = 'C:\\Users\\Friend\\AppData\\Local';
const BACKUPS_DIR = windowsPaths(LOCAL_APP_DATA).backupsDir;
const OLDER = '20261008T033000Z';
const NEWER = '20261009T033000Z';
const KEPT = '20261009T120000Z-before-import';

// The one restore command line: the backup's container shape, with -i so
// the shell's own question can be answered on its input.
function restoreArgs(name: string, backup: string): readonly string[] {
  return [
    'run',
    '--rm',
    '-i',
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
    'restore',
    name,
    backup,
  ];
}

function psLine(name: string): string {
  return commandLine('docker', [
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=aman-${name}`,
    '--filter',
    'status=running',
  ]);
}

// Answers the state check from a table, answers the restore with one
// result, and keeps every line run and what was sent on input.
class RestoreRunner implements ProcessRunner {
  readonly lines: string[] = [];
  readonly inputs: string[] = [];
  private readonly answers: ReadonlyMap<string, ProcessResult>;
  private readonly restore: ProcessBytesResult;

  constructor({ answers, restore }: { answers: ReadonlyMap<string, ProcessResult>; restore: ProcessBytesResult }) {
    this.answers = answers;
    this.restore = restore;
  }

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    const line = commandLine(command, args);
    this.lines.push(line);
    return Promise.resolve(this.answers.get(line) ?? { exitCode: 1, stdout: '', stderr: '', started: false });
  }

  runBytes(command: string, args: readonly string[], stdin: Uint8Array): Promise<ProcessBytesResult> {
    this.lines.push(commandLine(command, args));
    this.inputs.push(new TextDecoder().decode(stdin));
    return Promise.resolve(this.restore);
  }
}

function bytesResult({
  exitCode,
  stdout,
  stderr,
}: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): ProcessBytesResult {
  return { exitCode, stdout: new TextEncoder().encode(stdout), stderr, started: true };
}

const DONE = bytesResult({
  exitCode: 0,
  stdout:
    'The current state of main is saved at /root/.amanuensis/backups/20261010T080000Z-before-restore\n' +
    'Done. main is back to how it was on 2026-10-09 03:30 UTC, and it is running.\n',
  stderr:
    'This replaces the current chats and settings of main with the backup from 2026-10-09 03:30 UTC. A copy of the current state is saved first.\n' +
    '  ❯ Type yes to continue: ',
});

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

function storeReading(read: () => Promise<StateSummary>): StateStore {
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

const ONE = summaryWith({ release: RELEASE, instances: [{ name: 'main', entries: [] }] });
const TWO = summaryWith({
  release: RELEASE,
  instances: [
    { name: 'main', entries: [] },
    { name: 'work', entries: [] },
  ],
});

interface Scenario {
  request?: Partial<RestoreRequest>;
  summary?: () => Promise<StateSummary>;
  backups?: readonly string[];
  listFails?: boolean;
  running?: boolean;
  answer?: string | null;
  // The answer to the yes question; yes unless a test says otherwise.
  agree?: string | null;
  restore?: ProcessBytesResult;
  kind?: 'windows' | 'darwin';
  dockerRemovedMark?: boolean;
  clearFails?: boolean;
  backupHolds?: ReadonlyMap<string, readonly string[]>;
}

async function run(scenario: Scenario): Promise<{
  code: number;
  lines: string[];
  runner: RestoreRunner;
  questions: string[];
  confirms: string[];
  jobs: FakeWindowsJobs;
}> {
  const lines: string[] = [];
  const questions: string[] = [];
  const confirms: string[] = [];
  const running = scenario.running ?? true;
  const runner = new RestoreRunner({
    answers: new Map([
      [psLine('main'), okResult(running ? 'a\nb\nc\n' : '')],
      [psLine('work'), okResult('')],
    ]),
    restore: scenario.restore ?? DONE,
  });
  const failSteps = new Set<FakeWindowsJobStep>();
  if (scenario.listFails === true) {
    failSteps.add('backupsList');
  }
  if (scenario.clearFails === true) {
    failSteps.add('clear-docker-mark');
  }
  const jobs = new FakeWindowsJobs({
    localAppDataDir: LOCAL_APP_DATA,
    selfExePath: 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
    startMenuProgramsDir: 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
    backups: [...(scenario.backups ?? [OLDER, NEWER, KEPT])],
    dockerRemovedMark: scenario.dockerRemovedMark ?? false,
    ...(scenario.backupHolds === undefined ? {} : { backupHolds: scenario.backupHolds }),
    failSteps,
  });
  const code = await runRestore(
    {
      host: new FakeHost({ kind: scenario.kind ?? 'windows', memoryBytes: 8 * 1024 ** 3 }),
      runner,
      store: storeReading(scenario.summary ?? ((): Promise<StateSummary> => Promise.resolve(ONE))),
      jobs,
      print: line => {
        lines.push(line);
      },
      ask: question => {
        if (question.endsWith(RESTORE_YES_PROMPT)) {
          confirms.push(question);
          return Promise.resolve(scenario.agree === undefined ? 'yes' : scenario.agree);
        }
        questions.push(question);
        return Promise.resolve(scenario.answer ?? null);
      },
    },
    { name: null, backup: null, latest: false, ...scenario.request },
  );
  return { code, lines, runner, questions, confirms, jobs };
}

function yesQuestion(options: { name: string; label: string; running: boolean }): string {
  return `${restoreQuestionLine(options)} ${RESTORE_YES_PROMPT}`;
}

test('the words a restore takes are the shell restore words', () => {
  assert.deepEqual(parseRestoreArgs([]), { name: null, backup: null, latest: false });
  assert.deepEqual(parseRestoreArgs([NEWER]), { name: null, backup: NEWER, latest: false });
  assert.deepEqual(parseRestoreArgs(['main', KEPT]), { name: 'main', backup: KEPT, latest: false });
  assert.deepEqual(parseRestoreArgs([KEPT, 'main']), { name: 'main', backup: KEPT, latest: false });
  assert.deepEqual(parseRestoreArgs(['--latest']), { name: null, backup: null, latest: true });
  assert.deepEqual(parseRestoreArgs(['--latest', NEWER]), RESTORE_BOTH_GIVEN);
  assert.deepEqual(parseRestoreArgs(['--force']), restoreUsageProblem('--force'));
  assert.deepEqual(parseRestoreArgs([OLDER, NEWER]), restoreUsageProblem(NEWER));
  assert.deepEqual(parseRestoreArgs(['main', 'work']), restoreUsageProblem('work'));
});

test('a backup name reads as its time, and a kept backup says why it was kept', () => {
  assert.equal(backupLabel(NEWER), '2026-10-09 03:30 UTC');
  assert.equal(backupLabel(KEPT), '2026-10-09 12:00 UTC (before import)');
  assert.equal(backupLabel('20261009T033000Z-2'), '2026-10-09 03:30 UTC');
});

test('a named backup is put back with the shell restore, after one question, with the backups folder mounted', async () => {
  const { code, lines, runner, questions, confirms } = await run({ request: { backup: NEWER } });
  assert.equal(code, 0);
  assert.deepEqual(questions, []);
  assert.deepEqual(confirms, [yesQuestion({ name: 'main', label: '2026-10-09 03:30 UTC', running: true })]);
  assert.deepEqual(runner.lines, [psLine('main'), commandLine('docker', restoreArgs('main', NEWER))]);
  assert.deepEqual(runner.inputs, ['yes\n'], "the shell's own question is answered on its input");
  assert.deepEqual(lines, [
    RESTORE_PASSWORD_LINE,
    RESTORE_WORKING_LINE,
    `The current state of main is saved at ${BACKUPS_DIR}\\20261010T080000Z-before-restore`,
    'Done. main is back to how it was on 2026-10-09 03:30 UTC, and it is running.',
  ]);
});

test('with no backup named, the backups are listed newest first and the number typed is used', async () => {
  const { code, lines, runner, questions } = await run({ answer: '2', backups: [OLDER, KEPT, NEWER, 'notes'] });
  assert.equal(code, 0);
  assert.deepEqual(questions, [RESTORE_CHOICE_QUESTION]);
  assert.deepEqual(lines.slice(0, 4), [
    RESTORE_LIST_HEADING_LINE,
    restoreChoiceLine({ number: 1, label: '2026-10-09 12:00 UTC (before import)' }),
    restoreChoiceLine({ number: 2, label: '2026-10-09 03:30 UTC' }),
    restoreChoiceLine({ number: 3, label: '2026-10-08 03:30 UTC' }),
  ]);
  assert.ok(runner.lines.includes(commandLine('docker', restoreArgs('main', NEWER))));
});

test('--latest takes the newest backup without a list', async () => {
  const { code, runner, questions } = await run({ request: { latest: true }, backups: [OLDER, NEWER] });
  assert.equal(code, 0);
  assert.deepEqual(questions, []);
  assert.ok(runner.lines.includes(commandLine('docker', restoreArgs('main', NEWER))));
});

test('an answer that is not a number from the list changes nothing', async () => {
  for (const answer of ['', 'yes', '0', '4', '1.5']) {
    const { code, lines, runner, confirms } = await run({ answer });
    assert.equal(code, 1);
    assert.equal(lines.at(-1), problemText(RESTORE_NOT_A_CHOICE));
    assert.deepEqual(confirms, []);
    assert.equal(runner.inputs.length, 0);
  }
});

test('saying no at the question changes nothing and runs no restore', async () => {
  for (const agree of ['no', '', 'yess']) {
    const { code, lines, runner, jobs } = await run({ request: { backup: NEWER }, agree, dockerRemovedMark: true });
    assert.equal(code, 0);
    assert.deepEqual(lines, [RESTORE_PASSWORD_LINE, RESTORE_DECLINED_LINE]);
    assert.deepEqual(runner.lines, [psLine('main')]);
    assert.equal(jobs.dockerRemovedMark, true, 'a no leaves the removal note alone');
  }
});

test('no answer, at the list or at the question, changes nothing and fails with one next step', async () => {
  const atList = await run({ answer: null });
  const atQuestion = await run({ request: { backup: NEWER }, agree: null });
  for (const outcome of [atList, atQuestion]) {
    assert.equal(outcome.code, 1);
    assert.equal(outcome.lines.at(-1), problemText(RESTORE_NO_ANSWER));
    assert.equal(outcome.runner.inputs.length, 0);
  }
  assert.deepEqual(atList.confirms, []);
});

test('a yes clears the note an earlier removal left, before the restore runs', async () => {
  const { code, runner, jobs } = await run({ request: { backup: NEWER }, dockerRemovedMark: true });
  assert.equal(code, 0);
  assert.equal(jobs.dockerRemovedMark, false);
  assert.ok(runner.lines.includes(commandLine('docker', restoreArgs('main', NEWER))));
});

test('a removal note that cannot be cleared stops the restore before anything runs', async () => {
  const { code, lines, runner } = await run({ request: { backup: NEWER }, dockerRemovedMark: true, clearFails: true });
  assert.equal(code, 1);
  assert.deepEqual(lines, [RESTORE_PASSWORD_LINE, problemText(RESTORE_REMOVAL_NOTE_STUCK)]);
  assert.deepEqual(runner.lines, [psLine('main')]);
  assert.equal(runner.inputs.length, 0);
});

test('only the backups that hold the instance are listed', async () => {
  const { lines, questions } = await run({
    answer: '1',
    backups: [OLDER, NEWER],
    backupHolds: new Map([[NEWER, ['work']]]),
  });
  assert.deepEqual(questions, [RESTORE_CHOICE_QUESTION]);
  assert.deepEqual(lines.slice(0, 2), [
    RESTORE_LIST_HEADING_LINE,
    restoreChoiceLine({ number: 1, label: '2026-10-08 03:30 UTC' }),
  ]);
  const none = await run({ backups: [NEWER], backupHolds: new Map([[NEWER, ['work']]]) });
  assert.deepEqual(none.lines, [problemText(restoreNoBackupsProblem({ name: 'main', folder: BACKUPS_DIR }))]);
});

test('the password line comes right before the question', async () => {
  const { lines, confirms } = await run({ request: { backup: NEWER }, agree: 'no' });
  assert.deepEqual(lines, [RESTORE_PASSWORD_LINE, RESTORE_DECLINED_LINE]);
  assert.equal(confirms.length, 1);
});

test("the shell's question lines are not shown again after the exe asked its own", async () => {
  const { lines } = await run({
    request: { backup: NEWER },
    restore: bytesResult({
      exitCode: 0,
      stdout:
        'This replaces the current chats and settings of main with the backup from 2026-10-09 03:30 UTC.\n' +
        'The password goes back to the one main had then, and devices signed in now may have to sign in again.\n' +
        'You then sign in as old@example.com, the email the backup was made with, not as new@example.com.\n' +
        'A copy of the current state is saved first.\n' +
        'Done. main is back to how it was on 2026-10-09 03:30 UTC, and it is running.\n',
      stderr: '  ❯ Type yes to continue: ',
    }),
  });
  assert.deepEqual(lines, [
    RESTORE_PASSWORD_LINE,
    RESTORE_WORKING_LINE,
    'You then sign in as old@example.com, the email the backup was made with, not as new@example.com.',
    'Done. main is back to how it was on 2026-10-09 03:30 UTC, and it is running.',
  ]);
});

test('a shell message wrapped over two lines still counts as explained, so no second next step is added', async () => {
  const wrapped = [
    '  ✗ The backup from 2026-10-09 03:30 UTC (before restore) cannot be used',
    '    because it was copied only in part or has been changed. Nothing was',
    '    changed.',
    '    Next: Pick another one with: aman restore main',
  ].join('\n');
  const refused = await run({
    request: { backup: NEWER },
    restore: bytesResult({ exitCode: 1, stdout: '', stderr: `${wrapped}\n` }),
  });
  assert.equal(refused.code, 1);
  assert.ok(!refused.lines.includes(problemText(RESTORE_FAILED)));
  const undo = [
    '  ✗ The restore did not work and work-laptop could not be put back by',
    '    itself. A copy of it from before is at /root/.amanuensis/backups/20261010T080000Z-before-restore.',
    '    Next: Run: aman restore work-laptop 20261010T080000Z-before-restore',
  ].join('\n');
  const failed = await run({
    request: { backup: NEWER },
    restore: bytesResult({ exitCode: 1, stdout: '', stderr: `${undo}\n` }),
  });
  assert.ok(!failed.lines.includes(problemText(RESTORE_FAILED)));
  assert.ok(
    failed.lines.some(line => line.includes(`${BACKUPS_DIR}\\20261010T080000Z-before-restore.`)),
    'the copy is named by its folder on the PC',
  );
});

test('the question says a running instance is stopped, and does not say so for a stopped one', async () => {
  const stopped = await run({ request: { backup: NEWER }, running: false });
  assert.deepEqual(stopped.confirms, [yesQuestion({ name: 'main', label: '2026-10-09 03:30 UTC', running: false })]);
  assert.ok(!(stopped.confirms[0] ?? '').includes('is running now'));
  const running = await run({ request: { backup: NEWER } });
  assert.ok((running.confirms[0] ?? '').includes('main is running now and is stopped while this happens.'));
});

test('restore refuses on a computer that is not Windows, before reading anything', async () => {
  const { code, lines, runner } = await run({
    kind: 'darwin',
    summary: () => Promise.reject(new Error('the store must not be read')),
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(RESTORE_NOT_WINDOWS)]);
  assert.deepEqual(runner.lines, []);
});

test('the record of what is installed failing to read says why, in restore words', async () => {
  const cases: [() => Promise<StateSummary>, string][] = [
    [() => Promise.reject(new StateDockerError('docker did not answer')), problemText(RESTORE_DOCKER_NOT_ANSWERING)],
    [() => Promise.reject(new StateImageError('no image')), problemText(RESTORE_IMAGE_UNAVAILABLE)],
    [() => Promise.reject(new Error('bad record')), problemText(RESTORE_STATE_UNREADABLE)],
    [() => Promise.resolve(summaryWith({ releaseUnreadable: true })), problemText(RESTORE_STATE_UNREADABLE)],
    [() => Promise.resolve(summaryWith({})), problemText(RESTORE_NOT_INSTALLED)],
  ];
  for (const [summary, expected] of cases) {
    const { code, lines, runner } = await run({ summary });
    assert.equal(code, 1);
    assert.deepEqual(lines, [expected]);
    assert.deepEqual(runner.lines, []);
  }
});

test('with two instances the name is needed, and a name that is not there is refused', async () => {
  const both = await run({ summary: () => Promise.resolve(TWO) });
  assert.deepEqual(both.lines, [problemText(restoreWhichInstanceProblem(['main', 'work']))]);
  const named = await run({ summary: () => Promise.resolve(TWO), request: { name: 'work', backup: NEWER } });
  assert.equal(named.code, 0);
  assert.ok(named.runner.lines.includes(commandLine('docker', restoreArgs('work', NEWER))));
  const missing = await run({ request: { name: 'home' } });
  assert.deepEqual(missing.lines, [problemText(restoreNoSuchInstanceProblem('home'))]);
});

test('no backups, a backup that is not there, and a folder that cannot be listed each say so', async () => {
  const none = await run({ backups: [] });
  assert.deepEqual(none.lines, [problemText(restoreNoBackupsProblem({ name: 'main', folder: BACKUPS_DIR }))]);
  const unknown = await run({ request: { backup: '20250101T000000Z' } });
  assert.deepEqual(unknown.lines, [problemText(restoreNoSuchBackupProblem('20250101T000000Z'))]);
  const unlisted = await run({ listFails: true });
  assert.deepEqual(unlisted.lines, [problemText(RESTORE_COULD_NOT_LIST)]);
  for (const outcome of [none, unknown, unlisted]) {
    assert.equal(outcome.code, 1);
    assert.equal(outcome.runner.inputs.length, 0);
  }
});

test("the shell's refusal and its rollback are shown in its own words, with nothing added", async () => {
  const refusal =
    '  ✗ The backup from 2026-10-09 03:30 UTC cannot be used because it was copied only in part or has been changed. Nothing was changed.';
  const refused = await run({
    request: { backup: NEWER },
    restore: bytesResult({ exitCode: 1, stdout: '', stderr: `${refusal}\n` }),
  });
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.lines, [RESTORE_PASSWORD_LINE, RESTORE_WORKING_LINE, refusal]);
  const rolledBack = 'The restore did not work, so main was put back the way it was. The copy of it is at /x.';
  const back = await run({
    request: { backup: NEWER },
    restore: bytesResult({ exitCode: 1, stdout: `${rolledBack}\n`, stderr: '' }),
  });
  assert.deepEqual(back.lines, [RESTORE_PASSWORD_LINE, RESTORE_WORKING_LINE, rolledBack]);
});

test('a busy install, Docker not starting the helper, and an unexplained failure each say what to do', async () => {
  const busy = await run({
    request: { backup: NEWER },
    restore: bytesResult({ exitCode: 1, stdout: '', stderr: 'Another install is running right now.\n' }),
  });
  assert.equal(busy.lines.at(-1), problemText(RESTORE_BUSY));
  const notStarted = await run({
    request: { backup: NEWER },
    restore: { exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false },
  });
  assert.deepEqual(notStarted.lines, [
    RESTORE_PASSWORD_LINE,
    RESTORE_WORKING_LINE,
    problemText(RESTORE_DOCKER_NOT_ANSWERING),
  ]);
  const odd = await run({ request: { backup: NEWER }, restore: bytesResult({ exitCode: 3, stdout: '', stderr: '' }) });
  assert.deepEqual(odd.lines, [RESTORE_PASSWORD_LINE, RESTORE_WORKING_LINE, problemText(RESTORE_FAILED)]);
  for (const outcome of [busy, notStarted, odd]) {
    assert.equal(outcome.code, 1);
  }
});
