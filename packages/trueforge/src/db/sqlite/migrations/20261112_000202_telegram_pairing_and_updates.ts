import { sql, type Kysely } from 'kysely';

/**
 * Two Telegram connection columns: the name of the person waiting to pair, which Settings shows
 * instead of the pairing code (the code itself is shown only in Telegram), and the last update
 * id the channel has claimed, so an update delivered twice is handled once.
 * Mirrors db/postgres/migrations/20261112_000202_telegram_pairing_and_updates.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE telegram_connection ADD COLUMN pairing_display_name TEXT`.execute(trx);
    await sql`ALTER TABLE telegram_connection ADD COLUMN last_update_id TEXT`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE telegram_connection DROP COLUMN last_update_id`.execute(trx);
    await sql`ALTER TABLE telegram_connection DROP COLUMN pairing_display_name`.execute(trx);
  });
}
