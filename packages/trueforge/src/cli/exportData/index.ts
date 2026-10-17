import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { parseArgs } from 'node:util';

import type { Command } from '../command';
import { UsageError } from '../io';
import type { ExportDataSession } from './session';
import { looksLikeOldSchema } from './stores';

const USAGE = `Usage: aman export-data --list-users
       aman export-data --user <id> --out <file.zip> [--include-uploads] [--include-instance-data] [--migrate]
                        [--secrets-env <file>]

Exports one person's data (chats, sessions, agents, personas, spaces, schedules, connectors without
their keys, settings and memory) from this instance's database and memory files. This is run by
whoever operates the instance, from a terminal on the machine that runs it; there is no button in the app.

  --list-users              Print the user ids that own sessions, with their session counts
  --user <id>               The user id from --list-users
  --out <file.zip>          Where to write the archive; it is written whole or not at all, and never overwritten
  --include-uploads         Also include the files people uploaded to their chats
  --include-instance-data   Also include the shared memories and instance settings; they can hold other
                            people's data, so use it only when nobody else used this instance
  --migrate                 First update an older database to this version's schema (changes the database; back it up)
  --secrets-env <file>      Also blank the keys and passwords in this settings file, such as an old stack's .env

Without sign-in, all data belongs to one user id, which --list-users always shows.
`;

export interface ExportDataDeps {
  /** Opens the instance's stores; only called once the command line has been accepted. */
  open(options: { migrate: boolean }): Promise<ExportDataSession>;
}

/** Server config validates the environment on import, so the real wiring loads it only when asked. */
const lazyDeps: ExportDataDeps = {
  open: async options => (await import('./runtime')).openExportDataSession(options),
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
        'list-users': { type: 'boolean', default: false },
        user: { type: 'string' },
        out: { type: 'string' },
        'include-uploads': { type: 'boolean', default: false },
        'include-instance-data': { type: 'boolean', default: false },
        migrate: { type: 'boolean', default: false },
        'secrets-env': { type: 'string' },
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

function describeFailure({ error, migrate }: { error: unknown; migrate: boolean }): Error {
  const message = oneLine(error);
  const hint =
    !migrate && looksLikeOldSchema(message)
      ? ' The database looks older than this version; back it up and retry with --migrate.'
      : '';
  return new Error(`${message}${hint}`, { cause: error });
}

async function printJson({ io, value }: { io: { stdout(text: string): Promise<void> }; value: unknown }) {
  await io.stdout(`${JSON.stringify(value)}\n`);
}

export function createExportData(deps: ExportDataDeps): Command {
  return async ({ args, io }) => {
    const options = parseOptions(args);
    if (options.help) {
      await io.stderr(USAGE);
      return 0;
    }
    const listing = options['list-users'];
    if (listing === (options.user !== undefined)) {
      throw new UsageError('Use either --list-users, or --user <id> with --out <file.zip>.');
    }
    if (
      listing &&
      (options.out !== undefined ||
        options['include-uploads'] ||
        options['include-instance-data'] ||
        options['secrets-env'] !== undefined)
    ) {
      throw new UsageError('--list-users takes no other options except --migrate.');
    }
    const userId = options.user?.trim();
    if (!listing && (userId === undefined || userId === '')) {
      throw new UsageError('--user needs a user id; run --list-users to see them.');
    }
    if (!listing && (options.out === undefined || options.out.trim() === '')) {
      throw new UsageError('Missing --out <file.zip>.');
    }

    // Everything that can be checked before the database is opened is checked here.
    const target = options.out === undefined ? undefined : path.resolve(options.out);
    if (target !== undefined) {
      if (existsSync(target)) {
        throw new Error(`${target} already exists; export-data never overwrites.`);
      }
      const directory = path.dirname(target);
      if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new Error(`The directory ${directory} does not exist.`);
      }
    }

    const secretsEnvText =
      options['secrets-env'] === undefined ? undefined : await readSecretsEnv(path.resolve(options['secrets-env']));
    const plan = userId !== undefined && target !== undefined ? { userId, target, secretsEnvText } : undefined;

    let session: ExportDataSession;
    try {
      session = await deps.open({ migrate: options.migrate });
    } catch (error) {
      throw describeFailure({ error, migrate: options.migrate });
    }
    try {
      const owners = await session.listOwners();
      if (plan === undefined) {
        await printJson({
          io,
          value: {
            sign_in: session.signInOffUserId === undefined ? 'on' : 'off',
            ...(session.signInOffUserId === undefined ? {} : { sign_in_off_user_id: session.signInOffUserId }),
            users: owners,
          },
        });
        return 0;
      }
      if (!owners.some(owner => owner.user_id === plan.userId)) {
        throw new Error(`No sessions belong to the user "${plan.userId}". Run --list-users for the ids that do.`);
      }
      const result = await writeArchive({ session, plan, options }).catch(async (error: unknown) => {
        // Best effort: the database that failed the export may be the one that cannot take the row.
        await session
          .recordAudit({ description: `Data export of user ${plan.userId} from the command line failed.` })
          .catch(() => undefined);
        throw error;
      });
      await session
        .recordAudit({
          description: `Exported data of user ${plan.userId} from the command line (${String(result.bytesWritten)} bytes).`,
        })
        .catch(async (error: unknown) => {
          await io.stderr(`The export was written, but its audit row was not: ${oneLine(error)}\n`);
        });
      await printJson({
        io,
        value: {
          user_id: plan.userId,
          out: plan.target,
          bytes: result.bytesWritten,
          files: result.entries,
          redactions: result.redactions,
          uploads_included: options['include-uploads'],
          instance_data_included: options['include-instance-data'],
          persona_memory_left_out: result.personaVaultsLeftOut,
        },
      });
      if (!options['include-instance-data']) {
        await io.stderr(
          'Shared memories and instance settings were left out. If nobody else used this instance, export again with --include-instance-data.\n',
        );
      }
      if (result.personaVaultsLeftOut > 0) {
        await io.stderr(
          `Memory of ${String(result.personaVaultsLeftOut)} persona(s) was left out: another person here has a persona with the same name, so that memory is shared.\n`,
        );
      }
      return 0;
    } catch (error) {
      if (error instanceof UsageError) {
        throw error;
      }
      throw describeFailure({ error, migrate: options.migrate });
    } finally {
      await session.close().catch(() => undefined);
    }
  };
}

async function readSecretsEnv(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`The settings file ${file} could not be read. Pass --secrets-env a readable .env file.`, {
      cause: error,
    });
  }
}

/** Writes beside the target and renames when whole, so a failure never leaves a partial archive. */
async function writeArchive({
  session,
  plan: { userId, target, secretsEnvText },
  options,
}: {
  session: ExportDataSession;
  plan: { userId: string; target: string; secretsEnvText: string | undefined };
  options: { 'include-uploads': boolean; 'include-instance-data': boolean };
}) {
  const partial = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString('hex')}.partial`,
  );
  const file = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
  let fileError: unknown;
  file.on('error', error => {
    fileError = error;
  });
  try {
    const result = await session.exportUser({
      userId,
      includeUploads: options['include-uploads'],
      includeInstanceData: options['include-instance-data'],
      secretsEnvText,
      out: file,
    });
    file.end();
    await finished(file);
    await rename(partial, target);
    return result;
  } catch (error) {
    file.destroy();
    // The file may still be opening; removing it before it closes would let the open create it again.
    if (!file.closed) {
      await once(file, 'close');
    }
    await rm(partial, { force: true });
    // A full or failing disk surfaces as a closed destination; report the disk.
    throw fileError ?? error;
  }
}

export const exportData: Command = createExportData(lazyDeps);
