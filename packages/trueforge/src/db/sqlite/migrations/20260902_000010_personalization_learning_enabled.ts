import { sql, type Kysely } from 'kysely';

/**
 * User switch for the learned-profile distillation pass, carried on the personalization profile.
 * Defaults to 0 so an existing profile and a fresh deployment both start with learning off.
 * Mirrors db/postgres/migrations/20260902_000010_personalization_learning_enabled.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE personalization_profile
        ADD COLUMN learning_enabled INTEGER NOT NULL DEFAULT 0 CHECK (learning_enabled IN (0, 1))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT without a table rebuild; irreversible.
  void db;
  return Promise.reject(new Error('20260902_000010_personalization_learning_enabled is not reversible'));
}
