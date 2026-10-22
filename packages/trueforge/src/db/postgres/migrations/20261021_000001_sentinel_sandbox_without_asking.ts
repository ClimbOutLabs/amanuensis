import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Per-user switch for in-sandbox work: true runs code, commands and workspace files without asking,
 * false asks for each one. Defaults to true so a user with a saved row gets the same default as one without.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('sentinel_user_settings')
      .addColumn('sandbox_without_asking', 'boolean', col => col.notNull().defaultTo(true))
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('sentinel_user_settings').dropColumn('sandbox_without_asking').execute();
  });
}
