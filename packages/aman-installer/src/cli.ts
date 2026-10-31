import { runStatus } from './commands/status.ts';
import { checkDocker } from './doctor/dockerDoctor.ts';
import { runDoctor, type DoctorDeps } from './doctor/doctor.ts';
import { HELP_LINES, UNKNOWN_DOCTOR_CHECK, problemText, unknownCommandProblem, versionLine } from './messages.ts';
import { INSTALLER_VERSION } from './version.ts';

// The commands this program runs today: doctor and status, the two read
// paths over the folder state. Setup and install live in the shell
// installer; the wizard that drives it joins this program later. Every
// command is built from the one deps object main wires up.
export type CliDeps = DoctorDeps;

export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const [first] = args;
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
    const rest = args.slice(1);
    if (rest.length === 0) {
      return runDoctor(deps, { json: false });
    }
    if (rest.length === 1 && rest[0] === 'docker') {
      return checkDocker(deps);
    }
    if (rest.every(arg => arg === '--json' || arg === '--local' || arg === '--fix')) {
      return runDoctor(deps, {
        json: rest.includes('--json'),
        local: rest.includes('--local'),
        fix: rest.includes('--fix'),
      });
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
