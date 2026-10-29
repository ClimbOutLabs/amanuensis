import type { Host } from '../host/host.ts';
import { WindowsJobError, type WindowsJobs } from '../host/windowsJobs.ts';
import {
  OPEN_ADDRESS_MISSING,
  OPEN_DID_NOT_ANSWER,
  OPEN_DOCKER_DID_NOT_START,
  OPEN_DOCKER_MISSING,
  OPEN_IMAGE_UNAVAILABLE,
  OPEN_NOT_INSTALLED,
  OPEN_NOT_WINDOWS,
  OPEN_STATE_UNREADABLE,
  openBrowserFailedProblem,
  openReadyLine,
  problemText,
} from '../messages.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';
import {
  StateImageError,
  registryValue,
  type RegistryEntry,
  type StateStore,
  type StateSummary,
} from '../state/state.ts';

export interface OpenDeps {
  host: Host;
  runner: ProcessRunner;
  store: StateStore;
  jobs: WindowsJobs;
  print: (line: string) => void;
  now: () => number;
  probeHealth: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

// The wait matches the installer's own wait for an instance to answer
// (the compose --wait-timeout 240 of instance.sh), polled every two
// seconds.
const WAIT_SECONDS = 240;
const POLL_MS = 2000;

async function dockerAnswers(runner: ProcessRunner): Promise<boolean> {
  const result = await runner.run('docker', ['info', '--format', '{{.ServerVersion}}']);
  return result.started && result.exitCode === 0;
}

// The instance's recorded app port: the registry's app_port, with the
// port of the recorded public address behind it. Reading the record is
// the rule (the starter spec's review): the port is never assumed.
function recordedPort(entries: readonly RegistryEntry[]): number | null {
  const appPort = registryValue(entries, 'app_port');
  if (appPort !== null && /^\d+$/.test(appPort)) {
    const port = Number.parseInt(appPort, 10);
    if (port >= 1 && port <= 65535) {
      return port;
    }
  }
  const publicUrl = registryValue(entries, 'public_url');
  if (publicUrl !== null) {
    const match = /:(\d+)(?:\/|$)/.exec(publicUrl);
    const digits = match?.[1];
    if (digits !== undefined) {
      const port = Number.parseInt(digits, 10);
      if (port >= 1 && port <= 65535) {
        return port;
      }
    }
  }
  return null;
}

// aman open: what Aman-Setup.cmd open did. Start Docker Desktop if it
// is not running, wait until the app's health check answers at the
// recorded address, then open the browser there. The state record lives
// behind Docker on Windows, so Docker comes first.
export async function runOpen(deps: OpenDeps): Promise<number> {
  const { host, runner, store, jobs, print } = deps;
  if (host.kind !== 'windows') {
    print(problemText(OPEN_NOT_WINDOWS));
    return 1;
  }
  const version = await runner.run('docker', ['--version']);
  if (!version.started || version.exitCode !== 0) {
    print(problemText(OPEN_DOCKER_MISSING));
    return 1;
  }
  const waitFor = async (check: () => Promise<boolean>): Promise<boolean> => {
    const deadline = deps.now() + WAIT_SECONDS;
    for (;;) {
      if (await check()) {
        return true;
      }
      if (deps.now() >= deadline) {
        return false;
      }
      await deps.sleep(POLL_MS);
    }
  };
  if (!(await dockerAnswers(runner))) {
    try {
      await jobs.startDockerDesktop();
    } catch (error) {
      if (error instanceof WindowsJobError) {
        print(problemText(OPEN_DOCKER_DID_NOT_START));
        return 1;
      }
      throw error;
    }
    if (!(await waitFor(() => dockerAnswers(runner)))) {
      print(problemText(OPEN_DOCKER_DID_NOT_START));
      return 1;
    }
  }
  let summary: StateSummary;
  try {
    summary = await store.readSummary();
  } catch (error) {
    if (error instanceof StateImageError) {
      print(problemText(OPEN_IMAGE_UNAVAILABLE));
      return 1;
    }
    print(problemText(OPEN_STATE_UNREADABLE));
    return 1;
  }
  if (summary.releaseUnreadable) {
    print(problemText(OPEN_STATE_UNREADABLE));
    return 1;
  }
  const instance = summary.instances.find(candidate => candidate.name === 'main') ?? summary.instances[0];
  if (instance === undefined) {
    print(problemText(OPEN_NOT_INSTALLED));
    return 1;
  }
  const port = recordedPort(instance.entries);
  if (port === null) {
    print(problemText(OPEN_ADDRESS_MISSING));
    return 1;
  }
  const address = `http://127.0.0.1:${String(port)}`;
  if (!(await waitFor(() => deps.probeHealth(`${address}/healthz`)))) {
    print(problemText(OPEN_DID_NOT_ANSWER));
    return 1;
  }
  try {
    await jobs.openBrowser(address);
  } catch {
    print(problemText(openBrowserFailedProblem(address)));
    return 1;
  }
  print(openReadyLine(address));
  return 0;
}
