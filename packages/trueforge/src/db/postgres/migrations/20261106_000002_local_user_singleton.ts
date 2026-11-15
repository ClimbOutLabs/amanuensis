import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Makes the one-owner rule hold by construction. Every row carries the same `singleton`
 * value (the check allows nothing else) and a unique index over it, so the database
 * refuses a second row even when two first-run creates both look before either commits.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('local_user')
      .addColumn('singleton', 'boolean', col =>
        col
          .notNull()
          .defaultTo(true)
          .check(sql`singleton`),
      )
      .execute();
    await trx.schema.createIndex('local_user_singleton_idx').on('local_user').column('singleton').unique().execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropIndex('local_user_singleton_idx').execute();
    await trx.schema.alterTable('local_user').dropColumn('singleton').execute();
  });
}
