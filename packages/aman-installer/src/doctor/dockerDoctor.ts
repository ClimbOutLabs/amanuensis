import type { Host } from '../host/host.ts';
import {
  ALL_READY_LINE,
  COMPOSE_MISSING,
  DOCKER_NOT_INSTALLED,
  DOCKER_NOT_RUNNING,
  ENGINE_VERSION_MISSING,
  LOW_MEMORY,
  composeReadyLine,
  dockerInstalledLine,
  dockerRunningLine,
  memoryReadyLine,
  problemText,
} from '../messages.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';

export const MIN_MEMORY_BYTES = 6 * 1024 * 1024 * 1024;

export interface DoctorDeps {
  host: Host;
  runner: ProcessRunner;
  print: (line: string) => void;
}

function versionFrom(text: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(text);
  const version = match?.[1];
  if (version === undefined) {
    return null;
  }
  return version;
}

function memoryText(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  return `${String(Math.round(gib * 10) / 10)} GB`;
}

// Checks, in order: Docker installed, Docker running, Compose present,
// memory at least 6 GB, and the Engine version. Each failed check prints
// one Problem in this system's own words and stops the run.
export async function checkDocker(deps: DoctorDeps): Promise<number> {
  const { host, runner, print } = deps;

  const versionResult = await runner.run('docker', ['--version']);
  const dockerVersion =
    versionResult.started && versionResult.exitCode === 0 ? versionFrom(versionResult.stdout) : null;
  if (dockerVersion === null) {
    print(problemText(DOCKER_NOT_INSTALLED[host.kind]));
    return 1;
  }
  print(dockerInstalledLine(dockerVersion));

  const engineResult = await runner.run('docker', ['info', '--format', '{{.ServerVersion}}']);
  const engineVersion = engineResult.exitCode === 0 ? engineResult.stdout.trim() : '';
  if (!engineResult.started || engineResult.exitCode !== 0) {
    print(problemText(DOCKER_NOT_RUNNING[host.kind]));
    return 1;
  }
  if (engineVersion === '') {
    print(problemText(ENGINE_VERSION_MISSING));
    return 1;
  }
  print(dockerRunningLine(engineVersion));

  const composeResult = await runner.run('docker', ['compose', 'version']);
  const composeVersion =
    composeResult.started && composeResult.exitCode === 0 ? versionFrom(composeResult.stdout) : null;
  if (composeVersion === null) {
    print(problemText(COMPOSE_MISSING[host.kind]));
    return 1;
  }
  print(composeReadyLine(composeVersion));

  const memoryResult = await runner.run('docker', ['info', '--format', '{{.MemTotal}}']);
  const engineMemory = Number.parseInt(memoryResult.stdout.trim(), 10);
  const memoryBytes = Number.isNaN(engineMemory) || engineMemory <= 0 ? host.memoryBytes() : engineMemory;
  if (memoryBytes < MIN_MEMORY_BYTES) {
    print(problemText(LOW_MEMORY[host.kind]));
    return 1;
  }
  print(memoryReadyLine(memoryText(memoryBytes)));

  print(ALL_READY_LINE);
  return 0;
}
