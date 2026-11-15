import { sql, type Kysely } from 'kysely';

/**
 * Where each owed Telegram reply's turn started: in Telegram, or in the app's Telegram chat.
 * Mirrors db/postgres/migrations/20261115_000002_telegram_reply_origin.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE telegram_pending_reply
        ADD COLUMN origin TEXT NOT NULL DEFAULT 'telegram' CHECK (origin IN ('telegram', 'app'))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE telegram_pending_reply DROP COLUMN origin`.execute(trx);
  });
}
