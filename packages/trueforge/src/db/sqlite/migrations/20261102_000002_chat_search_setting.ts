import { sql, type Kysely } from 'kysely';

/**
 * Per-user switch for past-chat search: 1 lets the assistant search the person's own earlier
 * chats when they ask, 0 (the default) means the search tool is not offered at all.
 * Mirrors db/postgres/migrations/20261102_000002_chat_search_setting.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE sentinel_user_settings
        ADD COLUMN chat_search_enabled INTEGER NOT NULL DEFAULT 0 CHECK (chat_search_enabled IN (0, 1))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE sentinel_user_settings DROP COLUMN chat_search_enabled`.execute(trx);
  });
}
