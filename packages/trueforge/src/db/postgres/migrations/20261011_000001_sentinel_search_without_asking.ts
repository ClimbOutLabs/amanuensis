import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Per-user switch for the designated search provider: true runs its searches without asking, false
 * asks for each one. Defaults to true so a user with a saved row gets the same default as one without.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('sentinel_user_settings')
      .addColumn('search_without_asking', 'boolean', col => col.notNull().defaultTo(true))
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('sentinel_user_settings').dropColumn('search_without_asking').execute();
  });
}
