import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';
import { z } from 'zod';

import { knownSqliteMigrationNames } from '../db/migrateSqlite';
import type { Command } from './command';
import { UsageError } from './io';

export interface BackupCheckDeps {
  /** The migrations this build can run. */
  knownMigrations(): Promise<string[]>;
}

const MigrationRowsSchema = z.array(z.object({ name: z.string() }));

/** The migrations a database records as run; a database that never ran one records none. */
function recordedMigrations(file: string): string[] {
  const db = new Database(file, { fileMustExist: true, readonly: true });
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
    let values: { sqlite?: string };
    try {
      ({ values } = parseArgs({
        args: [...args],
        options: { sqlite: { type: 'string' } },
        allowPositionals: false,
        strict: true,
      }));
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : 'Invalid arguments.', { cause: error });
    }
    if (values.sqlite === undefined || values.sqlite.trim() === '') {
      throw new UsageError('Missing --sqlite <file>.');
    }
    const known = new Set(await deps.knownMigrations());
    const unknown = recordedMigrations(values.sqlite)
      .filter(name => !known.has(name))
      .sort();
    await io.stdout(`${JSON.stringify({ newer: unknown.length > 0, unknown_migrations: unknown })}\n`);
    return 0;
  };
}

export const backupCheck: Command = createBackupCheck({ knownMigrations: knownSqliteMigrationNames });
