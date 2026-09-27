import { sql, type Kysely } from 'kysely';

/**
 * Host-maintained learned profile document on the personalization profile.
 * Nullable: existing rows have learned nothing yet.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's Migrator already invokes this function with a Transaction. Starting another
  // transaction here is unsupported; every statement below shares the migrator-owned
  // transaction and rolls back together.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('personalization_profile').addColumn('learned_profile', 'text').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // This is the same migrator-owned transaction described in up().
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('personalization_profile').dropColumn('learned_profile').execute();
}
