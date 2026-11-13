import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Per-user switch for past-chat search: true lets the assistant search the person's own
 * earlier chats when they ask, false (the default) means the search tool is not offered at all.
 * Mirrors db/sqlite/migrations/20261102_000002_chat_search_setting.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('sentinel_user_settings')
      .addColumn('chat_search_enabled', 'boolean', col => col.notNull().defaultTo(false))
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('sentinel_user_settings').dropColumn('chat_search_enabled').execute();
  });
}
