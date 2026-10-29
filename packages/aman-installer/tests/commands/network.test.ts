import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'node:os';
import { test } from 'node:test';

import { runNetwork, type NetworkDeps } from '../../src/commands/network.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { FakeWindowsJobs, type FakeWindowsJobStep } from '../../src/host/fakeWindowsJobs.ts';
import {
  NETWORK_ADDRESS_MISSING,
  NETWORK_BUSY,
  NETWORK_CLOSED_LINE,
  NETWORK_CLOSE_FAILED,
  NETWORK_DOCKER_NOT_ANSWERING,
  NETWORK_FIREWALL_CLOSE_FAILED,
  NETWORK_FIREWALL_OPEN_FAILED,
  NETWORK_NOT_INSTALLED,
  NETWORK_NOT_WINDOWS,
  NETWORK_NO_ADDRESS,
  NETWORK_OPEN_LINE,
  NETWORK_USAGE,
  networkPhoneLine,
  problemText,
} from '../../src/messages.ts';
import type { ProcessBytesResult, ProcessResult, ProcessRunner } from '../../src/runner/processRunner.ts';
import { parseRegistry, type StateStore, type StateSummary } from '../../src/state/state.ts';
import { SETUP_IMAGE } from '../../src/state/volumeBackend.ts';

const OK: ProcessResult = { exitCode: 0, stdout: 'Open https://192.168.1.20:8443\n', stderr: '', started: true };
const OK_PLAIN: ProcessResult = { exitCode: 0, stdout: 'Open http://192.168.1.20:8791\n', stderr: '', started: true };
const OK_LOOPBACK: ProcessResult = { exitCode: 0, stdout: 'Open http://127.0.0.1:8791\n', stderr: '', started: true };
const BUSY: ProcessResult = {
  exitCode: 1,
  stdout: 'Another install is running right now\n',
  stderr: '',
  started: true,
};
const BROKEN: ProcessResult = { exitCode: 1, stdout: '', stderr: 'the refresh stopped\n', started: true };
const NOT_STARTED: ProcessResult = { exitCode: 1, stdout: '', stderr: '', started: false };

// Answers the one container run and writes down its command line.
class RefreshRunner implements ProcessRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  private readonly result: ProcessResult;

  constructor(result: ProcessResult) {
    this.result = result;
  }

  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ command, args });
    return Promise.resolve(this.result);
  }

  runBytes(): Promise<ProcessBytesResult> {
    return Promise.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: '', started: false });
  }
}

function v4(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:11:22:33:44:55',
    internal: false,
    cidr: `${address}/24`,
  };
}

const HOME_INTERFACES: NetworkDeps['interfaces'] = {
  Ethernet: [v4('192.168.1.20')],
  'vEthernet (WSL)': [v4('172.21.0.1')],
  Tailscale: [v4('100.101.102.103')],
};

function summaryWith(instances: StateSummary['instances']): StateSummary {
  return {
    release: null,
    releaseUnreadable: false,
    previousRelease: null,
    instances,
    backups: [],
    backupEntries: [],
    backupsMode: null,
    backupsModeTimeSeconds: null,
    certificateAuthority: { certPresent: false, keyMode: null, fingerprint: null, fingerprintHasContent: false },
    sourceCheckout: null,
    installedAppImage: null,
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
  };
}

function jobsWith(failSteps: ReadonlySet<FakeWindowsJobStep> = new Set()): FakeWindowsJobs {
  return new FakeWindowsJobs({
    localAppDataDir: 'C:\\Users\\Friend\\AppData\\Local',
    selfExePath: 'C:\\Users\\Friend\\Downloads\\aman-windows-x64.exe',
    startMenuProgramsDir: 'C:\\Users\\Friend\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
    failSteps,
  });
}

const MAIN_HTTPS = summaryWith([
  {
    name: 'main',
    entries: parseRegistry(
      'name=main\napp_port=8791\ntls=local\ntls_port=8443\norigins=http://127.0.0.1:8791,https://192.168.1.20:8443\n',
    ),
  },
]);

const MAIN_PLAIN = summaryWith([{ name: 'main', entries: parseRegistry('name=main\napp_port=8791\n') }]);

async function run(options: {
  runner: RefreshRunner;
  store: StateStore;
  jobs: FakeWindowsJobs;
  mode: string | undefined;
  kind?: 'windows' | 'linux';
  interfaces?: NetworkDeps['interfaces'];
  hostName?: string;
}): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runNetwork(
    {
      host: new FakeHost({ kind: options.kind ?? 'windows', memoryBytes: 8 * 1024 ** 3 }),
      runner: options.runner,
      store: options.store,
      jobs: options.jobs,
      print: line => {
        lines.push(line);
      },
      interfaces: options.interfaces ?? HOME_INTERFACES,
      hostName: options.hostName ?? 'DESKTOP-ABC',
    },
    { mode: options.mode },
  );
  return { code, lines };
}

function containerArgs(extraArgs: readonly string[]): readonly string[] {
  return [
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
    '--yes',
    'instance',
    'refresh',
    'main',
    ...extraArgs,
  ];
}

test('network open lets the ports through the firewall, hands the installer the private addresses, and prints the phone lines', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(OK);
  const { code, lines } = await run({ runner, store: storeWith(MAIN_HTTPS), jobs, mode: 'open' });
  assert.equal(code, 0);
  assert.equal(jobs.firewallOpen, true);
  assert.deepEqual(jobs.firewallPorts, [8443, 8791]);
  assert.deepEqual(runner.calls, [
    {
      command: 'docker',
      args: containerArgs(['--address', '192.168.1.20', '--address', 'desktop-abc']),
    },
  ]);
  assert.ok(jobs.shortcuts.some(shortcut => shortcut.args === 'network open'));
  assert.deepEqual(lines, [
    'Open https://192.168.1.20:8443',
    networkPhoneLine('https://192.168.1.20:8443'),
    NETWORK_OPEN_LINE,
  ]);
});

test('network open hands over no Tailscale-range address even when it sorts first, and the phone line names the home address', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(OK);
  const { code, lines } = await run({
    runner,
    store: storeWith(MAIN_HTTPS),
    jobs,
    mode: 'open',
    interfaces: {
      Tailscale: [v4('100.101.102.103')],
      Ethernet: [v4('192.168.1.20')],
    },
  });
  assert.equal(code, 0);
  assert.equal(jobs.firewallOpen, true);
  assert.deepEqual(runner.calls, [
    {
      command: 'docker',
      args: containerArgs(['--address', '192.168.1.20', '--address', 'desktop-abc']),
    },
  ]);
  assert.deepEqual(lines, [
    'Open https://192.168.1.20:8443',
    networkPhoneLine('https://192.168.1.20:8443'),
    NETWORK_OPEN_LINE,
  ]);
});

test('network open on a Tailscale-only computer completes on the name alone, and the phone line names the computer', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(OK);
  const { code, lines } = await run({
    runner,
    store: storeWith(MAIN_HTTPS),
    jobs,
    mode: 'open',
    interfaces: { Tailscale: [v4('100.101.102.103')] },
  });
  assert.equal(code, 0);
  assert.equal(jobs.firewallOpen, true);
  assert.deepEqual(jobs.firewallPorts, [8443, 8791]);
  assert.deepEqual(runner.calls, [{ command: 'docker', args: containerArgs(['--address', 'desktop-abc']) }]);
  assert.ok(jobs.shortcuts.some(shortcut => shortcut.args === 'network open'));
  assert.deepEqual(lines, [
    'Open https://192.168.1.20:8443',
    networkPhoneLine('https://desktop-abc:8443'),
    NETWORK_OPEN_LINE,
  ]);
});

test('network open on a plain instance covers the plain port and prints the plain phone address', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(OK_PLAIN);
  const { code, lines } = await run({ runner, store: storeWith(MAIN_PLAIN), jobs, mode: 'open' });
  assert.equal(code, 0);
  assert.deepEqual(jobs.firewallPorts, [8791]);
  assert.deepEqual(lines, [
    'Open http://192.168.1.20:8791',
    networkPhoneLine('http://192.168.1.20:8791'),
    NETWORK_OPEN_LINE,
  ]);
});

test('network open with no usable address changes nothing and prints its problem', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(OK);
  const { code, lines } = await run({
    runner,
    store: storeWith(MAIN_HTTPS),
    jobs,
    mode: 'open',
    interfaces: { 'vEthernet (WSL)': [v4('172.21.0.1')] },
    hostName: 'My Computer!',
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(NETWORK_NO_ADDRESS)]);
  assert.equal(jobs.firewallOpen, false);
  assert.deepEqual(runner.calls, []);
});

test('network open stops at a refused firewall change, before any container run', async () => {
  const jobs = jobsWith(new Set<FakeWindowsJobStep>(['firewall-open']));
  const runner = new RefreshRunner(OK);
  const { code, lines } = await run({ runner, store: storeWith(MAIN_HTTPS), jobs, mode: 'open' });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(NETWORK_FIREWALL_OPEN_FAILED)]);
  assert.deepEqual(runner.calls, []);
});

test('network open names the busy record when the refresh finds another install running', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(BUSY);
  const { code, lines } = await run({ runner, store: storeWith(MAIN_HTTPS), jobs, mode: 'open' });
  assert.equal(code, 1);
  assert.equal(jobs.firewallOpen, true);
  assert.deepEqual(lines, ['Another install is running right now', problemText(NETWORK_BUSY)]);
});

test('network open with Docker not answering prints its problem', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(NOT_STARTED);
  const { code, lines } = await run({ runner, store: storeWith(MAIN_HTTPS), jobs, mode: 'open' });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(NETWORK_DOCKER_NOT_ANSWERING)]);
});

test('network open with a record that names no port prints its problem', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(OK);
  const summary = summaryWith([{ name: 'main', entries: parseRegistry('name=main\n') }]);
  const { code, lines } = await run({ runner, store: storeWith(summary), jobs, mode: 'open' });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(NETWORK_ADDRESS_MISSING)]);
  assert.deepEqual(runner.calls, []);
});

test('network close turns the rule off and puts the instance back on this computer only', async () => {
  const jobs = jobsWith();
  jobs.firewallOpen = true;
  const runner = new RefreshRunner(OK_LOOPBACK);
  const { code, lines } = await run({ runner, store: storeWith(MAIN_HTTPS), jobs, mode: 'close' });
  assert.equal(code, 0);
  assert.equal(jobs.firewallOpen, false);
  assert.deepEqual(runner.calls, [{ command: 'docker', args: containerArgs(['--local-only']) }]);
  assert.deepEqual(lines, ['Open http://127.0.0.1:8791', NETWORK_CLOSED_LINE]);
});

test('network close stops at a refused firewall change, before any container run', async () => {
  const jobs = jobsWith(new Set<FakeWindowsJobStep>(['firewall-close']));
  const runner = new RefreshRunner(OK);
  const { code, lines } = await run({ runner, store: storeWith(MAIN_HTTPS), jobs, mode: 'close' });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(NETWORK_FIREWALL_CLOSE_FAILED)]);
  assert.deepEqual(runner.calls, []);
});

test('network close names its own failure when the refresh fails', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(BROKEN);
  const { code, lines } = await run({ runner, store: storeWith(MAIN_HTTPS), jobs, mode: 'close' });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['the refresh stopped', problemText(NETWORK_CLOSE_FAILED)]);
});

test('network with no instance prints the not-installed problem', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(OK);
  const { code, lines } = await run({ runner, store: storeWith(summaryWith([])), jobs, mode: 'open' });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(NETWORK_NOT_INSTALLED)]);
  assert.deepEqual(runner.calls, []);
});

test('network refuses on a computer that is not Windows', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(OK);
  const { code, lines } = await run({ runner, store: storeWith(MAIN_HTTPS), jobs, mode: 'open', kind: 'linux' });
  assert.equal(code, 1);
  assert.deepEqual(lines, [problemText(NETWORK_NOT_WINDOWS)]);
  assert.deepEqual(runner.calls, []);
});

test('network with no word or an unknown word after it prints its usage problem', async () => {
  const jobs = jobsWith();
  const runner = new RefreshRunner(OK);
  for (const mode of [undefined, 'sideways']) {
    const { code, lines } = await run({ runner, store: storeWith(MAIN_HTTPS), jobs, mode });
    assert.equal(code, 1);
    assert.deepEqual(lines, [problemText(NETWORK_USAGE)]);
  }
  assert.deepEqual(runner.calls, []);
});
