import { sql, type Kysely } from 'kysely';

/**
 * Makes the one-owner rule hold by construction: every row carries the same `singleton`
 * value (the check allows nothing else) and a unique index over it, so the table can only
 * ever hold one row. SQLite writes already serialize through one connection; this gives
 * the schema the same guarantee the store relies on.
 * Mirrors db/postgres/migrations/20261106_000002_local_user_singleton.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE local_user
        ADD COLUMN singleton INTEGER NOT NULL DEFAULT 1 CHECK (singleton = 1)
    `.execute(trx);
    await sql`CREATE UNIQUE INDEX local_user_singleton_idx ON local_user (singleton)`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP INDEX local_user_singleton_idx`.execute(trx);
    await sql`ALTER TABLE local_user DROP COLUMN singleton`.execute(trx);
  });
}
