import { runCli } from './cli.ts';
import { hostForPlatform } from './host/hostFor.ts';
import { SystemProcessRunner } from './runner/processRunner.ts';

// The one entry point the single executable is built from.
runCli(process.argv.slice(2), {
  host: hostForPlatform(process.platform),
  runner: new SystemProcessRunner(),
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
