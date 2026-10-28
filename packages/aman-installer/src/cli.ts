import { runStatus } from './commands/status.ts';
import { checkDocker } from './doctor/dockerDoctor.ts';
import { runDoctor, type DoctorDeps } from './doctor/doctor.ts';
import type { Host } from './host/host.ts';
import { HELP_LINES, UNKNOWN_DOCTOR_CHECK, problemText, unknownCommandProblem, versionLine } from './messages.ts';
import type { ProcessRunner } from './runner/processRunner.ts';
import type { StateStore } from './state/state.ts';
import { INSTALLER_VERSION } from './version.ts';

// The doctor's extra inputs ride along in the same deps, so every command
// is built from the one deps object main wires up.
export interface CliDeps extends DoctorDeps {
  host: Host;
  runner: ProcessRunner;
  store: StateStore;
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
    if (second === undefined) {
      return runDoctor(deps, { json: false });
    }
    if (second === '--json') {
      return runDoctor(deps, { json: true });
    }
    if (second === 'docker') {
      return checkDocker(deps);
    }
    deps.print(problemText(UNKNOWN_DOCTOR_CHECK));
    return 1;
  }
  if (first === 'status') {
    return runStatus(deps);
  }
  deps.print(problemText(unknownCommandProblem(first)));
  return 1;
}
