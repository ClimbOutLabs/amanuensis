import { sql, type Kysely } from 'kysely';

/**
 * Adds `model_provider.last_check`: the outcome of the connection check run when a provider
 * was saved, kept beside the manifest because it is a fact about the row, not configuration.
 * Null until the first check runs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('model_provider').addColumn('last_check', 'jsonb').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('model_provider').dropColumn('last_check').execute();
}
