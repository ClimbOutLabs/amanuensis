import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Per-user switch for embedded maps: true lets a map run without asking once the silent-run rules
 * hold, false asks for each one. Defaults to false so a user with a saved row gets the same default as one without.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('sentinel_user_settings')
      .addColumn('maps_without_asking', 'boolean', col => col.notNull().defaultTo(false))
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('sentinel_user_settings').dropColumn('maps_without_asking').execute();
  });
}
