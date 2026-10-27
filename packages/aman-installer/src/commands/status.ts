import type { Host } from '../host/host.ts';
import {
  DOCKER_NOT_ANSWERING,
  NOT_INSTALLED,
  NO_INSTANCES_LINE,
  STATE_BUSY,
  STATE_IMAGE_UNAVAILABLE,
  STATE_UNREADABLE,
  problemText,
  statusInstalledLine,
  statusInstanceLine,
  type InstanceState,
} from '../messages.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import {
  StateBusyError,
  StateDockerError,
  StateImageError,
  registryValue,
  type StateStore,
  type StateSummary,
} from '../state/state.ts';

export interface StatusDeps {
  host: Host;
  runner: ProcessRunner;
  store: StateStore;
  print: (line: string) => void;
}

// The shell counts an instance as running when at least this many of its
// containers are up (instance.sh, APP_EXPECTED_CONTAINERS).
const EXPECTED_CONTAINERS = 3;

async function instanceState(runner: ProcessRunner, name: string): Promise<InstanceState> {
  const result = await runner.run('docker', [
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=aman-${name}`,
    '--filter',
    'status=running',
  ]);
  const count = result.stdout.split('\n').filter(line => line.trim() !== '').length;
  if (count >= EXPECTED_CONTAINERS) {
    return 'running';
  }
  if (count > 0) {
    return 'partly running';
  }
  return 'stopped';
}

// aman status: what is installed, each instance's address, and whether it
// is running, read from the state home (on Windows, through one short-lived
// container that mounts the volume read-only).
export async function runStatus(deps: StatusDeps): Promise<number> {
  const { host, runner, store, print } = deps;
  let summary: StateSummary;
  try {
    summary = await store.readSummary();
  } catch (error) {
    if (error instanceof StateBusyError) {
      print(problemText(STATE_BUSY));
      return 1;
    }
    if (error instanceof StateDockerError) {
      print(problemText(DOCKER_NOT_ANSWERING[host.kind]));
      return 1;
    }
    if (error instanceof StateImageError) {
      print(problemText(STATE_IMAGE_UNAVAILABLE));
      return 1;
    }
    print(problemText(STATE_UNREADABLE));
    return 1;
  }
  if (summary.releaseUnreadable) {
    print(problemText(STATE_UNREADABLE));
    return 1;
  }
  if (summary.release === null && summary.instances.length === 0) {
    print(problemText(NOT_INSTALLED));
    return 1;
  }
  const version = summary.installedAppImage ?? summary.release?.appImage ?? null;
  if (version !== null) {
    print(statusInstalledLine(version));
  }
  if (summary.instances.length === 0) {
    print(NO_INSTANCES_LINE);
    return 0;
  }
  const probe = await runner.run('docker', ['ps', '-q']);
  const dockerAnswers = probe.started && probe.exitCode === 0;
  if (!dockerAnswers) {
    print(problemText(DOCKER_NOT_ANSWERING[host.kind]));
  }
  for (const instance of summary.instances) {
    const address = registryValue(instance.entries, 'public_url');
    const state: InstanceState = dockerAnswers ? await instanceState(runner, instance.name) : 'unknown';
    print(statusInstanceLine(instance.name, state, address === '' ? null : address));
  }
  return 0;
}
