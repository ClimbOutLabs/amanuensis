import { sql, type Kysely } from 'kysely';

/**
 * The user's name and how the assistant should address them, on the personalization profile.
 * Nullable: existing rows have not said yet.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's Migrator already invokes this function with a Transaction. Starting another
  // transaction here is unsupported; every statement below shares the migrator-owned
  // transaction and rolls back together.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('personalization_profile')
    .addColumn('user_name', 'text')
    .addColumn('address_as', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // This is the same migrator-owned transaction described in up().
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('personalization_profile').dropColumn('user_name').dropColumn('address_as').execute();
}
