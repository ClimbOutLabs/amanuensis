import { sql, type Kysely } from 'kysely';

/**
 * The areas the user picked for the Tour's "What would help you most?" question, on the
 * personalization profile. Defaults to an empty list so existing profiles read as no choice.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's Migrator already invokes this function with a Transaction. Starting another
  // transaction here is unsupported; every statement below shares the migrator-owned
  // transaction and rolls back together.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('personalization_profile')
    .addColumn('help_areas', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // This is the same migrator-owned transaction described in up().
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('personalization_profile').dropColumn('help_areas').execute();
}
