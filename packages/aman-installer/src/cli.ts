import { existsSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';

import { runAdopt } from './commands/adopt.ts';
import { runBackup } from './commands/backup.ts';
import { runBackups } from './commands/backups.ts';
import { runInstall } from './commands/install.ts';
import { runNetwork } from './commands/network.ts';
import { runOpen } from './commands/open.ts';
import { runStatus } from './commands/status.ts';
import { runUpgrade } from './commands/upgrade.ts';
import { runVerify } from './commands/verify.ts';
import { checkDocker } from './doctor/dockerDoctor.ts';
import { runDoctor, type DoctorDeps } from './doctor/doctor.ts';
import type { Host } from './host/host.ts';
import type { WindowsJobs } from './host/windowsJobs.ts';
import {
  HELP_LINES,
  INSTALL_KEY_ON_COMMAND_LINE,
  UNKNOWN_DOCTOR_CHECK,
  installUsageProblem,
  problemText,
  unknownCommandProblem,
  versionLine,
} from './messages.ts';
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
  // The install command's questions, set by main: one asks on the
  // terminal, the other asks without showing what is typed. The
  // defaults keep an unwired install safe: no answer is ever given.
  ask?: (question: string) => Promise<string | null>;
  askSecret?: (question: string) => Promise<string | null>;
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
  if (first === 'install') {
    const rest = args.slice(1);
    // The model key is refused on the command line, the way the shell
    // installer refuses it: it would stay in the terminal's history.
    if (rest.some(arg => arg === '--token-factory-key' || arg.startsWith('--token-factory-key='))) {
      deps.print(problemText(INSTALL_KEY_ON_COMMAND_LINE));
      return 1;
    }
    const unknown = rest.find(arg => arg !== '--dry-run');
    if (unknown !== undefined) {
      deps.print(problemText(installUsageProblem(unknown)));
      return 1;
    }
    return runInstall(
      {
        ...deps,
        jobs: deps.windowsJobs,
        confirm:
          deps.confirm ??
          ((): Promise<boolean> => {
            return Promise.resolve(false);
          }),
        fetchBytes: deps.fetchBytes ?? fetchBytesFromNetwork,
        programsDir: deps.programsDir ?? null,
        arch: deps.arch ?? 'x64',
        interfaces: deps.interfaces ?? {},
        hostName: deps.hostName ?? '',
        ask:
          deps.ask ??
          ((): Promise<string | null> => {
            return Promise.resolve(null);
          }),
        askSecret:
          deps.askSecret ??
          ((): Promise<string | null> => {
            return Promise.resolve(null);
          }),
        ...(deps.releasePublicKey === undefined ? {} : { releasePublicKey: deps.releasePublicKey }),
      },
      { dryRun: rest.includes('--dry-run') },
    );
  }
  if (first === 'setup') {
    // What running Aman-Setup.exe with no command means, decided from
    // what is on the computer: the program in place is the upgrade, a
    // starter install the adopt step has not reached yet is the
    // adopt, and nothing at all is the first install. A record that
    // cannot be read proves nothing, so it falls to the install,
    // whose own Docker steps settle what is really there.
    if (deps.host.kind === 'windows' && deps.programsDir != null && existsSync(join(deps.programsDir, 'aman.exe'))) {
      return runCli(['upgrade'], deps);
    }
    const installed = await deps.store.readSummary().then(
      summary => !summary.releaseUnreadable && (summary.release !== null || summary.instances.length > 0),
      () => false,
    );
    return runCli([installed ? 'adopt' : 'install'], deps);
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
  if (first === 'backup') {
    return runBackup({
      host: deps.host,
      runner: deps.runner,
      store: deps.store,
      jobs: deps.windowsJobs,
      print: deps.print,
    });
  }
  if (first === 'backups') {
    return runBackups({ host: deps.host, jobs: deps.windowsJobs, print: deps.print });
  }
  if (first === 'verify') {
    return runVerify(deps, { file: second });
  }
  deps.print(problemText(unknownCommandProblem(first)));
  return 1;
}
