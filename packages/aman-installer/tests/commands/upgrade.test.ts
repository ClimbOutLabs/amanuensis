import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { resolvePendingSwap, runUpgrade, type UpgradeDeps } from '../../src/commands/upgrade.ts';
import { runDoctorChecks } from '../../src/doctor/doctor.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs } from '../../src/host/fakeWindowsJobs.ts';
import {
  NOT_INSTALLED,
  problemText,
  UPGRADE_BUSY,
  UPGRADE_DECLINED_LINE,
  UPGRADE_DOCKER_NOT_ANSWERING,
  UPGRADE_DOWNLOAD_FAILED,
  UPGRADE_EXE_IN_PLACE_LINE,
  UPGRADE_NOT_WINDOWS,
  UPGRADE_OLD_PROGRAM_NOT_BACK,
  UPGRADE_PROGRAM_MISSING,
  UPGRADE_RELEASE_NOT_THERE,
  UPGRADE_ROLLED_BACK,
  UPGRADE_SMOKE_FAILED,
  UPGRADE_SOURCE_FAILED,
  UPGRADE_SOURCE_MISSING,
  UPGRADE_UP_TO_DATE_LINE,
  upgradeDoneLine,
  upgradeNotReadyProblem,
  upgradeQuestionLine,
  VERIFY_SIGNATURE_BAD,
  verifyChangedProblem,
} from '../../src/messages.ts';
import type { FetchBytesResult } from '../../src/release/download.ts';
import { buildManifest, manifestToBytes, type SourceIds } from '../../src/release/manifest.ts';
import { signMinisign } from '../../src/release/minisign.ts';
import {
  commandLine,
  okBytesResult,
  okResult,
  RecordingProcessRunner,
  StubProcessRunner,
  type ProcessBytesResult,
  type ProcessResult,
  type ProcessRunner,
} from '../../src/runner/processRunner.ts';
import { parseRegistry, type ReleaseRecord, type StateStore, type StateSummary } from '../../src/state/state.ts';
import { SETUP_IMAGE } from '../../src/state/volumeBackend.ts';
import { TEST_PUBLIC_KEY_MINISIGN, testKeyNum, testPrivateKeyDer } from '../release/testKeys.ts';

const NOW = 1791633600;
const GIB = 1024 * 1024 * 1024;
const RELEASE_TAG = 'v9.9.9';
const ASSET_NAME = 'aman-windows-x64.exe';
const ARCHIVE_NAME = 'amanuensis-v9.9.9.tar.gz';
const OLD_PROGRAM = new TextEncoder().encode('the old aman program');
const NEW_PROGRAM = new TextEncoder().encode('the new aman program');
const ARCHIVE_BYTES = new TextEncoder().encode('the source archive bytes');
const IDS: SourceIds = {
  'aman-app': 'aman-app:0123456789ab',
  'aman-stt': 'aman-stt:0123456789cd',
  'aman-calendar-caldav': 'aman-calendar-caldav:0123456789ef',
};
const RELEASE_BASE = 'https://github.com/ClimbOutLabs/amanuensis/releases';
const MANIFEST_URL = `${RELEASE_BASE}/latest/download/manifest.json`;
const SIGNATURE_URL = `${RELEASE_BASE}/latest/download/manifest.json.minisig`;
const ASSET_URL = `${RELEASE_BASE}/download/${RELEASE_TAG}/${ASSET_NAME}`;
const ARCHIVE_URL = `${RELEASE_BASE}/download/${RELEASE_TAG}/${ARCHIVE_NAME}`;
const START_MENU_DIR = 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';

const RELEASE: ReleaseRecord = {
  schema: '1',
  sourceRef: 'abc123',
  appImage: 'aman-app:test1',
  sttImage: 'aman-stt:test1',
  calendarImage: 'aman-calendar-caldav:test1',
  dexImage: 'aman-dex:test1',
  mailEmailImage: null,
};

function installedSummary(): StateSummary {
  return {
    release: RELEASE,
    releaseUnreadable: false,
    previousRelease: null,
    instances: [
      {
        name: 'main',
        entries: parseRegistry(
          [
            'name=main',
            'app_port=8791',
            'public_url=http://127.0.0.1:8791',
            'origins=http://127.0.0.1:8791',
            'sandbox=slots',
            'tls=off',
            'tls_port=',
          ].join('\n'),
        ),
      },
    ],
    backups: ['20261009T120000Z'],
    backupEntries: [{ name: '20261009T120000Z', timeSeconds: NOW - 86400 }],
    backupsMode: 'daily',
    backupsModeTimeSeconds: NOW - 3600,
    certificateAuthority: { certPresent: false, keyMode: null, fingerprint: null, fingerprintHasContent: false },
    sourceCheckout: null,
    installedAppImage: 'aman-app:test1',
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

const INFO_FORMAT =
  '{{.ServerVersion}}|{{.Architecture}}|{{.SecurityOptions}}|{{.DockerRootDir}}|{{.SystemTime}}|{{.OperatingSystem}}|{{.MemTotal}}';
const PS_FORMAT = '{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.service"}}';
const EXEC_LINES = [
  'service\tok\tThe app is running.\t',
  'login\tok\tSign-in is ready.\t',
  'database\tok\tThe database answers.\t',
].join('\n');

// The doctor's ready answers, as its own tests build them, with the one
// change the gate makes: the instance's doctor is called with --local.
function readyAnswers(): Map<string, ProcessResult> {
  return new Map<string, ProcessResult>([
    [
      commandLine('docker', ['info', '--format', INFO_FORMAT]),
      okResult(
        `28.4.0|x86_64|name=seccomp,profile=builtin|/nonexistent-docker-root|2026-10-10T12:00:00.123456789Z|Ubuntu 24.04.1 LTS|${String(16 * GIB)}\n`,
      ),
    ],
    [commandLine('docker', ['compose', 'version', '--short']), okResult('2.29.1\n')],
    [
      commandLine('docker', ['version', '--format', '{{range .Server.Components}}{{.Name}};{{end}}']),
      okResult('containerd;BuildKit;'),
    ],
    [commandLine('docker', ['--version']), okResult('Docker version 28.4.0, build 1234567\n')],
    [
      commandLine('docker', ['image', 'inspect', '--format', '{{.Architecture}}', 'aman-app:test1']),
      okResult('amd64\n'),
    ],
    [
      commandLine('docker', ['image', 'inspect', '--format', '{{.Architecture}}', 'aman-stt:test1']),
      okResult('amd64\n'),
    ],
    [
      commandLine('docker', ['image', 'inspect', '--format', '{{.Architecture}}', 'aman-dex:test1']),
      okResult('amd64\n'),
    ],
    [
      commandLine('docker', ['ps', '-a', '--format', PS_FORMAT]),
      okResult('slot0001|proj-slots-sandbox-1|running|Up 2 hours (healthy)|sandbox-1\n'),
    ],
    [
      commandLine('docker', [
        'ps',
        '-a',
        '--filter',
        'label=com.docker.compose.project=aman-main',
        '--format',
        PS_FORMAT,
      ]),
      okResult('app00001|aman-main-app-1|running|Up 2 hours (healthy)|app\n'),
    ],
    [
      commandLine('docker', [
        'exec',
        '-e',
        `AMAN_HOST_EPOCH=${String(NOW)}`,
        'app00001',
        'aman',
        'doctor',
        '--text',
        '--local',
      ]),
      okResult(`${EXEC_LINES}\n`),
    ],
  ]);
}

function signedManifestBytes({
  exeData = NEW_PROGRAM,
  archiveData = ARCHIVE_BYTES,
}: { exeData?: Uint8Array; archiveData?: Uint8Array | null } = {}): {
  manifestBytes: Uint8Array;
  signatureText: string;
} {
  const files = [
    { name: ASSET_NAME, data: exeData },
    { name: 'aman-darwin-arm64', data: new TextEncoder().encode('the mac build') },
    { name: 'aman-linux-x64', data: new TextEncoder().encode('the linux build') },
  ];
  if (archiveData !== null) {
    files.push({ name: ARCHIVE_NAME, data: archiveData });
  }
  const manifest = buildManifest({ release: RELEASE_TAG, files, sourceIds: IDS });
  const manifestBytes = manifestToBytes(manifest);
  const signatureText = signMinisign({
    data: manifestBytes,
    privateKeyDer: testPrivateKeyDer(),
    keyNum: testKeyNum(),
  });
  return { manifestBytes, signatureText };
}

interface World {
  deps: UpgradeDeps;
  printed: string[];
  recording: RecordingProcessRunner;
  jobs: FakeWindowsJobs;
  programsDir: string;
  fetchedUrls: string[];
  questions: string[];
}

interface WorldOptions {
  answers?: Map<string, ProcessResult>;
  byteAnswers?: Map<string, ProcessBytesResult>;
  wrapRunner?: (inner: ProcessRunner) => ProcessRunner;
  summary?: StateSummary;
  programBytes?: Uint8Array | null;
  confirmAnswer?: boolean;
  manifest?: { manifestBytes: Uint8Array; signatureText: string };
  servedExe?: Uint8Array;
  servedArchive?: Uint8Array;
  kind?: 'windows' | 'linux';
}

async function write(path: string, text: string, mode?: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
  if (mode !== undefined) {
    await chmod(path, mode);
  }
}

// Stands in for a folder appearing where the program belongs while the
// new program runs its smoke test, so the swap's last rename can no
// longer happen and neither can putting the old program back. Every
// command still gets the stub's answer.
class BlockingRunner implements ProcessRunner {
  private readonly inner: ProcessRunner;

  constructor(inner: ProcessRunner) {
    this.inner = inner;
  }

  async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    if (command.endsWith('aman.exe.new')) {
      const exeDir = join(dirname(command), 'aman.exe');
      mkdirSync(exeDir, { recursive: true });
      writeFileSync(join(exeDir, 'keep.txt'), 'in the way');
    }
    return this.inner.run(command, args);
  }

  runBytes(command: string, args: readonly string[], stdin: Uint8Array): Promise<ProcessBytesResult> {
    return this.inner.runBytes(command, args, stdin);
  }
}

// A Windows computer with Aman installed and adopted, a healthy Docker,
// and the release server answering from a table.
async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const personHome = await mkdtemp(join(tmpdir(), 'aman-upgrade-person-'));
  const stateHome = join(personHome, '.amanuensis');
  const checkoutDir = await mkdtemp(join(tmpdir(), 'aman-upgrade-checkout-'));
  await write(join(checkoutDir, 'installer', 'install.sh'), '#!/bin/sh\n', 0o755);
  await write(join(checkoutDir, 'installer', 'lib', 'part.sh'), '# part\n', 0o644);
  await chmod(checkoutDir, 0o755);
  await chmod(join(checkoutDir, 'installer'), 0o755);
  await chmod(join(checkoutDir, 'installer', 'lib'), 0o755);
  await write(join(personHome, 'Library', 'LaunchAgents', 'com.amanuensis.backup.plist'), '<plist/>\n');

  const programsDir = await mkdtemp(join(tmpdir(), 'aman-upgrade-programs-'));
  const programBytes = options.programBytes === undefined ? OLD_PROGRAM : options.programBytes;
  if (programBytes !== null) {
    await writeFile(join(programsDir, 'aman.exe'), programBytes);
  }

  const summary = options.summary ?? installedSummary();
  summary.sourceCheckout = checkoutDir;

  const manifest = options.manifest ?? signedManifestBytes();
  const servedExe = options.servedExe ?? NEW_PROGRAM;
  const servedArchive = options.servedArchive ?? ARCHIVE_BYTES;
  const fetchedUrls: string[] = [];
  const fetchBytes = (url: string): Promise<FetchBytesResult> => {
    fetchedUrls.push(url);
    if (url === MANIFEST_URL) {
      return Promise.resolve({ data: manifest.manifestBytes });
    }
    if (url === SIGNATURE_URL) {
      return Promise.resolve({ data: new TextEncoder().encode(manifest.signatureText) });
    }
    if (url === ASSET_URL) {
      return Promise.resolve({ data: servedExe });
    }
    if (url === ARCHIVE_URL) {
      return Promise.resolve({ data: servedArchive });
    }
    return Promise.resolve({ unreachable: true });
  };

  const answers = options.answers ?? readyAnswers();
  const smokeLine = commandLine(join(programsDir, 'aman.exe.new'), ['--version']);
  if (!answers.has(smokeLine)) {
    answers.set(smokeLine, okResult('aman 0.2.0\n'));
  }
  const stub = new StubProcessRunner(answers, options.byteAnswers ?? new Map());
  const recording = new RecordingProcessRunner(options.wrapRunner === undefined ? stub : options.wrapRunner(stub));
  const jobs = new FakeWindowsJobs({
    localAppDataDir: 'C:\\Users\\Friend\\AppData\\Local',
    selfExePath: 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
    startMenuProgramsDir: START_MENU_DIR,
  });
  const printed: string[] = [];
  const questions: string[] = [];
  const deps: UpgradeDeps = {
    host: new FakeHost({ kind: options.kind ?? 'windows', memoryBytes: 16 * GIB, kernelRelease: '6.8.0-45-generic' }),
    runner: recording,
    store: storeWith(summary),
    print: (line: string) => {
      printed.push(line);
    },
    confirm: (question: string) => {
      questions.push(question);
      return Promise.resolve(options.confirmAnswer ?? true);
    },
    fetchBytes,
    programsDir,
    jobs,
    arch: 'x64',
    releasePublicKey: TEST_PUBLIC_KEY_MINISIGN,
    now: () => NOW,
    homeDir: personHome,
    stateHome,
    osReleasePath: join(personHome, 'os-release'),
    dockerConfigDir: join(personHome, '.docker'),
    appService: 'app',
  };
  return { deps, printed, recording, jobs, programsDir, fetchedUrls, questions };
}

function goldenLines(world: World): string {
  return world.recording
    .goldenText()
    .replaceAll(SETUP_IMAGE, '<setup image>')
    .replaceAll(world.programsDir, '<programs>');
}

const UNPACK_LINE = commandLine('docker', [
  'run',
  '--rm',
  '-i',
  '--network',
  'none',
  '-v',
  'aman_source:/src',
  SETUP_IMAGE,
  'sh',
  '-c',
  'cd /src || exit 1; rm -rf -- * .[!.]*; tar -xzf - --strip-components=1 && test -f installer/install.sh',
]);

const CONTAINER_LINE = commandLine('docker', [
  'run',
  '--rm',
  '-v',
  '/var/run/docker.sock:/var/run/docker.sock',
  '-v',
  'aman_home:/root/.amanuensis',
  '-v',
  'aman_source:/src',
  '-w',
  '/src',
  SETUP_IMAGE,
  'installer/install.sh',
  'upgrade',
]);

function happyAnswers(containerResult: ProcessResult): {
  answers: Map<string, ProcessResult>;
  byteAnswers: Map<string, ProcessBytesResult>;
} {
  const answers = readyAnswers();
  answers.set(CONTAINER_LINE, containerResult);
  return { answers, byteAnswers: new Map([[UNPACK_LINE, okBytesResult(new Uint8Array())]]) };
}

test('the happy path swaps the program, unpacks the source and runs the container upgrade', async () => {
  const { answers, byteAnswers } = happyAnswers(okResult('The new version is running.\n'));
  const world = await makeWorld({ answers, byteAnswers });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 0);
  assert.deepEqual(world.questions, [upgradeQuestionLine(RELEASE_TAG)]);
  assert.deepEqual(world.fetchedUrls, [MANIFEST_URL, SIGNATURE_URL, ASSET_URL, ARCHIVE_URL]);
  assert.deepEqual(world.printed, [
    UPGRADE_EXE_IN_PLACE_LINE,
    'The new version is running.',
    upgradeDoneLine(RELEASE_TAG),
  ]);
  assert.deepEqual(new Uint8Array(await readFile(join(world.programsDir, 'aman.exe'))), NEW_PROGRAM);
  assert.deepEqual(new Uint8Array(await readFile(join(world.programsDir, 'aman.exe.old'))), OLD_PROGRAM);
  assert.equal(existsSync(join(world.programsDir, 'aman.exe.new')), false);
  // The Update Aman entry is refreshed through the Windows jobs, the
  // same owner the adopt and open steps use.
  assert.deepEqual(world.jobs.ops, ['update']);
  assert.deepEqual(
    world.jobs.shortcuts.filter(shortcut => shortcut.args === 'upgrade'),
    [
      {
        path: 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Update Aman.lnk',
        target: 'C:\\Users\\Friend\\AppData\\Local\\Programs\\Amanuensis\\aman.exe',
        args: 'upgrade',
      },
    ],
  );
  const golden = await readFile(new URL('../golden/upgrade-commands.txt', import.meta.url), 'utf8');
  assert.equal(goldenLines(world), golden);
});

test('an up-to-date program is left alone, with no question and no commands', async () => {
  const world = await makeWorld({ programBytes: NEW_PROGRAM });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 0);
  assert.deepEqual(world.printed, [UPGRADE_UP_TO_DATE_LINE]);
  assert.deepEqual(world.questions, []);
  assert.deepEqual(world.fetchedUrls, [MANIFEST_URL, SIGNATURE_URL]);
  assert.equal(world.recording.lines().length, 0);
});

test('a manifest that fails its signature check refuses before anything moves', async () => {
  const signed = signedManifestBytes();
  const tampered = new Uint8Array(signed.manifestBytes);
  tampered[20] = tampered[20] === 65 ? 66 : 65;
  const world = await makeWorld({
    manifest: { manifestBytes: tampered, signatureText: signed.signatureText },
  });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(VERIFY_SIGNATURE_BAD)]);
  assert.deepEqual(world.questions, []);
  assert.equal(world.recording.lines().length, 0);
  assert.deepEqual(new Uint8Array(await readFile(join(world.programsDir, 'aman.exe'))), OLD_PROGRAM);
  assert.equal(existsSync(join(world.programsDir, 'aman.exe.new')), false);
});

test('an unreachable release page is a download refusal', async () => {
  const world = await makeWorld({});
  world.deps.fetchBytes = () => Promise.resolve({ unreachable: true });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(UPGRADE_DOWNLOAD_FAILED)]);
  assert.equal(world.recording.lines().length, 0);
});

test('a release page that answers without the record names the page, not the connection', async () => {
  const world = await makeWorld({});
  world.deps.fetchBytes = () => Promise.resolve({ missing: true });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(UPGRADE_RELEASE_NOT_THERE)]);
  assert.equal(world.recording.lines().length, 0);
});

test('a release record with no source archive refuses before the gate', async () => {
  const world = await makeWorld({ manifest: signedManifestBytes({ archiveData: null }) });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(UPGRADE_SOURCE_MISSING)]);
  assert.deepEqual(world.questions, []);
  assert.equal(world.recording.lines().length, 0);
});

test('the health gate refuses on the first failing doctor check, in the doctor words', async () => {
  const world = await makeWorld({ answers: new Map() });
  const gate = await runDoctorChecks(world.deps, { local: true });
  const firstFail = gate.records.find(record => record.state === 'fail');
  assert.ok(firstFail !== undefined);
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [firstFail.detail, problemText(upgradeNotReadyProblem(firstFail.fix))]);
  assert.deepEqual(world.questions, []);
  assert.deepEqual(world.fetchedUrls, [MANIFEST_URL, SIGNATURE_URL]);
  assert.deepEqual(new Uint8Array(await readFile(join(world.programsDir, 'aman.exe'))), OLD_PROGRAM);
});

test('a no at the one question changes nothing', async () => {
  const world = await makeWorld({ confirmAnswer: false });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 0);
  assert.deepEqual(world.printed, [UPGRADE_DECLINED_LINE]);
  assert.deepEqual(world.fetchedUrls, [MANIFEST_URL, SIGNATURE_URL]);
  assert.ok(world.recording.lines().every(line => !line.includes('docker run') && !line.includes('powershell')));
  assert.deepEqual(new Uint8Array(await readFile(join(world.programsDir, 'aman.exe'))), OLD_PROGRAM);
  assert.equal(existsSync(join(world.programsDir, 'aman.exe.old')), false);
});

test('a downloaded program that does not match the record refuses before any file moves', async () => {
  const { answers, byteAnswers } = happyAnswers(okResult(''));
  const world = await makeWorld({
    answers,
    byteAnswers,
    servedExe: new TextEncoder().encode('a build that is not the recorded one'),
  });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(verifyChangedProblem(ASSET_NAME))]);
  assert.deepEqual(new Uint8Array(await readFile(join(world.programsDir, 'aman.exe'))), OLD_PROGRAM);
  assert.equal(existsSync(join(world.programsDir, 'aman.exe.new')), false);
  assert.equal(existsSync(join(world.programsDir, 'aman.exe.old')), false);
  assert.ok(world.recording.lines().every(line => !line.includes('docker run')));
});

test('a new program that fails its smoke test puts the old one back', async () => {
  const { answers, byteAnswers } = happyAnswers(okResult(''));
  const world = await makeWorld({ answers, byteAnswers });
  const smokeLine = commandLine(join(world.programsDir, 'aman.exe.new'), ['--version']);
  answers.set(smokeLine, { exitCode: 1, stdout: '', stderr: 'it does not start', started: true });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(UPGRADE_SMOKE_FAILED)]);
  assert.deepEqual(new Uint8Array(await readFile(join(world.programsDir, 'aman.exe'))), OLD_PROGRAM);
  assert.equal(existsSync(join(world.programsDir, 'aman.exe.new')), false);
  assert.equal(existsSync(join(world.programsDir, 'aman.exe.old')), false);
  assert.ok(world.recording.lines().every(line => !line.includes('docker run')));
});

test('a last rename that cannot happen says where the checked program waits and what to run', async () => {
  const { answers, byteAnswers } = happyAnswers(okResult(''));
  const world = await makeWorld({ answers, byteAnswers, wrapRunner: inner => new BlockingRunner(inner) });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(UPGRADE_OLD_PROGRAM_NOT_BACK)]);
  // The end state the words describe: the checked new program stays as
  // aman.exe.new, and the old program is kept whole beside it.
  assert.deepEqual(new Uint8Array(await readFile(join(world.programsDir, 'aman.exe.new'))), NEW_PROGRAM);
  assert.deepEqual(new Uint8Array(await readFile(join(world.programsDir, 'aman.exe.old'))), OLD_PROGRAM);
  assert.ok(world.recording.lines().every(line => !line.includes('docker run')));
});

test('a source archive that will not unpack stops before the container upgrade', async () => {
  const { answers } = happyAnswers(okResult(''));
  const world = await makeWorld({
    answers,
    byteAnswers: new Map([
      [UNPACK_LINE, { exitCode: 1, stdout: new Uint8Array(), stderr: 'tar failed', started: true }],
    ]),
  });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [UPGRADE_EXE_IN_PLACE_LINE, problemText(UPGRADE_SOURCE_FAILED)]);
  assert.ok(!world.recording.lines().includes(CONTAINER_LINE));
});

test('a rolled-back container upgrade says the previous version is back', async () => {
  const { answers, byteAnswers } = happyAnswers({
    exitCode: 1,
    stdout: 'The upgrade failed. Putting the previous version back.\n',
    stderr: 'The previous version is back, with its data restored from the backup.\n',
    started: true,
  });
  const world = await makeWorld({ answers, byteAnswers });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.equal(world.printed[world.printed.length - 1], problemText(UPGRADE_ROLLED_BACK));
});

test('a busy state lock inside the container upgrade is the busy problem', async () => {
  const { answers, byteAnswers } = happyAnswers({
    exitCode: 1,
    stdout: '',
    stderr: 'Another install is running right now. Wait for it to finish.\n',
    started: true,
  });
  const world = await makeWorld({ answers, byteAnswers });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.equal(world.printed[world.printed.length - 1], problemText(UPGRADE_BUSY));
});

test('a container that will not start for the upgrade is the docker problem', async () => {
  const { answers, byteAnswers } = happyAnswers({ exitCode: 1, stdout: '', stderr: '', started: false });
  const world = await makeWorld({ answers, byteAnswers });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.equal(world.printed[world.printed.length - 1], problemText(UPGRADE_DOCKER_NOT_ANSWERING));
});

test('upgrade on a computer that is not Windows refuses plainly', async () => {
  const world = await makeWorld({ kind: 'linux' });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(UPGRADE_NOT_WINDOWS)]);
  assert.equal(world.fetchedUrls.length, 0);
});

test('upgrade with nothing installed is the not-installed problem', async () => {
  const summary = installedSummary();
  summary.release = null;
  summary.instances = [];
  const world = await makeWorld({ summary });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(NOT_INSTALLED)]);
});

test('upgrade with the program missing says to run Setup once', async () => {
  const world = await makeWorld({ programBytes: null });
  const exitCode = await runUpgrade(world.deps);
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(UPGRADE_PROGRAM_MISSING)]);
});

test('the next start removes the kept old program once the new one runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aman-upgrade-swap-'));
  await writeFile(join(dir, 'aman.exe'), NEW_PROGRAM);
  await writeFile(join(dir, 'aman.exe.old'), OLD_PROGRAM);
  resolvePendingSwap(dir);
  assert.deepEqual(new Uint8Array(await readFile(join(dir, 'aman.exe'))), NEW_PROGRAM);
  assert.equal(existsSync(join(dir, 'aman.exe.old')), false);
});

test('a start with the program missing and the old one kept puts the old one back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aman-upgrade-swap-'));
  await writeFile(join(dir, 'aman.exe.old'), OLD_PROGRAM);
  resolvePendingSwap(dir);
  assert.deepEqual(new Uint8Array(await readFile(join(dir, 'aman.exe'))), OLD_PROGRAM);
  assert.equal(existsSync(join(dir, 'aman.exe.old')), false);
});

test('a start with no swap pending changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aman-upgrade-swap-'));
  await writeFile(join(dir, 'aman.exe'), OLD_PROGRAM);
  resolvePendingSwap(dir);
  assert.deepEqual(new Uint8Array(await readFile(join(dir, 'aman.exe'))), OLD_PROGRAM);
});
