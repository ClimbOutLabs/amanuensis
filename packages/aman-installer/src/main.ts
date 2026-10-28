import { homedir } from 'node:os';

import { runCli } from './cli.ts';
import { installerConfig } from './config.ts';
import { hostForPlatform } from './host/hostFor.ts';
import { systemWindowsJobs } from './host/windowsJobs.ts';
import { SystemProcessRunner } from './runner/processRunner.ts';
import { storeForHost } from './state/storeFor.ts';

// The one entry point the single executable is built from.
const host = hostForPlatform(process.platform);
const runner = new SystemProcessRunner();
const config = installerConfig({ env: process.env, homeDir: homedir() });
runCli(process.argv.slice(2), {
  host,
  runner,
  store: storeForHost({ host, runner, stateHome: config.stateHome }),
  windowsJobs: systemWindowsJobs({
    runner,
    localAppDataDir: config.localAppDataDir,
    selfExePath: process.execPath,
  }),
  probeHealth: async (url: string) => {
    try {
      const response = await fetch(url);
      return response.status === 200;
    } catch {
      return false;
    }
  },
  sleep: (ms: number) =>
    new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    }),
  print: (line: string) => {
    console.log(line);
  },
  now: () => Math.floor(Date.now() / 1000),
  homeDir: config.homeDir,
  stateHome: host.kind === 'windows' ? null : config.stateHome,
  osReleasePath: config.osReleasePath,
  dockerConfigDir: config.dockerConfigDir,
  appService: config.appService,
}).then(
  exitCode => {
    process.exitCode = exitCode;
  },
  () => {
    process.exitCode = 1;
  },
);
