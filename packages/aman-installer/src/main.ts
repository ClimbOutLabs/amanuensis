import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runCli } from './cli.ts';
import { installerConfig } from './config.ts';
import { checkDocker } from './doctor/dockerDoctor.ts';
import { hostForPlatform } from './host/hostFor.ts';
import { UNEXPECTED_FAILURE, problemText } from './messages.ts';
import { SystemProcessRunner } from './runner/processRunner.ts';
import { SystemEngineRunner } from './setup/engine.ts';
import { defaultTempRoot } from './setup/runs.ts';
import { storeForHost } from './state/storeFor.ts';

// The one entry point: it wires the host, the runner and the folder
// state store together and runs the command.
const host = hostForPlatform(process.platform);
const runner = new SystemProcessRunner();
const config = installerConfig({ env: process.env, homeDir: homedir() });
const store = storeForHost({ stateHome: config.stateHome });
const print = (line: string) => {
  console.log(line);
};
const now = () => Math.floor(Date.now() / 1000);
// The shell installer this program drives: installer/ at the root of the
// repo this package lives in (packages/aman-installer/src -> repo root).
const installerDir = fileURLToPath(new URL('../../../installer', import.meta.url));

runCli(process.argv.slice(2), {
  host,
  runner,
  store,
  print,
  now,
  homeDir: config.homeDir,
  stateHome: config.stateHome,
  osReleasePath: config.osReleasePath,
  dockerConfigDir: config.dockerConfigDir,
  appService: config.appService,
  setup: {
    host,
    store,
    engine: new SystemEngineRunner({ installerDir }),
    stateHome: config.stateHome,
    dmiDir: config.dmiDir,
    tempRoot: defaultTempRoot(),
    nowSeconds: now,
    dockerCheck: () =>
      checkDocker({ host, runner, print: () => undefined }).then(
        code => code === 0,
        () => false,
      ),
    openBrowser: async (url: string) => {
      const opener = host.kind === 'darwin' ? 'open' : 'xdg-open';
      const result = await runner.run(opener, [url]).catch(() => null);
      return result !== null && result.exitCode === 0;
    },
    print,
  },
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
