import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { knownSqliteMigrationNames } from '../db/migrateSqlite';
import { openSqliteFile } from '../db/sqlite/client';
import { sqliteDatabaseKey, sqliteDatabaseKeyFromRecovery } from '../secrets/sqliteAccess';
import type { Command } from './command';
import { processEnv, type CliEnv } from './env';
import { UsageError } from './io';

export interface BackupCheckDeps {
  env: CliEnv;
  /** The migrations this build can run. */
  knownMigrations(): Promise<string[]>;
}

const MigrationRowsSchema = z.array(z.object({ name: z.string() }));

/** The migrations a database records as run; a database that never ran one records none. */
function recordedMigrations({ file, key }: { file: string; key: Buffer | undefined }): string[] {
  const db = openSqliteFile({ filename: file, key, readonly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kysely_migration'").get();
    if (table === undefined) {
      return [];
    }
    return MigrationRowsSchema.parse(db.prepare('SELECT name FROM kysely_migration').all()).map(row => row.name);
  } finally {
    db.close();
  }
}

/**
 * Tells whether a backed-up database can be opened by this build. A database that a newer build has migrated
 * records migrations this one does not ship, and this build would refuse to start on it.
 */
export function createBackupCheck(deps: BackupCheckDeps): Command {
  return async ({ args, io }) => {
    let values: { sqlite?: string; 'key-file'?: string; 'recovery-key-file'?: string };
    try {
      ({ values } = parseArgs({
        args: [...args],
        options: {
          sqlite: { type: 'string' },
          'key-file': { type: 'string' },
          'recovery-key-file': { type: 'string' },
        },
        allowPositionals: false,
        strict: true,
      }));
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : 'Invalid arguments.', { cause: error });
    }
    if (values.sqlite === undefined || values.sqlite.trim() === '') {
      throw new UsageError('Missing --sqlite <file>.');
    }
    // A copy from another computer opens with its recovery key; any other with this computer's key, or with none
    // when it is from before encryption. Its key records are read from beside it.
    const recoveryKeyFile = values['recovery-key-file'];
    const key =
      recoveryKeyFile === undefined
        ? await sqliteDatabaseKey({
            sqlitePath: values.sqlite,
            keyFile: values['key-file'] ?? deps.env['SECRETS_KEY_FILE'],
          })
        : await sqliteDatabaseKeyFromRecovery({
            sqlitePath: values.sqlite,
            recoveryKey: await readFile(recoveryKeyFile, 'utf8'),
          });
    const known = new Set(await deps.knownMigrations());
    const unknown = recordedMigrations({ file: values.sqlite, key })
      .filter(name => !known.has(name))
      .sort();
    await io.stdout(`${JSON.stringify({ newer: unknown.length > 0, unknown_migrations: unknown })}\n`);
    return 0;
  };
}

export const backupCheck: Command = createBackupCheck({
  env: processEnv(),
  knownMigrations: knownSqliteMigrationNames,
});
