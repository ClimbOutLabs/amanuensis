import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { importAbsoluteModule } from '../util/crossPlatform';
import type { Database } from './sqlite/types';

/**
 * Runs all pending SQLite migrations.
 *
 * Used at sqlite startup and by SQLite store tests.
 * Resolves `…/sqlite/migrations` next to this module (source or `dist/`).
 *
 * Kysely does not wrap SQLite migrations in a transaction (`supportsTransactionalDdl`
 * is false). Migrations that need atomicity open `db.transaction()` themselves;
 * `PRAGMA foreign_keys` must stay outside that txn.
 */
export async function migrateSqliteToLatest(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({
    db,
    // Parallel release branches have historically landed migrations out of
    // filename order. Missing migration files still fail closed, while this
    // lets each known migration run exactly once on either upgrade path.
    allowUnorderedMigrations: true,
    provider: new FileMigrationProvider({
      fs,
      path,
      import: importAbsoluteModule,
      migrationFolder: path.join(import.meta.dirname, 'sqlite', 'migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach(it => {
    if (it.status === 'Error') {
      console.error(`failed to execute migration "${it.migrationName}"`);
    }
  });

  if (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('failed to migrate', { cause: error });
  }
}
