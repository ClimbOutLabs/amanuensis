import { sql, type Kysely } from 'kysely';

/**
 * Global key/value settings shared across tenants (e.g. the persisted live
 * tool-output screen override). Small table, point lookups by primary key only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE global_settings (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE global_settings`.execute(trx);
  });
}
