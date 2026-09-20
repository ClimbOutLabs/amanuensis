import { sql, type Kysely } from 'kysely';

/**
 * Host-maintained learned profile document on the personalization profile.
 * Nullable: existing rows have learned nothing yet.
 * Mirrors db/postgres/migrations/20260901_000010_personalization_learned_profile.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE personalization_profile
        ADD COLUMN learned_profile TEXT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT without a table rebuild; irreversible.
  void db;
  return Promise.reject(new Error('20260901_000010_personalization_learned_profile is not reversible'));
}
