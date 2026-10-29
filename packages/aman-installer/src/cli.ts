import type { NetworkInterfaceInfo } from 'node:os';

import { runAdopt } from './commands/adopt.ts';
import { runNetwork } from './commands/network.ts';
import { runOpen } from './commands/open.ts';
import { runStatus } from './commands/status.ts';
import { runUpgrade } from './commands/upgrade.ts';
import { runVerify } from './commands/verify.ts';
import { checkDocker } from './doctor/dockerDoctor.ts';
import { runDoctor, type DoctorDeps } from './doctor/doctor.ts';
import type { Host } from './host/host.ts';
import type { WindowsJobs } from './host/windowsJobs.ts';
import { HELP_LINES, UNKNOWN_DOCTOR_CHECK, problemText, unknownCommandProblem, versionLine } from './messages.ts';
import { fetchBytesFromNetwork, type FetchBytes } from './release/download.ts';
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
  // The Windows host jobs (the aman command's place, the shortcuts,
  // Docker Desktop, the browser): only the Windows commands use them,
  // and they refuse on any other system before touching them.
  windowsJobs: WindowsJobs;
  // The health check open waits for: true when the address answers.
  probeHealth: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  // Only a test sets this; the shipped command checks downloads
  // against the release key compiled into the executable.
  releasePublicKey?: string;
  // The upgrade's wiring, set by main. The defaults keep an unwired
  // upgrade safe: no question is answered yes, and no folder is assumed.
  confirm?: (question: string) => Promise<boolean>;
  fetchBytes?: FetchBytes;
  programsDir?: string | null;
  arch?: string;
  // The network command's wiring, set by main: this computer's network
  // adapters and its name. The defaults keep an unwired network
  // command safe: no adapters and no name, so it finds no address.
  interfaces?: Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>;
  hostName?: string;
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
    const rest = args.slice(1);
    if (rest.length === 0) {
      return runDoctor(deps, { json: false });
    }
    if (rest.length === 1 && rest[0] === 'docker') {
      return checkDocker(deps);
    }
    if (rest.every(arg => arg === '--json' || arg === '--local')) {
      return runDoctor(deps, { json: rest.includes('--json'), local: rest.includes('--local') });
    }
    deps.print(problemText(UNKNOWN_DOCTOR_CHECK));
    return 1;
  }
  if (first === 'status') {
    return runStatus(deps);
  }
  if (first === 'adopt') {
    return runAdopt({ host: deps.host, store: deps.store, jobs: deps.windowsJobs, print: deps.print });
  }
  if (first === 'open') {
    return runOpen({ ...deps, jobs: deps.windowsJobs });
  }
  if (first === 'network') {
    return runNetwork(
      {
        ...deps,
        jobs: deps.windowsJobs,
        interfaces: deps.interfaces ?? {},
        hostName: deps.hostName ?? '',
      },
      { mode: second },
    );
  }
  if (first === 'upgrade') {
    return runUpgrade({
      ...deps,
      confirm:
        deps.confirm ??
        ((): Promise<boolean> => {
          return Promise.resolve(false);
        }),
      fetchBytes: deps.fetchBytes ?? fetchBytesFromNetwork,
      programsDir: deps.programsDir ?? null,
      jobs: deps.windowsJobs,
      arch: deps.arch ?? 'x64',
      ...(deps.releasePublicKey === undefined ? {} : { releasePublicKey: deps.releasePublicKey }),
    });
  }
  if (first === 'verify') {
    return runVerify(deps, { file: second });
  }
  deps.print(problemText(unknownCommandProblem(first)));
  return 1;
}
