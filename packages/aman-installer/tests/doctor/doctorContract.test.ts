import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { release as osRelease, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runDoctor, type DoctorDeps } from '../../src/doctor/doctor.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { commandLine, okResult, StubProcessRunner, type ProcessResult } from '../../src/runner/processRunner.ts';
import { folderBackend } from '../../src/state/folderBackend.ts';
import { createStateStore } from '../../src/state/state.ts';

// The contract between the shell doctor and this one, over one fixture
// state: the machine checks must agree record for record, and the
// per-instance records that come from the instance's own doctor must
// agree too. The shell doctor also writes host-side records of its own
// (settings files, the container list, ports, public and network
// addresses); those stay with the shell in this stage, so the comparison
// takes the shell's instance records down to the ones the in-image call
// made.

const NOW = 1791633600;
const GIB = 1024 * 1024 * 1024;
const INFO_FORMAT =
  '{{.ServerVersion}}|{{.Architecture}}|{{.SecurityOptions}}|{{.DockerRootDir}}|{{.SystemTime}}|{{.OperatingSystem}}|{{.MemTotal}}';
const PS_FORMAT = '{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.service"}}';
const INFO_LINE =
  '28.4.0|x86_64|name=seccomp,profile=builtin|/nonexistent-docker-root|2026-10-10T12:00:00.123456789Z|Ubuntu 24.04.1 LTS|17179869184';
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
const IN_IMAGE_IDS = new Set([
  'service',
  'login',
  'database',
  'disk',
  'clock',
  'run_code',
  'attachments',
  'demo',
  'model',
]);

const FAKE_DOCKER = `#!/bin/bash
args="$*"
if [ "$args" = 'info --format {{.ServerVersion}}|{{.Architecture}}|{{.SecurityOptions}}|{{.DockerRootDir}}|{{.SystemTime}}|{{.OperatingSystem}}|{{.MemTotal}}' ]; then
  printf '%s\\n' '${INFO_LINE}'
elif [ "$args" = 'compose version --short' ]; then
  printf '%s\\n' '2.29.1'
elif [ "$args" = 'version --format {{range .Server.Components}}{{.Name}};{{end}}' ]; then
  printf '%s' 'containerd;BuildKit;'
elif [ "$args" = '--version' ]; then
  printf '%s\\n' 'Docker version 28.4.0, build 1234567'
elif [ "$args" = 'image inspect --format {{.Architecture}} aman-app:test1' ]; then
  printf '%s\\n' 'amd64'
elif [ "$args" = 'image inspect --format {{.Architecture}} aman-stt:test1' ]; then
  printf '%s\\n' 'amd64'
elif [ "$args" = 'image inspect --format {{.Architecture}} aman-dex:test1' ]; then
  printf '%s\\n' 'amd64'
elif [ "$args" = 'ps -a --format {{.ID}}|{{.Names}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.service"}}' ]; then
  printf '%s\\n' 'slot0001|proj-slots-sandbox-1|running|Up 2 hours (healthy)|sandbox-1'
elif [ "$args" = 'ps -a --filter label=com.docker.compose.project=aman-main --format {{.ID}}|{{.Names}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.service"}}' ]; then
  printf '%s\\n' 'app00001|aman-main-app-1|running|Up 2 hours (healthy)|app'
  printf '%s\\n' 'dex00001|aman-main-dex-1|running|Up 2 hours (healthy)|dex'
elif [ "$args" = 'exec -e AMAN_HOST_EPOCH=1791633600 app00001 aman doctor --text' ]; then
  printf '%s\\n' 'service\tok\tThe app is running.\t' 'login\tok\tSign-in is ready.\t' 'database\tok\tThe database answers.\t' 'disk\tok\tPlenty of space.\t' 'clock\tok\tThe clocks agree.\t' 'run_code\tok\tCode running is ready.\t' 'attachments\tok\tAttachments are ready.\t' 'demo\toff\tSkipped: the demo is off.\t' 'model\twarn\tThe model is slow to answer.\tRun aman doctor model --fix'
else
  case "$args" in
    'port '*) exit 0 ;;
    *) echo "unexpected docker call: $args" >&2; exit 99 ;;
  esac
fi
`;

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

function runShellDoctor(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const doctorPath = new URL('../../../../installer/doctor/aman', import.meta.url).pathname;
  return new Promise(resolvePromise => {
    execFile(
      'bash',
      [doctorPath, 'doctor', '--json'],
      { env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function dockerAnswers(): Map<string, ProcessResult> {
  return new Map<string, ProcessResult>([
    [commandLine('docker', ['info', '--format', INFO_FORMAT]), okResult(`${INFO_LINE}\n`)],
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
      commandLine('docker', ['exec', '-e', `AMAN_HOST_EPOCH=${String(NOW)}`, 'app00001', 'aman', 'doctor', '--text']),
      okResult(`${EXEC_LINES}\n`),
    ],
  ]);
}

test('the shell doctor and this one agree on the fixture state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aman-doctor-contract-'));
  const fixtureSource = new URL('../fixtures/doctor-home/', import.meta.url).pathname;

  const checkoutDir = join(root, 'checkout');
  await mkdir(join(checkoutDir, 'installer', 'lib'), { recursive: true });
  await writeFile(join(checkoutDir, 'installer', 'install.sh'), '#!/bin/sh\n');
  await chmod(join(checkoutDir, 'installer', 'install.sh'), 0o755);
  await writeFile(join(checkoutDir, 'installer', 'lib', 'part.sh'), '# part\n');
  await chmod(join(checkoutDir, 'installer', 'lib', 'part.sh'), 0o644);
  await chmod(join(checkoutDir, 'installer'), 0o755);
  await chmod(join(checkoutDir, 'installer', 'lib'), 0o755);
  await chmod(checkoutDir, 0o755);

  const personHome = join(root, 'person');
  await mkdir(join(personHome, 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(join(personHome, 'Library', 'LaunchAgents', 'com.amanuensis.backup.plist'), '<plist/>\n');
  const osReleasePath = join(root, 'os-release');
  await writeFile(osReleasePath, 'NAME="Ubuntu"\nID=ubuntu\n');
  const fakeBin = join(root, 'bin');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, 'docker'), FAKE_DOCKER);
  await chmod(join(fakeBin, 'docker'), 0o755);

  const prepareHome = async (name: string): Promise<string> => {
    const home = join(root, name);
    await cp(fixtureSource, home, { recursive: true });
    await writeFile(join(home, 'state', 'source'), `${checkoutDir}\n`);
    // The instance's env file is written here rather than kept in the
    // fixture: the repository does not track files named .env.
    await writeFile(join(home, 'instances', 'main', '.env'), 'PUBLIC_BASE_URL=http://127.0.0.1:8791\n');
    await chmod(join(home, 'instances', 'main', '.env'), 0o600);
    await chmod(join(home, 'instances', 'main', 'dex.env'), 0o600);
    const newest = new Date((NOW - 86400) * 1000);
    await utimes(join(home, 'backups', '20261009T120000Z'), newest, newest);
    const older = new Date((NOW - 2 * 86400) * 1000);
    await utimes(join(home, 'backups', '20261008T120000Z'), older, older);
    return home;
  };
  const shellHome = await prepareHome('shell-home');
  const folderHome = await prepareHome('folder-home');

  const shell = await runShellDoctor({
    PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
    HOME: personHome,
    AMANUENSIS_HOME: shellHome,
    AMAN_DOCTOR_NOW: String(NOW),
    AMAN_OS_RELEASE: osReleasePath,
  });
  assert.equal(shell.code, 0, `the shell doctor failed: ${shell.stderr}`);
  const shellDoc = parseDocument(shell.stdout.trim());

  const printed: string[] = [];
  const baseDeps = {
    host: new FakeHost({ kind: 'linux', memoryBytes: 16 * GIB, kernelRelease: osRelease() }),
    print: (line: string) => {
      printed.push(line);
    },
    now: () => NOW,
    homeDir: personHome,
    osReleasePath,
    dockerConfigDir: join(personHome, '.docker'),
    appService: 'app',
  };
  const folderDeps: DoctorDeps = {
    ...baseDeps,
    runner: new StubProcessRunner(dockerAnswers()),
    store: createStateStore(folderBackend(folderHome)),
    stateHome: folderHome,
  };
  const folderCode = await runDoctor(folderDeps, { json: true });
  assert.equal(folderCode, 0);
  const folderDoc = parseDocument(printed[0] ?? '');


  // The machine checks agree exactly, record for record.
  assert.deepEqual(folderDoc.machine, shellDoc.machine);
  // The records the instance's own doctor made agree; the shell's extra
  // host-side records are its own in this stage.
  const shellMain = shellDoc.instances['main'] ?? [];
  const shellInImage = shellMain.filter(record => IN_IMAGE_IDS.has(record.id));
  assert.deepEqual(folderDoc.instances['main'], shellInImage);
  assert.ok(shellMain.length > shellInImage.length, 'the shell wrote host-side records of its own');
});
