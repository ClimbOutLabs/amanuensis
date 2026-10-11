import { backup } from './backup';
import type { Command } from './command';
import { doctor } from './doctor';
import { hashPassword } from './hashPassword';
import { UsageError, type CliIo } from './io';

const COMMANDS: Readonly<Record<string, Command>> = {
  'hash-password': hashPassword,
  backup,
  doctor,
};

const USAGE = `Usage: amanuensis <command> [options]

Commands:
  hash-password   Read a password on stdin, print {"hash": "<bcrypt>"}
  backup          Copy the database, memory and persona knowledge to --target
  doctor          Check this instance and print the results

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
