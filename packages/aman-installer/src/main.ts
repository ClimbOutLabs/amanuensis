import { runCli } from './cli.ts';
import { hostForPlatform } from './host/hostFor.ts';
import { SystemProcessRunner } from './runner/processRunner.ts';
import { storeForHost } from './state/storeFor.ts';

// The one entry point the single executable is built from.
const host = hostForPlatform(process.platform);
const runner = new SystemProcessRunner();
runCli(process.argv.slice(2), {
  host,
  runner,
  store: storeForHost(host, runner),
  print: (line: string) => {
    console.log(line);
  },
}).then(
  exitCode => {
    process.exitCode = exitCode;
  },
  () => {
    process.exitCode = 1;
  },
);
