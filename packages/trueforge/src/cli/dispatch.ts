import type { Command } from './command';
import { demoSeed } from './demoSeed';
import { UsageError, type CliIo } from './io';

const COMMANDS: Readonly<Record<string, Command>> = {
  'demo-seed': demoSeed,
};

const USAGE = `Usage: aman <command> [options]

Commands:
  demo-seed       Seed one synthetic demo world (needs DEMO_MODE=true); --reset removes it

JSON goes to stdout, messages to stderr. Exit codes: 0 ok, 1 failure, 2 usage.
`;

/** Runs one command and returns its exit code; nothing here loads the server config. */
export async function runCli({ argv, io }: { argv: readonly string[]; io: CliIo }): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    await io.stderr(USAGE);
    return name === undefined ? 2 : 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) {
    await io.stderr(`Unknown command "${name}".\n\n${USAGE}`);
    return 2;
  }
  try {
    return await command({ args, io });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error.';
    await io.stderr(`${message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
