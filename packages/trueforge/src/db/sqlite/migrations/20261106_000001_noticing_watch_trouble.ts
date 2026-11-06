import { sql, type Kysely } from 'kysely';

/**
 * A watcher's trouble kept with its checkpoint: since when passes have failed and why, and the one message a pass
 * keeps failing on. Mirrors db/postgres/migrations/20261106_000001_noticing_watch_trouble.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE noticing_checkpoint ADD COLUMN failing_since TEXT`.execute(trx);
    await sql`ALTER TABLE noticing_checkpoint ADD COLUMN failure_kind TEXT`.execute(trx);
    await sql`ALTER TABLE noticing_checkpoint ADD COLUMN stuck_message_id TEXT`.execute(trx);
    await sql`ALTER TABLE noticing_checkpoint ADD COLUMN stuck_passes INTEGER NOT NULL DEFAULT 0`.execute(trx);
    await sql`ALTER TABLE noticing_checkpoint ADD COLUMN stuck_since TEXT`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE noticing_checkpoint DROP COLUMN stuck_since`.execute(trx);
    await sql`ALTER TABLE noticing_checkpoint DROP COLUMN stuck_passes`.execute(trx);
    await sql`ALTER TABLE noticing_checkpoint DROP COLUMN stuck_message_id`.execute(trx);
    await sql`ALTER TABLE noticing_checkpoint DROP COLUMN failure_kind`.execute(trx);
    await sql`ALTER TABLE noticing_checkpoint DROP COLUMN failing_since`.execute(trx);
  });
}
