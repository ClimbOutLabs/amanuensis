import type { SystemKind } from './host/host.ts';
import { LOCK_TIMING } from './state/lockTiming.ts';

// Every sentence a person can read lives in this file, as a Problem with two
// fields: what happened, and what to do (one sentence, one action). A test in
// tests/messages.test.ts fails the build when a message breaks the rules in
// the plan: plain words, no jargon, at most 40 words, one action.
export interface Problem {
  happened: string;
  fix: string;
}

export function problemText(problem: Problem): string {
  return `${problem.happened} ${problem.fix}`;
}

export function versionLine(version: string): string {
  return `aman ${version}`;
}

export const HELP_LINES: readonly string[] = [
  'Aman installer. It sets up Aman on this computer and checks that things work.',
  'Run aman --version to see which version this is.',
  'Run aman doctor to check this computer and each instance.',
  'Run aman doctor docker to check that Docker is ready for Aman.',
  'Run aman status to see what is installed and whether it is running.',
];

export const DOCKER_NOT_INSTALLED: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker is not installed on this computer.',
    fix: 'Install Docker Desktop from its website, then run this check again.',
  },
  darwin: {
    happened: 'Docker is not installed on this computer.',
    fix: 'Install Docker Desktop from its website, then run this check again.',
  },
  linux: {
    happened: 'Docker is not installed on this computer.',
    fix: 'Install Docker Engine from its website, then run this check again.',
  },
};

export const DOCKER_NOT_RUNNING: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker Desktop is not running.',
    fix: 'Open Docker Desktop from the Start menu, then run this check again.',
  },
  darwin: {
    happened: 'Docker Desktop is not running.',
    fix: 'Open Docker Desktop from Launchpad, then run this check again.',
  },
  linux: {
    happened: 'Docker Engine is not running.',
    fix: 'Start Docker Engine on this computer, then run this check again.',
  },
};

export const COMPOSE_MISSING: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker is installed without its Compose tool, which Aman needs.',
    fix: 'Update Docker Desktop to the newest version, then run this check again.',
  },
  darwin: {
    happened: 'Docker is installed without its Compose tool, which Aman needs.',
    fix: 'Update Docker Desktop to the newest version, then run this check again.',
  },
  linux: {
    happened: 'Docker is installed without its Compose tool, which Aman needs.',
    fix: 'Install the Docker Compose add-on, then run this check again.',
  },
};

export const LOW_MEMORY: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker has less than 6 GB of memory to work with on this computer.',
    fix: 'Open Docker Desktop, choose Settings, then Resources, give it at least 6 GB, then run this check again.',
  },
  darwin: {
    happened: 'Docker has less than 6 GB of memory to work with on this computer.',
    fix: 'Give Docker Desktop at least 6 GB of memory in its settings, then run this check again.',
  },
  linux: {
    happened: 'This computer gives Docker Engine less than 6 GB of memory to work with.',
    fix: 'Free up memory on this computer so Docker Engine can use at least 6 GB, then run this check again.',
  },
};

// Said when Docker does not report its memory at all. On Windows and Mac
// the check fails with this instead of guessing from the whole computer's
// memory, which is not the memory Docker can use.
export const MEMORY_NOT_REPORTED: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker did not say how much memory it has to work with.',
    fix: 'Open Docker Desktop, choose Settings, then Resources, set the memory to at least 6 GB, then run this check again.',
  },
  darwin: {
    happened: 'Docker did not say how much memory it has to work with.',
    fix: 'Open Docker Desktop, check the memory in its settings, then run this check again.',
  },
  linux: {
    happened: 'Docker did not say how much memory it has to work with.',
    fix: 'Start Docker Engine again, then run this check again.',
  },
};

export const ENGINE_VERSION_MISSING: Problem = {
  happened: 'Docker did not say which Engine version it is running.',
  fix: 'Update Docker to the newest version, then run this check again.',
};

export function unknownCommandProblem(command: string): Problem {
  return {
    happened: `Aman does not know the command "${command}".`,
    fix: 'Run aman with no command to see what it can do.',
  };
}

export const UNKNOWN_DOCTOR_CHECK: Problem = {
  happened: 'That doctor check is not one Aman knows.',
  fix: 'Run aman doctor docker to check Docker on this computer.',
};

export function dockerInstalledLine(version: string): string {
  return `Docker is installed, version ${version}.`;
}

export function dockerRunningLine(engineVersion: string): string {
  return `Docker is running, Engine version ${engineVersion}.`;
}

export function composeReadyLine(version: string): string {
  return `Docker Compose is ready, version ${version}.`;
}

export function memoryReadyLine(sizeText: string): string {
  return `Docker has ${sizeText} of memory to work with, which is enough.`;
}

export const ALL_READY_LINE = 'Docker is ready for Aman on this computer.';

export const NOT_INSTALLED: Problem = {
  happened: 'Aman is not installed on this computer yet.',
  fix: 'Install Aman on this computer, then run aman status again.',
};

export const STATE_UNREADABLE: Problem = {
  happened: 'The record of what is installed could not be read.',
  fix: 'Run the installer again from the folder Aman was installed from, then run aman status again.',
};

// The wait is the lock's dead limit: an install stopped without cleaning up
// leaves its lock until its beats have been missing that long.
export const STATE_BUSY: Problem = {
  happened: 'Another install is running right now.',
  fix: `Wait for it to finish, or wait ${String(LOCK_TIMING.deadSeconds / 60)} minutes if you stopped an install a moment ago, then run aman status again.`,
};

export const STATE_IMAGE_UNAVAILABLE: Problem = {
  happened: 'Docker could not download the small helper it needs to read the record of what is installed.',
  fix: 'Check your internet connection, then run aman status again.',
};

export const DOCKER_NOT_ANSWERING: Record<SystemKind, Problem> = {
  windows: {
    happened: 'Docker is not answering, so whether each instance is running is unknown.',
    fix: 'Open Docker Desktop from the Start menu, then run aman status again.',
  },
  darwin: {
    happened: 'Docker is not answering, so whether each instance is running is unknown.',
    fix: 'Open Docker Desktop from Launchpad, then run aman status again.',
  },
  linux: {
    happened: 'Docker is not answering, so whether each instance is running is unknown.',
    fix: 'Start Docker Engine on this computer, then run aman status again.',
  },
};

// The name and the address come from files in the state home, so a control
// character in them must not reach the screen as a terminal command.
function printable(text: string): string {
  return text.replace(/\p{Cc}/gu, '');
}

export function statusInstalledLine(version: string): string {
  return `Aman is installed, version ${printable(version)}.`;
}

export type InstanceState = 'running' | 'partly running' | 'stopped' | 'unknown';

export function statusInstanceLine(name: string, state: InstanceState, address: string | null): string {
  if (state === 'unknown') {
    return `Instance ${printable(name)}: whether it is running is unknown.`;
  }
  if (address === null) {
    return `Instance ${printable(name)} is ${state}.`;
  }
  return `Instance ${printable(name)} is ${state} at ${printable(address)}.`;
}

export const NO_INSTANCES_LINE = 'No instance has been made yet.';

// Every message, in a fixed order, for the golden file reviewers read.
export function allMessageLines(): string[] {
  const lines: string[] = [versionLine('0.0.0'), ...HELP_LINES];
  const kinds: SystemKind[] = ['windows', 'darwin', 'linux'];
  for (const kind of kinds) {
    lines.push(problemText(DOCKER_NOT_INSTALLED[kind]));
    lines.push(problemText(DOCKER_NOT_RUNNING[kind]));
    lines.push(problemText(COMPOSE_MISSING[kind]));
    lines.push(problemText(LOW_MEMORY[kind]));
    lines.push(problemText(MEMORY_NOT_REPORTED[kind]));
    lines.push(problemText(DOCKER_NOT_ANSWERING[kind]));
  }
  lines.push(problemText(ENGINE_VERSION_MISSING));
  lines.push(problemText(unknownCommandProblem('example')));
  lines.push(problemText(UNKNOWN_DOCTOR_CHECK));
  lines.push(dockerInstalledLine('0.0.0'));
  lines.push(dockerRunningLine('0.0.0'));
  lines.push(composeReadyLine('0.0.0'));
  lines.push(memoryReadyLine('0 GB'));
  lines.push(ALL_READY_LINE);
  lines.push(problemText(NOT_INSTALLED));
  lines.push(problemText(STATE_UNREADABLE));
  lines.push(problemText(STATE_BUSY));
  lines.push(problemText(STATE_IMAGE_UNAVAILABLE));
  lines.push(statusInstalledLine('aman-app:0'));
  lines.push(statusInstanceLine('main', 'running', 'http://127.0.0.1:8791'));
  lines.push(statusInstanceLine('main', 'partly running', 'http://127.0.0.1:8791'));
  lines.push(statusInstanceLine('main', 'stopped', null));
  lines.push(statusInstanceLine('main', 'unknown', null));
  lines.push(NO_INSTANCES_LINE);
  return lines;
}
