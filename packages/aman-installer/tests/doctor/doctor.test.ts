import assert from 'node:assert/strict';
import { chmod, chown, mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runDoctor, type DoctorDeps } from '../../src/doctor/doctor.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import type { SystemKind } from '../../src/host/host.ts';
import { DOCKER_NOT_ANSWERING, DOCTOR_STATE_UNREADABLE, problemText } from '../../src/messages.ts';
import {
  commandLine,
  okResult,
  RecordingProcessRunner,
  StubProcessRunner,
  type ProcessBytesResult,
  type ProcessResult,
  type ProcessRunner,
} from '../../src/runner/processRunner.ts';
import { folderBackend } from '../../src/state/folderBackend.ts';
import { createStateStore, StateDockerError, StateStoreError, type StateStore } from '../../src/state/state.ts';
import { volumeBackend } from '../../src/state/volumeBackend.ts';

const NOW = 1791633600;
const DAEMON_TIME = '2026-10-10T12:00:00.123456789Z';
const GIB = 1024 * 1024 * 1024;
const INFO_FORMAT =
  '{{.ServerVersion}}|{{.Architecture}}|{{.SecurityOptions}}|{{.DockerRootDir}}|{{.SystemTime}}|{{.OperatingSystem}}|{{.MemTotal}}';
const PS_FORMAT = '{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.service"}}';
const APP_IMAGE = 'aman-app:test1';
const EXEC_LINES = [
  'service\tok\tThe app is running.\t',
  'login\tok\tSign-in is ready.\t',
  'database\tok\tThe database answers.\t',
  'disk\tok\tPlenty of space.\t',
  'clock\tok\tThe clocks agree.\t',
  'run_code\tok\tCode running is ready.\t',
  'attachments\tok\tAttachments are ready.\t',
  'demo\toff\tSkipped: the demo is off.\t',
  'model\twarn\tThe model is slow to answer.\tRun aman doctor model --fix',
].join('\n');
const APP_PS_LINE = 'app00001|aman-main-app-1|running|Up 2 hours (healthy)|app';
const SLOT_PS_LINE = 'slot0001|proj-slots-sandbox-1|running|Up 2 hours (healthy)|sandbox-1';

interface JsonRecord {
  id: string;
  state: string;
  detail: string;
  fix: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: unknown): value is JsonRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['id'] === 'string' &&
    typeof value['state'] === 'string' &&
    typeof value['detail'] === 'string' &&
    typeof value['fix'] === 'string'
  );
}

interface DoctorDocument {
  machine: JsonRecord[];
  instances: Record<string, JsonRecord[]>;
}

function parseDocument(text: string): DoctorDocument {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error('the doctor document is not an object');
  }
  const machineRaw = value['machine'];
  const instancesRaw = value['instances'];
  if (!Array.isArray(machineRaw) || !machineRaw.every(isJsonRecord)) {
    throw new Error('the machine checks are not records');
  }
  if (typeof instancesRaw !== 'object' || instancesRaw === null) {
    throw new Error('the instances are not an object');
  }
  const instances: Record<string, JsonRecord[]> = {};
  for (const [name, records] of Object.entries(instancesRaw)) {
    if (!Array.isArray(records) || !records.every(isJsonRecord)) {
      throw new Error(`the checks of instance ${name} are not records`);
    }
    instances[name] = records;
  }
  return { machine: machineRaw, instances };
}

function recordById(records: readonly JsonRecord[], id: string): JsonRecord {
  const found = records.find(record => record.id === id);
  assert.ok(found !== undefined, `no record with id ${id}`);
  return found;
}

function noRecord(records: readonly JsonRecord[], id: string): void {
  assert.equal(
    records.some(record => record.id === id),
    false,
    `a record with id ${id} was not expected`,
  );
}

async function write(path: string, text: string, mode?: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
  if (mode !== undefined) {
    await chmod(path, mode);
  }
}

interface World {
  deps: DoctorDeps;
  printed: string[];
  recording: RecordingProcessRunner;
  personHome: string;
  stateHome: string;
  checkoutDir: string;
}

interface WorldOptions {
  kind?: SystemKind;
  kernelRelease?: string;
  answers?: Map<string, ProcessResult>;
  instances?: Record<string, Record<string, string>> | null;
  release?: string | null;
  backupsMode?: string | null;
  backups?: { name: string; ageSeconds: number }[];
  modeAgeSeconds?: number;
  schedule?: boolean;
  source?: boolean;
  osRelease?: string | null;
  dockerConfig?: string | null;
  stateHomeNull?: boolean;
  store?: StateStore;
}

// The ready world: a healthy Docker, one instance whose own doctor
// answers, a daily backup made a day ago, and the checkout Aman was
// installed from. Tests start here and break one thing.
async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const personHome = await mkdtemp(join(tmpdir(), 'aman-doctor-person-'));
  const stateHome = join(personHome, '.amanuensis');
  const checkoutDir = await mkdtemp(join(tmpdir(), 'aman-doctor-checkout-'));
  await write(join(checkoutDir, 'installer', 'install.sh'), '#!/bin/sh\n', 0o755);
  await write(join(checkoutDir, 'installer', 'lib', 'part.sh'), '# part\n', 0o644);
  await chmod(checkoutDir, 0o755);
  await chmod(join(checkoutDir, 'installer'), 0o755);
  await chmod(join(checkoutDir, 'installer', 'lib'), 0o755);

  const instances = options.instances === undefined ? { main: {} } : options.instances;
  if (instances !== null) {
    for (const [name, extra] of Object.entries(instances)) {
      const entries: Record<string, string> = {
        name,
        app_port: '8791',
        public_url: 'http://127.0.0.1:8791',
        origins: 'http://127.0.0.1:8791',
        sandbox: 'slots',
        tls: 'off',
        tls_port: '',
        ...extra,
      };
      const text = Object.entries(entries)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      await write(join(stateHome, 'state', 'instances', `${name}.conf`), `${text}\n`);
    }
  }
  if (options.release !== null) {
    const release =
      options.release ??
      JSON.stringify({
        schema: '1',
        source_ref: 'abc123',
        app_image: APP_IMAGE,
        stt_image: 'aman-stt:test1',
        dex_image: 'aman-dex:test1',
      });
    await write(join(stateHome, 'release', 'release.json'), release);
  }
  if (options.backupsMode !== null) {
    const modePath = join(stateHome, 'state', 'backups');
    await write(modePath, `${options.backupsMode ?? 'daily'}\n`);
    const modeTime = new Date((NOW - (options.modeAgeSeconds ?? 3600)) * 1000);
    await utimes(modePath, modeTime, modeTime);
  }
  const backups = options.backups ?? [{ name: '20261009T120000Z', ageSeconds: 86400 }];
  for (const backup of backups) {
    const dir = join(stateHome, 'backups', backup.name);
    await mkdir(dir, { recursive: true });
    const time = new Date((NOW - backup.ageSeconds) * 1000);
    await utimes(dir, time, time);
  }
  if (options.source !== false) {
    await write(join(stateHome, 'state', 'source'), `${checkoutDir}\n`);
  }
  if (options.schedule !== false) {
    await write(join(personHome, 'Library', 'LaunchAgents', 'com.amanuensis.backup.plist'), '<plist/>\n');
  }
  if (options.osRelease !== undefined && options.osRelease !== null) {
    await write(join(personHome, 'os-release'), options.osRelease);
  }
  if (options.dockerConfig !== undefined && options.dockerConfig !== null) {
    await write(join(personHome, '.docker', 'config.json'), options.dockerConfig);
  }

  const answers = options.answers ?? readyAnswers();
  const recording = new RecordingProcessRunner(new StubProcessRunner(answers));
  const printed: string[] = [];
  const deps: DoctorDeps = {
    host: new FakeHost({
      kind: options.kind ?? 'linux',
      memoryBytes: 16 * GIB,
      kernelRelease: options.kernelRelease ?? '6.8.0-45-generic',
    }),
    runner: recording,
    store: options.store ?? createStateStore(folderBackend(stateHome)),
    print: (line: string) => {
      printed.push(line);
    },
    now: () => NOW,
    homeDir: personHome,
    stateHome: options.stateHomeNull === true ? null : stateHome,
    osReleasePath: join(personHome, 'os-release'),
    dockerConfigDir: join(personHome, '.docker'),
    appService: 'app',
  };
  return { deps, printed, recording, personHome, stateHome, checkoutDir };
}

function infoAnswer(overrides: Record<string, string> = {}): ProcessResult {
  const fields = {
    version: '28.4.0',
    arch: 'x86_64',
    security: 'name=seccomp,profile=builtin',
    root: '/nonexistent-docker-root',
    time: DAEMON_TIME,
    os: 'Ubuntu 24.04.1 LTS',
    mem: String(16 * GIB),
    ...overrides,
  };
  return okResult(
    `${fields.version}|${fields.arch}|${fields.security}|${fields.root}|${fields.time}|${fields.os}|${fields.mem}\n`,
  );
}

function readyAnswers(): Map<string, ProcessResult> {
  return new Map<string, ProcessResult>([
    [commandLine('docker', ['info', '--format', INFO_FORMAT]), infoAnswer()],
    [commandLine('docker', ['compose', 'version', '--short']), okResult('2.29.1\n')],
    [
      commandLine('docker', ['version', '--format', '{{range .Server.Components}}{{.Name}};{{end}}']),
      okResult('containerd;BuildKit;'),
    ],
    [commandLine('docker', ['--version']), okResult('Docker version 28.4.0, build 1234567\n')],
    [commandLine('docker', ['image', 'inspect', '--format', '{{.Architecture}}', APP_IMAGE]), okResult('amd64\n')],
    [
      commandLine('docker', ['image', 'inspect', '--format', '{{.Architecture}}', 'aman-stt:test1']),
      okResult('amd64\n'),
    ],
    [
      commandLine('docker', ['image', 'inspect', '--format', '{{.Architecture}}', 'aman-dex:test1']),
      okResult('amd64\n'),
    ],
    [commandLine('docker', ['ps', '-a', '--format', PS_FORMAT]), okResult(`${SLOT_PS_LINE}\n`)],
    [
      commandLine('docker', [
        'ps',
        '-a',
        '--filter',
        'label=com.docker.compose.project=aman-main',
        '--format',
        PS_FORMAT,
      ]),
      okResult(`${APP_PS_LINE}\n`),
    ],
    [
      commandLine('docker', ['exec', '-e', `AMAN_HOST_EPOCH=${String(NOW)}`, 'app00001', 'aman', 'doctor', '--text']),
      okResult(`${EXEC_LINES}\n`),
    ],
  ]);
}

async function runJson(world: World): Promise<{ exitCode: number; doc: DoctorDocument }> {
  const exitCode = await runDoctor(world.deps, { json: true });
  assert.equal(world.printed.length, 1);
  return { exitCode, doc: parseDocument(world.printed[0] ?? '') };
}

test('a ready computer and instance: every check passes, in the shell order', async () => {
  const world = await makeWorld();
  const { exitCode, doc } = await runJson(world);
  assert.equal(exitCode, 0);
  assert.deepEqual(doc, {
    machine: [
      { id: 'docker', state: 'ok', detail: 'Docker 28.4.0 is running and Compose 2.29.1 is available.', fix: '' },
      { id: 'runtime', state: 'ok', detail: 'A supported Docker runtime is in use.', fix: '' },
      { id: 'credentials', state: 'ok', detail: 'No Docker settings file, so no credential store is in use.', fix: '' },
      { id: 'images', state: 'ok', detail: 'All 3 images are ready.', fix: '' },
      {
        id: 'disk',
        state: 'off',
        detail: 'Docker keeps its data inside a virtual machine here; free space is checked per instance.',
        fix: '',
      },
      { id: 'docker_memory', state: 'ok', detail: 'Docker has 16.0 GB of memory.', fix: '' },
      { id: 'clock', state: 'ok', detail: 'This machine and Docker agree on the time.', fix: '' },
      { id: 'backup', state: 'ok', detail: 'Daily backups are on; the last one is 1 day old.', fix: '' },
      { id: 'sandbox', state: 'ok', detail: 'All 1 sandbox slots are running and healthy.', fix: '' },
      {
        id: 'checkout',
        state: 'ok',
        detail: 'The folder Aman was installed from can only be changed by you.',
        fix: '',
      },
    ],
    instances: {
      main: [
        { id: 'service', state: 'ok', detail: 'The app is running.', fix: '' },
        { id: 'login', state: 'ok', detail: 'Sign-in is ready.', fix: '' },
        { id: 'database', state: 'ok', detail: 'The database answers.', fix: '' },
        { id: 'disk', state: 'ok', detail: 'Plenty of space.', fix: '' },
        { id: 'clock', state: 'ok', detail: 'The clocks agree.', fix: '' },
        { id: 'run_code', state: 'ok', detail: 'Code running is ready.', fix: '' },
        { id: 'attachments', state: 'ok', detail: 'Attachments are ready.', fix: '' },
        { id: 'demo', state: 'off', detail: 'Skipped: the demo is off.', fix: '' },
        { id: 'model', state: 'warn', detail: 'The model is slow to answer.', fix: 'Run aman doctor model --fix' },
      ],
    },
  });
});

test('the ready report reads as the shell report reads', async () => {
  const world = await makeWorld();
  const exitCode = await runDoctor(world.deps, { json: false });
  assert.equal(exitCode, 0);
  const golden = await readFile(new URL('../golden/doctor-report.txt', import.meta.url), 'utf8');
  assert.equal(`${world.printed.join('\n')}\n`, golden);
});

test('the ready run asks Docker exactly the shell questions', async () => {
  const world = await makeWorld();
  await runDoctor(world.deps, { json: true });
  const golden = await readFile(new URL('../golden/doctor-commands.txt', import.meta.url), 'utf8');
  assert.equal(world.recording.goldenText(), golden);
});

test('a local run passes --local to the instance doctor and asks nothing more', async () => {
  const answers = readyAnswers();
  const plainLine = commandLine('docker', [
    'exec',
    '-e',
    `AMAN_HOST_EPOCH=${String(NOW)}`,
    'app00001',
    'aman',
    'doctor',
    '--text',
  ]);
  const localLine = commandLine('docker', [
    'exec',
    '-e',
    `AMAN_HOST_EPOCH=${String(NOW)}`,
    'app00001',
    'aman',
    'doctor',
    '--text',
    '--local',
  ]);
  const plain = answers.get(plainLine);
  assert.ok(plain !== undefined);
  answers.delete(plainLine);
  answers.set(localLine, plain);
  const world = await makeWorld({ answers });
  const exitCode = await runDoctor(world.deps, { json: true, local: true });
  assert.equal(exitCode, 0);
  const golden = await readFile(new URL('../golden/doctor-commands-local.txt', import.meta.url), 'utf8');
  assert.equal(world.recording.goldenText(), golden);
});

function withAnswer(
  answers: Map<string, ProcessResult>,
  line: string,
  result: ProcessResult,
): Map<string, ProcessResult> {
  const next = new Map(answers);
  next.set(line, result);
  return next;
}

const INFO_LINE = commandLine('docker', ['info', '--format', INFO_FORMAT]);
const NOT_RUNNING: ProcessResult = {
  started: true,
  exitCode: 1,
  stdout: '',
  stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
};

test('Docker not running on Windows: the fix names Docker Desktop', async () => {
  const world = await makeWorld({ kind: 'windows', answers: withAnswer(readyAnswers(), INFO_LINE, NOT_RUNNING) });
  const exitCode = await runDoctor(world.deps, { json: false });
  assert.equal(exitCode, 1);
  const golden = await readFile(new URL('../golden/doctor-report-windows.txt', import.meta.url), 'utf8');
  assert.equal(`${world.printed.join('\n')}\n`, golden);
});

test('Docker not running on a Mac: the fix names Docker Desktop', async () => {
  const world = await makeWorld({ kind: 'darwin', answers: withAnswer(readyAnswers(), INFO_LINE, NOT_RUNNING) });
  const { exitCode, doc } = await runJson(world);
  assert.equal(exitCode, 1);
  assert.deepEqual(recordById(doc.machine, 'docker'), {
    id: 'docker',
    state: 'fail',
    detail: 'Docker is installed, but it is not running.',
    fix: 'Open Docker Desktop and wait until it says it is running, then run aman doctor.',
  });
  assert.deepEqual(doc.instances['main'], [
    {
      id: 'service',
      state: 'fail',
      detail: 'Docker is not reachable, so this instance cannot be checked.',
      fix: 'Fix the Docker problem reported under the machine checks first.',
    },
  ]);
});

test('Docker not running on Ubuntu: the fix is the doctor docker fix', async () => {
  const world = await makeWorld({
    answers: withAnswer(readyAnswers(), INFO_LINE, NOT_RUNNING),
    osRelease: 'NAME="Ubuntu"\nID=ubuntu\n',
  });
  const { doc } = await runJson(world);
  assert.equal(recordById(doc.machine, 'docker').fix, 'Run aman doctor docker --fix');
});

test('Docker not installed: one failure, the Docker checks skipped', async () => {
  const world = await makeWorld({ answers: new Map() });
  const { exitCode, doc } = await runJson(world);
  assert.equal(exitCode, 1);
  assert.deepEqual(recordById(doc.machine, 'docker'), {
    id: 'docker',
    state: 'fail',
    detail: 'Docker is not installed.',
    fix: 'Install Docker Desktop (macOS, Windows) or Docker Engine with Compose 2 (Linux), then run aman doctor.',
  });
  for (const id of ['runtime', 'images', 'disk', 'docker_memory', 'clock']) {
    assert.deepEqual(recordById(doc.machine, id), {
      id,
      state: 'off',
      detail: 'Skipped: Docker is not reachable.',
      fix: '',
    });
  }
  noRecord(doc.machine, 'sandbox');
  noRecord(doc.machine, 'tls');
});

test('a user who cannot use Docker yet gets the group fix', async () => {
  const denied: ProcessResult = {
    started: true,
    exitCode: 1,
    stdout: '',
    stderr: 'permission denied while trying to connect to the Docker daemon socket\n',
  };
  const world = await makeWorld({ answers: withAnswer(readyAnswers(), INFO_LINE, denied) });
  const { doc } = await runJson(world);
  assert.deepEqual(recordById(doc.machine, 'docker'), {
    id: 'docker',
    state: 'fail',
    detail: 'Your user cannot use Docker yet.',
    fix: 'Run aman doctor docker --fix',
  });
});

test('Docker answering in its own words fails with its first line', async () => {
  const odd: ProcessResult = { started: true, exitCode: 1, stdout: 'the daemon is confused\n', stderr: '' };
  const world = await makeWorld({ answers: withAnswer(readyAnswers(), INFO_LINE, odd) });
  const { doc } = await runJson(world);
  assert.deepEqual(recordById(doc.machine, 'docker'), {
    id: 'docker',
    state: 'fail',
    detail: 'Docker did not answer: the daemon is confused',
    fix: 'Open Docker Desktop and wait until it says it is running, then run aman doctor.',
  });
});

test('Compose missing and Compose too old name version 2', async () => {
  const composeLine = commandLine('docker', ['compose', 'version', '--short']);
  const missing = await makeWorld({
    answers: withAnswer(readyAnswers(), composeLine, { started: false, exitCode: 1, stdout: '', stderr: '' }),
  });
  const missingDoc = (await runJson(missing)).doc;
  assert.equal(recordById(missingDoc.machine, 'docker').detail, 'Docker Compose is missing; version 2 is needed.');
  const old = await makeWorld({ answers: withAnswer(readyAnswers(), composeLine, okResult('v1.29.2\n')) });
  const oldDoc = (await runJson(old)).doc;
  assert.equal(recordById(oldDoc.machine, 'docker').detail, 'Docker Compose 1.29.2 is too old; version 2 is needed.');
});

test('Podman and rootless Docker are refused with their fixes', async () => {
  const versionLine = commandLine('docker', ['version', '--format', '{{range .Server.Components}}{{.Name}};{{end}}']);
  const podman = await makeWorld({ answers: withAnswer(readyAnswers(), versionLine, okResult('Podman Engine;')) });
  assert.deepEqual(recordById((await runJson(podman)).doc.machine, 'runtime'), {
    id: 'runtime',
    state: 'fail',
    detail: 'Podman is not supported.',
    fix: 'Install Docker Engine or Docker Desktop and make it the docker command, then run aman doctor.',
  });
  const rootless = await makeWorld({
    answers: withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ security: 'name=rootless' })),
  });
  assert.deepEqual(recordById((await runJson(rootless)).doc.machine, 'runtime'), {
    id: 'runtime',
    state: 'fail',
    detail: 'Rootless Docker is not supported.',
    fix: 'Install the regular Docker Engine or Docker Desktop and switch to it, then run aman doctor.',
  });
});

test('an old Engine on native Linux leaks loopback ports; on WSL it does not', async () => {
  const old = await makeWorld({ answers: withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ version: '27.5.1' })) });
  const runtime = recordById((await runJson(old)).doc.machine, 'runtime');
  assert.equal(runtime.state, 'fail');
  assert.ok(runtime.detail.startsWith('Docker Engine 27.5.1 lets other devices on your network reach ports'));
  const wsl = await makeWorld({
    kernelRelease: '5.15.167.4-microsoft-standard-WSL2',
    answers: withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ version: '27.5.1' })),
  });
  assert.equal(recordById((await runJson(wsl)).doc.machine, 'runtime').state, 'ok');
});

test('a credential store that is missing or silent fails with its fix', async () => {
  const config = '{"credsStore":"desktop"}';
  const helperLine = commandLine('docker-credential-desktop', ['list']);
  const missing = await makeWorld({ dockerConfig: config });
  assert.deepEqual(recordById((await runJson(missing)).doc.machine, 'credentials'), {
    id: 'credentials',
    state: 'fail',
    detail:
      'Docker is set to use the credential store "desktop", but docker-credential-desktop is not on PATH; image downloads will fail with "error getting credentials".',
    fix: 'Open Docker Desktop and wait until it says it is running, then run aman doctor.',
  });
  const silent = await makeWorld({
    dockerConfig: config,
    answers: withAnswer(readyAnswers(), helperLine, { started: true, exitCode: 1, stdout: '', stderr: 'locked' }),
  });
  assert.deepEqual(recordById((await runJson(silent)).doc.machine, 'credentials'), {
    id: 'credentials',
    state: 'fail',
    detail: 'The credential store "desktop" is installed but did not answer; image downloads will fail.',
    fix: 'Open Docker Desktop and unlock your keychain, then run aman doctor.',
  });
  const answering = await makeWorld({
    dockerConfig: config,
    answers: withAnswer(readyAnswers(), helperLine, okResult('{}')),
  });
  assert.deepEqual(recordById((await runJson(answering)).doc.machine, 'credentials'), {
    id: 'credentials',
    state: 'ok',
    detail: 'The Docker credential store "desktop" answers.',
    fix: '',
  });
  const noStore = await makeWorld({ dockerConfig: '{"auths":{}}' });
  assert.equal(
    recordById((await runJson(noStore)).doc.machine, 'credentials').detail,
    'Docker uses no credential store.',
  );
});

test('images: no release record warns, a missing image fails, a wrong CPU type fails', async () => {
  const noRelease = await makeWorld({ release: null });
  assert.deepEqual(recordById((await runJson(noRelease)).doc.machine, 'images'), {
    id: 'images',
    state: 'warn',
    detail: 'No release record was found, so the expected images are unknown.',
    fix: 'Run install.sh again from the folder Aman was installed from.',
  });
  const inspectLine = commandLine('docker', ['image', 'inspect', '--format', '{{.Architecture}}', APP_IMAGE]);
  const missing = await makeWorld({
    answers: withAnswer(readyAnswers(), inspectLine, {
      started: true,
      exitCode: 1,
      stdout: '',
      stderr: 'No such image',
    }),
  });
  assert.deepEqual(recordById((await runJson(missing)).doc.machine, 'images'), {
    id: 'images',
    state: 'fail',
    detail: 'Some of Aman is not built on this computer: app_image.',
    fix: 'Run aman upgrade',
  });
  const wrongArch = await makeWorld({ answers: withAnswer(readyAnswers(), inspectLine, okResult('arm64\n')) });
  assert.deepEqual(recordById((await runJson(wrongArch)).doc.machine, 'images'), {
    id: 'images',
    state: 'fail',
    detail: 'Images built for another CPU type than Docker uses (amd64): app_image(arm64).',
    fix: 'Run aman upgrade',
  });
});

test('images: a release record with no images warns that none are listed', async () => {
  const world = await makeWorld({ release: JSON.stringify({ schema: '1', source_ref: 'abc123' }) });
  assert.deepEqual(recordById((await runJson(world)).doc.machine, 'images'), {
    id: 'images',
    state: 'warn',
    detail: 'The release record lists no images.',
    fix: 'Run install.sh again from the folder Aman was installed from.',
  });
});

async function diskWorld(availKb: number | null): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'aman-doctor-dfroot-'));
  const answers = withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ root }));
  if (availKb !== null) {
    const df = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 209715200 1000 ${String(availKb)} 1% /\n`;
    answers.set(commandLine('df', ['-Pk', root]), okResult(df));
  }
  return makeWorld({ answers });
}

test('disk: under 2 GB fails, under 10 GB warns, an unreadable answer warns', async () => {
  const low = await diskWorld(1048576);
  assert.deepEqual(recordById((await runJson(low)).doc.machine, 'disk'), {
    id: 'disk',
    state: 'fail',
    detail: 'Only 1.0 GB is free for Docker data; installs and upgrades will fail.',
    fix: 'Run aman doctor disk --fix',
  });
  const mid = await diskWorld(5242880);
  assert.deepEqual(recordById((await runJson(mid)).doc.machine, 'disk'), {
    id: 'disk',
    state: 'warn',
    detail: '5.0 GB is free for Docker data; 10 GB is recommended.',
    fix: 'Run aman doctor disk --fix',
  });
  const unreadable = await diskWorld(null);
  assert.deepEqual(recordById((await runJson(unreadable)).doc.machine, 'disk'), {
    id: 'disk',
    state: 'warn',
    detail: 'The free space for Docker data could not be read.',
    fix: 'Run aman doctor disk --fix',
  });
  const plenty = await diskWorld(20971520);
  assert.deepEqual(recordById((await runJson(plenty)).doc.machine, 'disk'), {
    id: 'disk',
    state: 'ok',
    detail: '20.0 GB is free for Docker data.',
    fix: '',
  });
});

test('memory: under 6 GB fails, under 8 GB warns, unreported is skipped', async () => {
  const fix = 'Raise it in Docker Desktop under Settings, Resources, Memory. On Linux, free up memory or add swap.';
  const low = await makeWorld({ answers: withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ mem: String(4 * GIB) })) });
  assert.deepEqual(recordById((await runJson(low)).doc.machine, 'docker_memory'), {
    id: 'docker_memory',
    state: 'fail',
    detail: 'Docker has only 4.0 GB of memory; building the app needs at least 6 GB.',
    fix,
  });
  const mid = await makeWorld({ answers: withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ mem: String(7 * GIB) })) });
  assert.deepEqual(recordById((await runJson(mid)).doc.machine, 'docker_memory'), {
    id: 'docker_memory',
    state: 'warn',
    detail: 'Docker has 7.0 GB of memory; 8 GB is recommended for builds and upgrades.',
    fix,
  });
  const none = await makeWorld({ answers: withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ mem: '' })) });
  assert.deepEqual(recordById((await runJson(none)).doc.machine, 'docker_memory'), {
    id: 'docker_memory',
    state: 'off',
    detail: 'Skipped: Docker did not report how much memory it has.',
    fix: '',
  });
});

test('clock: over five minutes fails, over a minute warns, unreadable is skipped', async () => {
  const fix =
    'Turn on automatic time sync in your system settings (with Docker Desktop, restart it: its clock drifts after the computer sleeps).';
  const far = await makeWorld({
    answers: withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ time: '2026-10-10T12:06:40Z' })),
  });
  assert.deepEqual(recordById((await runJson(far)).doc.machine, 'clock'), {
    id: 'clock',
    state: 'fail',
    detail: 'This machine and Docker disagree on the time by 400 seconds; sign-in will fail.',
    fix,
  });
  const near = await makeWorld({
    answers: withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ time: '2026-10-10T12:02:00Z' })),
  });
  assert.deepEqual(recordById((await runJson(near)).doc.machine, 'clock'), {
    id: 'clock',
    state: 'warn',
    detail: 'This machine and Docker disagree on the time by 120 seconds.',
    fix,
  });
  const odd = await makeWorld({ answers: withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ time: 'not a time' })) });
  assert.deepEqual(recordById((await runJson(odd)).doc.machine, 'clock'), {
    id: 'clock',
    state: 'off',
    detail: 'Skipped: Docker did not report a readable time.',
    fix: '',
  });
});

test('backup: a missing schedule warns, an old daily backup names its folder', async () => {
  const unscheduled = await makeWorld({ schedule: false });
  assert.deepEqual(recordById((await runJson(unscheduled)).doc.machine, 'backup'), {
    id: 'backup',
    state: 'warn',
    detail: 'Daily backups are on, but the schedule that runs them is missing.',
    fix: 'Run aman doctor backup --fix',
  });
  const old = await makeWorld({ backups: [{ name: '20261005T120000Z', ageSeconds: 5 * 86400 }] });
  const record = recordById((await runJson(old)).doc.machine, 'backup');
  assert.equal(record.state, 'warn');
  assert.equal(
    record.detail,
    'Daily backups are scheduled, but the last one is 5 days old. The newest backup is in ~/.amanuensis/backups/20261005T120000Z.',
  );
});

test('backup: off and old warns; no mode yet reads plainly; a fresh daily mode waits', async () => {
  const off = await makeWorld({ backupsMode: 'off', backups: [{ name: '20260930T120000Z', ageSeconds: 10 * 86400 }] });
  assert.deepEqual(recordById((await runJson(off)).doc.machine, 'backup'), {
    id: 'backup',
    state: 'warn',
    detail: 'Automatic backups are off, and the last backup is 10 days old.',
    fix: 'Run aman doctor backup --fix',
  });
  const unset = await makeWorld({ backupsMode: null, backups: [{ name: '20261008T120000Z', ageSeconds: 2 * 86400 }] });
  assert.deepEqual(recordById((await runJson(unset)).doc.machine, 'backup'), {
    id: 'backup',
    state: 'ok',
    detail: 'The last backup is 2 days old.',
    fix: '',
  });
  const waiting = await makeWorld({ backups: [], modeAgeSeconds: 3600 });
  assert.deepEqual(recordById((await runJson(waiting)).doc.machine, 'backup'), {
    id: 'backup',
    state: 'ok',
    detail: 'Daily backups are on; the first one runs within a day.',
    fix: '',
  });
  const noneMade = await makeWorld({ backups: [], modeAgeSeconds: 3 * 86400 });
  assert.deepEqual(recordById((await runJson(noneMade)).doc.machine, 'backup'), {
    id: 'backup',
    state: 'warn',
    detail: 'Daily backups are scheduled, but none has been made yet.',
    fix: 'Run aman doctor backup --fix',
  });
  const noInstances = await makeWorld({ instances: null });
  assert.deepEqual(recordById((await runJson(noInstances)).doc.machine, 'backup'), {
    id: 'backup',
    state: 'ok',
    detail: 'No instances yet; nothing to back up.',
    fix: '',
  });
});

test('backup: no backup at all reads plainly; one ahead of the clock is 0 days old', async () => {
  const none = await makeWorld({ backupsMode: null, backups: [] });
  assert.deepEqual(recordById((await runJson(none)).doc.machine, 'backup'), {
    id: 'backup',
    state: 'ok',
    detail: 'No backup yet; one is made automatically before your first upgrade.',
    fix: '',
  });
  // The shell counts whole days toward zero, so a backup an hour newer
  // than this computer's clock is 0 days old there, never -1.
  const ahead = await makeWorld({ backups: [{ name: '20261010T130000Z', ageSeconds: -3600 }] });
  assert.deepEqual(recordById((await runJson(ahead)).doc.machine, 'backup'), {
    id: 'backup',
    state: 'ok',
    detail: 'Daily backups are on; the last one is 0 days old.',
    fix: '',
  });
  const offRecent = await makeWorld({
    backupsMode: 'off',
    backups: [{ name: '20261008T120000Z', ageSeconds: 2 * 86400 }],
  });
  assert.deepEqual(recordById((await runJson(offRecent)).doc.machine, 'backup'), {
    id: 'backup',
    state: 'ok',
    detail: 'Automatic backups are off.',
    fix: '',
  });
  const unsetOld = await makeWorld({
    backupsMode: null,
    backups: [{ name: '20260930T120000Z', ageSeconds: 10 * 86400 }],
  });
  assert.deepEqual(recordById((await runJson(unsetOld)).doc.machine, 'backup'), {
    id: 'backup',
    state: 'warn',
    detail: 'The last backup is 10 days old.',
    fix: 'Run aman backup',
  });
});

test('sandbox: a stopped slot names its failed safety check in plain words', async () => {
  const psLine = commandLine('docker', ['ps', '-a', '--format', PS_FORMAT]);
  const stopped = 'slot0001|proj-slots-sandbox-1|exited|Exited (1) 2 hours ago|sandbox-1';
  const answers = withAnswer(readyAnswers(), psLine, okResult(`${stopped}\n`));
  answers.set(
    commandLine('docker', ['logs', '--tail', '50', 'slot0001']),
    okResult('starting\nattestation FAILED boot: disk not sealed\n'),
  );
  const world = await makeWorld({ answers });
  assert.deepEqual(recordById((await runJson(world)).doc.machine, 'sandbox'), {
    id: 'sandbox',
    state: 'fail',
    detail: 'A sandbox slot failed: Safety check boot failed: disk not sealed',
    fix: 'Run aman doctor sandbox --fix',
  });
  const quiet = await makeWorld({ answers: withAnswer(readyAnswers(), psLine, okResult('')) });
  noRecord((await runJson(quiet)).doc.machine, 'sandbox');
});

test('checkout: links and group-writable files fail with their fixes', async () => {
  const linked = await makeWorld();
  await symlink('part.sh', join(linked.checkoutDir, 'installer', 'lib', 'linked.sh'));
  assert.deepEqual(recordById((await runJson(linked)).doc.machine, 'checkout'), {
    id: 'checkout',
    state: 'fail',
    detail: 'The installer of the folder Aman was installed from contains links, so Aman will not run it.',
    fix: 'Copy the folder to one of yours and run install.sh from there.',
  });
  const writable = await makeWorld();
  await chmod(join(writable.checkoutDir, 'installer', 'lib', 'part.sh'), 0o666);
  assert.deepEqual(recordById((await runJson(writable)).doc.machine, 'checkout'), {
    id: 'checkout',
    state: 'fail',
    detail:
      'The folder Aman was installed from can be changed by other users, so Aman will not run its installer from it.',
    fix: 'Run aman doctor checkout --fix',
  });
  const noSource = await makeWorld({ source: false });
  noRecord((await runJson(noSource)).doc.machine, 'checkout');
});

test('sandbox: a stopped slot whose log names no check fails plainly', async () => {
  const psLine = commandLine('docker', ['ps', '-a', '--format', PS_FORMAT]);
  const stopped = 'slot0001|proj-slots-sandbox-1|exited|Exited (1) 2 hours ago|sandbox-1';
  const answers = withAnswer(readyAnswers(), psLine, okResult(`${stopped}\n`));
  answers.set(
    commandLine('docker', ['logs', '--tail', '50', 'slot0001']),
    okResult('starting\nthe slot stopped without a word\n'),
  );
  const world = await makeWorld({ answers });
  assert.deepEqual(recordById((await runJson(world)).doc.machine, 'sandbox'), {
    id: 'sandbox',
    state: 'fail',
    detail: 'One of the sandbox slots is not running properly, and its log does not say which check failed.',
    fix: 'Run aman doctor sandbox --fix',
  });
});

test('checkout: a writable folder above the checkout fails as a parent problem', async () => {
  const world = await makeWorld();
  const parent = await mkdtemp(join(tmpdir(), 'aman-doctor-parent-'));
  await chmod(parent, 0o777);
  const checkoutDir = join(parent, 'aman-checkout');
  await write(join(checkoutDir, 'installer', 'install.sh'), '#!/bin/sh\n', 0o755);
  await write(join(checkoutDir, 'installer', 'lib', 'part.sh'), '# part\n', 0o644);
  await chmod(checkoutDir, 0o755);
  await chmod(join(checkoutDir, 'installer'), 0o755);
  await chmod(join(checkoutDir, 'installer', 'lib'), 0o755);
  await write(join(world.stateHome, 'state', 'source'), `${checkoutDir}\n`);
  assert.deepEqual(recordById((await runJson(world)).doc.machine, 'checkout'), {
    id: 'checkout',
    state: 'fail',
    detail:
      'A folder above the folder Aman was installed from can be changed by other users, so Aman will not run its installer from it.',
    fix: 'Move the folder to one only you can change, such as one inside your home folder, then run install.sh from there.',
  });
});

test('checkout: a checkout owned by another user fails as an owner problem', async () => {
  // Only a run as root can hand a file to another user, so the case is
  // made where it can be made and skipped where it cannot.
  if (process.getuid?.() !== 0) {
    return;
  }
  const world = await makeWorld();
  await chown(join(world.checkoutDir, 'installer', 'install.sh'), 1000, 1000);
  assert.deepEqual(recordById((await runJson(world)).doc.machine, 'checkout'), {
    id: 'checkout',
    state: 'fail',
    detail: 'The folder Aman was installed from belongs to another user, so Aman will not run its installer from it.',
    fix: 'Copy it to a folder of yours and run install.sh from there.',
  });
});

const HTTPS_INSTANCE = { main: { tls: 'local', tls_port: '8443', origins: 'https://aman.test:8443' } };

// A world whose instance serves https, with the authority in place. The
// certificate answers and the https probe answer are the test's to set.
async function tlsWorld(options: {
  keyMode?: number;
  pki?: string;
  curlStatus?: string;
  backupsMode?: string;
}): Promise<{ world: World; doc: DoctorDocument }> {
  const world = await makeWorld({
    instances: HTTPS_INSTANCE,
    ...(options.backupsMode === undefined ? {} : { backupsMode: options.backupsMode }),
  });
  await write(join(world.stateHome, 'tls', 'ca', 'root.crt'), 'cert\n');
  await write(join(world.stateHome, 'tls', 'ca', 'root.key'), 'key\n', options.keyMode ?? 0o600);
  await write(join(world.stateHome, 'tls', 'ca', 'root.fingerprint'), 'AB:CD:EF\n');
  const answers = readyAnswers();
  answers.set(commandLine('id', ['-u']), okResult('1000\n'));
  answers.set(commandLine('id', ['-g']), okResult('1000\n'));
  if (options.pki !== undefined) {
    answers.set(
      commandLine('docker', [
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '1000:1000',
        '-v',
        `${world.stateHome}/tls:/tls:ro`,
        '-v',
        `${world.stateHome}/lib/pki.mjs:/pki.mjs:ro`,
        '--entrypoint',
        'node',
        APP_IMAGE,
        '/pki.mjs',
        'info',
        '/tls/ca',
        '/tls/leaf/main',
      ]),
      okResult(options.pki),
    );
  }
  if (options.curlStatus !== undefined) {
    answers.set(
      commandLine('curl', [
        '-sS',
        '--max-time',
        '8',
        '--cacert',
        join(world.stateHome, 'tls', 'ca', 'root.crt'),
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        'https://127.0.0.1:8443/healthz',
      ]),
      okResult(options.curlStatus),
    );
  }
  const deps: DoctorDeps = { ...world.deps, runner: new RecordingProcessRunner(new StubProcessRunner(answers)) };
  await runDoctor(deps, { json: true });
  return { world, doc: parseDocument(world.printed[0] ?? '') };
}

const HEALTHY_PKI =
  '{"root_days_left":400,"leaf_days_left":200,"leaf_names":["aman.test"],"root_constrained":true,"root_covers_leaf":true}';

test('tls: a healthy authority and certificate pass with the fingerprint', async () => {
  const { doc } = await tlsWorld({ pki: HEALTHY_PKI, curlStatus: '200' });
  assert.deepEqual(recordById(doc.machine, 'tls'), {
    id: 'tls',
    state: 'ok',
    detail:
      'Https is on; the certificate of instance main lasts 200 more days, and Aman renews it in its last 60 days. Authority fingerprint, to compare on a device before trusting it: AB:CD:EF',
    fix: '',
  });
});

test('tls: a readable authority key fails with the tls fix', async () => {
  const { doc } = await tlsWorld({ keyMode: 0o644, pki: HEALTHY_PKI, curlStatus: '200' });
  assert.deepEqual(recordById(doc.machine, 'tls'), {
    id: 'tls',
    state: 'fail',
    detail:
      "The key of this computer's certificate authority can be read by other users. Authority fingerprint, to compare on a device before trusting it: AB:CD:EF",
    fix: 'Run aman doctor tls --fix',
  });
});

test('tls: a short-lived certificate warns; silence over https fails', async () => {
  const short = await tlsWorld({
    pki: '{"root_days_left":400,"leaf_days_left":30,"leaf_names":["aman.test"],"root_constrained":true,"root_covers_leaf":true}',
    curlStatus: '200',
  });
  assert.deepEqual(recordById(short.doc.machine, 'tls'), {
    id: 'tls',
    state: 'warn',
    detail:
      'The https certificate of instance main ends in 30 days. Authority fingerprint, to compare on a device before trusting it: AB:CD:EF',
    fix: 'Run aman doctor tls --fix',
  });
  const silent = await tlsWorld({ pki: HEALTHY_PKI, curlStatus: '000' });
  const record = recordById(silent.doc.machine, 'tls');
  assert.equal(record.state, 'fail');
  assert.ok(record.detail.startsWith('Instance main does not answer over https on this computer.'));
  assert.equal(record.fix, 'Run aman doctor instance --fix');
});

test('tls: a missing authority fails before any certificate is read', async () => {
  const world = await makeWorld({ instances: HTTPS_INSTANCE });
  const { doc } = await runJson(world);
  assert.deepEqual(recordById(doc.machine, 'tls'), {
    id: 'tls',
    state: 'fail',
    detail: 'The certificate authority of this computer is missing, so devices cannot trust Aman.',
    fix: 'Run aman doctor tls --fix',
  });
});

test('runtime: the old Engine record names the whole problem and its fix', async () => {
  const world = await makeWorld({
    answers: withAnswer(readyAnswers(), INFO_LINE, infoAnswer({ version: '27.5.1' })),
  });
  assert.deepEqual(recordById((await runJson(world)).doc.machine, 'runtime'), {
    id: 'runtime',
    state: 'fail',
    detail:
      'Docker Engine 27.5.1 lets other devices on your network reach ports meant for this computer only. Install Docker Engine 28 or newer (install.sh --print-root-steps shows the steps), then run this again.',
    fix: 'Install a current Docker Engine (install.sh --print-root-steps shows the steps), then run aman doctor.',
  });
});

test('an instance whose app is stopped is skipped plainly', async () => {
  const appPsLine = commandLine('docker', [
    'ps',
    '-a',
    '--filter',
    'label=com.docker.compose.project=aman-main',
    '--format',
    PS_FORMAT,
  ]);
  const world = await makeWorld({ answers: withAnswer(readyAnswers(), appPsLine, okResult('')) });
  const { doc } = await runJson(world);
  assert.deepEqual(doc.instances['main'], [
    { id: 'service', state: 'off', detail: 'Skipped: the app is not running.', fix: '' },
  ]);
});

const FINGERPRINT_SUFFIX = ' Authority fingerprint, to compare on a device before trusting it: AB:CD:EF';

test('tls: an unconstrained authority, one missing a name, and a certificate missing a name each warn', async () => {
  const unconstrained = await tlsWorld({
    pki: '{"root_days_left":400,"leaf_days_left":200,"leaf_names":["aman.test"],"root_constrained":false,"root_covers_leaf":true}',
    curlStatus: '200',
  });
  assert.deepEqual(recordById(unconstrained.doc.machine, 'tls'), {
    id: 'tls',
    state: 'warn',
    detail:
      'The certificate authority of this computer, from an earlier version, can vouch for more names than it should. A new one covers only the names Aman is opened at and private addresses; each device then trusts it again.' +
      FINGERPRINT_SUFFIX,
    fix: 'Run aman doctor tls --fix',
  });
  const uncovered = await tlsWorld({
    pki: '{"root_days_left":400,"leaf_days_left":200,"leaf_names":["aman.test"],"root_constrained":true,"root_covers_leaf":false}',
    curlStatus: '200',
  });
  assert.deepEqual(recordById(uncovered.doc.machine, 'tls'), {
    id: 'tls',
    state: 'warn',
    detail:
      'The certificate authority of this computer does not cover every name of instance main. A new one does; each device then trusts it again.' +
      FINGERPRINT_SUFFIX,
    fix: 'Run aman doctor tls --fix',
  });
  const unlisted = await tlsWorld({
    pki: '{"root_days_left":400,"leaf_days_left":200,"leaf_names":["other.test"],"root_constrained":true,"root_covers_leaf":true}',
    curlStatus: '200',
  });
  assert.deepEqual(recordById(unlisted.doc.machine, 'tls'), {
    id: 'tls',
    state: 'warn',
    detail: 'The https certificate of instance main does not list: aman.test.' + FINGERPRINT_SUFFIX,
    fix: 'Run aman doctor tls --fix',
  });
});

test('tls: a certificate that has run out fails, and a pki answer with no root days counts as run out', async () => {
  const expired = await tlsWorld({
    pki: '{"root_days_left":400,"leaf_days_left":0,"leaf_names":["aman.test"],"root_constrained":true,"root_covers_leaf":true}',
    curlStatus: '200',
  });
  assert.deepEqual(recordById(expired.doc.machine, 'tls'), {
    id: 'tls',
    state: 'fail',
    detail: 'The https certificate of instance main has run out, so devices refuse it.' + FINGERPRINT_SUFFIX,
    fix: 'Run aman doctor tls --fix',
  });
  // The shell reads a missing root count as -1 in this test: run out, even
  // with leaf days to spare.
  const noRoot = await tlsWorld({
    pki: '{"leaf_days_left":200,"leaf_names":["aman.test"],"root_constrained":true,"root_covers_leaf":true}',
    curlStatus: '200',
  });
  assert.deepEqual(recordById(noRoot.doc.machine, 'tls'), {
    id: 'tls',
    state: 'fail',
    detail: 'The https certificate of instance main has run out, so devices refuse it.' + FINGERPRINT_SUFFIX,
    fix: 'Run aman doctor tls --fix',
  });
});

test('tls: with daily backups off, a healthy certificate warns that renewal is not automatic', async () => {
  const { doc } = await tlsWorld({ pki: HEALTHY_PKI, curlStatus: '200', backupsMode: 'off' });
  assert.deepEqual(recordById(doc.machine, 'tls'), {
    id: 'tls',
    state: 'warn',
    detail:
      'Daily backups are off, so the https certificate is renewed only when you run an aman command in its last 60 days, or run aman doctor tls --fix.' +
      FINGERPRINT_SUFFIX,
    fix: 'Run aman doctor backup --fix',
  });
});

test('tls: with no certificate read possible, the plain https line is recorded', async () => {
  const world = await makeWorld({
    instances: HTTPS_INSTANCE,
    release: JSON.stringify({
      schema: '1',
      source_ref: 'abc123',
      stt_image: 'aman-stt:test1',
      dex_image: 'aman-dex:test1',
    }),
  });
  await write(join(world.stateHome, 'tls', 'ca', 'root.crt'), 'cert\n');
  await write(join(world.stateHome, 'tls', 'ca', 'root.key'), 'key\n', 0o600);
  await write(join(world.stateHome, 'tls', 'ca', 'root.fingerprint'), 'AB:CD:EF\n');
  const { doc } = await runJson(world);
  assert.deepEqual(recordById(doc.machine, 'tls'), {
    id: 'tls',
    state: 'ok',
    detail: "Https is on, with a certificate from this computer's own authority.",
    fix: '',
  });
});

test('the in-image call: a failed run names its first line; unknown lines are dropped', async () => {
  const execLine = commandLine('docker', [
    'exec',
    '-e',
    `AMAN_HOST_EPOCH=${String(NOW)}`,
    'app00001',
    'aman',
    'doctor',
    '--text',
  ]);
  const failed = await makeWorld({
    answers: withAnswer(readyAnswers(), execLine, {
      started: true,
      exitCode: 2,
      stdout: '',
      stderr: 'container not running\n',
    }),
  });
  const failedDoc = (await runJson(failed)).doc;
  assert.deepEqual(failedDoc.instances['main'], [
    {
      id: 'service',
      state: 'fail',
      detail: 'The checks could not run inside the app container: container not running',
      fix: 'Run aman doctor instance --fix',
    },
  ]);
  const odd = await makeWorld({
    answers: withAnswer(
      readyAnswers(),
      execLine,
      okResult('mystery\tbogus\tNot a state.\t\nservice\tok\tThe app is running.\t\n'),
    ),
  });
  const oddDoc = (await runJson(odd)).doc;
  assert.deepEqual(oddDoc.instances['main'], [{ id: 'service', state: 'ok', detail: 'The app is running.', fix: '' }]);
});

test('a state store that cannot answer prints the one problem and stops', async () => {
  const store: StateStore = {
    readSummary: async () => {
      throw new StateDockerError('docker is down');
    },
    readCaCertificate: async () => null,
    refreshCache: () => undefined,
    writeInstance: async () => false,
    setInstanceValue: async () => false,
    removeInstance: async () => undefined,
    writeRelease: async () => false,
    setBackupsMode: async () => false,
  };
  const world = await makeWorld({ store });
  const exitCode = await runDoctor(world.deps, { json: false });
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(DOCKER_NOT_ANSWERING['linux'])]);
});

test('a record that cannot be read gets the doctor own next step, not the status one', async () => {
  const store: StateStore = {
    readSummary: async () => {
      throw new StateStoreError('the state volume could not be read');
    },
    readCaCertificate: async () => null,
    refreshCache: () => undefined,
    writeInstance: async () => false,
    setInstanceValue: async () => false,
    removeInstance: async () => undefined,
    writeRelease: async () => false,
    setBackupsMode: async () => false,
  };
  const world = await makeWorld({ store });
  const exitCode = await runDoctor(world.deps, { json: false });
  assert.equal(exitCode, 1);
  assert.deepEqual(world.printed, [problemText(DOCTOR_STATE_UNREADABLE)]);
});

// A volume nothing has written to yet: Docker answers its listings,
// every one of them empty, and no file can be read out of it.
class FreshVolumeRunner implements ProcessRunner {
  run(): Promise<ProcessResult> {
    return Promise.resolve(okResult(''));
  }

  runBytes(): Promise<ProcessBytesResult> {
    return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: 'cat: no such file', started: true });
  }
}

test('a fresh volume reads as nothing installed yet, not as a broken record', async () => {
  const store = createStateStore(volumeBackend(new FreshVolumeRunner()));
  const world = await makeWorld({
    store,
    instances: null,
    release: null,
    backups: [],
    backupsMode: null,
    source: false,
    schedule: false,
  });
  const { doc } = await runJson(world);
  assert.deepEqual(doc.instances, {});
  const backup = recordById(doc.machine, 'backup');
  assert.equal(backup.state, 'ok');
  assert.equal(backup.detail, 'No instances yet; nothing to back up.');
});
