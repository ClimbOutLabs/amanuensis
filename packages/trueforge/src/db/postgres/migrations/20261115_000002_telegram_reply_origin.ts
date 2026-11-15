import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/** Where each owed Telegram reply's turn started: in Telegram, or in the app's Telegram chat. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('telegram_pending_reply')
      .addColumn('origin', 'text', col =>
        col
          .notNull()
          .defaultTo('telegram')
          .check(sql`origin in ('telegram', 'app')`),
      )
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('telegram_pending_reply').dropColumn('origin').execute();
  });
}
