import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Per-user allowance for package downloads in chats that are not working on a project: true lets
 * the sandbox download packages there through the mirrors, false asks on the first download.
 * Defaults to false, off, including for a user with a saved row: a download allowance is only
 * ever granted by the person's own approval or switch.
 * Mirrors db/sqlite/migrations/20261031_000001_sentinel_package_downloads_without_project.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('sentinel_user_settings')
      .addColumn('package_downloads_without_project_allowed', 'boolean', col => col.notNull().defaultTo(false))
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('sentinel_user_settings')
      .dropColumn('package_downloads_without_project_allowed')
      .execute();
  });
}
