import type { Host } from '../host/host.ts';
import {
  ALL_READY_LINE,
  COMPOSE_MISSING,
  DOCKER_NOT_INSTALLED,
  DOCKER_NOT_RUNNING,
  ENGINE_TOO_OLD,
  ENGINE_VERSION_MISSING,
  LOW_MEMORY,
  MEMORY_NOT_REPORTED,
  composeReadyLine,
  dockerInstalledLine,
  dockerRunningLine,
  memoryReadyLine,
  problemText,
} from '../messages.ts';
import type { ProcessRunner } from '../runner/processRunner.ts';

export const MIN_MEMORY_BYTES = 6 * 1024 * 1024 * 1024;

// The oldest Engine that can mount one folder inside a volume, which is
// how the https folders are mounted on a Windows PC, where the state
// lives in a volume: mounting a folder inside a volume arrived in
// Engine 26.
export const MIN_ENGINE_VERSION_FOR_SUBPATH = '26.0.0';

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

function versionParts(version: string): [number, number, number] | null {
  const found = versionFrom(version);
  if (found === null) {
    return null;
  }
  const parts = found.split('.').map(part => Number.parseInt(part, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

// A version Docker reports in a shape this check cannot read is not
// judged here; a version that was never reported at all fails earlier,
// as ENGINE_VERSION_MISSING.
function engineSupportsSubpath(engineVersion: string): boolean {
  const parts = versionParts(engineVersion);
  const floor = versionParts(MIN_ENGINE_VERSION_FOR_SUBPATH);
  if (parts === null || floor === null) {
    return true;
  }
  for (let index = 0; index < 3; index += 1) {
    const part = parts[index] ?? 0;
    const floorPart = floor[index] ?? 0;
    if (part !== floorPart) {
      return part > floorPart;
    }
  }
  return true;
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
  // The Engine version is read here, with the running check, but an empty
  // one only fails at the end, so the checks surface in the stated order.
  if (engineVersion !== '') {
    print(dockerRunningLine(engineVersion));
  }

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
  let memoryBytes: number | null =
    memoryResult.started && memoryResult.exitCode === 0 && !Number.isNaN(engineMemory) && engineMemory > 0
      ? engineMemory
      : null;
  if (memoryBytes === null && host.kind === 'linux') {
    // On Linux, Docker Engine uses the computer's own memory directly, so
    // the host total is the memory Docker can use when Docker reports none.
    // On Windows and Mac, Docker gets only part of the computer's memory,
    // so a missing report fails below instead of passing on a wrong guess.
    memoryBytes = host.memoryBytes();
  }
  if (memoryBytes === null) {
    print(problemText(MEMORY_NOT_REPORTED[host.kind]));
    return 1;
  }
  if (memoryBytes < MIN_MEMORY_BYTES) {
    print(problemText(LOW_MEMORY[host.kind]));
    return 1;
  }
  print(memoryReadyLine(memoryText(memoryBytes)));

  if (engineVersion === '') {
    print(problemText(ENGINE_VERSION_MISSING));
    return 1;
  }
  if (!engineSupportsSubpath(engineVersion)) {
    print(problemText(ENGINE_TOO_OLD[host.kind]));
    return 1;
  }

  print(ALL_READY_LINE);
  return 0;
}
