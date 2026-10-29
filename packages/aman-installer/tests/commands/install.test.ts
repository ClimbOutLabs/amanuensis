import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runInstall, type InstallDeps } from '../../src/commands/install.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs, type FakeWindowsJobStep } from '../../src/host/fakeWindowsJobs.ts';
import { DOCKER_DESKTOP_DOWNLOAD_URL } from '../../src/host/windowsJobs.ts';
import {
  ADOPTED_LINE,
  ADOPT_NOT_INSTALLED,
  FILES_MADE_PRIVATE_LINE,
  INSTALL_BUSY,
  INSTALL_CONTINUING_LINE,
  INSTALL_DOCKER_UNTRUSTED,
  INSTALL_DONE_LINE,
  INSTALL_DRY_RUN_LINES,
  INSTALL_KEY_EMPTY_LINE,
  INSTALL_NOT_WINDOWS,
  INSTALL_NO_ANSWER,
  INSTALL_PASSWORD_MISMATCH_LINE,
  INSTALL_RELEASE_NOT_THERE,
  INSTALL_RESTART_NEEDED,
  INSTALL_RESUME_FAILED,
  LOW_MEMORY,
  NETWORK_OPEN_LINE,
  UPGRADE_UP_TO_DATE_LINE,
  VERIFY_SIGNATURE_BAD,
  installPasswordProblem,
  openReadyLine,
  problemText,
} from '../../src/messages.ts';
import type { FetchBytesResult } from '../../src/release/download.ts';
import { buildManifest, manifestToBytes, type SourceIds } from '../../src/release/manifest.ts';
import { signMinisign } from '../../src/release/minisign.ts';
import {
  RecordingProcessRunner,
  commandLine,
  okBytesResult,
  okResult,
  type ProcessBytesResult,
  type ProcessResult,
  type ProcessRunner,
} from '../../src/runner/processRunner.ts';
import { createStateStore, parseRegistry, type StateStore, type StateSummary } from '../../src/state/state.ts';
import { volumeBackend } from '../../src/state/volumeBackend.ts';
import { TEST_PUBLIC_KEY_MINISIGN, testKeyNum, testPrivateKeyDer } from '../release/testKeys.ts';

const NOW = 1791633600;
const GIB = 1024 * 1024 * 1024;
const RELEASE_TAG = 'v9.9.9';
const ASSET_NAME = 'aman-windows-x64.exe';
const ARCHIVE_NAME = 'amanuensis-v9.9.9.tar.gz';
const PROGRAM = new TextEncoder().encode('the aman program');
const ARCHIVE = new TextEncoder().encode('the source archive bytes');
const DOCKER_INSTALLER = new TextEncoder().encode('the docker desktop installer');
const PASSWORD = 'Password1!';
const KEY = 'tf-key-1234567890';
const IDS: SourceIds = {
  'aman-app': 'aman-app:0123456789ab',
  'aman-stt': 'aman-stt:0123456789cd',
  'aman-calendar-caldav': 'aman-calendar-caldav:0123456789ef',
};
const RELEASE_BASE = 'https://github.com/ClimbOutLabs/amanuensis/releases';
const MANIFEST_URL = `${RELEASE_BASE}/latest/download/manifest.json`;
const SIGNATURE_URL = `${RELEASE_BASE}/latest/download/manifest.json.minisig`;
const ARCHIVE_URL = `${RELEASE_BASE}/download/${RELEASE_TAG}/${ARCHIVE_NAME}`;
const LOCAL_APP_DATA = 'C:\\Users\\Friend\\AppData\\Local';
const START_MENU_DIR = 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';
const CERT = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n';

function emptySummary(): StateSummary {
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
  };
}

function installedSummary(): StateSummary {
  return {
    ...emptySummary(),
    instances: [
      {
        name: 'main',
        entries: parseRegistry(
          [
            'name=main',
            'app_port=8791',
            'login_port=5556',
            'tls=local',
            'tls_port=8443',
            'origins=http://127.0.0.1:8791,https://localhost:8443',
            'public_url=https://localhost:8443',
          ].join('\n'),
        ),
      },
    ],
  };
}

// The state store the flow reads: an install the container step made
// appears once the step has run, as it does on a real computer.
class WorldStore implements StateStore {
  installed = false;
  modes: string[] = [];

  readSummary(): Promise<StateSummary> {
    return Promise.resolve(this.installed ? installedSummary() : emptySummary());
  }

  readCaCertificate(): Promise<string | null> {
    return Promise.resolve(this.installed ? CERT : null);
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

  setBackupsMode(mode: 'daily' | 'off'): Promise<boolean> {
    this.modes.push(mode);
    return Promise.resolve(true);
  }
}

interface WorldOptions {
  kind?: 'windows' | 'darwin';
  dockerInstalled?: boolean;
  dockerRunning?: boolean;
  dockerNeverRuns?: boolean;
  lowMemory?: boolean;
  installerSigner?: string | null;
  runOncePending?: boolean;
  runOnceValueName?: string;
  failRunOnceSet?: boolean;
  storeInstalled?: boolean;
  askAnswers?: readonly (string | null)[];
  secretAnswers?: readonly (string | null)[];
  containerStdout?: string;
  containerExit?: number;
  tamperManifest?: boolean;
  noDockerDownload?: boolean;
}

// The computer the flow runs on: Docker in the state the test asks
// for, the release server answering from a table, and the container
// install making the install appear in the store when it succeeds.
class WorldRunner implements ProcessRunner {
  private readonly options: WorldOptions;
  private readonly jobs: FakeWindowsJobs;
  private readonly store: WorldStore;
  dockerInstalled: boolean;
  installRuns: { args: readonly string[]; stdin: Uint8Array }[] = [];
  installerRuns: (readonly string[])[] = [];

  constructor(options: WorldOptions, jobs: FakeWindowsJobs, store: WorldStore) {
    this.options = options;
    this.jobs = jobs;
    this.store = store;
    this.dockerInstalled = options.dockerInstalled ?? true;
  }

  private dockerRunning(): boolean {
    if (this.options.dockerNeverRuns === true) {
      return false;
    }
    return (this.options.dockerRunning ?? true) || this.jobs.dockerDesktopStarts > 0;
  }

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    if (command === this.jobs.dockerDesktopInstallerPath) {
      this.installerRuns.push(args);
      this.dockerInstalled = true;
      return Promise.resolve(okResult(''));
    }
    if (command !== 'docker') {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '', started: false });
    }
    const line = commandLine(command, args);
    if (line === 'docker --version') {
      return Promise.resolve(
        this.dockerInstalled
          ? okResult('Docker version 27.3.1, build 0a1b2c3\n')
          : { exitCode: 1, stdout: '', stderr: '', started: false },
      );
    }
    if (line === 'docker info --format {{.ServerVersion}}') {
      return Promise.resolve(
        this.dockerInstalled && this.dockerRunning()
          ? okResult('27.3.1\n')
          : { exitCode: 1, stdout: '', stderr: 'docker is not running\n', started: true },
      );
    }
    if (line === 'docker compose version') {
      return Promise.resolve(okResult('Docker Compose version v2.29.1\n'));
    }
    if (line === 'docker info --format {{.MemTotal}}') {
      return Promise.resolve(okResult(`${String(this.options.lowMemory === true ? 4 * GIB : 8 * GIB)}\n`));
    }
    if (args.includes('refresh')) {
      return Promise.resolve(okResult('Aman is reachable on your home network.\n'));
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: '', started: false });
  }

  runBytes(command: string, args: readonly string[], stdin: Uint8Array): Promise<ProcessBytesResult> {
    void command;
    if (args.includes('sh')) {
      return Promise.resolve(okBytesResult(new Uint8Array()));
    }
    if (args.includes('installer/install.sh')) {
      this.installRuns.push({ args, stdin });
      const exit = this.options.containerExit ?? 0;
      if (exit === 0) {
        this.store.installed = true;
      }
      return Promise.resolve({
        exitCode: exit,
        stdout: new TextEncoder().encode(this.options.containerStdout ?? 'Instance main is ready.\n'),
        stderr: '',
        started: true,
      });
    }
    return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false });
  }
}

interface World {
  deps: InstallDeps;
  printed: string[];
  recording: RecordingProcessRunner;
  jobs: FakeWindowsJobs;
  store: WorldStore;
  runner: WorldRunner;
  asked: { kind: 'ask' | 'secret'; question: string }[];
}

async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const programsDir = await mkdtemp(join(tmpdir(), 'aman-install-programs-'));
  await writeFile(join(programsDir, 'aman.exe'), PROGRAM);
  const jobs = new FakeWindowsJobs({
    localAppDataDir: LOCAL_APP_DATA,
    selfExePath: 'C:\\Users\\Friend\\Downloads\\Aman-Setup.exe',
    startMenuProgramsDir: START_MENU_DIR,
    ...(options.installerSigner === undefined ? {} : { installerSigner: options.installerSigner }),
    ...(options.runOncePending === undefined ? {} : { runOncePending: options.runOncePending }),
    ...(options.runOnceValueName === undefined ? {} : { runOnceValueName: options.runOnceValueName }),
    ...(options.failRunOnceSet === true ? { failSteps: new Set<FakeWindowsJobStep>(['runOnceSet']) } : {}),
  });
  const store = new WorldStore();
  store.installed = options.storeInstalled ?? false;
  const runner = new WorldRunner(options, jobs, store);
  const recording = new RecordingProcessRunner(runner);
  const manifest = buildManifest({
    release: RELEASE_TAG,
    files: [
      { name: ASSET_NAME, data: PROGRAM },
      { name: ARCHIVE_NAME, data: ARCHIVE },
    ],
    sourceIds: IDS,
  });
  let manifestBytes = manifestToBytes(manifest);
  if (options.tamperManifest === true) {
    manifestBytes = new Uint8Array(manifestBytes);
    manifestBytes[10] = (manifestBytes[10] ?? 0) + 1;
  }
  const signatureText = signMinisign({
    data: manifestToBytes(manifest),
    privateKeyDer: testPrivateKeyDer(),
    keyNum: testKeyNum(),
  });
  const fetchBytes = (url: string): Promise<FetchBytesResult> => {
    if (url === MANIFEST_URL) {
      return Promise.resolve({ data: manifestBytes });
    }
    if (url === SIGNATURE_URL) {
      return Promise.resolve({ data: new TextEncoder().encode(signatureText) });
    }
    if (url === ARCHIVE_URL) {
      return Promise.resolve({ data: ARCHIVE });
    }
    if (url === DOCKER_DESKTOP_DOWNLOAD_URL) {
      return Promise.resolve(options.noDockerDownload === true ? { unreachable: true } : { data: DOCKER_INSTALLER });
    }
    return Promise.resolve({ unreachable: true });
  };
  const printed: string[] = [];
  const asked: World['asked'] = [];
  const askQueue = [...(options.askAnswers ?? ['friend@example.com', 'yes'])];
  const secretQueue = [...(options.secretAnswers ?? [PASSWORD, PASSWORD, KEY])];
  let nowValue = NOW;
  const personHome = await mkdtemp(join(tmpdir(), 'aman-install-person-'));
  const deps: InstallDeps = {
    host: new FakeHost({ kind: options.kind ?? 'windows', memoryBytes: 16 * GIB }),
    runner: recording,
    store,
    jobs,
    print: (line: string) => {
      printed.push(line);
    },
    now: () => nowValue,
    homeDir: personHome,
    stateHome: null,
    osReleasePath: join(personHome, 'os-release'),
    dockerConfigDir: join(personHome, '.docker'),
    appService: 'app',
    probeHealth: () => Promise.resolve(true),
    sleep: (ms: number) => {
      nowValue += Math.floor(ms / 1000);
      return Promise.resolve();
    },
    ask: (question: string) => {
      asked.push({ kind: 'ask', question });
      return Promise.resolve(askQueue.shift() ?? null);
    },
    askSecret: (question: string) => {
      asked.push({ kind: 'secret', question });
      return Promise.resolve(secretQueue.shift() ?? null);
    },
    confirm: () => Promise.resolve(true),
    fetchBytes,
    programsDir,
    arch: 'x64',
    interfaces: {
      Ethernet: [
        {
          address: '192.168.1.20',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: '192.168.1.20/24',
        },
      ],
    },
    hostName: 'FRIEND-PC',
    releasePublicKey: TEST_PUBLIC_KEY_MINISIGN,
  };
  return { deps, printed, recording, jobs, store, runner, asked };
}

const PAGE_URL = 'file:///C:/Users/Friend/AppData/Local/Amanuensis/Getting started.html';

test('the first install asks the four questions, installs, and opens the getting started page once', async () => {
  const world = await makeWorld();
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.deepEqual(
    world.asked.map(entry => `${entry.kind}:${entry.question}`),
    [
      'ask:Your email, used to sign in:',
      'secret:Choose a password (at least 8 characters, not shown):',
      'secret:Type it again:',
      'secret:Paste your model key (not shown):',
      'ask:Also use Aman from your phone and other devices on your home Wi-Fi? (yes or no):',
    ],
  );
  assert.equal(world.runner.installRuns.length, 1);
  const run = world.runner.installRuns[0];
  assert.ok(run !== undefined);
  assert.deepEqual(run.args.slice(run.args.indexOf('installer/install.sh')), [
    'installer/install.sh',
    '--yes',
    '--name',
    'main',
    '--email',
    'friend@example.com',
    '--password-stdin',
    '--token-factory-key-stdin',
    '--tls',
    'local',
    '--address',
    'localhost',
    '--backups',
    'daily',
  ]);
  assert.equal(new TextDecoder().decode(run.stdin), `${PASSWORD}\n${KEY}\n`);
  // The secrets ride on the input only: no command line holds them.
  for (const line of world.recording.lines()) {
    assert.ok(!line.includes(PASSWORD), line);
    assert.ok(!line.includes(KEY), line);
  }
  assert.deepEqual(world.store.modes, ['daily']);
  assert.equal(world.jobs.firewallOpen, true);
  // The browser opens Aman, then the page, each once.
  assert.deepEqual(world.jobs.browserUrls, ['https://localhost:8443', PAGE_URL]);
  const page = world.jobs.gettingStartedText;
  assert.ok(page !== null);
  assert.ok(page.includes('https://localhost:8443'));
  assert.ok(page.includes('Settings, then Personalization'));
  assert.ok(page.includes('Settings, then Models'));
  assert.ok(!page.includes('\u2014'));
  assert.ok(world.printed.includes(ADOPTED_LINE));
  assert.ok(world.printed.includes(UPGRADE_UP_TO_DATE_LINE));
  assert.ok(world.printed.includes(FILES_MADE_PRIVATE_LINE));
  assert.ok(world.printed.includes(openReadyLine('https://localhost:8443')));
  assert.ok(world.printed.includes(NETWORK_OPEN_LINE));
  assert.equal(world.printed.at(-1), INSTALL_DONE_LINE);
});

// The state of a computer whose aman_home volume exists but holds
// nothing yet: Docker answers the volume's listings, every one empty,
// and no file can be read out of it. Everything else about the world
// is the one the other install tests use.
class FreshVolumeRunner implements ProcessRunner {
  private readonly inner: ProcessRunner;

  constructor(inner: ProcessRunner) {
    this.inner = inner;
  }

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    if (args.includes('ls')) {
      return Promise.resolve(okResult(''));
    }
    return this.inner.run(command, args);
  }

  runBytes(command: string, args: readonly string[], stdin: Uint8Array): Promise<ProcessBytesResult> {
    if (args.includes('cat')) {
      return Promise.resolve({
        exitCode: 1,
        stdout: new Uint8Array(),
        stderr: 'cat: no such file or directory',
        started: true,
      });
    }
    return this.inner.runBytes(command, args, stdin);
  }
}

test('a first install on a fresh volume asks the questions and runs the container install', async () => {
  const world = await makeWorld();
  world.deps.store = createStateStore(volumeBackend(new FreshVolumeRunner(world.runner)));
  const code = await runInstall(world.deps, { dryRun: false });
  assert.deepEqual(
    world.asked.map(entry => `${entry.kind}:${entry.question}`),
    [
      'ask:Your email, used to sign in:',
      'secret:Choose a password (at least 8 characters, not shown):',
      'secret:Type it again:',
      'secret:Paste your model key (not shown):',
      'ask:Also use Aman from your phone and other devices on your home Wi-Fi? (yes or no):',
    ],
  );
  assert.equal(world.runner.installRuns.length, 1);
  // The fake container step cannot write the volume, so the steps that
  // finish an install find nothing in it and the adopt step says so.
  // Those steps are covered by the WorldStore tests above; this test
  // pins that a fresh volume no longer stops the flow before them.
  assert.equal(code, 1);
  assert.ok(world.printed.includes(problemText(ADOPT_NOT_INSTALLED)));
});

test('the golden file holds the command lines of a first install with no Docker yet', async () => {
  const world = await makeWorld({ dockerInstalled: false, dockerRunning: false });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  const golden = readFileSync(new URL('../golden/install-commands.txt', import.meta.url), 'utf8');
  assert.equal(world.recording.goldenText(), golden);
});

test('a dry run prints the steps and asks and changes nothing', async () => {
  const world = await makeWorld({ dockerInstalled: false });
  const code = await runInstall(world.deps, { dryRun: true });
  assert.equal(code, 0);
  assert.deepEqual(world.printed, [...INSTALL_DRY_RUN_LINES]);
  assert.deepEqual(world.asked, []);
  assert.deepEqual(world.jobs.ops, []);
  assert.deepEqual(world.recording.lines(), []);
});

test('install refuses on a computer that is not Windows', async () => {
  const world = await makeWorld({ kind: 'darwin' });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.deepEqual(world.printed, [problemText(INSTALL_NOT_WINDOWS)]);
  assert.deepEqual(world.asked, []);
});

test('a Docker Desktop download that is not from Docker Inc is refused before it runs', async () => {
  const world = await makeWorld({
    dockerInstalled: false,
    dockerRunning: false,
    installerSigner: 'CN=Somebody Else, O=Somebody Else',
  });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.deepEqual(world.printed, [problemText(INSTALL_DOCKER_UNTRUSTED)]);
  assert.deepEqual(world.runner.installerRuns, []);
  assert.deepEqual(world.asked, []);
  assert.deepEqual(world.jobs.browserUrls, []);
});

test('a Docker Desktop download that cannot be checked is refused the same way', async () => {
  const world = await makeWorld({ dockerInstalled: false, dockerRunning: false, installerSigner: null });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.deepEqual(world.printed, [problemText(INSTALL_DOCKER_UNTRUSTED)]);
  assert.deepEqual(world.runner.installerRuns, []);
});

test('a signer whose names only contain Docker Inc is refused before it runs', async () => {
  const world = await makeWorld({
    dockerInstalled: false,
    dockerRunning: false,
    installerSigner: 'CN=Docker Inc Ltd, O=Docker Inc Ltd, C=US',
  });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.deepEqual(world.printed, [problemText(INSTALL_DOCKER_UNTRUSTED)]);
  assert.deepEqual(world.runner.installerRuns, []);
});

test('a signer whose organisation is exactly Docker Inc is let through', async () => {
  const world = await makeWorld({
    dockerInstalled: false,
    dockerRunning: false,
    installerSigner: 'CN=Docker Desktop, O=Docker Inc, L=San Francisco, S=California, C=US',
  });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.deepEqual(world.runner.installerRuns, [['install', '--quiet', '--accept-license']]);
});

test('when Docker Desktop is installed by the flow, the resume entry is set and later taken down', async () => {
  const world = await makeWorld({ dockerInstalled: false, dockerRunning: false });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.deepEqual(world.runner.installerRuns, [['install', '--quiet', '--accept-license']]);
  assert.deepEqual(world.jobs.installerBytes, DOCKER_INSTALLER);
  const setAt = world.jobs.ops.indexOf('runOnceSet');
  const clearAt = world.jobs.ops.indexOf('runOnceClear');
  assert.ok(setAt !== -1 && clearAt > setAt, world.jobs.ops.join(','));
  assert.equal(world.jobs.runOncePending, false);
  assert.ok(world.jobs.awakeRequests >= 1);
});

test('when Docker never answers after its install, the flow asks for a restart and keeps the resume entry', async () => {
  const world = await makeWorld({ dockerInstalled: false, dockerRunning: false, dockerNeverRuns: true });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.deepEqual(world.printed, [problemText(INSTALL_RESTART_NEEDED)]);
  assert.equal(world.jobs.runOncePending, true);
  assert.deepEqual(world.asked, []);
});

test('a run the restart reopened says it is continuing, and takes the resume entry down', async () => {
  const world = await makeWorld({ runOncePending: true });
  // Windows opens the program the entry names at the sign-in: the
  // entry's name starts with "!", so the entry is still there for the
  // reopened run to find, as it is on a real computer.
  world.jobs.launchFromRunOnce();
  assert.equal(world.jobs.runOncePending, true);
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.equal(world.printed[0], INSTALL_CONTINUING_LINE);
  // The run that completes takes the entry down: nothing is left to
  // reopen the setup at the next sign-in.
  assert.equal(world.jobs.runOncePending, false);
  assert.ok(world.jobs.ops.includes('runOnceClear'));
});

test('a resume entry without the mark is taken down before the reopened run starts', async () => {
  // An entry written without the "!" (by an older setup, say) is one
  // Windows deletes before the program it names runs: the reopened
  // run finds nothing, and does not claim to be continuing.
  const world = await makeWorld({ runOnceValueName: 'Amanuensis Setup' });
  world.jobs.launchFromRunOnce();
  assert.equal(world.jobs.runOncePending, false);
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.ok(!world.printed.includes(INSTALL_CONTINUING_LINE));
});

test('when the resume entry cannot be set and a restart is needed, the flow does not promise the reopen', async () => {
  const world = await makeWorld({
    dockerInstalled: false,
    dockerRunning: false,
    dockerNeverRuns: true,
    failRunOnceSet: true,
  });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.deepEqual(world.printed, [problemText(INSTALL_RESUME_FAILED)]);
  assert.equal(world.jobs.runOncePending, false);
  assert.deepEqual(world.asked, []);
});

test('when the resume entry cannot be set but Docker answers, the install carries on with no restart words', async () => {
  const world = await makeWorld({ dockerInstalled: false, dockerRunning: false, failRunOnceSet: true });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.ok(!world.printed.includes(problemText(INSTALL_RESUME_FAILED)));
  assert.ok(!world.printed.includes(problemText(INSTALL_RESTART_NEEDED)));
});

test('an empty key is allowed: the install asks for no key on the input and says what that means', async () => {
  const world = await makeWorld({ secretAnswers: [PASSWORD, PASSWORD, ''] });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.ok(world.printed.includes(INSTALL_KEY_EMPTY_LINE));
  const run = world.runner.installRuns[0];
  assert.ok(run !== undefined);
  assert.ok(!run.args.includes('--token-factory-key-stdin'));
  assert.equal(new TextDecoder().decode(run.stdin), `${PASSWORD}\n`);
});

test('a password that falls short of the rule is asked again at the question', async () => {
  const world = await makeWorld({ secretAnswers: ['short', 'short', PASSWORD, PASSWORD, KEY] });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.ok(
    world.printed.includes('That password still needs at least 8 characters, a number and a symbol, like @ # $ %.'),
  );
});

test('two different passwords are asked again at the question', async () => {
  const world = await makeWorld({ secretAnswers: [PASSWORD, 'Password2!', PASSWORD, PASSWORD, KEY] });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.ok(world.printed.includes(INSTALL_PASSWORD_MISMATCH_LINE));
});

test('the password rule counts accented letters in bytes, as the shell counts them', () => {
  // Each accented letter here is two bytes: the first password is six
  // letters but nine bytes, past the shell's eight; the second is
  // seven bytes, short of it, though both have a number and a symbol.
  assert.equal(installPasswordProblem('ééé1!a'), null);
  assert.equal(installPasswordProblem('éé1!a'), 'That password still needs at least 8 characters.');
});

test('an accented password at the byte boundary is accepted at the question', async () => {
  const accented = 'ééé1!a';
  const world = await makeWorld({ secretAnswers: [accented, accented, KEY] });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  const run = world.runner.installRuns[0];
  assert.ok(run !== undefined);
  assert.equal(new TextDecoder().decode(run.stdin), `${accented}\n${KEY}\n`);
});

test('a no to the phone question leaves the home network closed and still opens the page', async () => {
  const world = await makeWorld({ askAnswers: ['friend@example.com', 'no'] });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.equal(world.jobs.firewallOpen, false);
  assert.ok(!world.recording.lines().some(line => line.includes('refresh')));
  assert.deepEqual(world.jobs.browserUrls, ['https://localhost:8443', PAGE_URL]);
});

test('a closed terminal at the first question stops the install with its problem', async () => {
  const world = await makeWorld({ askAnswers: [null] });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.equal(world.printed.at(-1), problemText(INSTALL_NO_ANSWER));
  assert.deepEqual(world.runner.installRuns, []);
});

test('the memory check runs before the first question and stops a small computer', async () => {
  const world = await makeWorld({ lowMemory: true });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.equal(world.printed.at(-1), problemText(LOW_MEMORY.windows));
  assert.deepEqual(world.asked, []);
});

test('a busy container install stops the flow before any later step', async () => {
  const world = await makeWorld({
    containerStdout: 'Another install is running right now\n',
    containerExit: 3,
  });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.equal(world.printed.at(-1), problemText(INSTALL_BUSY));
  assert.ok(!world.jobs.ops.includes('copy'));
  assert.equal(world.jobs.gettingStartedText, null);
});

test('a release page that answers without the record names the page, not the connection', async () => {
  const world = await makeWorld();
  world.deps.fetchBytes = () => Promise.resolve({ missing: true });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.equal(world.asked.length, 5);
  assert.ok(world.printed.includes(problemText(INSTALL_RELEASE_NOT_THERE)));
  assert.equal(world.runner.installRuns.length, 0);
});

test('a release record that does not check out stops the flow before the install', async () => {
  const world = await makeWorld({ tamperManifest: true });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 1);
  assert.ok(world.printed.includes(problemText(VERIFY_SIGNATURE_BAD)));
  assert.deepEqual(world.runner.installRuns, []);
});

test('a run that finds Aman already installed finishes the later steps and opens no page', async () => {
  const world = await makeWorld({ storeInstalled: true });
  const code = await runInstall(world.deps, { dryRun: false });
  assert.equal(code, 0);
  assert.deepEqual(world.asked, []);
  assert.deepEqual(world.runner.installRuns, []);
  assert.equal(world.jobs.gettingStartedText, null);
  assert.deepEqual(world.jobs.browserUrls, ['https://localhost:8443']);
  assert.ok(world.printed.includes(ADOPTED_LINE));
  assert.ok(!world.printed.includes(INSTALL_DONE_LINE));
});
