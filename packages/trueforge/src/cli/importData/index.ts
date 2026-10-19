import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { DataImportError } from '../../dataImport/importError';
import type { ImportDataResult } from '../../schemas/dataImport';
import type { Command } from '../command';
import { errorCode } from '../errorCode';
import { UsageError } from '../io';
import type { ImportDataSession } from './session';

const USAGE = `Usage: aman import-data --in <file.zip> [--user <owner>] [--display-name <name>] [--dry-run]
       aman import-data --check-ready

Restores a data export (made by aman export-data) into this instance. Each person gets a new
instance. Everything imported belongs to this instance's owner. Only import a file you exported
yourself. The instance must be fresh (no chats, personas, agents or other data yet); stop the app
before running this by hand. This is run by whoever operates the instance, from a terminal on the
machine that runs it; there is no button in the app.

  --in <file.zip>         The export archive
  --user <owner>          The owner's user id (default: the owner); any other id is refused
  --display-name <name>   How the owner is named on imported chats (default: the user id)
  --dry-run               Check the file and say what an import would bring, including anything it would leave out, and change nothing
  --check-ready           Print whether the search model the import needs is on disk yet, and change nothing

Prints the summary on stdout, in plain words, and the result as JSON on stderr, where the
installer keeps it in the import log. Exit codes: 0 ok, 1 failure, 2 usage.
`;

export interface ImportDataDeps {
  /** Opens the instance's stores; only called once the command line has been accepted. */
  open(): Promise<ImportDataSession>;
  /** Whether the search model persona knowledge is indexed with is on disk; reads no database. */
  searchModelReady(): Promise<boolean>;
}

/** Server config validates the environment on import, so the real wiring loads it only when asked. */
const lazyDeps: ImportDataDeps = {
  open: async () => (await import('./runtime')).openImportDataSession(),
  searchModelReady: async () => (await import('./runtime')).isSearchModelReady(),
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
        'dry-run': { type: 'boolean', default: false },
        'check-ready': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    throw new UsageError(argumentErrorMessage(error), { cause: error });
  }
}

function counted({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

/** What an import brought, in one line, for the audit row; the printed summary is the full layout. */
function broughtLine(result: ImportDataResult): string {
  return [
    counted({ count: result.chats, singular: 'chat', plural: 'chats' }),
    counted({ count: result.memories, singular: 'memory', plural: 'memories' }),
    counted({ count: result.personas, singular: 'persona', plural: 'personas' }),
    counted({ count: result.spaces, singular: 'space', plural: 'spaces' }),
    counted({ count: result.agents, singular: 'agent', plural: 'agents' }),
    result.schedules === 0
      ? counted({ count: 0, singular: 'schedule', plural: 'schedules' })
      : `${counted({ count: result.schedules, singular: 'schedule', plural: 'schedules' })} (off)`,
  ].join(', ');
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
    if (options['check-ready']) {
      if (
        options.in !== undefined ||
        options.user !== undefined ||
        options['display-name'] !== undefined ||
        options['dry-run']
      ) {
        throw new UsageError('--check-ready takes no other options.');
      }
      const ready = await deps.searchModelReady();
      await io.stdout(`${JSON.stringify({ search_model: ready ? 'ready' : 'downloading' })}\n`);
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
          `--user must be this instance's owner (${session.owner}). Each person gets a new instance, so an import is only made for its owner.`,
        );
      }
      const named = options['display-name']?.trim();
      const displayName = named === undefined || named === '' ? userId : named;
      const dryRun = options['dry-run'];
      const result = await session.importArchive({ archive, userId, displayName, dryRun }).catch((error: unknown) => {
        throw describeFailure(error);
      });
      if (dryRun) {
        await io.stderr(`${JSON.stringify({ user_id: userId, dry_run: true, ...result })}\n`);
        await io.stdout(`${result.summary}\n`);
        return 0;
      }
      await session
        .recordAudit({
          userId,
          description: `Imported data for ${userId} from the command line. Imported ${broughtLine(result)}.`,
        })
        .catch(async (error: unknown) => {
          await io.stderr(`The import finished, but its audit row was not written: ${oneLine(error)}\n`);
        });
      await io.stderr(`${JSON.stringify({ user_id: userId, ...result })}\n`);
      await io.stdout(`${result.summary}\n`);
      return 0;
    } finally {
      await session.close().catch(() => undefined);
    }
  };
}

export const importData: Command = createImportData(lazyDeps);
