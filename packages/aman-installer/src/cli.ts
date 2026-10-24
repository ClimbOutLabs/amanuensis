import { checkDocker } from './doctor/dockerDoctor.ts';
import type { Host } from './host/host.ts';
import { HELP_LINES, UNKNOWN_DOCTOR_CHECK, problemText, unknownCommandProblem, versionLine } from './messages.ts';
import type { ProcessRunner } from './runner/processRunner.ts';
import { INSTALLER_VERSION } from './version.ts';

export interface CliDeps {
  host: Host;
  runner: ProcessRunner;
  print: (line: string) => void;
}

export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const [first, second] = args;
  if (first === undefined) {
    for (const line of HELP_LINES) {
      deps.print(line);
    }
    return 0;
  }
  if (first === '--version' || first === 'version') {
    deps.print(versionLine(INSTALLER_VERSION));
    return 0;
  }
  if (first === 'doctor') {
    if (second === 'docker') {
      return checkDocker(deps);
    }
    deps.print(problemText(UNKNOWN_DOCTOR_CHECK));
    return 1;
  }
  deps.print(problemText(unknownCommandProblem(first)));
  return 1;
}
