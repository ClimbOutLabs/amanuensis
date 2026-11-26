import { sql, type Kysely } from 'kysely';

/**
 * Whether a goal's target carries a time of day the person chose, stored as 0
 * or 1: one goal store serves Postgres and SQLite, and SQLite cannot bind a
 * boolean, so both databases hold the same shape. Defaults to 0, so every
 * goal stored before this column reads as a date alone, which is how the
 * screens already show those goals.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's Migrator already invokes this function with a Transaction. Starting another
  // transaction here is unsupported; every statement below shares the migrator-owned
  // transaction and rolls back together.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    ALTER TABLE goal
      ADD COLUMN target_has_time integer NOT NULL DEFAULT 0 CHECK (target_has_time IN (0, 1))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // This is the same migrator-owned transaction described in up().
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('goal').dropColumn('target_has_time').execute();
}
