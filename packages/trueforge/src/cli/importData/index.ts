import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { DataImportError } from '../../dataImport/importError';
import type { Command } from '../command';
import { errorCode } from '../errorCode';
import { UsageError } from '../io';
import type { ImportDataSession } from './session';

const USAGE = `Usage: aman import-data --in <file.zip> [--user <owner>] [--display-name <name>]

Restores a data export (made by aman export-data or the Export button) into this instance. The
instance has one account, its owner, and everything imported belongs to it. The instance must be
fresh (no chats, personas, agents or other data yet); stop the app before running this by hand.

  --in <file.zip>         The export archive
  --user <owner>          The owner's user id (default: the owner); any other id is refused
  --display-name <name>   How the owner is named on imported chats (default: the user id)

Prints the result as JSON on stdout and a summary on stderr. Exit codes: 0 ok, 1 failure, 2 usage.
`;

export interface ImportDataDeps {
  /** Opens the instance's stores; only called once the command line has been accepted. */
  open(): Promise<ImportDataSession>;
}

/** Server config validates the environment on import, so the real wiring loads it only when asked. */
const lazyDeps: ImportDataDeps = {
  open: async () => (await import('./runtime')).openImportDataSession(),
};

/** `parseArgs` errors are not `instanceof Error` everywhere (separate realms), so the message is read structurally. */
function argumentErrorMessage(error: unknown): string {
  const message: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined;
  return typeof message === 'string' && message !== '' ? message : 'Invalid arguments.';
}

function parseOptions(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      options: {
        in: { type: 'string' },
        user: { type: 'string' },
        'display-name': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    throw new UsageError(argumentErrorMessage(error), { cause: error });
  }
}

/** A failure is reported as one plain line. */
function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unexpected error.';
  const line = message.replace(/\s+/g, ' ').trim();
  return line === '' ? 'Unexpected error.' : line;
}

function describeFailure(error: unknown): Error {
  if (error instanceof DataImportError && error.status === 503) {
    return new Error(
      `${oneLine(error)} Start the instance, wait for it to finish downloading its search model, then run the import again.`,
      { cause: error },
    );
  }
  return new Error(oneLine(error), { cause: error });
}

async function readArchiveFile(file: string): Promise<Buffer> {
  try {
    if (!(await stat(file)).isFile()) {
      throw new Error(`${file} is not a file.`);
    }
    return await readFile(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new Error(`There is no file at ${file}.`, { cause: error });
    }
    throw error;
  }
}

export function createImportData(deps: ImportDataDeps): Command {
  return async ({ args, io }) => {
    const options = parseOptions(args);
    if (options.help) {
      await io.stderr(USAGE);
      return 0;
    }
    if (options.in === undefined || options.in.trim() === '') {
      throw new UsageError('Missing --in <file.zip>.');
    }
    if (options.user?.trim() === '') {
      throw new UsageError('--user needs a user id.');
    }
    const file = path.resolve(options.in);
    const archive = await readArchiveFile(file);

    const session = await deps.open().catch((error: unknown) => {
      throw describeFailure(error);
    });
    try {
      const userId = options.user?.trim() ?? session.owner;
      if (userId !== session.owner) {
        throw new UsageError(
          `--user must be this instance's owner (${session.owner}). The instance has one account, so an import is only made for its owner.`,
        );
      }
      const named = options['display-name']?.trim();
      const displayName = named === undefined || named === '' ? userId : named;
      const result = await session.importArchive({ archive, userId, displayName }).catch((error: unknown) => {
        throw describeFailure(error);
      });
      await session
        .recordAudit({ userId, description: `Imported data for ${userId} from the command line. ${result.summary}` })
        .catch(async (error: unknown) => {
          await io.stderr(`The import finished, but its audit row was not written: ${oneLine(error)}\n`);
        });
      await io.stderr(`${result.summary}\n`);
      await io.stdout(`${JSON.stringify({ user_id: userId, ...result })}\n`);
      return 0;
    } finally {
      await session.close().catch(() => undefined);
    }
  };
}

export const importData: Command = createImportData(lazyDeps);
