import { sql, type Kysely } from 'kysely';

/**
 * A reading voice per persona: replies from that persona are read aloud in it. NULL (every
 * existing persona) keeps the voice the person picked for all replies.
 * Mirrors db/postgres/migrations/20261106_000001_persona_voice.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE persona ADD COLUMN voice TEXT`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE persona DROP COLUMN voice`.execute(trx);
  });
}
