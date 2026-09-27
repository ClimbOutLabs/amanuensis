import { sql, type Kysely } from 'kysely';

/**
 * User switch for the learned-profile distillation pass, carried on the personalization profile.
 * Defaults to false so an existing profile and a fresh deployment both start with learning off.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's Migrator already invokes this function with a Transaction. Starting another
  // transaction here is unsupported; every statement below shares the migrator-owned
  // transaction and rolls back together.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('personalization_profile')
    .addColumn('learning_enabled', 'boolean', col => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // This is the same migrator-owned transaction described in up().
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('personalization_profile').dropColumn('learning_enabled').execute();
}
