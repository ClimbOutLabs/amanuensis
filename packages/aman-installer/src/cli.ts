import { runStatus } from './commands/status.ts';
import { checkDocker } from './doctor/dockerDoctor.ts';
import { runDoctor, type DoctorDeps } from './doctor/doctor.ts';
import { HELP_LINES, UNKNOWN_DOCTOR_CHECK, problemText, unknownCommandProblem, versionLine } from './messages.ts';
import { runSetup, type SetupDeps } from './setup/setup.ts';
import { INSTALLER_VERSION } from './version.ts';

// The commands this program runs: doctor and status, the two read paths
// over the folder state, and setup, the guided install that drives the
// shell installer from a local page. Every command is built from the one
// deps object main wires up; setup's deps ride along as their own set,
// since the wizard runs a server the read paths never start.
export interface CliDeps extends DoctorDeps {
  setup?: SetupDeps;
}

// With nothing installed, aman on its own opens the guided setup: that
// is the default way in. With an install in place (or no setup wired),
// it prints what it can do, as it always has.
async function nothingInstalled(deps: CliDeps): Promise<boolean> {
  const summary = await deps.store.readSummary().catch(() => null);
  return summary !== null && summary.release === null && summary.instances.length === 0;
}

async function runSetupCommand(deps: CliDeps, noBrowser: boolean): Promise<number> {
  const setup = deps.setup;
  if (setup === undefined) {
    deps.print(problemText(unknownCommandProblem('setup')));
    return 1;
  }
  const handle = await runSetup(setup, { noBrowser });
  await handle.closed;
  return 0;
}

export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const [first] = args;
  if (first === undefined) {
    if (deps.setup !== undefined && (await nothingInstalled(deps))) {
      return runSetupCommand(deps, false);
    }
    for (const line of HELP_LINES) {
      deps.print(line);
    }
    return 0;
  }
  if (first === '--version' || first === 'version') {
    deps.print(versionLine(INSTALLER_VERSION));
    return 0;
  }
  if (first === 'setup') {
    const rest = args.slice(1);
    if (rest.every(arg => arg === '--no-browser')) {
      return runSetupCommand(deps, rest.includes('--no-browser'));
    }
    deps.print(problemText(unknownCommandProblem(first)));
    return 1;
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
