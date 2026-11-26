import { sql, type Kysely } from 'kysely';

/**
 * Whether a goal's target carries a time of day the person chose. Defaults to
 * 0, so every goal stored before this column reads as a date alone, which is
 * how the screens already show those goals. Mirrors
 * db/postgres/migrations/20261125_000001_goal_target_has_time.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE goal
        ADD COLUMN target_has_time INTEGER NOT NULL DEFAULT 0 CHECK (target_has_time IN (0, 1))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT without a table rebuild; irreversible.
  void db;
  return Promise.reject(new Error('20261125_000001_goal_target_has_time is not reversible'));
}
