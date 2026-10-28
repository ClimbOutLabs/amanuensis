import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { runCli } from './cli.ts';
import { resolvePendingSwap } from './commands/upgrade.ts';
import { installerConfig } from './config.ts';
import { hostForPlatform } from './host/hostFor.ts';
import { fetchBytesFromNetwork } from './release/download.ts';
import { SystemProcessRunner } from './runner/processRunner.ts';
import { storeForHost } from './state/storeFor.ts';

// The one entry point the single executable is built from.
const host = hostForPlatform(process.platform);
const runner = new SystemProcessRunner();
const config = installerConfig({ env: process.env, homeDir: homedir() });

// The folders the adopt step works with on Windows: the installed
// program's folder, and the Start menu Programs folder above the Aman
// entries. Null everywhere Windows does not name the roots.
const programsDir = config.localAppDataDir === null ? null : join(config.localAppDataDir, 'Programs', 'Amanuensis');
const startMenuDir =
  config.appDataDir === null ? null : join(config.appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

// The upgrade's one question, asked on the terminal. Anything but an
// explicit yes is a no, and a closed terminal is a no.
async function askConfirm(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`${question} Type yes to go ahead: `);
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    terminal.close();
  }
}

// This same program is also built as Aman-Setup.exe (the setup build
// names its output, not its code). Run with no command under that name,
// it is the upgrade: on an installed PC that is the whole of re-running
// the setup file, and where Aman is not installed the upgrade says so.
// The first-install build adds its own path ahead of this one.
function invokedAsSetup(): boolean {
  for (const path of [process.argv[1] ?? '', process.execPath]) {
    if (/^aman-setup(\.exe)?$/i.test(basename(path))) {
      return true;
    }
  }
  return false;
}

let args = process.argv.slice(2);
if (args.length === 0 && invokedAsSetup()) {
  args = ['upgrade'];
}
if (host.kind === 'windows' && programsDir !== null) {
  resolvePendingSwap(programsDir);
}
runCli(args, {
  host,
  runner,
  store: storeForHost({ host, runner, stateHome: config.stateHome }),
  print: (line: string) => {
    console.log(line);
  },
  now: () => Math.floor(Date.now() / 1000),
  homeDir: config.homeDir,
  stateHome: host.kind === 'windows' ? null : config.stateHome,
  osReleasePath: config.osReleasePath,
  dockerConfigDir: config.dockerConfigDir,
  appService: config.appService,
  confirm: askConfirm,
  fetchBytes: fetchBytesFromNetwork,
  programsDir,
  startMenuDir,
  arch: process.arch,
}).then(
  exitCode => {
    process.exitCode = exitCode;
  },
  () => {
    process.exitCode = 1;
  },
);
