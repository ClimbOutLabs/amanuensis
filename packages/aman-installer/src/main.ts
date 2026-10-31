import { homedir } from 'node:os';

import { runCli } from './cli.ts';
import { installerConfig } from './config.ts';
import { hostForPlatform } from './host/hostFor.ts';
import { UNEXPECTED_FAILURE, problemText } from './messages.ts';
import { SystemProcessRunner } from './runner/processRunner.ts';
import { storeForHost } from './state/storeFor.ts';

// The one entry point: it wires the host, the runner and the folder
// state store together and runs the command.
const host = hostForPlatform(process.platform);
const runner = new SystemProcessRunner();
const config = installerConfig({ env: process.env, homeDir: homedir() });

runCli(process.argv.slice(2), {
  host,
  runner,
  store: storeForHost({ stateHome: config.stateHome }),
  print: (line: string) => {
    console.log(line);
  },
  now: () => Math.floor(Date.now() / 1000),
  homeDir: config.homeDir,
  stateHome: config.stateHome,
  osReleasePath: config.osReleasePath,
  dockerConfigDir: config.dockerConfigDir,
  appService: config.appService,
}).then(
  exitCode => {
    process.exitCode = exitCode;
  },
  () => {
    // A failure no command planned for still owes the person one
    // plain problem and a next step, never a silent exit.
    console.log(problemText(UNEXPECTED_FAILURE));
    process.exitCode = 1;
  },
);
