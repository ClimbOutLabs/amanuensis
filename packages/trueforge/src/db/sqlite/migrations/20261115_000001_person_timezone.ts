import { sql, type Kysely } from 'kysely';

/**
 * The time zone each person's browser last gave, so a message that brings none is still read in their own day.
 * Mirrors db/postgres/migrations/20261115_000001_person_timezone.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE person_timezone (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        timezone TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE person_timezone`.execute(trx);
  });
}
