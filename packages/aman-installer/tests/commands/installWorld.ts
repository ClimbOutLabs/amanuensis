import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type InstallDeps } from '../../src/commands/install.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs, type FakeWindowsJobStep } from '../../src/host/fakeWindowsJobs.ts';
import { DOCKER_DESKTOP_DOWNLOAD_URL } from '../../src/host/windowsJobs.ts';
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
import { parseRegistry, type StateStore, type StateSummary } from '../../src/state/state.ts';
import { TEST_PUBLIC_KEY_MINISIGN, testKeyNum, testPrivateKeyDer } from '../release/testKeys.ts';

export const NOW = 1791633600;
export const GIB = 1024 * 1024 * 1024;
export const RELEASE_TAG = 'v9.9.9';
export const ASSET_NAME = 'aman-windows-x64.exe';
export const ARCHIVE_NAME = 'amanuensis-v9.9.9.tar.gz';
export const PROGRAM = new TextEncoder().encode('the aman program');
export const ARCHIVE = new TextEncoder().encode('the source archive bytes');
export const DOCKER_INSTALLER = new TextEncoder().encode('the docker desktop installer');
export const PASSWORD = 'Password1!';
export const IDS: SourceIds = {
  'aman-app': 'aman-app:0123456789ab',
  'aman-stt': 'aman-stt:0123456789cd',
  'aman-tts': 'aman-tts:0123456789cd',
  'aman-calendar-caldav': 'aman-calendar-caldav:0123456789ef',
  'aman-browser': 'aman-browser:0123456789ef',
};
export const RELEASE_BASE = 'https://github.com/ClimbOutLabs/amanuensis/releases';
export const MANIFEST_URL = `${RELEASE_BASE}/latest/download/manifest.json`;
export const SIGNATURE_URL = `${RELEASE_BASE}/latest/download/manifest.json.minisig`;
export const ARCHIVE_URL = `${RELEASE_BASE}/download/${RELEASE_TAG}/${ARCHIVE_NAME}`;
export const LOCAL_APP_DATA = 'C:\\Users\\Friend\\AppData\\Local';
export const START_MENU_DIR = 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';
export const CERT = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n';

export function emptySummary(): StateSummary {
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

export function installedSummary(): StateSummary {
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
export class WorldStore implements StateStore {
  installed = false;
  modes: string[] = [];

  readSummary(): Promise<StateSummary> {
    return Promise.resolve(this.installed ? installedSummary() : emptySummary());
  }

  readCaCertificate(): Promise<string | null> {
    return Promise.resolve(this.installed ? CERT : null);
  }

  refreshCache(): void {
    // This store holds nothing back: every read answers from the
    // world as it stands, so there is no cache to drop.
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

export interface WorldOptions {
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
export class WorldRunner implements ProcessRunner {
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

  runBytes(
    command: string,
    args: readonly string[],
    stdin: Uint8Array,
    onLine?: (line: string) => void,
  ): Promise<ProcessBytesResult> {
    void command;
    if (args.includes('sh')) {
      return Promise.resolve(okBytesResult(new Uint8Array()));
    }
    if (args.includes('installer/install.sh')) {
      // A copy, as the container reads it: the install wipes its own.
      this.installRuns.push({ args, stdin: stdin.slice() });
      const exit = this.options.containerExit ?? 0;
      if (exit === 0) {
        this.store.installed = true;
      }
      const text = this.options.containerStdout ?? 'Instance main is ready.\n';
      for (const line of text.split('\n').slice(0, -1)) {
        onLine?.(line);
      }
      return Promise.resolve({
        exitCode: exit,
        stdout: new TextEncoder().encode(text),
        stderr: '',
        started: true,
      });
    }
    return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false });
  }
}

export interface World {
  deps: InstallDeps;
  printed: string[];
  recording: RecordingProcessRunner;
  jobs: FakeWindowsJobs;
  store: WorldStore;
  runner: WorldRunner;
  asked: { kind: 'ask' | 'secret'; question: string }[];
}

export async function makeWorld(options: WorldOptions = {}): Promise<World> {
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
  const secretQueue = [...(options.secretAnswers ?? [PASSWORD, PASSWORD])];
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
