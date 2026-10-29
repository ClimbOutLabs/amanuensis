import type { NetworkInterfaceInfo } from 'node:os';

import type { Host } from '../host/host.ts';
import {
  networkAddressList,
  networkInstallAddresses,
  tailscaleRangeIpv4,
  type NetworkAddressList,
} from '../host/networkAddresses.ts';
import { WindowsJobError, type WindowsJobs } from '../host/windowsJobs.ts';
import {
  NETWORK_ADDRESS_MISSING,
  NETWORK_BUSY,
  NETWORK_CLOSED_LINE,
  NETWORK_CLOSE_FAILED,
  NETWORK_DOCKER_NOT_ANSWERING,
  NETWORK_FIREWALL_CLOSE_FAILED,
  NETWORK_FIREWALL_OPEN_FAILED,
  NETWORK_IMAGE_UNAVAILABLE,
  NETWORK_NOT_INSTALLED,
  NETWORK_NOT_WINDOWS,
  NETWORK_NO_ADDRESS,
  NETWORK_OPEN_FAILED,
  NETWORK_OPEN_LINE,
  NETWORK_STATE_UNREADABLE,
  NETWORK_USAGE,
  networkPhoneLine,
  problemText,
} from '../messages.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import {
  StateImageError,
  registryValue,
  type InstanceRecord,
  type StateStore,
  type StateSummary,
} from '../state/state.ts';
import { SETUP_IMAGE, STATE_VOLUME, VOLUME_HOME } from '../state/volumeBackend.ts';
import { recordedPort } from './open.ts';

export interface NetworkDeps {
  host: Host;
  runner: ProcessRunner;
  store: StateStore;
  jobs: WindowsJobs;
  print: (line: string) => void;
  // This computer's network adapters and its name, read on the host by
  // main: the setup container cannot see the adapters, so the address
  // list is made here and handed to the installer.
  interfaces: Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>;
  hostName: string;
}

// The source checkout's volume and its place in the setup container:
// the names the starter set, the same ones the upgrade runs from.
const SOURCE_VOLUME = 'aman_source';
const SOURCE_DIR = '/src';

// The recorded https port, when the instance has one.
function recordedTlsPort(instance: InstanceRecord): number | null {
  const value = registryValue(instance.entries, 'tls_port');
  if (value !== null && /^\d+$/.test(value)) {
    const port = Number.parseInt(value, 10);
    if (port >= 1 && port <= 65535) {
      return port;
    }
  }
  return null;
}

// The address a phone opens: the first private IPv4 address outside
// Tailscale's range, which a phone on the same Wi-Fi can open, else
// the computer's name, at the https port when the instance serves
// https and at the plain port otherwise. The Tailscale address is
// never the printed one: a phone that is not on the tailnet cannot
// open it, so when it is the only address the name stands in.
function phoneAddress(list: NetworkAddressList, ports: { appPort: number; tlsPort: number | null }): string | null {
  const host = list.ipv4.find(address => !tailscaleRangeIpv4(address)) ?? list.hostName;
  if (host === null) {
    return null;
  }
  return ports.tlsPort === null
    ? `http://${host}:${String(ports.appPort)}`
    : `https://${host}:${String(ports.tlsPort)}`;
}

// Runs the installer's own refresh for the instance in the setup
// container, the container shape the upgrade runs in, and shows its
// output as it stands: its closing block is the summary, with the
// addresses, the trust page link and the scan code from qr.mjs. The
// extra arguments are the address list on open, or --local-only on
// close; the shell's own address step judges what changes.
async function runRefresh(
  deps: NetworkDeps,
  options: { instanceName: string; extraArgs: readonly string[]; mode: 'open' | 'close' },
): Promise<boolean> {
  const { print } = deps;
  const result = await deps.runner.run('docker', [
    'run',
    '--rm',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${STATE_VOLUME}:${VOLUME_HOME}`,
    '-v',
    `${SOURCE_VOLUME}:${SOURCE_DIR}`,
    '-w',
    SOURCE_DIR,
    SETUP_IMAGE,
    'installer/install.sh',
    '--yes',
    'instance',
    'refresh',
    options.instanceName,
    ...options.extraArgs,
  ]);
  if (!result.started) {
    print(problemText(NETWORK_DOCKER_NOT_ANSWERING));
    return false;
  }
  for (const line of result.stdout.split('\n')) {
    if (line.trim() !== '') {
      print(line);
    }
  }
  for (const line of result.stderr.split('\n')) {
    if (line.trim() !== '') {
      print(line);
    }
  }
  if (result.exitCode === 0) {
    return true;
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (combined.includes('Another install is running right now')) {
    print(problemText(NETWORK_BUSY));
    return false;
  }
  print(problemText(options.mode === 'open' ? NETWORK_OPEN_FAILED : NETWORK_CLOSE_FAILED));
  return false;
}

// The Start menu entry that shows the phone address and scan code
// again, refreshed through the Windows jobs, the one owner of every
// Aman shortcut. Best effort, as the upgrade's entry is: the entry is
// a convenience, and its absence never undoes an opening that worked.
async function ensurePhoneEntry(deps: NetworkDeps): Promise<void> {
  await deps.jobs.ensurePhoneShortcut().catch(() => undefined);
}

async function runNetworkOpen(deps: NetworkDeps, instance: InstanceRecord): Promise<number> {
  const { print } = deps;
  const appPort = recordedPort(instance.entries);
  if (appPort === null) {
    print(problemText(NETWORK_ADDRESS_MISSING));
    return 1;
  }
  const tlsPort = recordedTlsPort(instance);
  const list = networkAddressList({ interfaces: deps.interfaces, hostName: deps.hostName });
  const installAddresses = networkInstallAddresses(list);
  if (installAddresses.length === 0) {
    print(problemText(NETWORK_NO_ADDRESS));
    return 1;
  }
  // The firewall first: one Windows prompt, answered before the
  // longer refresh runs, and a refusal leaves everything as it was.
  try {
    await deps.jobs.openFirewallToHome(tlsPort === null ? [appPort] : [tlsPort, appPort]);
  } catch (error) {
    if (error instanceof WindowsJobError) {
      print(problemText(NETWORK_FIREWALL_OPEN_FAILED));
      return 1;
    }
    throw error;
  }
  const addressArgs = installAddresses.flatMap(address => ['--address', address]);
  if (!(await runRefresh(deps, { instanceName: instance.name, extraArgs: addressArgs, mode: 'open' }))) {
    return 1;
  }
  await ensurePhoneEntry(deps);
  const address = phoneAddress(list, { appPort, tlsPort });
  if (address !== null) {
    print(networkPhoneLine(address));
  }
  print(NETWORK_OPEN_LINE);
  return 0;
}

async function runNetworkClose(deps: NetworkDeps, instance: InstanceRecord): Promise<number> {
  const { print } = deps;
  try {
    await deps.jobs.closeFirewallToHome();
  } catch (error) {
    if (error instanceof WindowsJobError) {
      print(problemText(NETWORK_FIREWALL_CLOSE_FAILED));
      return 1;
    }
    throw error;
  }
  if (!(await runRefresh(deps, { instanceName: instance.name, extraArgs: ['--local-only'], mode: 'close' }))) {
    return 1;
  }
  print(NETWORK_CLOSED_LINE);
  return 0;
}

// aman network open and aman network close: turn Aman's reach to the
// devices on the home network on and off. Opening hands the installer
// this computer's private addresses (the container cannot see its
// adapters), lets those devices through the Windows firewall on
// Aman's ports, and prints the address and scan code a phone uses.
// Closing turns the firewall rule off and puts the instance back on
// this computer only.
export async function runNetwork(deps: NetworkDeps, options: { mode: string | undefined }): Promise<number> {
  const { host, store, print } = deps;
  if (options.mode !== 'open' && options.mode !== 'close') {
    print(problemText(NETWORK_USAGE));
    return 1;
  }
  if (host.kind !== 'windows') {
    print(problemText(NETWORK_NOT_WINDOWS));
    return 1;
  }
  let summary: StateSummary;
  try {
    summary = await store.readSummary();
  } catch (error) {
    if (error instanceof StateImageError) {
      print(problemText(NETWORK_IMAGE_UNAVAILABLE));
      return 1;
    }
    print(problemText(NETWORK_STATE_UNREADABLE));
    return 1;
  }
  if (summary.releaseUnreadable) {
    print(problemText(NETWORK_STATE_UNREADABLE));
    return 1;
  }
  const instance = summary.instances.find(candidate => candidate.name === 'main') ?? summary.instances[0];
  if (instance === undefined) {
    print(problemText(NETWORK_NOT_INSTALLED));
    return 1;
  }
  return options.mode === 'open' ? runNetworkOpen(deps, instance) : runNetworkClose(deps, instance);
}
