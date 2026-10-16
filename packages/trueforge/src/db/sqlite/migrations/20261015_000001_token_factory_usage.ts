import { sql, type Kysely } from 'kysely';

/**
 * Per-instance daily Token Factory token counter: one row per UTC day (`YYYY-MM-DD`), read and
 * incremented by primary key only. Mirrors db/postgres/migrations/20261015_000001_token_factory_usage.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE token_factory_usage (
        usage_date TEXT NOT NULL PRIMARY KEY,
        used_tokens INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE token_factory_usage`.execute(trx);
  });
}
