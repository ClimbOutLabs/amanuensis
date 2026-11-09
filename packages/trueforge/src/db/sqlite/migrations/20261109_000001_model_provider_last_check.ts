import { sql, type Kysely } from 'kysely';

/**
 * Adds `model_provider.last_check` for SQLite, mirroring the Postgres column: the outcome of
 * the connection check run when a provider was saved (BLOB SQLite JSONB). Null until the
 * first check runs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE model_provider ADD COLUMN last_check BLOB`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE model_provider DROP COLUMN last_check`.execute(trx);
  });
}
