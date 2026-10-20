import { sql, type Kysely } from 'kysely';

/**
 * Per-user switch for embedded maps: 1 lets a map run without asking once the silent-run rules hold,
 * 0 asks for each one. Defaults to 0 so a user with a saved row gets the same default as one without.
 * Mirrors db/postgres/migrations/20261020_000001_sentinel_maps_without_asking.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE sentinel_user_settings
        ADD COLUMN maps_without_asking INTEGER NOT NULL DEFAULT 0 CHECK (maps_without_asking IN (0, 1))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE sentinel_user_settings DROP COLUMN maps_without_asking`.execute(trx);
  });
}
