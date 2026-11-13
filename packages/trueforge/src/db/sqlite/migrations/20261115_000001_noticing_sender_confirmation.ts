import { sql, type Kysely } from 'kysely';

/**
 * Records on each mail checkpoint whether the source that wrote it reports sender confirmation, as the source
 * states about itself, so Reach me can word its always-important rule from that fact instead of naming a provider.
 * Checkpoints written before this carry null, which says nothing either way. Mirrors
 * db/postgres/migrations/20261115_000001_noticing_sender_confirmation.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE noticing_checkpoint ADD COLUMN sender_confirmation INTEGER CHECK (sender_confirmation IN (0, 1))`.execute(
      trx,
    );
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE noticing_checkpoint DROP COLUMN sender_confirmation`.execute(trx);
  });
}
