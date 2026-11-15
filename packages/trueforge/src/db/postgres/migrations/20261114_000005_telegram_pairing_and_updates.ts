import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Two Telegram connection columns: the name of the person waiting to pair, which Settings shows
 * instead of the pairing code (the code itself is shown only in Telegram), and the last update
 * id the channel has claimed, so an update delivered twice is handled once.
 * Mirrors db/sqlite/migrations/20261114_000005_telegram_pairing_and_updates.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('telegram_connection').addColumn('pairing_display_name', 'text').execute();
    await trx.schema.alterTable('telegram_connection').addColumn('last_update_id', 'text').execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('telegram_connection').dropColumn('last_update_id').execute();
    await trx.schema.alterTable('telegram_connection').dropColumn('pairing_display_name').execute();
  });
}
