import { sql, type Kysely } from 'kysely';

/**
 * The areas the user picked for the Tour's "What would help you most?" question, on the
 * personalization profile. Defaults to an empty list so existing profiles read as no choice.
 * Mirrors db/postgres/migrations/20261021_000010_personalization_help_areas.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  // X'0B' is the jsonb encoding of an empty array, the default SQLite accepts on ADD COLUMN.
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE personalization_profile
        ADD COLUMN help_areas BLOB NOT NULL DEFAULT X'0B'
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The column has no index, key or constraint that blocks DROP COLUMN, so it is removed in place.
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE personalization_profile
        DROP COLUMN help_areas
    `.execute(trx);
  });
}
