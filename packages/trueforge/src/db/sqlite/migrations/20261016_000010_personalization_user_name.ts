import { sql, type Kysely } from 'kysely';

/**
 * The user's name and how the assistant should address them, on the personalization profile.
 * Nullable: existing rows have not said yet.
 * Mirrors db/postgres/migrations/20261016_000010_personalization_user_name.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE personalization_profile
        ADD COLUMN user_name TEXT
    `.execute(trx);
    await sql`
      ALTER TABLE personalization_profile
        ADD COLUMN address_as TEXT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT without a table rebuild; irreversible.
  void db;
  return Promise.reject(new Error('20261016_000010_personalization_user_name is not reversible'));
}
